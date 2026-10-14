#pragma once

#include <string>
#include <vector>
#include <unordered_map>
#include <map>
#include <cstdint>
#include <algorithm>
#include <cmath>
#include <sstream>
#include <iostream>
#include <iomanip>
#include <optional>

namespace swarm {

// Telemetry information for an individual backend candidate
struct BackendTelemetryInfo {
    std::string primary_id;      // e.g. "127.0.0.1:50052" or "local-cuda-0"
    std::string secondary_id;    // e.g. "RPC0" or "CUDA0"
    std::string device_name;     // Hardware adapter name
    std::string backend_type;    // "cuda", "loopback_rpc", "remote_rpc", "cpu"
    bool is_loopback = false;
    std::string memory_scope;    // "shared_host", "device_vram", "remote_host:..."

    // GGML backend properties queried during backend registration
    uint64_t ggml_memory_total = 0;
    uint64_t ggml_memory_free = 0;
    bool has_ggml_props = false;

    // Agent-reported metrics (from worker reporting agent)
    bool has_agent_telemetry = false;
    bool is_stale = false;
    uint64_t telemetry_age_ms = 0;
    std::string provenance = "UNKNOWN"; // "MEASURED", "CONFIGURED_BUDGET", "SIMULATED", "UNKNOWN"
    uint64_t agent_ram_total = 0;
    uint64_t agent_ram_available = 0;
    uint64_t agent_vram_total = 0; // Note: DXGI DedicatedVideoMemory is total VRAM, not available VRAM
    bool is_simulated = false;
};

// Result of conservative capacity evaluation for a single backend
struct BackendCapacityAssessment {
    std::string device_identifier;
    std::string backend_type;
    bool is_loopback = false;
    std::string memory_scope;

    // Telemetry and measurement provenance
    std::string provenance = "UNKNOWN";
    uint64_t measured_total_bytes = 0;
    uint64_t measured_available_bytes = 0;

    // Safety headroom and usable budget
    uint64_t reserved_headroom_bytes = 0;
    uint64_t usable_budget_bytes = 0;

    // Layer capacity
    uint64_t bytes_per_layer = 0;
    int estimated_layer_capacity = 0;
    int capped_layer_capacity = 0;
    float split_weight = 0.0f;

    // Validation status
    bool is_valid = false;
    std::string status_reason;
};

class ConservativeCapacityEstimator {
public:
    // Calibrated model cost constants for Qwen 2.5 3B (37 total layers including output)
    static constexpr uint64_t BASE_WEIGHTS_PER_LAYER_BYTES = 73ULL * 1024ULL * 1024ULL;  // ~73 MiB
    static constexpr uint64_t BASE_KV_CACHE_2048_BYTES = 16ULL * 1024ULL * 1024ULL;      // ~16 MiB at n_ctx=2048
    static constexpr uint64_t COMPUTE_BUFFER_PER_LAYER_BYTES = 2360000ULL;                // ~2.25 MiB
    static constexpr uint64_t DEFAULT_HEADROOM_RAM_BYTES = 1024ULL * 1024ULL * 1024ULL;   // 1 GiB OS headroom
    static constexpr uint64_t DEFAULT_HEADROOM_VRAM_BYTES = 256ULL * 1024ULL * 1024ULL;   // 256 MiB GPU headroom
    static constexpr uint64_t FRESHNESS_TTL_MS = 30000ULL;                                // 30s freshness threshold

    // Model- and context-aware layer cost calculation
    static uint64_t estimate_bytes_per_layer(int n_ctx, uint64_t custom_bytes = 0) {
        if (custom_bytes > 0) {
            return custom_bytes;
        }
        // Scale KV cache buffer proportionally to context size
        double ctx_scale = (n_ctx > 0) ? (static_cast<double>(n_ctx) / 2048.0) : 1.0;
        uint64_t kv_scaled = static_cast<uint64_t>(static_cast<double>(BASE_KV_CACHE_2048_BYTES) * ctx_scale);
        uint64_t total = BASE_WEIGHTS_PER_LAYER_BYTES + kv_scaled + COMPUTE_BUFFER_PER_LAYER_BYTES;

        // Add conservative 2% rounding margin
        return total + (total / 50ULL); // ~92 MiB at n_ctx=2048
    }

