#include <iostream>
#include <cassert>
#include <string>
#include <vector>
#include <chrono>
#include <cmath>

#include "policy.h"
#include "estimator.h"
#include "node.h"

using namespace swarm;

// Helper to construct a candidate device for testing
PlacementPolicyEngine::CandidateDevice make_candidate(
    const std::string& id,
    const std::string& sec_id,
    const std::string& type,
    bool loopback,
    const std::string& mem_scope,
    uint64_t total_ram,
    uint64_t free_ram,
    bool has_agent = true,
    bool is_stale = false,
    uint64_t age_ms = 1000,
    const std::string& prov = "MEASURED",
    bool simulated = false) {

    PlacementPolicyEngine::CandidateDevice cd;
    cd.primary_id = id;
    cd.secondary_id = sec_id;
    cd.device_name = "TestDev-" + sec_id;
    cd.backend_type = type;
    cd.is_loopback = loopback;
    cd.memory_scope = mem_scope;
    cd.physical_memory_total = total_ram;
    cd.physical_memory_free = free_ram;

    cd.has_agent_telemetry = has_agent;
    cd.is_stale = is_stale;
    cd.telemetry_age_ms = age_ms;
    cd.provenance = prov;
    cd.agent_ram_total = total_ram;
    cd.agent_ram_available = free_ram;
    cd.agent_vram_total = (type == "cuda") ? total_ram : 0;
    cd.is_simulated = simulated;
    return cd;
}

// TEST 1: Heterogeneous backends dynamic allocation
void test_heterogeneous_backends() {
    std::cout << "[TEST 1] Heterogeneous backends dynamic allocation: ";
    std::vector<PlacementPolicyEngine::CandidateDevice> devices;

    // Worker 1: 8 GiB RAM, 6 GiB free (remote worker)
    devices.push_back(make_candidate("192.168.1.10:50052", "RPC0", "remote_rpc", false, "remote_host:192.168.1.10",
                                     8ULL * 1024 * 1024 * 1024, 6ULL * 1024 * 1024 * 1024));

    // Worker 2: 4 GiB RAM, 2.5 GiB free (remote worker)
    devices.push_back(make_candidate("192.168.1.20:50053", "RPC1", "remote_rpc", false, "remote_host:192.168.1.20",
                                     4ULL * 1024 * 1024 * 1024, 2500ULL * 1024 * 1024));

    // Local CUDA: 4 GiB VRAM, 3.5 GiB free
    devices.push_back(make_candidate("local-cuda-0", "CUDA0", "cuda", false, "device_local",
                                     4ULL * 1024 * 1024 * 1024, 3500ULL * 1024 * 1024));

    std::unordered_map<std::string, DeviceProfile> empty_profiles;
    // Request offloading 8 layers
    PlacementPolicyResult res = PlacementPolicyEngine::evaluate(
        PlacementPolicyType::DYNAMIC, devices, empty_profiles, 36, 8, 16);

    assert(res.success);
    assert(res.plans.size() == 3);

    // Verify all backends received positive split weights proportional to usable capacity
    assert(res.plans[0].split_weight > 0.0f);
    assert(res.plans[1].split_weight > 0.0f);
    assert(res.plans[2].split_weight > 0.0f);

    // Verify Worker 1 (larger capacity) has higher or equal capacity than Worker 2
    assert(res.plans[0].capped_layer_capacity >= res.plans[1].capped_layer_capacity);

    // Total predicted layers must equal requested offload count (8 layers)
    size_t total_pred = 0;
    for (const auto& p : res.plans) {
        total_pred += p.predicted_layers.size();
    }
    assert(total_pred == 8);

    std::cout << "PASS (8 layers distributed across heterogeneous nodes)" << std::endl;
}

