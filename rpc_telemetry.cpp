#ifndef NOMINMAX
#define NOMINMAX
#endif

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#endif

#include "rpc_telemetry.h"
#include "ggml.h"
#include "json.hpp"
#include "logger.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <limits>
#include <memory>
#include <mutex>
#include <numeric>
#include <sstream>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace swarm {
namespace {

using json = nlohmann::json;
using clock_type = std::chrono::steady_clock;

#ifdef _WIN32
using socket_handle = SOCKET;
const socket_handle kInvalidSocket = INVALID_SOCKET;
#else
using socket_handle = int;
const socket_handle kInvalidSocket = -1;
#endif

constexpr size_t kMaxFrameSize = 1024ull * 1024ull * 1024ull;
constexpr size_t kMaxBufferedPayload = 256ull * 1024ull * 1024ull;
constexpr size_t kTensorPrefixBytes = sizeof(uint64_t) * 40;
constexpr size_t kGraphCaptureBytes = 4ull * 1024ull * 1024ull;

// Keep these in sync with the vendored ggml RPC protocol.
enum RpcCmd {
    RPC_CMD_ALLOC_BUFFER = 0,
    RPC_CMD_GET_ALIGNMENT = 1,
    RPC_CMD_GET_MAX_SIZE = 2,
    RPC_CMD_BUFFER_GET_BASE = 3,
    RPC_CMD_FREE_BUFFER = 4,
    RPC_CMD_BUFFER_CLEAR = 5,
    RPC_CMD_SET_TENSOR = 6,
    RPC_CMD_SET_TENSOR_HASH = 7,
    RPC_CMD_GET_TENSOR = 8,
    RPC_CMD_COPY_TENSOR = 9,
    RPC_CMD_GRAPH_COMPUTE = 10,
    RPC_CMD_GET_DEVICE_MEMORY = 11,
    RPC_CMD_INIT_TENSOR = 12,
    RPC_CMD_GET_ALLOC_SIZE = 13,
    RPC_CMD_HELLO = 14,
    RPC_CMD_DEVICE_COUNT = 15,
    RPC_CMD_GRAPH_RECOMPUTE = 16,
    RPC_CMD_MEMSET_TENSOR = 17,
    RPC_CMD_NONE = 18,
};

#pragma pack(push, 1)
struct RpcTensorWire {
    uint64_t id;
    uint32_t type;
    uint64_t buffer;
    uint32_t ne[GGML_MAX_DIMS];
    uint32_t nb[GGML_MAX_DIMS];
    uint32_t op;
    int32_t op_params[GGML_MAX_OP_PARAMS / sizeof(int32_t)];
    int32_t flags;
    uint64_t src[GGML_MAX_SRC];
    uint64_t view_src;
    uint64_t view_offs;
    uint64_t data;
    char name[GGML_MAX_NAME];
    int32_t use_count;
};
#pragma pack(pop)

static_assert(sizeof(RpcTensorWire) == 296, "unexpected rpc_tensor wire size");

const char* command_name(int cmd) {
    switch (cmd) {
    case RPC_CMD_ALLOC_BUFFER: return "ALLOC_BUFFER";
    case RPC_CMD_GET_ALIGNMENT: return "GET_ALIGNMENT";
    case RPC_CMD_GET_MAX_SIZE: return "GET_MAX_SIZE";
    case RPC_CMD_BUFFER_GET_BASE: return "BUFFER_GET_BASE";
    case RPC_CMD_FREE_BUFFER: return "FREE_BUFFER";
    case RPC_CMD_BUFFER_CLEAR: return "BUFFER_CLEAR";
    case RPC_CMD_SET_TENSOR: return "SET_TENSOR";
    case RPC_CMD_SET_TENSOR_HASH: return "SET_TENSOR_HASH";
    case RPC_CMD_GET_TENSOR: return "GET_TENSOR";
    case RPC_CMD_COPY_TENSOR: return "COPY_TENSOR";
    case RPC_CMD_GRAPH_COMPUTE: return "GRAPH_COMPUTE";
    case RPC_CMD_GET_DEVICE_MEMORY: return "GET_DEVICE_MEMORY";
    case RPC_CMD_INIT_TENSOR: return "INIT_TENSOR";
    case RPC_CMD_GET_ALLOC_SIZE: return "GET_ALLOC_SIZE";
    case RPC_CMD_HELLO: return "HELLO";
    case RPC_CMD_DEVICE_COUNT: return "DEVICE_COUNT";
    case RPC_CMD_GRAPH_RECOMPUTE: return "GRAPH_RECOMPUTE";
    case RPC_CMD_MEMSET_TENSOR: return "MEMSET_TENSOR";
    case RPC_CMD_NONE: return "NONE";
    default: return "UNKNOWN";
    }
}

bool command_has_response(int cmd) {
    switch (cmd) {
    case RPC_CMD_ALLOC_BUFFER:
    case RPC_CMD_GET_ALIGNMENT:
    case RPC_CMD_GET_MAX_SIZE:
    case RPC_CMD_BUFFER_GET_BASE:
    case RPC_CMD_SET_TENSOR_HASH:
    case RPC_CMD_GET_TENSOR:
    case RPC_CMD_COPY_TENSOR:
    case RPC_CMD_GET_DEVICE_MEMORY:
    case RPC_CMD_GET_ALLOC_SIZE:
    case RPC_CMD_HELLO:
    case RPC_CMD_DEVICE_COUNT:
        return true;
    default:
        return false;
    }
}

bool command_has_tensor(int cmd) {
    return cmd == RPC_CMD_SET_TENSOR || cmd == RPC_CMD_SET_TENSOR_HASH ||
           cmd == RPC_CMD_GET_TENSOR || cmd == RPC_CMD_COPY_TENSOR ||
           cmd == RPC_CMD_INIT_TENSOR || cmd == RPC_CMD_MEMSET_TENSOR ||
           cmd == RPC_CMD_GET_ALLOC_SIZE;
}

RpcTensorInfo parse_tensor(const uint8_t* data, size_t size, size_t offset = 0) {
    RpcTensorInfo info;
    if (!data || size < offset + sizeof(RpcTensorWire)) {
        return info;
    }
    RpcTensorWire wire{};
    std::memcpy(&wire, data + offset, sizeof(wire));
    info.valid = true;

    char name[GGML_MAX_NAME + 1] = {};
    std::memcpy(name, wire.name, GGML_MAX_NAME);
    info.name = name;

    const char* type_name = ggml_type_name(static_cast<enum ggml_type>(wire.type));
    info.type = type_name ? type_name : "UNKNOWN";

    for (int i = 0; i < GGML_MAX_DIMS; ++i) {
        if (wire.ne[i] == 0) {
            break;
        }
        if (i == 0 || wire.ne[i] > 1 || i + 1 < GGML_MAX_DIMS) {
            info.shape.push_back(static_cast<int64_t>(wire.ne[i]));
        }
    }
    return info;
}

std::string join_shape(const std::vector<int64_t>& shape) {
    std::string out;
    for (size_t i = 0; i < shape.size(); ++i) {
        if (i) out += " x ";
        out += std::to_string(shape[i]);
    }
    return out;
}

double ms_between(clock_type::time_point a, clock_type::time_point b) {
    return std::chrono::duration<double, std::milli>(b - a).count();
}

uint64_t now_us() {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
        clock_type::now().time_since_epoch()).count());
}