    // Evaluate single device telemetry and compute usable budget
    static BackendCapacityAssessment assess_device(
        const BackendTelemetryInfo& info,
        uint64_t reserved_headroom_ram = DEFAULT_HEADROOM_RAM_BYTES,
        uint64_t reserved_headroom_vram = DEFAULT_HEADROOM_VRAM_BYTES,
        uint64_t now_ms = 0) {

        BackendCapacityAssessment ca;
        ca.device_identifier = info.primary_id;
        ca.backend_type = info.backend_type;
        ca.is_loopback = info.is_loopback;
        ca.memory_scope = info.memory_scope;
        ca.is_valid = false;

        // 1. Check for stale telemetry
        if (info.is_stale || (info.has_agent_telemetry && info.telemetry_age_ms > FRESHNESS_TTL_MS)) {
            ca.status_reason = "Telemetry is STALE (age " + std::to_string(info.telemetry_age_ms) +
                               "ms exceeds " + std::to_string(FRESHNESS_TTL_MS) + "ms TTL)";
            return ca;
        }

        // 2. Identify backend category (GPU/CUDA vs Host RAM/RPC)
        bool is_cuda = (info.backend_type == "cuda" || info.primary_id == "local-cuda-0" || info.secondary_id == "CUDA0");

        if (is_cuda) {
            ca.provenance = "MEASURED";
            // For CUDA, GGML props query cudaMemGetInfo directly, providing genuine free and total VRAM
            if (!info.has_ggml_props || info.ggml_memory_total == 0) {
                ca.status_reason = "CUDA backend lacks valid GGML device properties";
                return ca;
            }

            ca.measured_total_bytes = info.ggml_memory_total;
            ca.measured_available_bytes = info.ggml_memory_free;

            // Physical sanity check
            if (ca.measured_available_bytes > ca.measured_total_bytes) {
                ca.status_reason = "Implausible VRAM measurements: available (" +
                                   std::to_string(ca.measured_available_bytes) + ") > total (" +
                                   std::to_string(ca.measured_total_bytes) + ")";
                return ca;
            }

            // Deduct conservative VRAM headroom
            ca.reserved_headroom_bytes = reserved_headroom_vram;
            if (ca.measured_available_bytes > ca.reserved_headroom_bytes) {
                ca.usable_budget_bytes = ca.measured_available_bytes - ca.reserved_headroom_bytes;
            } else {
                ca.usable_budget_bytes = 0;
            }

            ca.is_valid = true;
            ca.status_reason = "Valid CUDA telemetry; usable VRAM: " + std::to_string(ca.usable_budget_bytes) + " bytes";
            return ca;
        }

        // Host RAM / RPC Worker assessment
        // If agent telemetry is present, verify provenance and plausible values
        if (!info.has_agent_telemetry && !info.has_ggml_props) {
            ca.status_reason = "No telemetry or GGML properties available for worker '" + info.primary_id + "'";
            return ca;
        }

        ca.provenance = info.has_agent_telemetry ? info.provenance : "MEASURED";

        uint64_t candidate_total = 0;
        uint64_t candidate_avail = 0;

        if (info.has_agent_telemetry) {
            // Agent reported physical RAM via GlobalMemoryStatusEx
            candidate_total = info.agent_ram_total;
            candidate_avail = info.agent_ram_available;
        } else if (info.has_ggml_props) {
            // Fallback to GGML RPC reported memory if agent not yet reporting
            candidate_total = info.ggml_memory_total;
            candidate_avail = info.ggml_memory_free;
        }

        // Sanity bounds checks
        if (candidate_total == 0) {
            ca.status_reason = "Reported host RAM total is zero";
            return ca;
        }
        if (candidate_avail > candidate_total) {
            ca.status_reason = "Implausible host RAM: available (" + std::to_string(candidate_avail) +
                               ") > total (" + std::to_string(candidate_total) + ")";
            return ca;
        }

        // Consistency check if both agent and GGML RPC properties are available
        if (info.has_agent_telemetry && info.has_ggml_props && info.ggml_memory_total > 0) {
            // Check for massive total disparity (> 50% mismatch indicating wrong host query)
            double ratio = static_cast<double>(candidate_total) / static_cast<double>(info.ggml_memory_total);
            if (ratio < 0.5 || ratio > 2.0) {
                ca.status_reason = "Discrepancy between agent reported RAM (" + std::to_string(candidate_total) +
                                   ") and GGML RPC reported RAM (" + std::to_string(info.ggml_memory_total) + ")";
                return ca;
            }
            // Conservatively take the smaller available memory figure
            candidate_avail = std::min(candidate_avail, info.ggml_memory_free);
        }

        ca.measured_total_bytes = candidate_total;
        ca.measured_available_bytes = candidate_avail;

        // Apply conservative OS headroom (e.g. 1 GiB or 15% of RAM, whichever is greater)
        uint64_t percentage_headroom = candidate_total / 8ULL; // 12.5%
        ca.reserved_headroom_bytes = std::max(reserved_headroom_ram, percentage_headroom);

        if (ca.measured_available_bytes > ca.reserved_headroom_bytes) {
            ca.usable_budget_bytes = ca.measured_available_bytes - ca.reserved_headroom_bytes;
        } else {
            ca.usable_budget_bytes = 0;
        }

        ca.is_valid = true;
        ca.status_reason = "Valid host RAM telemetry; raw usable budget: " + std::to_string(ca.usable_budget_bytes) + " bytes";
        return ca;
    }

    // Partition shared host RAM among collocated loopback workers to prevent additive memory inflation
    static void deduplicate_and_partition_shared_hosts(std::vector<BackendCapacityAssessment>& assessments) {
        // Count how many valid loopback devices share host memory
        size_t loopback_count = 0;
        uint64_t min_shared_usable = UINT64_MAX;

        for (const auto& ca : assessments) {
            if (ca.is_valid && ca.is_loopback && ca.memory_scope == "shared_host") {
                loopback_count++;
                if (ca.usable_budget_bytes < min_shared_usable) {
                    min_shared_usable = ca.usable_budget_bytes;
                }
            }
        }

        if (loopback_count > 1 && min_shared_usable != UINT64_MAX) {
            // Partition the single host's usable budget equally among loopback workers
            uint64_t partitioned_budget = min_shared_usable / loopback_count;
            for (auto& ca : assessments) {
                if (ca.is_valid && ca.is_loopback && ca.memory_scope == "shared_host") {
                    ca.usable_budget_bytes = partitioned_budget;
                    ca.status_reason += " [Loopback partitioned across " + std::to_string(loopback_count) +
                                        " workers: " + std::to_string(partitioned_budget) + " bytes each]";
                }
            }
        }
    }
};

} // namespace swarm