// TEST 2: Configured budgets vs measured values
void test_configured_vs_measured_provenance() {
    std::cout << "[TEST 2] Configured budgets vs measured values: ";
    std::vector<PlacementPolicyEngine::CandidateDevice> devices;

    devices.push_back(make_candidate("127.0.0.1:50052", "RPC0", "loopback_rpc", true, "shared_host",
                                     16ULL * 1024 * 1024 * 1024, 8ULL * 1024 * 1024 * 1024,
                                     true, false, 2000, "MEASURED"));

    devices.push_back(make_candidate("local-cuda-0", "CUDA0", "cuda", false, "device_local",
                                     4ULL * 1024 * 1024 * 1024, 3ULL * 1024 * 1024 * 1024,
                                     false, false, 0, "MEASURED"));

    std::unordered_map<std::string, DeviceProfile> profiles;
    PlacementPolicyResult res = PlacementPolicyEngine::evaluate(
        PlacementPolicyType::DYNAMIC, devices, profiles, 36, 4, 16);

    assert(res.success);
    for (const auto& p : res.plans) {
        assert(p.provenance == "MEASURED");
        assert(p.usable_budget_bytes > 0);
        assert(p.reserved_headroom_bytes > 0);
    }
    std::cout << "PASS (Provenance strictly preserved as MEASURED, headroom reserved)" << std::endl;
}

// TEST 3: Stale and missing telemetry rejection
void test_stale_and_missing_telemetry() {
    std::cout << "[TEST 3] Stale and missing telemetry rejection: ";
    std::unordered_map<std::string, DeviceProfile> empty_profiles;

    // Case 3A: Stale telemetry (age 35000ms > 30000ms TTL)
    {
        std::vector<PlacementPolicyEngine::CandidateDevice> devices;
        devices.push_back(make_candidate("192.168.1.10:50052", "RPC0", "remote_rpc", false, "remote_host:192.168.1.10",
                                         8ULL * 1024 * 1024 * 1024, 6ULL * 1024 * 1024 * 1024,
                                         true, true, 35000)); // Stale
        devices.push_back(make_candidate("local-cuda-0", "CUDA0", "cuda", false, "device_local",
                                         4ULL * 1024 * 1024 * 1024, 3ULL * 1024 * 1024 * 1024));

        PlacementPolicyResult res = PlacementPolicyEngine::evaluate(
            PlacementPolicyType::DYNAMIC, devices, empty_profiles, 36, 4, 16);
        assert(!res.success);
        assert(res.error_message.find("STALE") != std::string::npos);
    }

    // Case 3B: Missing telemetry (worker with no agent and no GGML properties)
    {
        std::vector<PlacementPolicyEngine::CandidateDevice> devices;
        auto missing_dev = make_candidate("192.168.1.10:50052", "RPC0", "remote_rpc", false, "remote_host:192.168.1.10",
                                          0, 0, false, false, 0); // No agent, 0 total
        devices.push_back(missing_dev);
        devices.push_back(make_candidate("local-cuda-0", "CUDA0", "cuda", false, "device_local",
                                         4ULL * 1024 * 1024 * 1024, 3ULL * 1024 * 1024 * 1024));

        PlacementPolicyResult res = PlacementPolicyEngine::evaluate(
            PlacementPolicyType::DYNAMIC, devices, empty_profiles, 36, 4, 16);
        assert(!res.success);
        assert(res.error_message.find("No telemetry") != std::string::npos ||
               res.error_message.find("validation failed") != std::string::npos);
    }

    std::cout << "PASS (Stale and missing telemetry cleanly rejected with diagnostics)" << std::endl;
}