#ifdef _WIN32
void ensure_winsock() {
    static std::once_flag once;
    std::call_once(once, []() {
        WSADATA wsa{};
        WSAStartup(MAKEWORD(2, 2), &wsa);
    });
}
#else
void ensure_winsock() {}
#endif

void close_socket(socket_handle s) {
    if (s == kInvalidSocket) return;
#ifdef _WIN32
    closesocket(s);
#else
    close(s);
#endif
}

void shutdown_socket(socket_handle s) {
    if (s == kInvalidSocket) return;
#ifdef _WIN32
    shutdown(s, SD_BOTH);
#else
    shutdown(s, SHUT_RDWR);
#endif
}

bool socket_valid(socket_handle s) {
    return s != kInvalidSocket;
}

void set_socket_timeout(socket_handle s, int seconds) {
#ifdef _WIN32
    DWORD timeout = static_cast<DWORD>(seconds) * 1000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
#else
    timeval tv{};
    tv.tv_sec = seconds;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif
}

void set_tcp_nodelay(socket_handle s) {
    int one = 1;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY,
               reinterpret_cast<const char*>(&one), sizeof(one));
}

bool recv_all(socket_handle s, void* data, size_t size) {
    uint8_t* ptr = static_cast<uint8_t*>(data);
    size_t remaining = size;
    while (remaining > 0) {
        const int chunk = static_cast<int>(std::min<size_t>(remaining, 1ull << 20));
#ifdef _WIN32
        const int n = recv(s, reinterpret_cast<char*>(ptr), chunk, 0);
#else
        const ssize_t n = recv(s, ptr, static_cast<size_t>(chunk), 0);
#endif
        if (n <= 0) {
            return false;
        }
        ptr += n;
        remaining -= static_cast<size_t>(n);
    }
    return true;
}

bool send_all(socket_handle s, const void* data, size_t size) {
    const uint8_t* ptr = static_cast<const uint8_t*>(data);
    size_t remaining = size;
    while (remaining > 0) {
        const int chunk = static_cast<int>(std::min<size_t>(remaining, 1ull << 20));
#ifdef _WIN32
        const int n = send(s, reinterpret_cast<const char*>(ptr), chunk, 0);
#else
        const ssize_t n = send(s, ptr, static_cast<size_t>(chunk), 0);
#endif
        if (n <= 0) {
            return false;
        }
        ptr += n;
        remaining -= static_cast<size_t>(n);
    }
    return true;
}

