#include <iostream>
#include <string>
#include <vector>
#include <chrono>
#include <thread>
#include <cstdlib>

#define NOMINMAX
#define _WINSOCK_DEPRECATED_NO_WARNINGS

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "iphlpapi.lib")
#endif

#define TEST_ASSERT(cond) do { \
    if (!(cond)) { \
        std::cerr << "\nFATAL ASSERTION FAILURE: " << #cond << " at " << __FILE__ << ":" << __LINE__ << std::endl; \
        std::abort(); \
    } \
} while(0)

#include "worker.h"
#include "policy.h"
#include "estimator.h"
#include "node.h"
#include "placement.h"

using namespace swarm;

// Helper to create a candidate device for dynamic placement testing
PlacementPolicyEngine::CandidateDevice make_candidate(
    const std::string& id,
    const std::string& sec_id,
    const std::string& type,
    bool loopback,
    const std::string& mem_scope,
    uint64_t total_ram,
    uint64_t free_ram) {

    PlacementPolicyEngine::CandidateDevice cd;
    cd.primary_id = id;
    cd.secondary_id = sec_id;
    cd.device_name = "Device-" + sec_id;
    cd.backend_type = type;
    cd.is_loopback = loopback;
    cd.memory_scope = mem_scope;
    cd.physical_memory_total = total_ram;
    cd.physical_memory_free = free_ram;
    cd.has_agent_telemetry = true;
    cd.is_stale = false;
    cd.telemetry_age_ms = 500;
    cd.provenance = "MEASURED";
    cd.agent_ram_total = total_ram;
    cd.agent_ram_available = free_ram;
    cd.agent_vram_total = (type == "cuda") ? total_ram : 0;
    cd.is_simulated = false;
    return cd;
}

// TEST 1: Healthy remote RPC worker with an established connection is NOT marked unavailable by unnecessary competing probe
void test_1_active_connection_not_marked_unavailable() {
    std::cout << "[Test 1] Healthy remote RPC worker with established connection probe suppression... ";

    WorkerManager wm;

    // Sub-case A: Worker is marked is_inference_active or BUSY during inference
    WorkerInfo w_busy;
    w_busy.id = "remote-busy";
    w_busy.host = "127.0.0.1";
    w_busy.port = 59990; // Even with no listener, busy inference must not be probed
    w_busy.type = WorkerType::REMOTE_RPC;
    w_busy.state = WorkerState::BUSY;
    w_busy.is_inference_active = true;
    w_busy.has_active_backend_connection = true;

    wm.check_worker_health(w_busy);
    TEST_ASSERT(w_busy.state == WorkerState::BUSY);
    TEST_ASSERT(w_busy.is_inference_active == true);
    TEST_ASSERT(w_busy.last_error.empty());

    // Sub-case B: Worker has a real established TCP socket from coordinator
    // Start a test server on a local port
    SOCKET server_sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    TEST_ASSERT(server_sock != INVALID_SOCKET);

    sockaddr_in server_addr{};
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    server_addr.sin_port = htons(0); // auto assign port
    int bind_res = bind(server_sock, (sockaddr*)&server_addr, sizeof(server_addr));
    TEST_ASSERT(bind_res == 0);
    int listen_res = listen(server_sock, 1);
    TEST_ASSERT(listen_res == 0);

    int addr_len = sizeof(server_addr);
    int gsn_res = getsockname(server_sock, (sockaddr*)&server_addr, &addr_len);
    TEST_ASSERT(gsn_res == 0);
    uint16_t listen_port = ntohs(server_addr.sin_port);
    TEST_ASSERT(listen_port > 0);

    // Establish client connection from this process (simulating coordinator backend RPC connection)
    SOCKET client_sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    TEST_ASSERT(client_sock != INVALID_SOCKET);
    int conn_res = connect(client_sock, (sockaddr*)&server_addr, sizeof(server_addr));
    TEST_ASSERT(conn_res == 0);

    SOCKET accepted_sock = accept(server_sock, NULL, NULL);
    TEST_ASSERT(accepted_sock != INVALID_SOCKET);

    // Worker represents this remote endpoint
    WorkerInfo w_conn;
    w_conn.id = "remote-connected";
    w_conn.host = "127.0.0.1";
    w_conn.port = listen_port;
    w_conn.type = WorkerType::REMOTE_RPC;
    w_conn.state = WorkerState::READY;
    w_conn.has_active_backend_connection = true;

    // Check health: should inspect existing socket without opening a new competing connection
    wm.check_worker_health(w_conn);
    TEST_ASSERT(w_conn.state == WorkerState::READY);
    TEST_ASSERT(w_conn.has_active_backend_connection == true);
    TEST_ASSERT(w_conn.last_error.empty());

    // Clean up sockets
    closesocket(client_sock);
    closesocket(accepted_sock);
    closesocket(server_sock);

    std::cout << "PASS\n";
}

