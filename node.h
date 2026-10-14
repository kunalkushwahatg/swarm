#ifndef SWARM_NODE_H
#define SWARM_NODE_H

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <string>
#include <vector>
#include <map>
#include <optional>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <algorithm>
#include <sstream>
#include <fstream>
#include <iomanip>

#include "json.hpp"
#include "worker.h"
#include "placement.h"
#include "policy.h"
#include "agent.h"

using json = nlohmann::json;

namespace swarm {

// Provenance of a resource measurement
enum class ResourceProvenance {
    MEASURED,           // Directly queried from hardware / OS / GGML runtime
    CONFIGURED_BUDGET,  // Manually specified in configuration / policy profile
    SIMULATED,          // Sourced from an offline synthetic test fixture
    UNKNOWN             // Not measurable or not available
};

inline std::string provenance_to_string(ResourceProvenance prov) {
    switch (prov) {
        case ResourceProvenance::MEASURED: return "measured";
        case ResourceProvenance::CONFIGURED_BUDGET: return "configured_budget";
        case ResourceProvenance::SIMULATED: return "simulated";
        case ResourceProvenance::UNKNOWN: default: return "unknown";
    }
}

inline ResourceProvenance string_to_provenance(const std::string& str) {
    if (str == "measured") return ResourceProvenance::MEASURED;
    if (str == "configured_budget") return ResourceProvenance::CONFIGURED_BUDGET;
    if (str == "simulated") return ResourceProvenance::SIMULATED;
    return ResourceProvenance::UNKNOWN;
}

// Wrapper for a resource value tracking its origin and freshness
template <typename T>
struct ResourceValue {
    std::optional<T> value;
    ResourceProvenance provenance = ResourceProvenance::UNKNOWN;
    std::string source = "unmeasured";
    uint64_t observed_at_ms = 0;

    static ResourceValue<T> measured(T val, const std::string& src, uint64_t now_ms) {
        ResourceValue<T> r;
        r.value = val;
        r.provenance = ResourceProvenance::MEASURED;
        r.source = src;
        r.observed_at_ms = now_ms;
        return r;
    }

    static ResourceValue<T> configured(T val, const std::string& src, uint64_t now_ms) {
        ResourceValue<T> r;
        r.value = val;
        r.provenance = ResourceProvenance::CONFIGURED_BUDGET;
        r.source = src;
        r.observed_at_ms = now_ms;
        return r;
    }

    static ResourceValue<T> simulated(T val, const std::string& src, uint64_t now_ms) {
        ResourceValue<T> r;
        r.value = val;
        r.provenance = ResourceProvenance::SIMULATED;
        r.source = src;
        r.observed_at_ms = now_ms;
        return r;
    }

    static ResourceValue<T> unknown(const std::string& reason = "unmeasured") {
        ResourceValue<T> r;
        r.value = std::nullopt;
        r.provenance = ResourceProvenance::UNKNOWN;
        r.source = reason;
        r.observed_at_ms = 0;
        return r;
    }

    json to_json() const {
        json j;
        if (value.has_value()) {
            j["value"] = value.value();
        } else {
            j["value"] = nullptr;
        }
        j["provenance"] = provenance_to_string(provenance);
        j["source"] = source;
        j["observed_at_ms"] = observed_at_ms;
        return j;
    }
};

// Represents a backend compute/memory device on a node
struct DeviceCapability {
    std::string device_id;              // e.g. "CUDA0", "CPU", "RPC0"
    std::string device_name;            // e.g. "NVIDIA GeForce GTX 1050", "Intel Core i5..."
    std::string device_type;            // "CPU", "GPU"
    ResourceValue<uint64_t> memory_total_bytes;
    ResourceValue<uint64_t> memory_free_bytes;

    json to_json() const {
        json j;
        j["device_id"] = device_id;
        j["device_name"] = device_name;
        j["device_type"] = device_type;
        j["memory_total_bytes"] = memory_total_bytes.to_json();
        j["memory_free_bytes"] = memory_free_bytes.to_json();
        return j;
    }
};

// Detailed representation of an individual distributed node
struct NodeRecord {
    std::string node_id;                // Stable unique node ID
    std::string endpoint;               // "local" or "127.0.0.1:50052"
    std::string host;                   // "127.0.0.1"
    uint16_t port = 0;                  // Port (0 for local host)
    bool is_loopback = true;            // Whether node is collocated on loopback
    std::string node_role;              // "gateway", "worker"
    std::string connection_state = "UNKNOWN"; // "ONLINE", "OFFLINE", "READY", "BUSY", "UNAVAILABLE", "FAILED"
    bool is_ready_for_inference = false;// Whether node is currently ready to participate in compute

    std::vector<DeviceCapability> devices;

