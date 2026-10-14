#ifndef SWARM_PLACEMENT_H
#define SWARM_PLACEMENT_H

#include <string>
#include <vector>
#include <map>
#include <set>
#include <utility>
#include <mutex>
#include <sstream>
#include <fstream>
#include <cmath>
#include <algorithm>
#include <iostream>
#include <optional>
#include <iomanip>

#include "json.hpp"
#include "worker.h"

using json = nlohmann::json;

// Details for a single backend placement
struct BackendPlacement {
    std::string backend_id;             // "RPC0", "RPC1", "CUDA0", "CPU"
    std::string device_name;            // "RPC0", "RPC1", "CUDA0", "CPU"
    std::string description;            // e.g., "127.0.0.1:50052", "NVIDIA GeForce GTX 1050", etc.
    std::string endpoint;               // "127.0.0.1:50052" or ""
    std::string backend_type;           // "loopback_rpc", "remote_rpc", "local_cuda", "cpu"
    bool is_loopback = false;           // true if loopback address
    std::string memory_scope;           // "shared_host", "device_vram", "remote_host:<ip>"
    std::vector<int> assigned_layers;   // Sorted layer indices
    std::vector<std::pair<int, int>> assigned_layer_ranges; // Ranges [start, end]
    size_t model_buffer_bytes = 0;      // Model weights buffer
    size_t kv_buffer_bytes = 0;         // KV cache buffer
    size_t compute_buffer_bytes = 0;    // Compute / scratch buffer
    size_t memory_total_bytes = 0;      // Advertised total memory
    size_t memory_free_bytes = 0;       // Advertised free memory
    std::string measurement_status = "unavailable"; // "observed", "unavailable"
    bool log_derived = false;           // true if populated via loader logs

    // Policy & simulation metadata
    uint64_t virtual_budget_bytes = 0;  // Virtual budget if configured
    int capped_capacity = -1;           // Policy capped capacity
    float split_weight = 0.0f;          // Policy tensor_split weight
    std::vector<int> predicted_layers;  // Layers predicted by policy
    std::optional<bool> policy_match;   // true if observed assigned_layers == predicted_layers

    json to_json() const {
        json j;
        j["backend_id"] = backend_id;
        j["device_name"] = device_name;
        j["description"] = description;
        j["endpoint"] = endpoint;
        j["backend_type"] = backend_type;
        j["is_loopback"] = is_loopback;
        j["memory_scope"] = memory_scope;
        j["assigned_layers"] = assigned_layers;
        
        json ranges_json = json::array();
        for (const auto& r : assigned_layer_ranges) {
            ranges_json.push_back({r.first, r.second});
        }
        j["assigned_layer_ranges"] = ranges_json;
        
        j["model_buffer_bytes"] = model_buffer_bytes;
        j["kv_buffer_bytes"] = kv_buffer_bytes;
        j["compute_buffer_bytes"] = compute_buffer_bytes;
        j["memory_total_bytes"] = memory_total_bytes;
        j["memory_free_bytes"] = memory_free_bytes;
        j["measurement_status"] = measurement_status;
        j["log_derived"] = log_derived;

        if (virtual_budget_bytes > 0 || capped_capacity >= 0 || !predicted_layers.empty()) {
            j["virtual_budget_bytes"] = virtual_budget_bytes;
            j["capped_capacity"] = capped_capacity;
            j["split_weight"] = split_weight;
            j["predicted_layers"] = predicted_layers;
            if (policy_match.has_value()) {
                j["policy_match"] = policy_match.value();
            }
        }
        return j;
    }
};

class PlacementTracker {
public:
    PlacementTracker() = default;

    // Helper: checks if an IP is loopback
    static bool is_loopback_address(const std::string& host) {
        return (host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "0.0.0.0");
    }

    // Register a backend known before model loading
    void register_backend(const std::string& backend_id,
                          const std::string& device_name,
                          const std::string& description,
                          const std::string& endpoint,
                          const std::string& backend_type,
                          bool is_loopback,
                          const std::string& memory_scope,
                          size_t memory_total_bytes,
                          size_t memory_free_bytes) {
        std::lock_guard<std::mutex> lock(mutex_);
        BackendPlacement bp;
        bp.backend_id = backend_id;
        bp.device_name = device_name;
        bp.description = description;
        bp.endpoint = endpoint;
        bp.backend_type = backend_type;
        bp.is_loopback = is_loopback;
        bp.memory_scope = memory_scope;
        bp.memory_total_bytes = memory_total_bytes;
        bp.memory_free_bytes = memory_free_bytes;
        bp.measurement_status = "unavailable";
        backends_[backend_id] = bp;
    }

