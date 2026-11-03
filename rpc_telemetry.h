#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace swarm {

enum class RpcEventKind {
    Operation,
    TensorSend,
    TensorRecv,
    TensorCopy,
    GraphCompute,
    WorkerBusy,
    RttProbe,
};

struct RpcTensorInfo {
    bool valid = false;
    std::string name;
    std::string type;
    std::vector<int64_t> shape;
};

struct RpcWireEvent {
    RpcEventKind kind = RpcEventKind::Operation;
    std::string worker_id;
    uint64_t request_id = 0;
    std::string op;
    int cmd = -1;
    double offset_ms = 0.0;
    double duration_ms = 0.0;
    double upload_ms = 0.0;
    double remote_ms = 0.0;
    double download_ms = 0.0;
    double compute_ms = 0.0;
    bool has_compute = false;
    uint64_t request_wire_bytes = 0;
    uint64_t response_wire_bytes = 0;
    uint64_t tensor_bytes = 0;
    RpcTensorInfo tensor;
    uint32_t node_count = 0;
    uint32_t graph_tensor_count = 0;
    std::string note;
};

struct RpcTelemetryWorkerSummary {
    std::string id;
    std::string endpoint;
    bool is_loopback = false;
    std::vector<int> assigned_layers;
    double wall_ms = 0.0;
    double upload_ms = 0.0;
    double remote_ms = 0.0;
    double compute_ms = 0.0;
    double download_ms = 0.0;
    double network_rtt_ms = 0.0;
    uint64_t bytes_sent = 0;
    uint64_t bytes_received = 0;
    uint64_t tensor_bytes_sent = 0;
    uint64_t tensor_bytes_received = 0;
    uint64_t tensor_count_sent = 0;
    uint64_t tensor_count_received = 0;
    uint64_t rpc_messages_sent = 0;
    uint64_t rpc_messages_received = 0;
    uint64_t probe_count = 0;
    uint64_t graph_count = 0;
    uint64_t worker_busy_count = 0;
    bool compute_measured = false;
    bool partial = false;
};

struct RpcTelemetrySummary {
    bool available = false;
    bool partial = false;
    uint64_t request_id = 0;
    double wall_ms = 0.0;
    double upload_ms = 0.0;
    double remote_ms = 0.0;
    double compute_ms = 0.0;
    double download_ms = 0.0;
    double network_rtt_ms = 0.0;
    double total_rpc_ms = 0.0;
    uint64_t bytes_sent = 0;
    uint64_t bytes_received = 0;
    uint64_t tensor_bytes_sent = 0;
    uint64_t tensor_bytes_received = 0;
    uint64_t tensor_count_sent = 0;
    uint64_t tensor_count_received = 0;
    uint64_t rpc_messages_sent = 0;
    uint64_t rpc_messages_received = 0;
    uint64_t probe_count = 0;
    uint64_t graph_count = 0;
    uint64_t worker_busy_count = 0;
    bool compute_measured = false;
    std::vector<RpcTelemetryWorkerSummary> workers;
};

class RpcTelemetryProxy;

class RpcTelemetryStore {
public:
    static RpcTelemetryStore& instance();

    void begin_request(uint64_t request_id);
    void end_request(uint64_t request_id);
    bool is_request_active(uint64_t request_id) const;
    uint64_t active_request() const;
    double active_offset_ms() const;

    void register_worker(const std::string& id, const std::string& endpoint, bool is_loopback);
    void update_worker_layers(const std::string& id, const std::vector<int>& layers);

    void record_event(const RpcWireEvent& event);
    void flush(uint64_t request_id, int timeout_ms);
    RpcTelemetrySummary build_summary(uint64_t request_id) const;
    std::string build_detail_json(uint64_t request_id) const;
    bool has_request(uint64_t request_id) const;

    void register_proxy(const std::shared_ptr<RpcTelemetryProxy>& proxy);
    void unregister_proxy(const std::string& worker_id);

private:
    RpcTelemetryStore();
    ~RpcTelemetryStore();
    RpcTelemetryStore(const RpcTelemetryStore&) = delete;
    RpcTelemetryStore& operator=(const RpcTelemetryStore&) = delete;

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

class RpcTelemetryProxy {
public:
    RpcTelemetryProxy(
        std::string worker_id,
        std::string worker_label,
        std::string host,
        uint16_t port
    );
    ~RpcTelemetryProxy();

    bool start();
    void stop();
    bool started() const;
    std::string local_endpoint() const;
    uint16_t local_port() const;
    const std::string& worker_id() const;
    const std::string& worker_label() const;
    const std::string& remote_endpoint() const;

    void measure_rtt(uint64_t request_id);
    bool flush(uint64_t request_id, int timeout_ms);
    double last_rtt_ms() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace swarm