    // Node-level memory measurements
    ResourceValue<uint64_t> ram_total_bytes;
    ResourceValue<uint64_t> ram_free_bytes;
    ResourceValue<uint64_t> vram_total_bytes;
    ResourceValue<uint64_t> vram_free_bytes;

    // Policy budget
    ResourceValue<uint64_t> placement_budget_bytes;

    // Model placement status
    std::vector<int> assigned_layers;
    std::vector<std::pair<int, int>> assigned_layer_ranges;
    bool is_required_by_model = false;  // true if assigned_layers > 0 or model_buffer > 0
    uint64_t model_buffer_bytes = 0;
    uint64_t kv_buffer_bytes = 0;
    uint64_t compute_buffer_bytes = 0;

    // Worker agent metadata (Milestone 8 & 9)
    bool agent_reported = false;
    std::string agent_version = "none";
    uint64_t last_agent_report_ms = 0;  // Remote timestamp reported by agent
    uint64_t last_receipt_time_ms = 0;  // Local monotonic/receipt time on coordinator
    std::string agent_session_id;       // Agent session ID for replay protection
    uint64_t last_sequence_number = 0;  // Monotonically increasing report sequence number
    int64_t clock_skew_ms = 0;          // Coordinator receipt time minus worker reported timestamp
    std::string cpu_architecture = "unknown";
    int cpu_processor_count = 0;
    std::string cpu_model_name = "unknown";
    std::vector<std::string> unsupported_metrics;
    bool is_stale = false;
    std::string stale_reason;

    uint64_t last_observed_ms = 0;      // Timestamp of last successful observation
    bool is_simulated = false;          // Explicitly marks test fixtures
    std::vector<std::string> validation_errors; // Validation issues if any

    json to_json() const {
        json j;
        j["node_id"] = node_id;
        j["endpoint"] = endpoint;
        j["host"] = host;
        j["port"] = port;
        j["is_loopback"] = is_loopback;
        j["node_role"] = node_role;
        j["connection_state"] = connection_state;
        j["is_ready_for_inference"] = is_ready_for_inference;

        json dev_arr = json::array();
        for (const auto& dev : devices) {
            dev_arr.push_back(dev.to_json());
        }
        j["devices"] = dev_arr;

        j["ram_total_bytes"] = ram_total_bytes.to_json();
        j["ram_free_bytes"] = ram_free_bytes.to_json();
        j["vram_total_bytes"] = vram_total_bytes.to_json();
        j["vram_free_bytes"] = vram_free_bytes.to_json();
        j["placement_budget_bytes"] = placement_budget_bytes.to_json();

        j["assigned_layers"] = assigned_layers;
        json ranges_arr = json::array();
        for (const auto& r : assigned_layer_ranges) {
            ranges_arr.push_back({r.first, r.second});
        }
        j["assigned_layer_ranges"] = ranges_arr;

        j["is_required_by_model"] = is_required_by_model;
        j["model_buffer_bytes"] = model_buffer_bytes;
        j["kv_buffer_bytes"] = kv_buffer_bytes;
        j["compute_buffer_bytes"] = compute_buffer_bytes;

        // Worker reporting agent fields (Milestone 8 & 9)
        j["agent_reported"] = agent_reported;
        j["agent_version"] = agent_version;
        j["last_agent_report_ms"] = last_agent_report_ms;
        j["last_receipt_time_ms"] = last_receipt_time_ms;
        j["agent_session_id"] = agent_session_id;
        j["last_sequence_number"] = last_sequence_number;
        j["clock_skew_ms"] = clock_skew_ms;
        j["cpu_info"] = {
            {"architecture", cpu_architecture},
            {"processor_count", cpu_processor_count},
            {"model_name", cpu_model_name}
        };
        j["unsupported_metrics"] = unsupported_metrics;
        j["is_stale"] = is_stale;
        if (is_stale && !stale_reason.empty()) {
            j["stale_reason"] = stale_reason;
        }

        j["last_observed_ms"] = last_observed_ms;
        j["is_simulated"] = is_simulated;
        j["validation_errors"] = validation_errors;
        return j;
    }
};

class NodeInventory {
public:
    NodeInventory() = default;