// TEST 4: Duplicate host memory deduplication for loopback workers
void test_loopback_deduplication_partitioning() {
    std::cout << "[TEST 4] Loopback memory deduplication and partitioning: ";

    std::vector<PlacementPolicyEngine::CandidateDevice> devices;
    // Two loopback workers sharing the same 16 GiB host RAM with 6 GiB free
    devices.push_back(make_candidate("127.0.0.1:50052", "RPC0", "loopback_rpc", true, "shared_host",
                                     16ULL * 1024 * 1024 * 1024, 6ULL * 1024 * 1024 * 1024));
    devices.push_back(make_candidate("127.0.0.1:50053", "RPC1", "loopback_rpc", true, "shared_host",
                                     16ULL * 1024 * 1024 * 1024, 6ULL * 1024 * 1024 * 1024));
    devices.push_back(make_candidate("local-cuda-0", "CUDA0", "cuda", false, "device_local",
                                     4ULL * 1024 * 1024 * 1024, 3ULL * 1024 * 1024 * 1024));

    std::unordered_map<std::string, DeviceProfile> empty_profiles;
    PlacementPolicyResult res = PlacementPolicyEngine::evaluate(
        PlacementPolicyType::DYNAMIC, devices, empty_profiles, 36, 6, 16);

    assert(res.success);

    // Sum of usable budgets of RPC0 and RPC1 must NOT exceed total usable host RAM
    uint64_t total_loopback_budget = res.plans[0].usable_budget_bytes + res.plans[1].usable_budget_bytes;
    // Host has 6 GiB free - 2 GiB headroom (12.5% of 16GB) = 4 GiB usable host budget
    // When partitioned across 2 workers, each gets ~2 GiB
    assert(res.plans[0].usable_budget_bytes == res.plans[1].usable_budget_bytes);
    assert(total_loopback_budget <= 4ULL * 1024 * 1024 * 1024 + 1024); // Never inflated to 8 GiB!

    std::cout << "PASS (Host RAM partitioned equally; no additive inflation)" << std::endl;
}

// TEST 5: Zero-capacity backend receiving zero layers
void test_zero_capacity_backend() {
    std::cout << "[TEST 5] Zero-capacity backend handling: ";

    std::vector<PlacementPolicyEngine::CandidateDevice> devices;
    // Worker with only 500 MiB free RAM, below 1 GiB OS headroom -> 0 usable budget
    devices.push_back(make_candidate("192.168.1.10:50052", "RPC0", "remote_rpc", false, "remote_host:192.168.1.10",
                                     4ULL * 1024 * 1024 * 1024, 500ULL * 1024 * 1024));

    // Local CUDA with 3.5 GiB free -> sufficient for 4 layers
    devices.push_back(make_candidate("local-cuda-0", "CUDA0", "cuda", false, "device_local",
                                     4ULL * 1024 * 1024 * 1024, 3500ULL * 1024 * 1024));

    std::unordered_map<std::string, DeviceProfile> empty_profiles;
    PlacementPolicyResult res = PlacementPolicyEngine::evaluate(
        PlacementPolicyType::DYNAMIC, devices, empty_profiles, 36, 4, 16);

    assert(res.success);
    // Worker has 0 usable budget and receives 0 layers
    assert(res.plans[0].capped_layer_capacity == 0);
    assert(res.plans[0].split_weight == 0.0f);
    assert(res.plans[0].predicted_layers.empty());

    // CUDA receives all 4 requested layers
    assert(res.plans[1].predicted_layers.size() == 4);

    std::cout << "PASS (Zero-capacity worker assigned 0 layers without error)" << std::endl;
}

// TEST 6: Insufficient total capacity rejection
void test_insufficient_total_capacity() {
    std::cout << "[TEST 6] Insufficient total capacity rejection: ";

    std::vector<PlacementPolicyEngine::CandidateDevice> devices;
    // Worker with 1.1 GiB free (100 MiB usable after 1 GiB headroom) -> 1 layer (~92 MiB)
    devices.push_back(make_candidate("192.168.1.10:50052", "RPC0", "remote_rpc", false, "remote_host:192.168.1.10",
                                     4ULL * 1024 * 1024 * 1024, 1100ULL * 1024 * 1024));

    // Local CUDA with 350 MiB free (94 MiB usable after 256MB headroom) -> 1 layer
    devices.push_back(make_candidate("local-cuda-0", "CUDA0", "cuda", false, "device_local",
                                     1ULL * 1024 * 1024 * 1024, 350ULL * 1024 * 1024));

    // Total available capacity is ~2 layers, but 8 layers requested
    std::unordered_map<std::string, DeviceProfile> empty_profiles;
    PlacementPolicyResult res = PlacementPolicyEngine::evaluate(
        PlacementPolicyType::DYNAMIC, devices, empty_profiles, 36, 8, 16);

    assert(!res.success);
    assert(res.error_message.find("Insufficient dynamic capacity") != std::string::npos);

    std::cout << "PASS (Insufficient capacity halted startup cleanly)" << std::endl;
}