// TEST 2: Genuinely dead or unreachable worker is detected
void test_2_dead_or_unreachable_worker_detected() {
    std::cout << "[Test 2] Genuinely dead or unreachable worker detection... ";

    WorkerManager wm;

    // Sub-case A: Idle worker with an unreachable port
    WorkerInfo w_dead;
    w_dead.id = "remote-dead";
    w_dead.host = "127.0.0.1";
    w_dead.port = 59991; // No listener
    w_dead.type = WorkerType::REMOTE_RPC;
    w_dead.state = WorkerState::STARTING;
    w_dead.has_active_backend_connection = false;

    wm.check_worker_health(w_dead);
    TEST_ASSERT(w_dead.state == WorkerState::UNAVAILABLE);
    TEST_ASSERT(!w_dead.last_error.empty());

    // Sub-case B: Worker previously had active backend connection with assigned layers, but socket was dropped
    WorkerInfo w_lost;
    w_lost.id = "remote-lost";
    w_lost.host = "127.0.0.1";
    w_lost.port = 59992;
    w_lost.type = WorkerType::REMOTE_RPC;
    w_lost.state = WorkerState::READY;
    w_lost.has_active_backend_connection = true;
    w_lost.assigned_layers = { 33 }; // Has assigned layer!

    // Health check should detect that coordinator process no longer holds an established socket to 59992
    wm.check_worker_health(w_lost);
    TEST_ASSERT(w_lost.state == WorkerState::UNAVAILABLE);
    TEST_ASSERT(w_lost.last_error.find("lost") != std::string::npos);

    std::cout << "PASS\n";
}

// TEST 3: Failed connection is reported accurately and does NOT stop unrelated workers
void test_3_failed_connection_isolation() {
    std::cout << "[Test 3] Failed connection isolation across workers... ";

    WorkerManager wm;

    // Worker 1: Healthy worker (start a listener for it)
    SOCKET server_sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    TEST_ASSERT(server_sock != INVALID_SOCKET);
    sockaddr_in server_addr{};
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    server_addr.sin_port = htons(0);
    int bind_res = bind(server_sock, (sockaddr*)&server_addr, sizeof(server_addr));
    TEST_ASSERT(bind_res == 0);
    int listen_res = listen(server_sock, 5);
    TEST_ASSERT(listen_res == 0);
    int addr_len = sizeof(server_addr);
    int gsn_res = getsockname(server_sock, (sockaddr*)&server_addr, &addr_len);
    TEST_ASSERT(gsn_res == 0);
    uint16_t healthy_port = ntohs(server_addr.sin_port);
    TEST_ASSERT(healthy_port > 0);

    WorkerInfo w_healthy;
    w_healthy.id = "worker-healthy";
    w_healthy.host = "127.0.0.1";
    w_healthy.port = healthy_port;
    w_healthy.type = WorkerType::REMOTE_RPC;
    w_healthy.state = WorkerState::STARTING;

    // Worker 2: Dead worker
    WorkerInfo w_failing;
    w_failing.id = "worker-failing";
    w_failing.host = "127.0.0.1";
    w_failing.port = 59993; // No listener
    w_failing.type = WorkerType::REMOTE_RPC;
    w_failing.state = WorkerState::STARTING;

    wm.add_worker(w_healthy);
    wm.add_worker(w_failing);

    wm.check_worker_health("worker-healthy");
    wm.check_worker_health("worker-failing");

    auto workers = wm.get_workers();
    TEST_ASSERT(workers.size() == 2);

    // Worker 0 should be READY
    TEST_ASSERT(workers[0].state == WorkerState::READY);
    TEST_ASSERT(workers[0].last_error.empty());

    // Worker 1 should be UNAVAILABLE with error
    TEST_ASSERT(workers[1].state == WorkerState::UNAVAILABLE);
    TEST_ASSERT(!workers[1].last_error.empty());

    // Verify Worker 0 was not impacted by Worker 1's failure
    wm.check_worker_health("worker-healthy");
    workers = wm.get_workers();
    TEST_ASSERT(workers[0].state == WorkerState::READY);

    closesocket(server_sock);
    std::cout << "PASS\n";
}