    // Validate a node record for internal consistency and format correctness
    static std::vector<std::string> validate_node(const NodeRecord& node) {
        std::vector<std::string> errors;
        if (node.node_id.empty()) {
            errors.push_back("node_id cannot be empty");
        }
        if (node.endpoint.empty()) {
            errors.push_back("endpoint cannot be empty");
        }
        if (node.endpoint != "local") {
            size_t colon = node.endpoint.find(':');
            if (colon == std::string::npos || colon == 0 || colon == node.endpoint.length() - 1) {
                errors.push_back("Invalid remote endpoint format, expected host:port");
            }
        }

        // Check memory value bounds
        if (node.ram_total_bytes.value.has_value() && node.ram_free_bytes.value.has_value()) {
            if (node.ram_free_bytes.value.value() > node.ram_total_bytes.value.value()) {
                errors.push_back("ram_free_bytes exceeds ram_total_bytes");
            }
        }
        if (node.vram_total_bytes.value.has_value() && node.vram_free_bytes.value.has_value()) {
            if (node.vram_free_bytes.value.value() > node.vram_total_bytes.value.value()) {
                errors.push_back("vram_free_bytes exceeds vram_total_bytes");
            }
        }

        // Connection state validity
        if (node.connection_state != "ONLINE" && node.connection_state != "OFFLINE" &&
            node.connection_state != "READY" && node.connection_state != "BUSY" &&
            node.connection_state != "STOPPED" && node.connection_state != "STARTING" &&
            node.connection_state != "UNAVAILABLE" && node.connection_state != "FAILED" &&
            node.connection_state != "STOPPING") {
            errors.push_back("Unknown connection_state: " + node.connection_state);
        }

        return errors;
    }

    // Check if node measurements are stale given a maximum allowable age
    // Freshness is calculated strictly from elapsed time on coordinator monotonic clock
    static bool is_stale(const NodeRecord& node, uint64_t max_age_ms, uint64_t current_time_ms) {
        if (node.agent_reported) {
            if (node.last_receipt_time_ms == 0) return true;
            if (current_time_ms <= node.last_receipt_time_ms) return false;
            return (current_time_ms - node.last_receipt_time_ms) > max_age_ms;
        }
        if (node.last_observed_ms == 0) return true;
        if (current_time_ms <= node.last_observed_ms) return false;
        return (current_time_ms - node.last_observed_ms) > max_age_ms;
    }

    // Add or update a node record in the inventory
    void upsert_node(const NodeRecord& node) {
        std::lock_guard<std::mutex> lock(mutex_);
        nodes_[node.node_id] = node;
    }

    // Retrieve a node by ID
    std::optional<NodeRecord> get_node(const std::string& node_id) const {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = nodes_.find(node_id);
        if (it != nodes_.end()) {
            return it->second;
        }
        return std::nullopt;
    }

    // Get all nodes
    std::vector<NodeRecord> get_all_nodes() const {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<NodeRecord> result;
        result.reserve(nodes_.size());
        for (const auto& [_, n] : nodes_) {
            result.push_back(n);
        }
        return result;
    }

    // Clear all inventory records
    void clear() {
        std::lock_guard<std::mutex> lock(mutex_);
        nodes_.clear();
    }

    // Ingest a report from a worker reporting agent (string overload)
    bool ingest_agent_report(const std::string& report_raw, uint64_t now_ms, std::string& err_msg, bool is_live_stream = true) {
        try {
            auto j = json::parse(report_raw);
            return ingest_agent_report(j, now_ms, err_msg, is_live_stream);
        } catch (const std::exception& e) {
            err_msg = std::string("Malformed JSON payload: ") + e.what();
            return false;
        }
    }