// TEST 7: Malformed and implausible values
void test_malformed_implausible_values() {
    std::cout << "[TEST 7] Malformed and implausible values rejection: ";

    std::unordered_map<std::string, DeviceProfile> empty_profiles;

    // Inverted RAM: available > total
    {
        std::vector<PlacementPolicyEngine::CandidateDevice> devices;
        devices.push_back(make_candidate("192.168.1.10:50052", "RPC0", "remote_rpc", false, "remote_host:192.168.1.10",
                                         4ULL * 1024 * 1024 * 1024, 8ULL * 1024 * 1024 * 1024)); // 8GB avail > 4GB total
        devices.push_back(make_candidate("local-cuda-0", "CUDA0", "cuda", false, "device_local",
                                         4ULL * 1024 * 1024 * 1024, 3ULL * 1024 * 1024 * 1024));

        PlacementPolicyResult res = PlacementPolicyEngine::evaluate(
            PlacementPolicyType::DYNAMIC, devices, empty_profiles, 36, 4, 16);
        assert(!res.success);
        assert(res.error_message.find("Implausible") != std::string::npos);
    }

    // Zero total RAM
    {
        std::vector<PlacementPolicyEngine::CandidateDevice> devices;
        devices.push_back(make_candidate("192.168.1.10:50052", "RPC0", "remote_rpc", false, "remote_host:192.168.1.10",
                                         0, 0));
        devices.push_back(make_candidate("local-cuda-0", "CUDA0", "cuda", false, "device_local",
                                         4ULL * 1024 * 1024 * 1024, 3ULL * 1024 * 1024 * 1024));

        PlacementPolicyResult res = PlacementPolicyEngine::evaluate(
            PlacementPolicyType::DYNAMIC, devices, empty_profiles, 36, 4, 16);
        assert(!res.success);
    }

    std::cout << "PASS (Inverted and zero values safely rejected)" << std::endl;
}

// TEST 8: Simulated fixtures isolation
void test_simulated_fixtures_isolation() {
    std::cout << "[TEST 8] Simulated fixtures isolation: ";

    std::vector<PlacementPolicyEngine::CandidateDevice> devices;
    devices.push_back(make_candidate("node-sim-remote", "RPC0", "remote_rpc", false, "remote_host:10.0.0.99",
                                     16ULL * 1024 * 1024 * 1024, 12ULL * 1024 * 1024 * 1024,
                                     true, false, 500, "SIMULATED", true));

    devices.push_back(make_candidate("local-cuda-0", "CUDA0", "cuda", false, "device_local",
                                     4ULL * 1024 * 1024 * 1024, 3ULL * 1024 * 1024 * 1024));

    std::unordered_map<std::string, DeviceProfile> empty_profiles;
    PlacementPolicyResult res = PlacementPolicyEngine::evaluate(
        PlacementPolicyType::DYNAMIC, devices, empty_profiles, 36, 4, 16);

    assert(res.success);
    assert(res.plans[0].provenance == "SIMULATED");
    assert(res.plans[1].provenance == "MEASURED");

    std::cout << "PASS (Simulated tag isolated from live measured provenance)" << std::endl;
}