// TEST 4: Dynamic placement with insufficient usable memory safely assigns zero layers
void test_4_dynamic_placement_insufficient_memory_zero_cap() {
    std::cout << "[Test 4] Dynamic placement insufficient memory safety (zero-cap)... ";

    // Replicate Computer B physical parameters:
    // Total RAM: 7.19 GiB = 7720499200 bytes
    // Free RAM: 946 MiB = 991952896 bytes
    // Headroom floor: 12.5% = 920.6 MiB = 965062400 bytes
    // Usable RAM: 946 - 920.6 = ~25.4 MiB (< 92.2 MiB required for 1 layer of 36-layer model)
    uint64_t total_ram = 7720499200ULL;
    uint64_t free_ram = 991952896ULL;

    std::vector<PlacementPolicyEngine::CandidateDevice> devices;
    // Remote Computer B worker (insufficient free RAM after headroom)
    devices.push_back(make_candidate("192.168.137.1:50052", "RPC0", "remote_rpc", false,
                                     "remote_host:192.168.137.1", total_ram, free_ram));
    // Local Computer A CUDA device (ample free VRAM)
    devices.push_back(make_candidate("local-cuda-0", "CUDA0", "cuda", false,
                                     "device_local", 4294967296ULL, 3500ULL * 1024 * 1024));

    // Request offloading up to 4 layers for a 36-layer model
    std::unordered_map<std::string, DeviceProfile> empty_profiles;
    PlacementPolicyResult res = PlacementPolicyEngine::evaluate(
        PlacementPolicyType::DYNAMIC, devices, empty_profiles, 36, 4, 16);

    // Evaluation succeeds: CUDA absorbs the offload, while RPC0 safely receives 0 layers
    TEST_ASSERT(res.success);
    TEST_ASSERT(res.plans.size() == 2);
    // RPC0 plan
    TEST_ASSERT(res.plans[0].capped_layer_capacity == 0);
    TEST_ASSERT(res.plans[0].predicted_layers.empty());
    TEST_ASSERT(res.plans[0].split_weight == 0.0f);
    // CUDA0 plan gets all 4 layers
    TEST_ASSERT(res.plans[1].predicted_layers.size() == 4);

    std::cout << "PASS (RPC0 safely allocated 0 layers, preserving memory safety)\n";
}

// TEST 5: Remote layer allocation is reflected accurately in /backends
void test_5_backends_reflection_of_remote_allocation() {
    std::cout << "[Test 5] Remote layer allocation reflection in /backends payload... ";

    PlacementTracker tracker;

    // Register remote RPC worker as backend RPC0
    tracker.register_backend("RPC0", "RPC0", "192.168.137.1:50052", "192.168.137.1:50052",
                             "remote_rpc", false, "remote_host:192.168.137.1",
                             7720499200ULL, 991952896ULL);

    // Register local CUDA backend
    tracker.register_backend("CUDA0", "CUDA0", "NVIDIA GeForce GTX 1050", "",
                             "local_cuda", false, "device_vram",
                             4294967296ULL, 3526361088ULL);

    // Register host CPU backend
    tracker.register_backend("CPU", "CPU", "Host CPU", "",
                             "cpu", false, "shared_host",
                             17179869184ULL, 8589934592ULL);

    // Simulate placement assignment via loader log lines:
    // RPC0: layer 33
    // CUDA0: layers 34, 35, 36
    // CPU: layers 0-32
    tracker.parse_line("load_tensors: layer  33 assigned to device RPC0, is_swa = 0");
    tracker.parse_line("load_tensors: RPC0[192.168.137.1:50052] model buffer size =    47.04 MiB");
    tracker.parse_line("load_tensors: layer  34 assigned to device CUDA0, is_swa = 0");
    tracker.parse_line("load_tensors: layer  35 assigned to device CUDA0, is_swa = 0");
    tracker.parse_line("load_tensors: layer  36 assigned to device CUDA0, is_swa = 0");
    tracker.finalize();

    // Generate JSON payload matching /backends endpoint
    json j = tracker.to_json(17179869184ULL, 8589934592ULL);

    TEST_ASSERT(j.contains("backends"));
    TEST_ASSERT(j["backends"].is_array());
    TEST_ASSERT(j["backends"].size() == 3);

    // Verify RPC0 attributes
    const json* rpc0_json = nullptr;
    for (const auto& b : j["backends"]) {
        if (b["backend_id"] == "RPC0") {
            rpc0_json = &b;
            break;
        }
    }
    TEST_ASSERT(rpc0_json != nullptr);
    TEST_ASSERT((*rpc0_json)["backend_type"] == "remote_rpc");
    TEST_ASSERT((*rpc0_json)["endpoint"] == "192.168.137.1:50052");
    TEST_ASSERT((*rpc0_json)["is_loopback"] == false);
    TEST_ASSERT((*rpc0_json)["assigned_layers"].size() == 1);
    TEST_ASSERT((*rpc0_json)["assigned_layers"][0] == 33);
    TEST_ASSERT((*rpc0_json)["model_buffer_bytes"].get<size_t>() > 40000000ULL);

    std::cout << "PASS\n";
}