    // Ingest a report from a worker reporting agent (Milestone 8 & 9)
    bool ingest_agent_report(const json& report_json, uint64_t now_ms, std::string& err_msg, bool is_live_stream = true) {
        auto report_opt = NodeReport::from_json(report_json, err_msg);
        if (!report_opt.has_value()) {
            return false;
        }
        const auto& report = report_opt.value();

        std::lock_guard<std::mutex> lock(mutex_);

        // Find matching node by node_id, endpoint, or host:port
        NodeRecord* target_node = nullptr;
        for (auto& [id, n] : nodes_) {
            if (n.node_id == report.node_id || n.endpoint == report.endpoint) {
                target_node = &n;
                break;
            }
            if (report.rpc_port > 0 && n.port == report.rpc_port &&
                (n.host == report.hostname || (!n.host.empty() && report.endpoint.find(n.host) != std::string::npos))) {
                target_node = &n;
                break;
            }
        }

        // Replay Protection Policy
        if (target_node) {
            // Case 1: Session-based sequence tracking
            if (!report.agent_session_id.empty() && report.agent_session_id == target_node->agent_session_id) {
                if (report.sequence_number <= target_node->last_sequence_number) {
                    err_msg = "Replayed report rejected: sequence_number " + std::to_string(report.sequence_number) +
                              " <= last_sequence_number " + std::to_string(target_node->last_sequence_number);
                    return false;
                }
            } else if (report.sequence_number == 0) {
                // Case 2: Unsequenced/legacy report replay check using remote timestamp
                if (target_node->last_agent_report_ms > 0 && report.timestamp_ms <= target_node->last_agent_report_ms) {
                    err_msg = "Replayed report rejected: timestamp_ms " + std::to_string(report.timestamp_ms) +
                              " <= last_agent_report_ms " + std::to_string(target_node->last_agent_report_ms);
                    return false;
                }
            }
        }

        // Monotonic receipt time handling:
        // In live ingestion, receipt time is coordinator's clock (now_ms).
        // In offline file ingestion (is_live_stream = false), receipt time mirrors recorded timestamp.
        uint64_t receipt_time = is_live_stream ? now_ms : report.timestamp_ms;
        bool stale = (now_ms > receipt_time) && ((now_ms - receipt_time) > 30000);
        int64_t clock_skew = static_cast<int64_t>(now_ms) - static_cast<int64_t>(report.timestamp_ms);

        if (target_node) {
            target_node->agent_reported = true;
            target_node->agent_version = report.agent_version;
            target_node->agent_session_id = report.agent_session_id;
            target_node->last_sequence_number = report.sequence_number;
            target_node->last_agent_report_ms = report.timestamp_ms;
            target_node->last_receipt_time_ms = receipt_time;
            target_node->last_observed_ms = now_ms;
            target_node->clock_skew_ms = clock_skew;
            target_node->is_stale = stale;
            target_node->stale_reason = stale ? "Report timestamp exceeded 30000ms TTL" : "";
            target_node->cpu_architecture = report.cpu.architecture;
            target_node->cpu_processor_count = report.cpu.processor_count;
            target_node->cpu_model_name = report.cpu.model_name;
            target_node->unsupported_metrics = report.unsupported_metrics;

            // Ingest measured physical RAM from agent
            target_node->ram_total_bytes = ResourceValue<uint64_t>::measured(
                report.ram.total_bytes, "agent_GlobalMemoryStatusEx", receipt_time);
            target_node->ram_free_bytes = ResourceValue<uint64_t>::measured(
                report.ram.available_bytes, "agent_GlobalMemoryStatusEx", receipt_time);

            // Ingest measured GPU VRAM if reported
            if (report.gpu.detected && report.gpu.vram_total_bytes > 0) {
                target_node->vram_total_bytes = ResourceValue<uint64_t>::measured(
                    report.gpu.vram_total_bytes, "agent_dxgi_adapter", receipt_time);
                if (report.gpu.vram_free_bytes.has_value()) {
                    target_node->vram_free_bytes = ResourceValue<uint64_t>::measured(
                        report.gpu.vram_free_bytes.value(), "agent_dxgi_adapter", receipt_time);
                }
            }

            // If node was marked UNAVAILABLE, restore to report status if fresh
            if (!stale && (target_node->connection_state == "UNAVAILABLE" || target_node->connection_state == "OFFLINE")) {
                target_node->connection_state = report.status;
                target_node->is_ready_for_inference = true;
            }
        } else {
            // Register as newly discovered worker node
            NodeRecord new_node;
            new_node.node_id = report.node_id;
            new_node.endpoint = report.endpoint;
            new_node.host = report.hostname;
            new_node.port = report.rpc_port;
            new_node.is_loopback = (report.endpoint.find("127.0.0.1") != std::string::npos ||
                                    report.endpoint.find("localhost") != std::string::npos);
            new_node.node_role = "worker";
            new_node.connection_state = report.status;
            new_node.is_ready_for_inference = !stale; // not ready if stale
            new_node.is_required_by_model = false;
            new_node.agent_reported = true;
            new_node.agent_version = report.agent_version;
            new_node.agent_session_id = report.agent_session_id;
            new_node.last_sequence_number = report.sequence_number;
            new_node.last_agent_report_ms = report.timestamp_ms;
            new_node.last_receipt_time_ms = receipt_time;
            new_node.last_observed_ms = now_ms;
            new_node.clock_skew_ms = clock_skew;
            new_node.is_stale = stale;
            new_node.stale_reason = stale ? "Report timestamp exceeded 30000ms TTL" : "";
            new_node.cpu_architecture = report.cpu.architecture;
            new_node.cpu_processor_count = report.cpu.processor_count;
            new_node.cpu_model_name = report.cpu.model_name;
            new_node.unsupported_metrics = report.unsupported_metrics;

            new_node.ram_total_bytes = ResourceValue<uint64_t>::measured(
                report.ram.total_bytes, "agent_GlobalMemoryStatusEx", receipt_time);
            new_node.ram_free_bytes = ResourceValue<uint64_t>::measured(
                report.ram.available_bytes, "agent_GlobalMemoryStatusEx", receipt_time);

            if (report.gpu.detected && report.gpu.vram_total_bytes > 0) {
                new_node.vram_total_bytes = ResourceValue<uint64_t>::measured(
                    report.gpu.vram_total_bytes, "agent_dxgi_adapter", receipt_time);
                if (report.gpu.vram_free_bytes.has_value()) {
                    new_node.vram_free_bytes = ResourceValue<uint64_t>::measured(
                        report.gpu.vram_free_bytes.value(), "agent_dxgi_adapter", receipt_time);
                } else {
                    new_node.vram_free_bytes = ResourceValue<uint64_t>::unknown("dxgi_vram_free_unsupported");
                }
            } else {
                new_node.vram_total_bytes = ResourceValue<uint64_t>::unknown("no_gpu_detected");
                new_node.vram_free_bytes = ResourceValue<uint64_t>::unknown("no_gpu_detected");
            }
            new_node.placement_budget_bytes = ResourceValue<uint64_t>::unknown("no_budget_configured");

            new_node.validation_errors = validate_node(new_node);
            nodes_[new_node.node_id] = new_node;
        }

        return true;
    }