// TEST 9: Clock skew and replay protection
void test_clock_skew_and_replay_protection() {
    std::cout << "[TEST 9] Clock skew and replay protection:\n";

    NodeInventory inv;
    std::string err;
    uint64_t t0 = 1000000ULL; // Coordinator base monotonic time (1,000,000 ms)

    // 1. Worker whose clock is 35 seconds behind (skew = +35,000 ms)
    std::cout << "  - Subtest 1: Clock skew behind..." << std::endl;
    json r1 = {
        {"schema_version", "1.0"},
        {"agent_version", "1.0.0"},
        {"agent_session_id", "session-worker-1"},
        {"sequence_number", 1ULL},
        {"timestamp_ms", t0 - 35000ULL}, // 35s behind coordinator
        {"node_id", "node-skew-behind"},
        {"endpoint", "192.168.1.10:50052"},
        {"hostname", "remote-host-1"},
        {"rpc_port", 50052},
        {"status", "ONLINE"},
        {"cpu", {{"architecture", "x86_64"}, {"processor_count", 8}}},
        {"ram", {{"total_bytes", 16000000000ULL}, {"available_bytes", 8000000000ULL}}}
    };

    assert(inv.ingest_agent_report(r1, t0, err, true));
    auto n1 = inv.get_node("node-skew-behind").value();
    assert(!n1.is_stale);
    assert(n1.clock_skew_ms == 35000);
    assert(n1.last_receipt_time_ms == t0);
    assert(n1.last_agent_report_ms == t0 - 35000ULL);
    assert(!NodeInventory::is_stale(n1, 30000, t0)); // Legitimate fresh report NOT rejected

    // 2. Worker whose clock is 60 seconds ahead (skew = -60,000 ms)
    std::cout << "  - Subtest 2: Clock skew ahead..." << std::endl;
    json r2 = {
        {"schema_version", "1.0"},
        {"agent_version", "1.0.0"},
        {"agent_session_id", "session-worker-2"},
        {"sequence_number", 1ULL},
        {"timestamp_ms", t0 + 60000ULL}, // 60s ahead of coordinator
        {"node_id", "node-skew-ahead"},
        {"endpoint", "192.168.1.20:50052"},
        {"hostname", "remote-host-2"},
        {"rpc_port", 50052},
        {"status", "ONLINE"},
        {"cpu", {{"architecture", "x86_64"}, {"processor_count", 8}}},
        {"ram", {{"total_bytes", 16000000000ULL}, {"available_bytes", 8000000000ULL}}}
    };

    assert(inv.ingest_agent_report(r2, t0, err, true));
    auto n2 = inv.get_node("node-skew-ahead").value();
    assert(!n2.is_stale);
    assert(n2.clock_skew_ms == -60000);
    assert(n2.last_receipt_time_ms == t0);
    assert(n2.last_agent_report_ms == t0 + 60000ULL);
    assert(!NodeInventory::is_stale(n2, 30000, t0)); // Legitimate fresh report NOT rejected

    // 3. Telemetry becoming stale after 30 seconds without a new accepted report
    std::cout << "  - Subtest 3: Staleness after 30s..." << std::endl;
    uint64_t t1 = t0 + 35000ULL; // 35s elapsed on coordinator clock
    assert(NodeInventory::is_stale(n1, 30000, t1));
    // Stale even though worker clock was ahead (+60s)
    assert(NodeInventory::is_stale(n2, 30000, t1));

    // 4. Repeated or replayed reports not improperly extending freshness
    std::cout << "  - Subtest 4: Replay protection..." << std::endl;
    // Replay r2 with same session and sequence number at t1
    assert(!inv.ingest_agent_report(r2, t1, err, true));
    assert(err.find("Replayed report rejected") != std::string::npos);
    auto n2_replayed = inv.get_node("node-skew-ahead").value();
    assert(n2_replayed.last_receipt_time_ms == t0); // Receipt time NOT extended
    assert(NodeInventory::is_stale(n2_replayed, 30000, t1)); // Remains stale

    // Test unsequenced legacy report replay
    json r_legacy = {
        {"schema_version", "1.0"},
        {"agent_version", "1.0.0"},
        {"timestamp_ms", t0},
        {"node_id", "node-legacy"},
        {"endpoint", "192.168.1.30:50052"},
        {"hostname", "legacy-host"},
        {"status", "ONLINE"},
        {"ram", {{"total_bytes", 8000000000ULL}, {"available_bytes", 4000000000ULL}}}
    };
    assert(inv.ingest_agent_report(r_legacy, t0, err, true));
    assert(!inv.ingest_agent_report(r_legacy, t1, err, true));
    assert(err.find("Replayed report rejected") != std::string::npos);

    // 5. Valid subsequent report restoring freshness
    std::cout << "  - Subtest 5: Freshness restoration..." << std::endl;
    json r2_seq2 = r2;
    r2_seq2["sequence_number"] = 2ULL;
    r2_seq2["timestamp_ms"] = t0 + 60000ULL + 36000ULL;
    uint64_t t2 = t1 + 1000ULL; // t0 + 36s
    assert(inv.ingest_agent_report(r2_seq2, t2, err, true));
    auto n2_restored = inv.get_node("node-skew-ahead").value();
    assert(!n2_restored.is_stale);
    assert(n2_restored.last_sequence_number == 2ULL);
    assert(n2_restored.last_receipt_time_ms == t2);
    assert(!NodeInventory::is_stale(n2_restored, 30000, t2)); // Freshness restored

    // Agent restart restores freshness under new session ID
    json r2_restarted = r2;
    r2_restarted["agent_session_id"] = "session-worker-2-restarted";
    r2_restarted["sequence_number"] = 1ULL;
    r2_restarted["timestamp_ms"] = t0 + 60000ULL + 40000ULL;
    uint64_t t3 = t2 + 5000ULL;
    assert(inv.ingest_agent_report(r2_restarted, t3, err, true));
    auto n2_restarted = inv.get_node("node-skew-ahead").value();
    assert(n2_restarted.agent_session_id == "session-worker-2-restarted");
    assert(n2_restarted.last_sequence_number == 1ULL);
    assert(!NodeInventory::is_stale(n2_restarted, 30000, t3));

    // 6. Missing, malformed and implausible timestamp values
    std::cout << "  - Subtest 6: Malformed / implausible timestamps..." << std::endl;
    // Missing timestamp_ms
    json r_missing = r1;
    r_missing.erase("timestamp_ms");
    assert(!inv.ingest_agent_report(r_missing, t0, err, true));
    assert(err.find("timestamp_ms") != std::string::npos);

    // Malformed timestamp_ms (string)
    json r_malformed = r1;
    r_malformed["timestamp_ms"] = "2026-10-10";
    assert(!inv.ingest_agent_report(r_malformed, t0, err, true));
    assert(err.find("timestamp_ms") != std::string::npos);

    // Zero timestamp_ms
    json r_zero = r1;
    r_zero["timestamp_ms"] = 0ULL;
    assert(!inv.ingest_agent_report(r_zero, t0, err, true));
    assert(err.find("timestamp_ms") != std::string::npos);

    // Implausible futuristic timestamp_ms (> year 2100)
    json r_futuristic = r1;
    r_futuristic["timestamp_ms"] = 9999999999999ULL;
    assert(!inv.ingest_agent_report(r_futuristic, t0, err, true));
    assert(err.find("timestamp_ms") != std::string::npos);

    std::cout << "  PASS (Clock skew, replay rejection, staleness and timestamp validation verified)" << std::endl;
}

int main() {
    std::cout << "=== Swarm Milestone 9: Dynamic Placement & Capacity Estimator Unit Tests ===" << std::endl;
    test_heterogeneous_backends();
    test_configured_vs_measured_provenance();
    test_stale_and_missing_telemetry();
    test_loopback_deduplication_partitioning();
    test_zero_capacity_backend();
    test_insufficient_total_capacity();
    test_malformed_implausible_values();
    test_simulated_fixtures_isolation();
    test_clock_skew_and_replay_protection();
    std::cout << "All 9 dynamic policy unit tests passed successfully." << std::endl;
    return 0;
}