    // Feed a chunk of log text (handles partial lines)
    void feed_log_text(const char* text) {
        if (!text) return;
        std::lock_guard<std::mutex> lock(mutex_);
        for (const char* p = text; *p; ++p) {
            if (*p == '\n' || *p == '\r') {
                if (!line_buffer_.empty()) {
                    parse_line_locked(line_buffer_);
                    line_buffer_.clear();
                }
            } else {
                line_buffer_.push_back(*p);
            }
        }
    }

    // Parse a standalone log line
    void parse_line(const std::string& line) {
        std::lock_guard<std::mutex> lock(mutex_);
        parse_line_locked(line);
    }

    // Finalize placement calculations (compute ranges, statuses)
    void finalize() {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!line_buffer_.empty()) {
            parse_line_locked(line_buffer_);
            line_buffer_.clear();
        }
        for (auto& [id, bp] : backends_) {
            // Sort assigned layers
            std::sort(bp.assigned_layers.begin(), bp.assigned_layers.end());
            // Deduplicate if needed
            bp.assigned_layers.erase(
                std::unique(bp.assigned_layers.begin(), bp.assigned_layers.end()),
                bp.assigned_layers.end()
            );

            // Compute contiguous ranges
            bp.assigned_layer_ranges.clear();
            if (!bp.assigned_layers.empty()) {
                int start = bp.assigned_layers[0];
                int prev = start;
                for (size_t i = 1; i < bp.assigned_layers.size(); ++i) {
                    if (bp.assigned_layers[i] == prev + 1) {
                        prev = bp.assigned_layers[i];
                    } else {
                        bp.assigned_layer_ranges.push_back({start, prev});
                        start = bp.assigned_layers[i];
                        prev = start;
                    }
                }
                bp.assigned_layer_ranges.push_back({start, prev});
            }

            if (bp.log_derived || bp.model_buffer_bytes > 0 || !bp.assigned_layers.empty()) {
                bp.measurement_status = "observed";
            }

            if (!bp.predicted_layers.empty() || bp.capped_capacity >= 0) {
                bp.policy_match = (bp.assigned_layers == bp.predicted_layers);
            }
        }
    }

    // Synchronize placement info back into WorkerManager
    void sync_to_workers(WorkerManager& wm) {
        std::lock_guard<std::mutex> lock(mutex_);
        for (auto& worker : wm.get_workers()) {
            std::string worker_endpoint = worker.host + ":" + std::to_string(worker.port);
            BackendPlacement* matched = nullptr;

            // Find matching backend by endpoint or ID
            for (auto& [id, bp] : backends_) {
                if (!bp.endpoint.empty() && bp.endpoint == worker_endpoint) {
                    matched = &bp;
                    break;
                }
            }
            if (!matched) {
                for (auto& [id, bp] : backends_) {
                    if (bp.backend_id == worker.id || bp.description == worker.host) {
                        matched = &bp;
                        break;
                    }
                }
            }

            if (matched) {
                worker.device_name = matched->device_name;
                worker.backend_id = matched->backend_id;
                worker.backend_type = matched->backend_type;
                worker.is_loopback = matched->is_loopback;
                worker.memory_scope = matched->memory_scope;
                worker.assigned_layers = matched->assigned_layers;
                worker.assigned_layer_ranges = matched->assigned_layer_ranges;
                worker.model_buffer_bytes = matched->model_buffer_bytes;
                worker.kv_buffer_bytes = matched->kv_buffer_bytes;
                worker.compute_buffer_bytes = matched->compute_buffer_bytes;
                worker.measurement_status = matched->measurement_status;
                worker.log_derived = matched->log_derived;
                if (matched->memory_total_bytes > 0) {
                    worker.memory_total_bytes = matched->memory_total_bytes;
                }
                if (matched->memory_free_bytes > 0) {
                    worker.memory_free_bytes = matched->memory_free_bytes;
                }
            }
        }
    }

    // Get all registered placements
    std::vector<BackendPlacement> get_all_backends() const {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<BackendPlacement> result;
        for (const auto& [id, bp] : backends_) {
            result.push_back(bp);
        }
        return result;
    }

    // Find backend placement by ID
    std::optional<BackendPlacement> get_backend(const std::string& id) const {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = backends_.find(id);
        if (it != backends_.end()) {
            return it->second;
        }
        return std::nullopt;
    }

    // Parse full log file
    bool parse_log_file(const std::string& filepath) {
        std::ifstream file(filepath);
        if (!file.is_open()) return false;
        std::string line;
        while (std::getline(file, line)) {
            parse_line(line);
        }
        finalize();
        return true;
    }

    // JSON representation of overall placement and memory accounting
    json to_json(size_t host_ram_total = 0, size_t host_ram_avail = 0) const {
        std::lock_guard<std::mutex> lock(mutex_);
        json j;
        j["backends"] = json::array();

        size_t total_model_bytes = 0;
        size_t total_kv_bytes = 0;
        size_t total_compute_bytes = 0;
        bool has_loopback = false;

        for (const auto& [id, bp] : backends_) {
            j["backends"].push_back(bp.to_json());
            total_model_bytes += bp.model_buffer_bytes;
            total_kv_bytes += bp.kv_buffer_bytes;
            total_compute_bytes += bp.compute_buffer_bytes;
            if (bp.is_loopback) {
                has_loopback = true;
            }
        }

        j["placement_policy"] = policy_name_;
        j["policy_evaluated"] = policy_evaluated_;

        j["memory_accounting"] = {
            {"total_model_buffer_bytes", total_model_bytes},
            {"total_kv_buffer_bytes", total_kv_bytes},
            {"total_compute_buffer_bytes", total_compute_bytes},
            {"total_allocated_buffers_bytes", total_model_bytes + total_kv_bytes + total_compute_bytes},
            {"host_ram_total_bytes", host_ram_total},
            {"host_ram_available_bytes", host_ram_avail},
            {"shared_host_memory_deduplicated", has_loopback},
            {"note", has_loopback ? "Loopback RPC endpoints share physical host RAM; reported capacities are not additive." : "Unique hosts reported."}
        };

        return j;
    }

    void record_policy_plan(const std::string& dev_id, uint64_t budget, int cap, float weight, const std::vector<int>& pred) {
        std::lock_guard<std::mutex> lock(mutex_);
        policy_evaluated_ = true;
        for (auto& [id, bp] : backends_) {
            if (bp.endpoint == dev_id || bp.backend_id == dev_id ||
                (dev_id == "local-cuda-0" && bp.backend_id == "CUDA0") ||
                (dev_id == "CUDA0" && bp.backend_id == "CUDA0")) {
                bp.virtual_budget_bytes = budget;
                bp.capped_capacity = cap;
                bp.split_weight = weight;
                bp.predicted_layers = pred;
                break;
            }
        }
    }

    void set_policy_name(const std::string& name) {
        std::lock_guard<std::mutex> lock(mutex_);
        policy_name_ = name;
    }