    // Build a live snapshot directly from active Swarm components
    void update_from_live_state(const WorkerManager& worker_mgr,
                                const PlacementTracker& placement_trk,
                                const std::string& policy_name,
                                uint64_t now_ms,
                                size_t host_ram_total,
                                size_t host_ram_avail) {
        std::lock_guard<std::mutex> lock(mutex_);

        // Cache existing agent-reported records to preserve reports across refreshes
        std::map<std::string, NodeRecord> existing_agent_data;
        for (const auto& [id, n] : nodes_) {
            if (n.agent_reported) {
                existing_agent_data[id] = n;
                existing_agent_data[n.endpoint] = n;
            }
        }

        nodes_.clear();

        // 1. Gateway Node (local host, local CUDA if present, local CPU)
        NodeRecord gateway;
        gateway.node_id = "node-gateway-local";
        gateway.endpoint = "local";
        gateway.host = "127.0.0.1";
        gateway.port = 0;
        gateway.is_loopback = true;
        gateway.node_role = "gateway";
        gateway.connection_state = "ONLINE";
        gateway.is_ready_for_inference = true;
        gateway.last_observed_ms = now_ms;
        gateway.is_simulated = false;

        if (host_ram_total > 0) {
            gateway.ram_total_bytes = ResourceValue<uint64_t>::measured(host_ram_total, "win32_GlobalMemoryStatusEx", now_ms);
            gateway.ram_free_bytes = ResourceValue<uint64_t>::measured(host_ram_avail, "win32_GlobalMemoryStatusEx", now_ms);
        } else {
            gateway.ram_total_bytes = ResourceValue<uint64_t>::unknown("win32_mem_unqueried");
            gateway.ram_free_bytes = ResourceValue<uint64_t>::unknown("win32_mem_unqueried");
        }

        // Add local CUDA device if known to placement tracker
        auto cuda_opt = placement_trk.get_backend("CUDA0");
        if (cuda_opt.has_value()) {
            const auto& c = cuda_opt.value();
            DeviceCapability cuda_dev;
            cuda_dev.device_id = "CUDA0";
            cuda_dev.device_name = c.description;
            cuda_dev.device_type = "GPU";
            if (c.memory_total_bytes > 0) {
                cuda_dev.memory_total_bytes = ResourceValue<uint64_t>::measured(c.memory_total_bytes, "ggml_cuda_props", now_ms);
                cuda_dev.memory_free_bytes = ResourceValue<uint64_t>::measured(c.memory_free_bytes, "ggml_cuda_props", now_ms);
                gateway.vram_total_bytes = cuda_dev.memory_total_bytes;
                gateway.vram_free_bytes = cuda_dev.memory_free_bytes;
            } else {
                cuda_dev.memory_total_bytes = ResourceValue<uint64_t>::unknown("cuda_props_unavailable");
                cuda_dev.memory_free_bytes = ResourceValue<uint64_t>::unknown("cuda_props_unavailable");
                gateway.vram_total_bytes = cuda_dev.memory_total_bytes;
                gateway.vram_free_bytes = cuda_dev.memory_free_bytes;
            }
            gateway.devices.push_back(cuda_dev);

            gateway.assigned_layers = c.assigned_layers;
            gateway.assigned_layer_ranges = c.assigned_layer_ranges;
            gateway.model_buffer_bytes = c.model_buffer_bytes;
            gateway.kv_buffer_bytes = c.kv_buffer_bytes;
            gateway.compute_buffer_bytes = c.compute_buffer_bytes;
            gateway.is_required_by_model = (!c.assigned_layers.empty() || c.model_buffer_bytes > 0);
            if (c.virtual_budget_bytes > 0) {
                gateway.placement_budget_bytes = ResourceValue<uint64_t>::configured(c.virtual_budget_bytes, "env_SWARM_WORKER_PROFILES", now_ms);
            } else {
                gateway.placement_budget_bytes = ResourceValue<uint64_t>::unknown("no_profile_configured");
            }
        } else {
            gateway.vram_total_bytes = ResourceValue<uint64_t>::unknown("no_cuda_device");
            gateway.vram_free_bytes = ResourceValue<uint64_t>::unknown("no_cuda_device");
            gateway.placement_budget_bytes = ResourceValue<uint64_t>::unknown("no_profile_configured");
        }

        // Add local CPU device
        auto cpu_opt = placement_trk.get_backend("CPU");
        if (cpu_opt.has_value()) {
            const auto& cpu = cpu_opt.value();
            DeviceCapability cpu_dev;
            cpu_dev.device_id = "CPU";
            cpu_dev.device_name = cpu.device_name;
            cpu_dev.device_type = "CPU";
            cpu_dev.memory_total_bytes = gateway.ram_total_bytes;
            cpu_dev.memory_free_bytes = gateway.ram_free_bytes;
            gateway.devices.push_back(cpu_dev);

            if (gateway.assigned_layers.empty()) {
                gateway.assigned_layers = cpu.assigned_layers;
                gateway.assigned_layer_ranges = cpu.assigned_layer_ranges;
            }
            gateway.model_buffer_bytes += cpu.model_buffer_bytes;
            gateway.kv_buffer_bytes += cpu.kv_buffer_bytes;
            gateway.compute_buffer_bytes += cpu.compute_buffer_bytes;
        }

        gateway.validation_errors = validate_node(gateway);
        nodes_[gateway.node_id] = gateway;

        // 2. Remote / Loopback RPC Nodes
        for (const auto& worker : worker_mgr.get_workers()) {
            if (worker.type != WorkerType::REMOTE_RPC && worker.type != WorkerType::LOCAL_RPC) {
                continue;
            }

            NodeRecord node;
            node.node_id = "node-" + worker.host + "-" + std::to_string(worker.port);
            node.endpoint = worker.host + ":" + std::to_string(worker.port);
            node.host = worker.host;
            node.port = worker.port;
            node.is_loopback = worker.is_loopback;
            node.node_role = "worker";
            node.connection_state = worker_state_to_string(worker.state);
            node.is_ready_for_inference = (worker.state == WorkerState::READY || worker.state == WorkerState::BUSY);
            node.last_observed_ms = (worker.last_health_check.time_since_epoch().count() > 0)
                ? std::chrono::duration_cast<std::chrono::milliseconds>(worker.last_health_check.time_since_epoch()).count()
                : now_ms;
            node.is_simulated = false;

            // Merge previously ingested agent information if available
            auto agent_it = existing_agent_data.find(node.node_id);
            if (agent_it == existing_agent_data.end()) {
                agent_it = existing_agent_data.find(node.endpoint);
            }
            if (agent_it != existing_agent_data.end()) {
                const auto& prev = agent_it->second;
                node.agent_reported = true;
                node.agent_version = prev.agent_version;
                node.last_agent_report_ms = prev.last_agent_report_ms;
                node.last_receipt_time_ms = prev.last_receipt_time_ms;
                node.agent_session_id = prev.agent_session_id;
                node.last_sequence_number = prev.last_sequence_number;
                node.clock_skew_ms = prev.clock_skew_ms;
                node.cpu_architecture = prev.cpu_architecture;
                node.cpu_processor_count = prev.cpu_processor_count;
                node.cpu_model_name = prev.cpu_model_name;
                node.unsupported_metrics = prev.unsupported_metrics;
                if (prev.ram_total_bytes.provenance == ResourceProvenance::MEASURED) {
                    node.ram_total_bytes = prev.ram_total_bytes;
                    node.ram_free_bytes = prev.ram_free_bytes;
                }
                if (prev.vram_total_bytes.provenance == ResourceProvenance::MEASURED) {
                    node.vram_total_bytes = prev.vram_total_bytes;
                    node.vram_free_bytes = prev.vram_free_bytes;
                }
            }

            // Device properties from GGML
            DeviceCapability dev;
            dev.device_id = worker.backend_id.value_or(worker.id);
            dev.device_name = worker.device_name.value_or("RPC Worker Device");
            dev.device_type = worker.device_type.has_value() ?
                (worker.device_type.value() == GGML_BACKEND_DEVICE_TYPE_GPU ? "GPU" : "CPU") : "CPU";

            if (worker.memory_total_bytes.has_value()) {
                dev.memory_total_bytes = ResourceValue<uint64_t>::measured(worker.memory_total_bytes.value(), "ggml_rpc_device_props", now_ms);
                dev.memory_free_bytes = ResourceValue<uint64_t>::measured(worker.memory_free_bytes.value_or(0), "ggml_rpc_device_props", now_ms);
            } else {
                dev.memory_total_bytes = ResourceValue<uint64_t>::unknown("rpc_props_unqueried");
                dev.memory_free_bytes = ResourceValue<uint64_t>::unknown("rpc_props_unqueried");
            }
            node.devices.push_back(dev);

            // Node RAM & VRAM (if not already populated from agent)
            if (!node.agent_reported || node.ram_total_bytes.provenance != ResourceProvenance::MEASURED) {
                if (dev.device_type == "GPU") {
                    node.vram_total_bytes = dev.memory_total_bytes;
                    node.vram_free_bytes = dev.memory_free_bytes;
                    node.ram_total_bytes = ResourceValue<uint64_t>::unknown("host_ram_unreported_by_gpu_rpc");
                    node.ram_free_bytes = ResourceValue<uint64_t>::unknown("host_ram_unreported_by_gpu_rpc");
                } else {
                    node.ram_total_bytes = dev.memory_total_bytes;
                    node.ram_free_bytes = dev.memory_free_bytes;
                    node.vram_total_bytes = ResourceValue<uint64_t>::unknown("no_gpu_device");
                    node.vram_free_bytes = ResourceValue<uint64_t>::unknown("no_gpu_device");
                }
            }

            // Placement & assigned layers
            node.assigned_layers = worker.assigned_layers;
            node.assigned_layer_ranges = worker.assigned_layer_ranges;
            node.model_buffer_bytes = worker.model_buffer_bytes.value_or(0);
            node.kv_buffer_bytes = worker.kv_buffer_bytes.value_or(0);
            node.compute_buffer_bytes = worker.compute_buffer_bytes.value_or(0);
            node.is_required_by_model = (!worker.assigned_layers.empty() || node.model_buffer_bytes > 0);

            // Policy budget from placement tracker
            auto bp_opt = placement_trk.get_backend(worker.id);
            if (!bp_opt.has_value()) {
                bp_opt = placement_trk.get_backend(worker.backend_id.value_or(""));
            }
            if (bp_opt.has_value() && bp_opt.value().virtual_budget_bytes > 0) {
                node.placement_budget_bytes = ResourceValue<uint64_t>::configured(
                    bp_opt.value().virtual_budget_bytes, "env_SWARM_WORKER_PROFILES", now_ms);
            } else {
                node.placement_budget_bytes = ResourceValue<uint64_t>::unknown("no_budget_configured");
            }

            node.validation_errors = validate_node(node);
            nodes_[node.node_id] = node;
        }

        // Restore any standalone agent-reported nodes not tracked by worker_manager
        for (const auto& [id, prev_node] : existing_agent_data) {
            if (nodes_.find(prev_node.node_id) == nodes_.end()) {
                nodes_[prev_node.node_id] = prev_node;
            }
        }
    }