socket_handle connect_tcp(const std::string& host, uint16_t port) {
    ensure_winsock();
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    addrinfo* results = nullptr;
    const std::string port_text = std::to_string(port);
    if (getaddrinfo(host.c_str(), port_text.c_str(), &hints, &results) != 0) {
        return kInvalidSocket;
    }

    socket_handle out = kInvalidSocket;
    for (int attempt = 0; attempt < 10; ++attempt) {
        for (addrinfo* it = results; it != nullptr; it = it->ai_next) {
            socket_handle s = socket(it->ai_family, it->ai_socktype, it->ai_protocol);
            if (!socket_valid(s)) {
                continue;
            }
            if (connect(s, it->ai_addr, static_cast<int>(it->ai_addrlen)) == 0) {
                out = s;
                break;
            }
            close_socket(s);
        }
        if (socket_valid(out)) {
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    freeaddrinfo(results);
    return out;
}

socket_handle create_loopback_listener(uint16_t& port_out) {
    ensure_winsock();
    socket_handle s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (!socket_valid(s)) {
        return kInvalidSocket;
    }
    int reuse = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR,
               reinterpret_cast<const char*>(&reuse), sizeof(reuse));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    if (bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0 ||
        listen(s, 16) != 0) {
        close_socket(s);
        return kInvalidSocket;
    }

    sockaddr_in bound{};
#ifdef _WIN32
    int bound_len = sizeof(bound);
#else
    socklen_t bound_len = sizeof(bound);
#endif
    if (getsockname(s, reinterpret_cast<sockaddr*>(&bound), &bound_len) != 0) {
        close_socket(s);
        return kInvalidSocket;
    }
    port_out = ntohs(bound.sin_port);
    return s;
}

struct ProxyState;
struct ConnectionState;

struct PendingResponse {
    int cmd = -1;
    std::string op;
    bool probe = false;
    bool rtt_probe = false;
    bool hello = false;
    bool forward = true;
    uint64_t request_id = 0;
    double offset_ms = 0.0;
    clock_type::time_point req_start{};
    clock_type::time_point req_write_end{};
    double upload_ms = 0.0;
    uint64_t request_wire_bytes = 0;
    uint64_t expected_response_size = 0;
    RpcTensorInfo tensor;
    uint32_t node_count = 0;
    uint32_t graph_tensor_count = 0;
    std::atomic<bool> ready{false};
};

struct ProxyState {
    std::string worker_id;
    std::string worker_label;
    std::string host;
    uint16_t port = 0;
    std::string remote_endpoint;
    uint16_t local_port = 0;
    socket_handle listener = kInvalidSocket;
    std::atomic<bool> running{false};
    std::thread accept_thread;
    mutable std::mutex connections_mutex;
    std::vector<std::shared_ptr<ConnectionState>> connections;

    void add_connection(const std::shared_ptr<ConnectionState>& conn);
    void remove_connection(const std::shared_ptr<ConnectionState>& conn);
    std::vector<std::shared_ptr<ConnectionState>> snapshot() const;
};

struct ConnectionState {
    std::shared_ptr<ProxyState> proxy;
    socket_handle client_sock = kInvalidSocket;
    socket_handle worker_sock = kInvalidSocket;
    std::atomic<bool> running{true};
    std::atomic<bool> hello_done{false};
    std::atomic<bool> rtt_probe_inflight{false};
    std::atomic<uint64_t> rtt_us{0};
    std::atomic<bool> in_flight_frame{false};

    std::mutex write_mutex;
    std::mutex pending_mutex;
    std::condition_variable pending_cv;
    std::deque<std::shared_ptr<PendingResponse>> pending;

    // A graph can finish without an explicit response. The next server response
    // closes the busy window. This avoids adding a probe round trip per token.
    std::mutex busy_mutex;
    int open_graph_count = 0;
    clock_type::time_point open_graph_first_write_end{};
    clock_type::time_point open_graph_upload_start{};
    double open_graph_offset_ms = 0.0;
    uint64_t open_graph_request_id = 0;
    uint64_t open_graph_wire_bytes = 0;

    void notify_pending() {
        pending_cv.notify_all();
    }

    bool send_probe_locked(bool rtt_probe, uint64_t request_id, double offset_ms,
                           clock_type::time_point start, uint64_t request_wire_bytes,
                           double upload_ms, const std::string& op,
                           uint32_t node_count, uint32_t graph_tensor_count,
                           clock_type::time_point write_end) {
        if (!running.load() || !socket_valid(worker_sock)) {
            return false;
        }

        auto p = std::make_shared<PendingResponse>();
        p->cmd = RPC_CMD_GET_ALIGNMENT;
        p->op = rtt_probe ? "RTT_PROBE" : op;
        p->probe = true;
        p->rtt_probe = rtt_probe;
        p->forward = false;
        p->request_id = request_id;
        p->offset_ms = offset_ms;
        p->req_start = start;
        p->req_write_end = write_end;
        p->upload_ms = upload_ms;
        p->request_wire_bytes = request_wire_bytes;
        p->expected_response_size = sizeof(uint64_t);
        p->node_count = node_count;
        p->graph_tensor_count = graph_tensor_count;

        {
            std::lock_guard<std::mutex> lock(pending_mutex);
            pending.push_back(p);
        }

        if (rtt_probe) {
            rtt_probe_inflight.store(true);
        }

        const uint8_t cmd = static_cast<uint8_t>(RPC_CMD_GET_ALIGNMENT);
        const uint64_t payload_size = sizeof(uint32_t);
        const uint32_t device = 0;
        const bool ok = send_all(worker_sock, &cmd, sizeof(cmd)) &&
                        send_all(worker_sock, &payload_size, sizeof(payload_size)) &&
                        send_all(worker_sock, &device, sizeof(device));
        if (!ok) {
            if (rtt_probe) {
                rtt_probe_inflight.store(false);
            }
            running.store(false);
            pending_cv.notify_all();
            return false;
        }
        p->ready.store(true);
        pending_cv.notify_all();
        return true;
    }

    void measure_rtt(uint64_t request_id) {
        if (!running.load() || !hello_done.load() || rtt_probe_inflight.load()) {
            return;
        }
        std::lock_guard<std::mutex> write_lock(write_mutex);
        if (!running.load() || !hello_done.load() || rtt_probe_inflight.load()) {
            return;
        }
        const auto start = clock_type::now();
        send_probe_locked(true, request_id, -1.0, start, 0, 0.0, "RTT_PROBE", 0, 0, start);
    }

    bool flush(uint64_t request_id, int timeout_ms) {
        if (!running.load()) {
            return false;
        }
        const auto deadline = clock_type::now() + std::chrono::milliseconds(timeout_ms);
        {
            std::unique_lock<std::mutex> lock(pending_mutex);
            pending_cv.wait_until(lock, deadline, [&]() {
                return !running.load() || (!in_flight_frame.load() && pending.empty());
            });
            if (!running.load()) {
                return false;
            }
            if (in_flight_frame.load() || !pending.empty()) {
                return false;
            }
        }

        {
            std::lock_guard<std::mutex> write_lock(write_mutex);
            const auto start = clock_type::now();
            if (!send_probe_locked(true, request_id, -1.0, start, 0, 0.0,
                                   "RTT_PROBE", 0, 0, start)) {
                return false;
            }
        }

        {
            std::unique_lock<std::mutex> lock(pending_mutex);
            const bool drained = pending_cv.wait_until(lock, deadline, [&]() {
                return !running.load() || pending.empty();
            });
            return drained && running.load();
        }
    }

    void record_event(RpcWireEvent event) {
        if (event.request_id == 0) {
            return;
        }
        RpcTelemetryStore::instance().record_event(event);
    }

    void close_busy_window(const clock_type::time_point& response_first_byte,
                           const char* reason) {
        RpcWireEvent event;
        {
            std::lock_guard<std::mutex> lock(busy_mutex);
            if (open_graph_count <= 0) {
                return;
            }
            const double busy_ms = ms_between(open_graph_first_write_end, response_first_byte);
            const double rtt_ms = static_cast<double>(rtt_us.load()) / 1000.0;
            const bool measured = rtt_us.load() > 0;

            event.kind = RpcEventKind::WorkerBusy;
            event.worker_id = proxy->worker_id;
            event.request_id = open_graph_request_id;
            event.op = "WORKER_BUSY";
            event.offset_ms = open_graph_offset_ms;
            event.duration_ms = busy_ms;
            event.remote_ms = busy_ms;
            event.compute_ms = measured ? std::max(0.0, busy_ms - rtt_ms) : 0.0;
            event.has_compute = measured;
            event.node_count = 0;
            event.note = std::string(reason ? reason : "closed by next server response") +
                         " (" + std::to_string(open_graph_count) + " graph ops)";

            open_graph_count = 0;
            open_graph_request_id = 0;
            open_graph_offset_ms = 0.0;
            open_graph_wire_bytes = 0;
            open_graph_first_write_end = {};
            open_graph_upload_start = {};
        }
        record_event(std::move(event));
    }

    void mark_busy_window(uint64_t request_id, double offset_ms,
                          const clock_type::time_point& upload_start,
                          const clock_type::time_point& write_end, uint64_t wire_bytes) {
        std::lock_guard<std::mutex> lock(busy_mutex);
        if (open_graph_count == 0) {
            open_graph_first_write_end = write_end;
            open_graph_upload_start = upload_start;
            open_graph_offset_ms = offset_ms;
            open_graph_request_id = static_cast<uint64_t>(request_id);
            open_graph_wire_bytes = wire_bytes;
        }
        open_graph_count++;
    }


    void request_loop();
    void response_loop();
};

void ProxyState::add_connection(const std::shared_ptr<ConnectionState>& conn) {
    std::lock_guard<std::mutex> lock(connections_mutex);
    connections.erase(std::remove_if(connections.begin(), connections.end(),
        [](const std::shared_ptr<ConnectionState>& c) {
            return !c || !c->running.load();
        }), connections.end());
    connections.push_back(conn);
}

void ProxyState::remove_connection(const std::shared_ptr<ConnectionState>& conn) {
    std::lock_guard<std::mutex> lock(connections_mutex);
    connections.erase(std::remove(connections.begin(), connections.end(), conn),
                      connections.end());
}

std::vector<std::shared_ptr<ConnectionState>> ProxyState::snapshot() const {
    std::lock_guard<std::mutex> lock(connections_mutex);
    return connections;
}

void handle_client(const std::shared_ptr<ProxyState>& state, socket_handle client) {
    if (!socket_valid(client)) {
        return;
    }
    set_socket_timeout(client, 120);
    set_tcp_nodelay(client);

    socket_handle worker = connect_tcp(state->host, state->port);
    if (!socket_valid(worker)) {
        log_warn("[RPC Telemetry] Failed to connect proxy for worker '" + state->worker_id +
                 "' to " + state->remote_endpoint);
        close_socket(client);
        return;
    }
    set_socket_timeout(worker, 120);
    set_tcp_nodelay(worker);

    auto conn = std::make_shared<ConnectionState>();
    conn->proxy = state;
    conn->client_sock = client;
    conn->worker_sock = worker;
    state->add_connection(conn);

    std::thread response_thread([conn]() { conn->response_loop(); });
    conn->request_loop();

    conn->running.store(false);
    conn->notify_pending();
    shutdown_socket(client);
    shutdown_socket(worker);
    close_socket(client);
    close_socket(worker);
    if (response_thread.joinable()) {
        response_thread.join();
    }
    state->remove_connection(conn);
}

} // namespace