private:
    mutable std::mutex mutex_;
    std::string line_buffer_;
    std::map<std::string, BackendPlacement> backends_;
    std::string policy_name_ = "none";
    bool policy_evaluated_ = false;

    // Find backend by matching buffer name:
    // e.g. "RPC0[127.0.0.1:50052]", "CUDA0", "CPU_Mapped", "CPU"
    BackendPlacement* find_backend_for_buffer(const std::string& buf_name) {
        // 1. Check if bracket contains endpoint: RPC0[127.0.0.1:50052]
        size_t open_b = buf_name.find('[');
        size_t close_b = buf_name.find(']');
        if (open_b != std::string::npos && close_b != std::string::npos && close_b > open_b) {
            std::string ep = buf_name.substr(open_b + 1, close_b - open_b - 1);
            for (auto& [id, bp] : backends_) {
                if (bp.endpoint == ep) {
                    return &bp;
                }
            }
        }

        // 2. Exact match on backend_id or device_name
        for (auto& [id, bp] : backends_) {
            if (id == buf_name || bp.device_name == buf_name) {
                return &bp;
            }
        }

        // 3. CUDA prefix match
        if (buf_name.find("CUDA") != std::string::npos) {
            for (auto& [id, bp] : backends_) {
                if (bp.backend_type == "local_cuda" || id.find("CUDA") != std::string::npos) {
                    return &bp;
                }
            }
        }

        // 4. CPU match
        if (buf_name.find("CPU") != std::string::npos) {
            for (auto& [id, bp] : backends_) {
                if (bp.backend_type == "cpu" || id == "CPU") {
                    return &bp;
                }
            }
        }

        return nullptr;
    }

    void parse_line_locked(const std::string& line) {
        // Pattern 1: Layer assignment
        // "load_tensors: layer  33 assigned to device RPC0, is_swa = 0"
        size_t pos = line.find("assigned to device ");
        if (pos != std::string::npos && line.find("load_tensors: layer") != std::string::npos) {
            size_t layer_pos = line.find("layer");
            if (layer_pos != std::string::npos) {
                const char* start_num = line.c_str() + layer_pos + 5;
                char* end_num = nullptr;
                long layer_idx = strtol(start_num, &end_num, 10);
                if (end_num != start_num) {
                    std::string after_dev = line.substr(pos + 19);
                    size_t comma_pos = after_dev.find(',');
                    std::string dev_name = (comma_pos != std::string::npos)
                        ? after_dev.substr(0, comma_pos)
                        : after_dev;
                    while (!dev_name.empty() && isspace(dev_name.front())) dev_name.erase(dev_name.begin());
                    while (!dev_name.empty() && isspace(dev_name.back())) dev_name.pop_back();

                    if (!dev_name.empty()) {
                        auto it = backends_.find(dev_name);
                        if (it == backends_.end()) {
                            BackendPlacement bp;
                            bp.backend_id = dev_name;
                            bp.device_name = dev_name;
                            bp.backend_type = (dev_name.find("RPC") != std::string::npos) ? "remote_rpc" :
                                              (dev_name.find("CUDA") != std::string::npos) ? "local_cuda" : "cpu";
                            backends_[dev_name] = bp;
                        }
                        backends_[dev_name].assigned_layers.push_back(static_cast<int>(layer_idx));
                        backends_[dev_name].log_derived = true;
                    }
                }
            }
            return;
        }

        // Pattern 2: Model buffer size
        // "load_tensors: RPC0[127.0.0.1:50052] model buffer size =    47.04 MiB"
        // "load_tensors:        CUDA0 model buffer size =   290.48 MiB"
        pos = line.find("model buffer size =");
        if (pos != std::string::npos && line.find("load_tensors:") != std::string::npos) {
            size_t colon_pos = line.find(':');
            std::string buf_str = line.substr(colon_pos + 1, pos - colon_pos - 1);
            while (!buf_str.empty() && isspace(buf_str.front())) buf_str.erase(buf_str.begin());
            while (!buf_str.empty() && isspace(buf_str.back())) buf_str.pop_back();

            const char* size_start = line.c_str() + pos + 19;
            char* size_end = nullptr;
            double mib = strtod(size_start, &size_end);
            if (size_end != size_start) {
                size_t bytes = static_cast<size_t>(std::llround(mib * 1024.0 * 1024.0));
                BackendPlacement* bp = find_backend_for_buffer(buf_str);
                if (bp) {
                    bp->model_buffer_bytes = bytes;
                    bp->log_derived = true;
                }
            }
            return;
        }

        // Pattern 3: KV buffer size
        // "llama_kv_cache: RPC0[127.0.0.1:50052] KV buffer size =     2.00 MiB"
        pos = line.find("KV buffer size =");
        if (pos != std::string::npos && line.find("llama_kv_cache:") != std::string::npos) {
            size_t colon_pos = line.find(':');
            std::string buf_str = line.substr(colon_pos + 1, pos - colon_pos - 1);
            while (!buf_str.empty() && isspace(buf_str.front())) buf_str.erase(buf_str.begin());
            while (!buf_str.empty() && isspace(buf_str.back())) buf_str.pop_back();

            const char* size_start = line.c_str() + pos + 16;
            char* size_end = nullptr;
            double mib = strtod(size_start, &size_end);
            if (size_end != size_start) {
                size_t bytes = static_cast<size_t>(std::llround(mib * 1024.0 * 1024.0));
                BackendPlacement* bp = find_backend_for_buffer(buf_str);
                if (bp) {
                    bp->kv_buffer_bytes = bytes;
                    bp->log_derived = true;
                }
            }
            return;
        }

        // Pattern 4: Compute buffer size
        // "sched_reserve: RPC0[127.0.0.1:50052] compute buffer size =    72.50 MiB"
        pos = line.find("compute buffer size =");
        if (pos != std::string::npos && line.find("sched_reserve:") != std::string::npos) {
            size_t colon_pos = line.find(':');
            std::string buf_str = line.substr(colon_pos + 1, pos - colon_pos - 1);
            while (!buf_str.empty() && isspace(buf_str.front())) buf_str.erase(buf_str.begin());
            while (!buf_str.empty() && isspace(buf_str.back())) buf_str.pop_back();

            const char* size_start = line.c_str() + pos + 21;
            char* size_end = nullptr;
            double mib = strtod(size_start, &size_end);
            if (size_end != size_start) {
                size_t bytes = static_cast<size_t>(std::llround(mib * 1024.0 * 1024.0));
                BackendPlacement* bp = find_backend_for_buffer(buf_str);
                if (bp) {
                    bp->compute_buffer_bytes = bytes;
                    bp->log_derived = true;
                }
            }
            return;
        }
    }
};

#endif // SWARM_PLACEMENT_H