    // Load simulated fixture for offline heterogeneous testing
    static NodeRecord create_simulated_fixture(const std::string& node_id,
                                               const std::string& endpoint,
                                               const std::string& host,
                                               uint16_t port,
                                               bool is_loopback,
                                               const std::string& role,
                                               const std::string& connection_state,
                                               std::optional<uint64_t> ram_total,
                                               std::optional<uint64_t> ram_free,
                                               std::optional<uint64_t> vram_total,
                                               std::optional<uint64_t> vram_free,
                                               std::optional<uint64_t> budget,
                                               const std::vector<int>& assigned_layers,
                                               uint64_t model_buffer,
                                               uint64_t observed_at_ms) {
        NodeRecord n;
        n.node_id = node_id;
        n.endpoint = endpoint;
        n.host = host;
        n.port = port;
        n.is_loopback = is_loopback;
        n.node_role = role;
        n.connection_state = connection_state;
        n.is_ready_for_inference = (connection_state == "ONLINE");
        n.last_observed_ms = observed_at_ms;
        n.is_simulated = true;

        if (ram_total.has_value()) {
            n.ram_total_bytes = ResourceValue<uint64_t>::simulated(ram_total.value(), "simulation_fixture", observed_at_ms);
            n.ram_free_bytes = ResourceValue<uint64_t>::simulated(ram_free.value_or(0), "simulation_fixture", observed_at_ms);
        } else {
            n.ram_total_bytes = ResourceValue<uint64_t>::unknown("simulated_unmeasured");
            n.ram_free_bytes = ResourceValue<uint64_t>::unknown("simulated_unmeasured");
        }

        if (vram_total.has_value()) {
            n.vram_total_bytes = ResourceValue<uint64_t>::simulated(vram_total.value(), "simulation_fixture", observed_at_ms);
            n.vram_free_bytes = ResourceValue<uint64_t>::simulated(vram_free.value_or(0), "simulation_fixture", observed_at_ms);
        } else {
            n.vram_total_bytes = ResourceValue<uint64_t>::unknown("simulated_no_gpu");
            n.vram_free_bytes = ResourceValue<uint64_t>::unknown("simulated_no_gpu");
        }

        if (budget.has_value()) {
            n.placement_budget_bytes = ResourceValue<uint64_t>::configured(budget.value(), "simulated_config", observed_at_ms);
        } else {
            n.placement_budget_bytes = ResourceValue<uint64_t>::unknown("simulated_no_budget");
        }

        n.assigned_layers = assigned_layers;
        n.model_buffer_bytes = model_buffer;
        n.is_required_by_model = (!assigned_layers.empty() || model_buffer > 0);

        n.validation_errors = validate_node(n);
        return n;
    }