// The proxy needs to stream request payloads. This helper reads from the client
// and writes to the worker in one pass so large tensors do not sit in memory.
namespace {

bool forward_request_frame(ConnectionState& conn, int cmd, uint64_t payload_size,
                           std::vector<uint8_t>& captured, bool& truncated) {
    captured.clear();
    truncated = false;
    if (payload_size == 0) {
        return true;
    }

    size_t capture_limit = kTensorPrefixBytes;
    if (cmd == RPC_CMD_GRAPH_COMPUTE) {
        capture_limit = kGraphCaptureBytes;
    } else if (cmd == RPC_CMD_GET_TENSOR || cmd == RPC_CMD_SET_TENSOR_HASH) {
        capture_limit = sizeof(RpcTensorWire) + sizeof(uint64_t) * 2;
    } else if (cmd == RPC_CMD_COPY_TENSOR) {
        capture_limit = sizeof(RpcTensorWire) * 2;
    } else if (cmd == RPC_CMD_GET_ALLOC_SIZE) {
        capture_limit = sizeof(RpcTensorWire) * (1 + GGML_MAX_SRC) + sizeof(uint32_t);
    } else if (cmd == RPC_CMD_INIT_TENSOR || cmd == RPC_CMD_MEMSET_TENSOR) {
        capture_limit = sizeof(RpcTensorWire) + sizeof(uint64_t) * 2 + 1;
    } else if (cmd == RPC_CMD_SET_TENSOR) {
        capture_limit = sizeof(RpcTensorWire) + sizeof(uint64_t);
    }

    const size_t want = static_cast<size_t>(std::min<uint64_t>(payload_size, capture_limit));
    captured.resize(want);
    if (want > 0 && !recv_all(conn.client_sock, captured.data(), want)) {
        return false;
    }
    if (!send_all(conn.worker_sock, captured.data(), captured.size())) {
        return false;
    }

    size_t remaining = static_cast<size_t>(payload_size) - want;
    std::vector<uint8_t> scratch(64 * 1024);
    while (remaining > 0) {
        const size_t chunk = std::min<size_t>(remaining, scratch.size());
        if (!recv_all(conn.client_sock, scratch.data(), chunk)) {
            return false;
        }
        if (!send_all(conn.worker_sock, scratch.data(), chunk)) {
            return false;
        }
        remaining -= chunk;
    }
    truncated = want < payload_size;
    return true;
}

} // namespace

void ConnectionState::request_loop() {
    while (running.load()) {
        uint8_t cmd_byte = 0;
        if (!recv_all(client_sock, &cmd_byte, 1)) {
            break;
        }
        in_flight_frame.store(true);
        const int cmd = static_cast<int>(cmd_byte);
        uint64_t payload_size = 0;
        if (!recv_all(client_sock, &payload_size, sizeof(payload_size))) {
            break;
        }
        if (payload_size > kMaxFrameSize) {
            break;
        }

        const uint64_t captured_request_id = RpcTelemetryStore::instance().active_request();
        const double captured_offset_ms = RpcTelemetryStore::instance().active_offset_ms();
        const auto req_start = clock_type::now();
        const uint64_t request_wire_bytes = 1 + sizeof(uint64_t) + payload_size;

        std::vector<uint8_t> captured;
        bool truncated = false;

        std::unique_lock<std::mutex> write_lock(write_mutex);
        if (!running.load()) {
            break;
        }

        std::shared_ptr<PendingResponse> pending_response;
        if (command_has_response(cmd)) {
            pending_response = std::make_shared<PendingResponse>();
            pending_response->cmd = cmd;
            pending_response->op = command_name(cmd);
            pending_response->request_id = captured_request_id;
            pending_response->offset_ms = captured_offset_ms;
            pending_response->req_start = req_start;
            pending_response->request_wire_bytes = request_wire_bytes;
            pending_response->hello = (cmd == RPC_CMD_HELLO);

            if (cmd == RPC_CMD_HELLO) {
                pending_response->expected_response_size = 28;
            } else if (cmd == RPC_CMD_GET_TENSOR) {
                pending_response->expected_response_size = 0;
            } else if (cmd == RPC_CMD_ALLOC_BUFFER) {
                pending_response->expected_response_size = 16;
            } else if (cmd == RPC_CMD_GET_ALIGNMENT || cmd == RPC_CMD_GET_MAX_SIZE ||
                       cmd == RPC_CMD_BUFFER_GET_BASE || cmd == RPC_CMD_DEVICE_COUNT ||
                       cmd == RPC_CMD_GET_ALLOC_SIZE) {
                pending_response->expected_response_size = 8;
            } else if (cmd == RPC_CMD_SET_TENSOR_HASH || cmd == RPC_CMD_COPY_TENSOR) {
                pending_response->expected_response_size = 1;
            } else if (cmd == RPC_CMD_GET_DEVICE_MEMORY) {
                pending_response->expected_response_size = 16;
            }

            {
                std::lock_guard<std::mutex> pending_lock(pending_mutex);
                pending.push_back(pending_response);
            }
            pending_cv.notify_all();
        }

        const uint8_t out_cmd = cmd_byte;
        if (!send_all(worker_sock, &out_cmd, sizeof(out_cmd)) ||
            !send_all(worker_sock, &payload_size, sizeof(payload_size))) {
            running.store(false);
            break;
        }
        if (!forward_request_frame(*this, cmd, payload_size, captured, truncated)) {
            running.store(false);
            break;
        }
        const auto write_end = clock_type::now();
        const double upload_ms = ms_between(req_start, write_end);

        if (pending_response) {
            pending_response->req_write_end = write_end;
            pending_response->upload_ms = upload_ms;

            if (cmd == RPC_CMD_GET_TENSOR || cmd == RPC_CMD_SET_TENSOR_HASH ||
                cmd == RPC_CMD_COPY_TENSOR) {
                pending_response->tensor = parse_tensor(captured.data(), captured.size(), 0);
            }
            if (cmd == RPC_CMD_COPY_TENSOR) {
                RpcTensorInfo dst = parse_tensor(captured.data(), captured.size(), sizeof(RpcTensorWire));
                if (dst.valid) {
                    pending_response->tensor.name += " -> " + dst.name;
                }
            }
            pending_response->ready.store(true);
            pending_cv.notify_all();

            if (cmd == RPC_CMD_HELLO) {
                const auto probe_start = clock_type::now();
                send_probe_locked(true, 0, -1.0, probe_start, 0, 0.0, "RTT_PROBE", 0, 0, probe_start);
            }
        } else if (cmd == RPC_CMD_SET_TENSOR) {
            RpcWireEvent event;
            event.kind = RpcEventKind::TensorSend;
            event.worker_id = proxy->worker_id;
            event.request_id = captured_request_id;
            event.op = "SET_TENSOR";
            event.cmd = cmd;
            event.offset_ms = captured_offset_ms;
            event.duration_ms = upload_ms;
            event.upload_ms = upload_ms;
            event.request_wire_bytes = request_wire_bytes;
            event.tensor = parse_tensor(captured.data(), captured.size(), 0);
            if (payload_size >= sizeof(RpcTensorWire) + sizeof(uint64_t)) {
                event.tensor_bytes = payload_size - sizeof(RpcTensorWire) - sizeof(uint64_t);
            }
            if (!event.tensor.valid) {
                event.note = "tensor metadata unavailable";
            }
            record_event(std::move(event));
        } else if (cmd == RPC_CMD_GRAPH_COMPUTE || cmd == RPC_CMD_GRAPH_RECOMPUTE) {
            RpcWireEvent event;
            event.kind = RpcEventKind::GraphCompute;
            event.worker_id = proxy->worker_id;
            event.request_id = captured_request_id;
            event.op = command_name(cmd);
            event.cmd = cmd;
            event.offset_ms = captured_offset_ms;
            event.duration_ms = upload_ms;
            event.upload_ms = upload_ms;
            event.request_wire_bytes = request_wire_bytes;

            if (cmd == RPC_CMD_GRAPH_COMPUTE && captured.size() >= 12) {
                uint32_t device = 0;
                uint32_t n_nodes = 0;
                std::memcpy(&device, captured.data(), sizeof(device));
                std::memcpy(&n_nodes, captured.data() + sizeof(device), sizeof(n_nodes));
                event.node_count = n_nodes;
                const size_t nodes_end = sizeof(uint32_t) * 2 + static_cast<size_t>(n_nodes) * sizeof(uint64_t);
                if (captured.size() >= nodes_end + sizeof(uint32_t)) {
                    uint32_t n_tensors = 0;
                    std::memcpy(&n_tensors, captured.data() + nodes_end, sizeof(n_tensors));
                    event.graph_tensor_count = n_tensors;
                    const uint64_t expected = nodes_end + sizeof(uint32_t) +
                        static_cast<uint64_t>(n_tensors) * sizeof(RpcTensorWire);
                    if (expected != payload_size) {
                        event.note = "graph metadata truncated";
                    }
                }
            }
            record_event(std::move(event));
            mark_busy_window(captured_request_id, captured_offset_ms,
                             req_start, write_end, request_wire_bytes);
        } else {
            RpcWireEvent event;
            event.kind = RpcEventKind::Operation;
            event.worker_id = proxy->worker_id;
            event.request_id = captured_request_id;
            event.op = command_name(cmd);
            event.cmd = cmd;
            event.offset_ms = captured_offset_ms;
            event.duration_ms = upload_ms;
            event.upload_ms = upload_ms;
            event.request_wire_bytes = request_wire_bytes;
            if (command_has_tensor(cmd)) {
                event.tensor = parse_tensor(captured.data(), captured.size(), 0);
            }
            record_event(std::move(event));
        }

        in_flight_frame.store(false);
        pending_cv.notify_all();
        write_lock.unlock();
    }

    in_flight_frame.store(false);
    pending_cv.notify_all();
}