// TEST 6: A worker whose backend session died must never be re-readied just
// because a fresh TCP handshake to its port succeeds. Dispatching a graph into
// such a worker aborts the coordinator (ggml-rpc cannot recover a dead session).
void test_6_lost_backend_session_never_readied_by_reachable_port() {
    std::cout << "[Test 6] Lost backend session is not re-readied by a live port... ";

    // A listener stands in for "something still answers on the worker port".
    SOCKET server_sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    TEST_ASSERT(server_sock != INVALID_SOCKET);
    sockaddr_in server_addr{};
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    server_addr.sin_port = htons(0);
    int bind_res = bind(server_sock, (sockaddr*)&server_addr, sizeof(server_addr));
    TEST_ASSERT(bind_res == 0);
    int listen_res = listen(server_sock, 5);
    TEST_ASSERT(listen_res == 0);

    int addr_len = sizeof(server_addr);
    int gsn_res = getsockname(server_sock, (sockaddr*)&server_addr, &addr_len);
    TEST_ASSERT(gsn_res == 0);
    uint16_t live_port = ntohs(server_addr.sin_port);
    TEST_ASSERT(live_port > 0);

    WorkerManager wm;

    WorkerInfo w_lost;
    w_lost.id = "remote-lost-session";
    w_lost.host = "127.0.0.1";
    w_lost.port = live_port;
    w_lost.type = WorkerType::REMOTE_RPC;
    w_lost.state = WorkerState::READY;
    w_lost.has_active_backend_connection = true; // it HAD a live GGML RPC session
    w_lost.assigned_layers = { 25, 26, 27, 28, 29, 30 };
    w_lost.assigned_layer_ranges = { { 25, 30 } };

    wm.add_worker(w_lost);
    wm.check_worker_health("remote-lost-session");

    auto workers = wm.get_workers();
    TEST_ASSERT(workers.size() == 1);
    // The port answers, but the backend session is gone: must stay unavailable.
    TEST_ASSERT(workers[0].state == WorkerState::UNAVAILABLE);
    TEST_ASSERT(workers[0].last_error.find("restart the engine") != std::string::npos);

    // And a second probe must not promote it either.
    wm.check_worker_health("remote-lost-session");
    workers = wm.get_workers();
    TEST_ASSERT(workers[0].state == WorkerState::UNAVAILABLE);

    closesocket(server_sock);
    std::cout << "PASS\n";
}

int main() {
#ifdef _WIN32
    WSADATA wsaData;
    int wsa_res = WSAStartup(MAKEWORD(2, 2), &wsaData);
    TEST_ASSERT(wsa_res == 0);
#endif

    std::cout << "=== Swarm Milestone 12: Remote RPC Health & Placement Regression Tests ===\n";

    test_1_active_connection_not_marked_unavailable();
    test_2_dead_or_unreachable_worker_detected();
    test_3_failed_connection_isolation();
    test_6_lost_backend_session_never_readied_by_reachable_port();
    test_4_dynamic_placement_insufficient_memory_zero_cap();
    test_5_backends_reflection_of_remote_allocation();

    std::cout << "\nALL 5 REGRESSION TESTS PASSED SUCCESSFULLY!\n";

#ifdef _WIN32
    WSACleanup();
#endif
    return 0;
}