    // Lookup node by id, endpoint, or host:port
    std::optional<NodeRecord> find_node(const std::string& query, uint64_t current_time_ms = 0) const {
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& [id, orig_node] : nodes_) {
            if (id == query || orig_node.endpoint == query ||
                (orig_node.host + ":" + std::to_string(orig_node.port)) == query) {
                NodeRecord n = orig_node;
                if (current_time_ms > 0) {
                    n.is_stale = is_stale(n, 30000, current_time_ms);
                }
                return n;
            }
        }
        return std::nullopt;
    }

    // Ingest telemetry reports from a file containing single report or array of reports
    bool ingest_report_file(const std::string& filepath, uint64_t now_ms, std::string& error) {
        std::ifstream f(filepath);
        if (!f.is_open()) {
            error = "Could not open report file: " + filepath;
            return false;
        }
        std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        try {
            auto j = json::parse(content);
            if (j.is_array()) {
                for (const auto& item : j) {
                    if (!ingest_agent_report(item, now_ms, error, false)) {
                        return false;
                    }
                }
                return true;
            } else {
                return ingest_agent_report(j, now_ms, error, false);
            }
        } catch (const std::exception& e) {
            error = std::string("JSON parse error in report file: ") + e.what();
            return false;
        }
    }

    // Produce structured JSON response for /nodes endpoint
    json to_json(uint64_t current_time_ms = 0) const {
        std::lock_guard<std::mutex> lock(mutex_);
        json j;

        int total_nodes = 0;
        int online_nodes = 0;
        int ready_nodes = 0;
        int required_nodes = 0;
        int unrequired_nodes = 0;
        int loopback_nodes = 0;
        int remote_nodes = 0;
        int agent_reported_nodes = 0;
        int stale_nodes = 0;
        uint64_t total_model_bytes = 0;
        uint64_t total_kv_bytes = 0;
        uint64_t total_compute_bytes = 0;

        uint64_t host_ram_sample = 0;

        json nodes_arr = json::array();
        for (const auto& [_, orig_node] : nodes_) {
            NodeRecord node = orig_node;
            total_nodes++;

            if (node.agent_reported) {
                agent_reported_nodes++;
            }

            // Freshness & Staleness evaluation
            if (current_time_ms > 0) {
                bool stale = is_stale(node, 30000, current_time_ms); // 30s threshold
                node.is_stale = stale;
                if (stale) {
                    stale_nodes++;
                    node.stale_reason = "Observation exceeded 30s freshness threshold";
                    if (node.agent_reported) {
                        node.connection_state = "UNAVAILABLE";
                        node.is_ready_for_inference = false;
                    }
                }
            }

            if (node.connection_state == "ONLINE" || node.connection_state == "READY" || node.connection_state == "BUSY") {
                online_nodes++;
            }
            if (node.is_ready_for_inference) ready_nodes++;
            if (node.is_required_by_model) required_nodes++;
            else unrequired_nodes++;

            if (node.is_loopback) {
                loopback_nodes++;
                if (node.ram_total_bytes.value.has_value() && host_ram_sample == 0) {
                    host_ram_sample = node.ram_total_bytes.value.value();
                }
            } else {
                remote_nodes++;
            }

            total_model_bytes += node.model_buffer_bytes;
            total_kv_bytes += node.kv_buffer_bytes;
            total_compute_bytes += node.compute_buffer_bytes;

            nodes_arr.push_back(node.to_json());
        }

        j["cluster_summary"] = {
            {"total_nodes", total_nodes},
            {"online_nodes", online_nodes},
            {"ready_nodes", ready_nodes},
            {"required_nodes", required_nodes},
            {"unrequired_nodes", unrequired_nodes},
            {"loopback_nodes", loopback_nodes},
            {"remote_nodes", remote_nodes},
            {"agent_reported_nodes", agent_reported_nodes},
            {"stale_nodes", stale_nodes},
            {"memory_accounting", {
                {"host_ram_deduplicated", true},
                {"note", "Loopback workers share the single host machine RAM; reported host memories are not summed additively."},
                {"independent_host_ram_bytes", host_ram_sample},
                {"total_model_buffer_bytes", total_model_bytes},
                {"total_kv_buffer_bytes", total_kv_bytes},
                {"total_compute_buffer_bytes", total_compute_bytes}
            }}
        };

        j["nodes"] = nodes_arr;
        return j;
    }

private:
    mutable std::mutex mutex_;
    std::map<std::string, NodeRecord> nodes_;
};

} // namespace swarm

#endif // SWARM_NODE_H