void ConnectionState::response_loop() {
    while (running.load()) {
        uint64_t payload_size = 0;
        if (!recv_all(worker_sock, &payload_size, sizeof(payload_size))) {
            break;
        }
        if (payload_size > kMaxFrameSize) {
            break;
        }
        const auto response_first_byte = clock_type::now();

        std::shared_ptr<PendingResponse> front;
        {
            std::lock_guard<std::mutex> lock(pending_mutex);
            if (!pending.empty()) {
                front = pending.front();
            }
        }

        // The request thread pushes a placeholder before it sends the frame. Wait
        // until it has filled in timing data before using it.
        if (front && !front->ready.load()) {
            std::unique_lock<std::mutex> lock(pending_mutex);
            pending_cv.wait_for(lock, std::chrono::seconds(5), [&]() {
                return !running.load() || front->ready.load();
            });
        }

        const bool forward = !front || front->forward;
        if (forward) {
            const uint64_t header = payload_size;
            if (!send_all(client_sock, &header, sizeof(header))) {
                break;
            }
        }

        std::vector<uint8_t> payload;
        if (payload_size <= kMaxBufferedPayload) {
            payload.resize(static_cast<size_t>(payload_size));
            if (payload_size > 0 && !recv_all(worker_sock, payload.data(), payload.size())) {
                break;
            }
            if (forward && !payload.empty() && !send_all(client_sock, payload.data(), payload.size())) {
                break;
            }
        } else {
            std::vector<uint8_t> scratch(64 * 1024);
            size_t remaining = static_cast<size_t>(payload_size);
            while (remaining > 0) {
                const size_t chunk = std::min<size_t>(remaining, scratch.size());
                if (!recv_all(worker_sock, scratch.data(), chunk)) {
                    running.store(false);
                    break;
                }
                if (forward && !send_all(client_sock, scratch.data(), chunk)) {
                    running.store(false);
                    break;
                }
                remaining -= chunk;
            }
            if (!running.load()) {
                break;
            }
        }
        const auto response_last_byte = clock_type::now();

        if (!front) {
            pending_cv.notify_all();
            continue;
        }

        {
            std::lock_guard<std::mutex> lock(pending_mutex);
            if (!pending.empty() && pending.front() == front) {
                pending.pop_front();
            }
        }

        if (!front->forward) {
            if (front->rtt_probe) {
                const double rtt_ms = ms_between(front->req_start, response_first_byte);
                rtt_us.store(static_cast<uint64_t>(std::max(0.0, rtt_ms) * 1000.0));
                rtt_probe_inflight.store(false);
                close_busy_window(response_first_byte, "closed by flush probe");

                RpcWireEvent event;
                event.kind = RpcEventKind::RttProbe;
                event.worker_id = proxy->worker_id;
                event.request_id = front->request_id;
                event.op = "RTT_PROBE";
                event.offset_ms = front->offset_ms;
                event.duration_ms = rtt_ms;
                event.remote_ms = rtt_ms;
                event.note = "round trip";
                record_event(std::move(event));
            }
            // Notify only after the probe has closed any open busy window and its
            // event has been recorded, so flush() never sees a half-finished drain.
            pending_cv.notify_all();
            continue;
        }

        if (front->hello) {
            hello_done.store(true);
            pending_cv.notify_all();
            continue;
        }

        close_busy_window(response_first_byte, "closed by next RPC response");

        RpcWireEvent event;
        event.worker_id = proxy->worker_id;
        event.request_id = front->request_id;
        event.op = front->op;
        event.cmd = front->cmd;
        event.offset_ms = front->offset_ms;
        event.duration_ms = ms_between(front->req_start, response_last_byte);
        event.upload_ms = front->upload_ms;
        event.remote_ms = ms_between(front->req_write_end, response_first_byte);
        event.download_ms = ms_between(response_first_byte, response_last_byte);
        event.request_wire_bytes = front->request_wire_bytes;
        event.response_wire_bytes = sizeof(uint64_t) + payload_size;
        event.tensor = front->tensor;
        event.node_count = front->node_count;
        event.graph_tensor_count = front->graph_tensor_count;

        switch (front->cmd) {
        case RPC_CMD_GET_TENSOR:
            event.kind = RpcEventKind::TensorRecv;
            event.tensor_bytes = payload_size;
            break;
        case RPC_CMD_SET_TENSOR_HASH:
            event.kind = RpcEventKind::TensorSend;
            event.tensor_bytes = 0;
            event.note = "hash upload (no tensor data)";
            break;
        case RPC_CMD_COPY_TENSOR:
            event.kind = RpcEventKind::TensorCopy;
            event.tensor_bytes = 0;
            event.note = "remote copy (no network tensor data)";
            break;
        default:
            event.kind = RpcEventKind::Operation;
            break;
        }
        record_event(std::move(event));
        pending_cv.notify_all();
    }

    running.store(false);
    pending_cv.notify_all();
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

struct RpcTelemetryStore::Impl {
    struct WorkerMeta {
        std::string endpoint;
        bool is_loopback = false;
        std::vector<int> layers;
    };

    struct RequestData {
        uint64_t id = 0;
        clock_type::time_point start{};
        clock_type::time_point end{};
        bool ended = false;
        bool partial = false;
        std::vector<RpcWireEvent> events;
    };

    struct ActiveContext {
        uint64_t request_id = 0;
        clock_type::time_point start{};
    };

    mutable std::mutex mutex;
    ActiveContext active;
    std::unordered_map<uint64_t, RequestData> requests;
    std::deque<uint64_t> order;
    std::unordered_map<std::string, WorkerMeta> workers;
    std::vector<std::weak_ptr<RpcTelemetryProxy>> proxies;

    static constexpr size_t kMaxRequests = 32;
    static constexpr size_t kMaxEvents = 50000;

    void prune_locked() {
        while (requests.size() > kMaxRequests && !order.empty()) {
            const uint64_t oldest = order.front();
            order.pop_front();
            requests.erase(oldest);
        }
    }

    RpcTelemetrySummary aggregate_locked(const RequestData& req) const {
        RpcTelemetrySummary summary;
        summary.available = true;
        summary.partial = req.partial;
        summary.request_id = req.id;

        std::unordered_map<std::string, RpcTelemetryWorkerSummary> by_worker;
        std::unordered_map<std::string, bool> worker_has_graph;
        std::unordered_map<std::string, bool> worker_has_busy;
        std::unordered_map<std::string, double> worker_first;
        std::unordered_map<std::string, double> worker_last;
        std::unordered_map<std::string, double> worker_rtt_last;
        std::unordered_map<std::string, uint64_t> worker_rtt_count;

        double first_offset = std::numeric_limits<double>::max();
        double last_offset = 0.0;

        for (const auto& event : req.events) {
            if (event.kind == RpcEventKind::RttProbe) {
                worker_rtt_last[event.worker_id] = event.remote_ms;
                worker_rtt_count[event.worker_id]++;
                continue;
            }

            auto& w = by_worker[event.worker_id];
            w.id = event.worker_id;
            auto meta_it = workers.find(event.worker_id);
            if (meta_it != workers.end()) {
                w.endpoint = meta_it->second.endpoint;
                w.is_loopback = meta_it->second.is_loopback;
                w.assigned_layers = meta_it->second.layers;
            }

            const double event_start = event.offset_ms >= 0.0 ? event.offset_ms : 0.0;
            const double event_end = event_start + std::max(0.0, event.duration_ms);
            first_offset = std::min(first_offset, event_start);
            last_offset = std::max(last_offset, event_end);
            auto fit = worker_first.find(event.worker_id);
            if (fit == worker_first.end() || event_start < fit->second) {
                worker_first[event.worker_id] = event_start;
            }
            auto lit = worker_last.find(event.worker_id);
            if (lit == worker_last.end() || event_end > lit->second) {
                worker_last[event.worker_id] = event_end;
            }

            w.upload_ms += event.upload_ms;
            w.download_ms += event.download_ms;
            if (event.kind == RpcEventKind::WorkerBusy) {
                w.compute_ms += event.compute_ms;
                w.worker_busy_count++;
                worker_has_busy[event.worker_id] = true;
                if (event.has_compute) {
                    w.compute_measured = true;
                } else {
                    w.partial = true;
                }
            }
            if (event.kind == RpcEventKind::GraphCompute) {
                w.graph_count++;
                worker_has_graph[event.worker_id] = true;
            }
            if (event.kind == RpcEventKind::TensorSend) {
                w.tensor_bytes_sent += event.tensor_bytes;
                w.tensor_count_sent++;
            }
            if (event.kind == RpcEventKind::TensorRecv) {
                w.tensor_bytes_received += event.tensor_bytes;
                w.tensor_count_received++;
            }
            if (event.request_wire_bytes > 0) {
                w.bytes_sent += event.request_wire_bytes;
                w.rpc_messages_sent++;
            }
            if (event.response_wire_bytes > 0) {
                w.bytes_received += event.response_wire_bytes;
                w.rpc_messages_received++;
            }
        }

        if (first_offset == std::numeric_limits<double>::max()) {
            first_offset = 0.0;
        }
        summary.wall_ms = std::max(0.0, last_offset - first_offset);
        summary.total_rpc_ms = summary.wall_ms;

        double rtt_sum = 0.0;
        uint64_t rtt_workers = 0;
        for (auto& [id, w] : by_worker) {
            auto fit = worker_first.find(id);
            auto lit = worker_last.find(id);
            if (fit != worker_first.end() && lit != worker_last.end()) {
                w.wall_ms = std::max(0.0, lit->second - fit->second);
            }
            auto rtt_it = worker_rtt_last.find(id);
            if (rtt_it != worker_rtt_last.end()) {
                w.network_rtt_ms = rtt_it->second;
                w.probe_count = worker_rtt_count[id];
                rtt_sum += rtt_it->second;
                rtt_workers++;
            }
            w.remote_ms = std::max(0.0, w.wall_ms - w.upload_ms - w.compute_ms - w.download_ms);
            if (worker_has_graph[id] && !worker_has_busy[id]) {
                w.partial = true;
            }
            summary.upload_ms += w.upload_ms;
            summary.download_ms += w.download_ms;
            summary.compute_ms += w.compute_ms;
            summary.bytes_sent += w.bytes_sent;
            summary.bytes_received += w.bytes_received;
            summary.tensor_bytes_sent += w.tensor_bytes_sent;
            summary.tensor_bytes_received += w.tensor_bytes_received;
            summary.tensor_count_sent += w.tensor_count_sent;
            summary.tensor_count_received += w.tensor_count_received;
            summary.rpc_messages_sent += w.rpc_messages_sent;
            summary.rpc_messages_received += w.rpc_messages_received;
            summary.probe_count += w.probe_count;
            summary.graph_count += w.graph_count;
            summary.worker_busy_count += w.worker_busy_count;
            summary.compute_measured = summary.compute_measured || w.compute_measured;
            summary.partial = summary.partial || w.partial;
        }
        summary.remote_ms = std::max(0.0, summary.wall_ms - summary.upload_ms -
                                            summary.compute_ms - summary.download_ms);
        summary.network_rtt_ms = rtt_workers > 0
            ? (rtt_sum / static_cast<double>(rtt_workers))
            : 0.0;

        for (auto& [id, w] : by_worker) {
            summary.workers.push_back(std::move(w));
        }
        std::sort(summary.workers.begin(), summary.workers.end(),
                  [](const RpcTelemetryWorkerSummary& a, const RpcTelemetryWorkerSummary& b) {
                      return a.wall_ms > b.wall_ms;
                  });

        if (summary.workers.empty()) {
            summary.available = false;
        }
        return summary;
    }

    json tensor_json(const RpcWireEvent& event) const {
        json t;
        t["name"] = event.tensor.name;
        t["type"] = event.tensor.type;
        t["shape"] = event.tensor.shape;
        return t;
    }

    json operation_json(const RpcWireEvent& event) const {
        json j;
        j["worker_id"] = event.worker_id;
        j["op"] = event.op;
        j["cmd"] = event.cmd;
        j["kind"] = event.kind == RpcEventKind::TensorSend ? "tensor_send" :
                    event.kind == RpcEventKind::TensorRecv ? "tensor_recv" :
                    event.kind == RpcEventKind::TensorCopy ? "tensor_copy" :
                    event.kind == RpcEventKind::GraphCompute ? "graph_compute" :
                    event.kind == RpcEventKind::WorkerBusy ? "worker_busy" :
                    event.kind == RpcEventKind::RttProbe ? "rtt_probe" : "rpc";
        j["offset_ms"] = event.offset_ms;
        j["duration_ms"] = event.duration_ms;
        j["upload_ms"] = event.upload_ms;
        j["remote_ms"] = event.remote_ms;
        j["download_ms"] = event.download_ms;
        j["compute_ms"] = event.compute_ms;
        j["has_compute"] = event.has_compute;
        j["request_bytes"] = event.request_wire_bytes;
        j["response_bytes"] = event.response_wire_bytes;
        j["tensor_bytes"] = event.tensor_bytes;
        j["node_count"] = event.node_count;
        j["graph_tensor_count"] = event.graph_tensor_count;
        j["note"] = event.note;
        if (event.tensor.valid) {
            j["tensor"] = tensor_json(event);
        }
        return j;
    }
};

RpcTelemetryStore::RpcTelemetryStore() : impl_(std::make_unique<Impl>()) {}
RpcTelemetryStore::~RpcTelemetryStore() = default;

RpcTelemetryStore& RpcTelemetryStore::instance() {
    static RpcTelemetryStore store;
    return store;
}

void RpcTelemetryStore::begin_request(uint64_t request_id) {
    std::vector<std::shared_ptr<RpcTelemetryProxy>> proxies_copy;
    {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        Impl::RequestData data;
        data.id = request_id;
        data.start = clock_type::now();
        impl_->requests[request_id] = std::move(data);
        impl_->order.push_back(request_id);
        impl_->active.request_id = request_id;
        impl_->active.start = clock_type::now();
        impl_->prune_locked();

        for (auto it = impl_->proxies.begin(); it != impl_->proxies.end();) {
            if (auto proxy = it->lock()) {
                proxies_copy.push_back(proxy);
                ++it;
            } else {
                it = impl_->proxies.erase(it);
            }
        }
    }
    for (const auto& proxy : proxies_copy) {
        proxy->measure_rtt(request_id);
    }
}

void RpcTelemetryStore::end_request(uint64_t request_id) {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    auto it = impl_->requests.find(request_id);
    if (it != impl_->requests.end()) {
        it->second.end = clock_type::now();
        it->second.ended = true;
    }
    if (impl_->active.request_id == request_id) {
        impl_->active.request_id = 0;
        impl_->active.start = {};
    }
}

bool RpcTelemetryStore::is_request_active(uint64_t request_id) const {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    return impl_->active.request_id == request_id && request_id != 0;
}

uint64_t RpcTelemetryStore::active_request() const {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    return impl_->active.request_id;
}

double RpcTelemetryStore::active_offset_ms() const {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (impl_->active.request_id == 0) {
        return -1.0;
    }
    return ms_between(impl_->active.start, clock_type::now());
}

void RpcTelemetryStore::register_worker(const std::string& id, const std::string& endpoint,
                                        bool is_loopback) {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    auto& meta = impl_->workers[id];
    meta.endpoint = endpoint;
    meta.is_loopback = is_loopback;
}

void RpcTelemetryStore::update_worker_layers(const std::string& id,
                                             const std::vector<int>& layers) {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    impl_->workers[id].layers = layers;
}

void RpcTelemetryStore::record_event(const RpcWireEvent& event) {
    if (event.request_id == 0) {
        return;
    }
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (impl_->active.request_id != event.request_id) {
        return;
    }
    auto it = impl_->requests.find(event.request_id);
    if (it == impl_->requests.end() || it->second.ended) {
        return;
    }
    if (it->second.events.size() >= Impl::kMaxEvents) {
        it->second.partial = true;
        return;
    }
    RpcWireEvent copy = event;
    if (copy.offset_ms < 0.0) {
        copy.offset_ms = ms_between(it->second.start, clock_type::now());
    }
    it->second.events.push_back(std::move(copy));
}

void RpcTelemetryStore::register_proxy(const std::shared_ptr<RpcTelemetryProxy>& proxy) {
    if (!proxy) return;
    std::lock_guard<std::mutex> lock(impl_->mutex);
    impl_->proxies.erase(std::remove_if(impl_->proxies.begin(), impl_->proxies.end(),
        [](const std::weak_ptr<RpcTelemetryProxy>& weak) { return weak.expired(); }),
        impl_->proxies.end());
    impl_->proxies.push_back(proxy);
}

void RpcTelemetryStore::unregister_proxy(const std::string& worker_id) {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    impl_->proxies.erase(std::remove_if(impl_->proxies.begin(), impl_->proxies.end(),
        [&](const std::weak_ptr<RpcTelemetryProxy>& weak) {
            auto proxy = weak.lock();
            return !proxy || proxy->worker_id() == worker_id;
        }), impl_->proxies.end());
}

void RpcTelemetryStore::flush(uint64_t request_id, int timeout_ms) {
    std::vector<std::shared_ptr<RpcTelemetryProxy>> proxies_copy;
    {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        std::unordered_set<std::string> used_workers;
        auto req_it = impl_->requests.find(request_id);
        if (req_it != impl_->requests.end()) {
            for (const auto& event : req_it->second.events) {
                if (event.kind != RpcEventKind::RttProbe && !event.worker_id.empty()) {
                    used_workers.insert(event.worker_id);
                }
            }
        }
        if (used_workers.empty()) {
            return;
        }
        for (auto it = impl_->proxies.begin(); it != impl_->proxies.end();) {
            if (auto proxy = it->lock()) {
                if (used_workers.count(proxy->worker_id())) {
                    proxies_copy.push_back(proxy);
                }
                ++it;
            } else {
                it = impl_->proxies.erase(it);
            }
        }
    }

    bool all_ok = true;
    for (const auto& proxy : proxies_copy) {
        if (!proxy->flush(request_id, timeout_ms)) {
            all_ok = false;
        }
    }

    if (!all_ok) {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        auto it = impl_->requests.find(request_id);
        if (it != impl_->requests.end()) {
            it->second.partial = true;
        }
    }
}

RpcTelemetrySummary RpcTelemetryStore::build_summary(uint64_t request_id) const {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    auto it = impl_->requests.find(request_id);
    if (it == impl_->requests.end()) {
        return {};
    }
    return impl_->aggregate_locked(it->second);
}

bool RpcTelemetryStore::has_request(uint64_t request_id) const {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    return impl_->requests.find(request_id) != impl_->requests.end();
}

std::string RpcTelemetryStore::build_detail_json(uint64_t request_id) const {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    auto it = impl_->requests.find(request_id);
    if (it == impl_->requests.end()) {
        json out;
        out["available"] = false;
        out["request_id"] = request_id;
        out["error"] = "request telemetry not found";
        return out.dump();
    }

    const auto& req = it->second;
    const RpcTelemetrySummary summary = impl_->aggregate_locked(req);

    json out;
    out["available"] = summary.available;
    out["request_id"] = request_id;
    out["partial"] = summary.partial;
    out["summary"] = json{
        {"wall_ms", summary.wall_ms},
        {"upload_ms", summary.upload_ms},
        {"remote_ms", summary.remote_ms},
        {"compute_ms", summary.compute_ms},
        {"download_ms", summary.download_ms},
        {"network_rtt_ms", summary.network_rtt_ms},
        {"total_rpc_ms", summary.total_rpc_ms},
        {"bytes_sent", summary.bytes_sent},
        {"bytes_received", summary.bytes_received},
        {"tensor_bytes_sent", summary.tensor_bytes_sent},
        {"tensor_bytes_received", summary.tensor_bytes_received},
        {"tensor_count_sent", summary.tensor_count_sent},
        {"tensor_count_received", summary.tensor_count_received},
        {"rpc_messages_sent", summary.rpc_messages_sent},
        {"rpc_messages_received", summary.rpc_messages_received},
        {"probe_count", summary.probe_count},
        {"graph_count", summary.graph_count},
        {"worker_busy_count", summary.worker_busy_count},
        {"compute_measured", summary.compute_measured},
    };

    json workers = json::array();
    for (const auto& w : summary.workers) {
        workers.push_back(json{
            {"id", w.id},
            {"endpoint", w.endpoint},
            {"is_loopback", w.is_loopback},
            {"assigned_layers", w.assigned_layers},
            {"wall_ms", w.wall_ms},
            {"upload_ms", w.upload_ms},
            {"remote_ms", w.remote_ms},
            {"compute_ms", w.compute_ms},
            {"download_ms", w.download_ms},
            {"network_rtt_ms", w.network_rtt_ms},
            {"bytes_sent", w.bytes_sent},
            {"bytes_received", w.bytes_received},
            {"tensor_bytes_sent", w.tensor_bytes_sent},
            {"tensor_bytes_received", w.tensor_bytes_received},
            {"tensor_count_sent", w.tensor_count_sent},
            {"tensor_count_received", w.tensor_count_received},
            {"rpc_messages_sent", w.rpc_messages_sent},
            {"rpc_messages_received", w.rpc_messages_received},
            {"probe_count", w.probe_count},
            {"graph_count", w.graph_count},
            {"worker_busy_count", w.worker_busy_count},
            {"compute_measured", w.compute_measured},
            {"partial", w.partial},
        });
    }
    out["workers"] = std::move(workers);

    json tensors = json::array();
    json operations = json::array();
    json worker_busy = json::array();
    for (const auto& event : req.events) {
        if (event.kind == RpcEventKind::RttProbe) {
            continue;
        }
        if (event.kind == RpcEventKind::TensorSend || event.kind == RpcEventKind::TensorRecv ||
            event.kind == RpcEventKind::TensorCopy) {
            json t = impl_->operation_json(event);
            t["direction"] = event.kind == RpcEventKind::TensorRecv ? "receive" :
                             event.kind == RpcEventKind::TensorCopy ? "copy" : "send";
            tensors.push_back(std::move(t));
        }
        if (event.kind == RpcEventKind::WorkerBusy) {
            worker_busy.push_back(impl_->operation_json(event));
        } else {
            operations.push_back(impl_->operation_json(event));
        }
    }
    out["tensors"] = std::move(tensors);
    out["operations"] = std::move(operations);
    out["worker_busy"] = std::move(worker_busy);
    out["started_at_ms"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        req.start.time_since_epoch()).count();
    out["ended_at_ms"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        (req.ended ? req.end : clock_type::now()).time_since_epoch()).count();
    return out.dump();
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

struct RpcTelemetryProxy::Impl {
    std::shared_ptr<ProxyState> state;
};

RpcTelemetryProxy::RpcTelemetryProxy(std::string worker_id, std::string worker_label,
                                     std::string host, uint16_t port)
    : impl_(std::make_unique<Impl>()) {
    impl_->state = std::make_shared<ProxyState>();
    impl_->state->worker_id = std::move(worker_id);
    impl_->state->worker_label = std::move(worker_label);
    impl_->state->host = std::move(host);
    impl_->state->port = port;
    impl_->state->remote_endpoint = impl_->state->host + ":" + std::to_string(port);
}

RpcTelemetryProxy::~RpcTelemetryProxy() {
    const std::string id = worker_id();
    stop();
    RpcTelemetryStore::instance().unregister_proxy(id);
}

bool RpcTelemetryProxy::start() {
    if (impl_->state->running.load()) {
        return true;
    }
    uint16_t port = 0;
    socket_handle listener = create_loopback_listener(port);
    if (!socket_valid(listener)) {
        log_warn("[RPC Telemetry] Could not create local proxy listener for worker '" +
                 impl_->state->worker_id + "'");
        return false;
    }
    impl_->state->listener = listener;
    impl_->state->local_port = port;
    impl_->state->running.store(true);

    auto state = impl_->state;
    impl_->state->accept_thread = std::thread([state]() {
        while (state->running.load()) {
            sockaddr_in addr{};
#ifdef _WIN32
            int addr_len = sizeof(addr);
#else
            socklen_t addr_len = sizeof(addr);
#endif
            socket_handle client = accept(state->listener,
                                          reinterpret_cast<sockaddr*>(&addr), &addr_len);
            if (!socket_valid(client)) {
                break;
            }
            std::thread(handle_client, state, client).detach();
        }
    });

    log_info("[RPC Telemetry] Measuring worker '" + impl_->state->worker_id +
             "' (" + impl_->state->remote_endpoint + ") through 127.0.0.1:" +
             std::to_string(port));
    return true;
}

void RpcTelemetryProxy::stop() {
    if (!impl_ || !impl_->state) {
        return;
    }
    auto state = impl_->state;
    if (!state->running.exchange(false)) {
        return;
    }
    if (socket_valid(state->listener)) {
        shutdown_socket(state->listener);
        close_socket(state->listener);
        state->listener = kInvalidSocket;
    }
    if (state->accept_thread.joinable()) {
        state->accept_thread.join();
    }
    for (const auto& conn : state->snapshot()) {
        conn->running.store(false);
        conn->notify_pending();
        shutdown_socket(conn->client_sock);
        shutdown_socket(conn->worker_sock);
    }
}

bool RpcTelemetryProxy::started() const {
    return impl_ && impl_->state && impl_->state->running.load();
}

std::string RpcTelemetryProxy::local_endpoint() const {
    if (!impl_ || !impl_->state) {
        return {};
    }
    return "127.0.0.1:" + std::to_string(impl_->state->local_port);
}

uint16_t RpcTelemetryProxy::local_port() const {
    return impl_ && impl_->state ? impl_->state->local_port : 0;
}

const std::string& RpcTelemetryProxy::worker_id() const {
    static const std::string empty;
    return impl_ && impl_->state ? impl_->state->worker_id : empty;
}

const std::string& RpcTelemetryProxy::worker_label() const {
    static const std::string empty;
    return impl_ && impl_->state ? impl_->state->worker_label : empty;
}

const std::string& RpcTelemetryProxy::remote_endpoint() const {
    static const std::string empty;
    return impl_ && impl_->state ? impl_->state->remote_endpoint : empty;
}

void RpcTelemetryProxy::measure_rtt(uint64_t request_id) {
    if (!impl_ || !impl_->state) {
        return;
    }
    for (const auto& conn : impl_->state->snapshot()) {
        if (conn && conn->running.load()) {
            conn->measure_rtt(request_id);
        }
    }
}

bool RpcTelemetryProxy::flush(uint64_t request_id, int timeout_ms) {
    if (!impl_ || !impl_->state) {
        return true;
    }
    const auto connections = impl_->state->snapshot();
    if (connections.empty()) {
        return true;
    }
    bool all_ok = true;
    for (const auto& conn : connections) {
        if (conn && conn->running.load()) {
            if (!conn->flush(request_id, timeout_ms)) {
                all_ok = false;
            }
        }
    }
    return all_ok;
}

double RpcTelemetryProxy::last_rtt_ms() const {
    if (!impl_ || !impl_->state) {
        return 0.0;
    }
    uint64_t rtt = 0;
    for (const auto& conn : impl_->state->snapshot()) {
        if (conn) {
            rtt = std::max(rtt, conn->rtt_us.load());
        }
    }
    return static_cast<double>(rtt) / 1000.0;
}

} // namespace swarm
