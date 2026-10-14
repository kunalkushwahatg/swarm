#pragma once

#include <string>
#include <vector>
#include <map>
#include <unordered_map>
#include <sstream>
#include <cstdint>
#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <iostream>
#include <iomanip>

#include "estimator.h"

namespace swarm {

enum class PlacementPolicyType {
  NONE,           // Default: standard GGML memory probing
  RESOURCE_AWARE, // Explicit simulated resource profiles and capacity-derived tensor splits
  DYNAMIC         // Live telemetry-driven dynamic layer allocation with conservative capacity estimation
};

struct DeviceProfile {
  std::string identifier;        // e.g. "127.0.0.1:50052" or "local-cuda-0" or "CUDA0"
  uint64_t virtual_budget_bytes; // User-configured virtual memory budget
  bool is_configured;
};

struct DevicePlacementPlan {
  size_t device_index;
  std::string device_identifier;
  std::string device_name;
  std::string backend_type;
  bool is_loopback;
  std::string memory_scope;
  uint64_t virtual_budget_bytes;
  uint64_t measured_total_bytes = 0;
  uint64_t measured_available_bytes = 0;
  uint64_t reserved_headroom_bytes = 0;
  uint64_t usable_budget_bytes = 0;
  std::string provenance = "UNKNOWN";
  int estimated_layer_capacity;
  int capped_layer_capacity;
  float split_weight;
  std::vector<int> predicted_layers;
};

struct PlacementPolicyResult {
  bool success;
  std::string error_message;
  PlacementPolicyType policy_type;
  std::vector<DevicePlacementPlan> plans;
  std::vector<float> tensor_split; // Sized to llama_max_devices() or device count
  int total_offload_layers_requested;
  int total_capacity_available;
};

class PlacementPolicyEngine {
public:
  // Estimated per-layer cost model for Qwen 2.5 3B at n_ctx=2048:
  // ~73 MiB weights + ~16 MiB KV cache + ~2.25 MiB compute buffer = ~91.25 MiB.
  // With conservative margin: 92 MiB.
  static constexpr uint64_t DEFAULT_ESTIMATED_BYTES_PER_LAYER = 92ULL * 1024ULL * 1024ULL;

  static bool parse_memory_unit(const std::string& str, uint64_t& out_bytes) {
    if (str.empty()) return false;

    // Find where number ends and unit begins
    size_t i = 0;
    while (i < str.size() && (std::isdigit(static_cast<unsigned char>(str[i])) || str[i] == '.')) {
      i++;
    }
    if (i == 0) return false;

    std::string num_str = str.substr(0, i);
    std::string unit_str = str.substr(i);

    // Trim whitespace
    while (!unit_str.empty() && std::isspace(static_cast<unsigned char>(unit_str.front()))) {
      unit_str.erase(unit_str.begin());
    }
    while (!unit_str.empty() && std::isspace(static_cast<unsigned char>(unit_str.back()))) {
      unit_str.pop_back();
    }

    double val = 0.0;
    try {
      size_t idx = 0;
      val = std::stod(num_str, &idx);
      if (idx != num_str.size() || val < 0.0) return false;
    } catch (...) {
      return false;
    }

    // Convert unit to lowercase
    std::string unit_lower;
    for (char c : unit_str) {
      unit_lower += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }

    uint64_t multiplier = 1ULL;
    if (unit_lower.empty() || unit_lower == "b") {
      multiplier = 1ULL;
    } else if (unit_lower == "k" || unit_lower == "kb") {
      multiplier = 1000ULL;
    } else if (unit_lower == "kib") {
      multiplier = 1024ULL;
    } else if (unit_lower == "m" || unit_lower == "mb") {
      multiplier = 1000ULL * 1000ULL;
    } else if (unit_lower == "mib") {
      multiplier = 1024ULL * 1024ULL;
    } else if (unit_lower == "g" || unit_lower == "gb") {
      multiplier = 1000ULL * 1000ULL * 1000ULL;
    } else if (unit_lower == "gib") {
      multiplier = 1024ULL * 1024ULL * 1024ULL;
    } else {
      return false; // Unknown unit
    }

    double total = val * static_cast<double>(multiplier);
    if (total > static_cast<double>(UINT64_MAX) || total < 0.0) {
      return false; // Overflow
    }

    out_bytes = static_cast<uint64_t>(total);
    return true;
  }

  // Parse comma-separated worker profiles: "id1=budget1,id2=budget2"
  static bool parse_worker_profiles(const std::string& raw_env,
                                    std::unordered_map<std::string, DeviceProfile>& out_profiles,
                                    std::string& out_error) {
    out_profiles.clear();
    out_error.clear();
    if (raw_env.empty()) return true;

    std::stringstream ss(raw_env);
    std::string item;
    while (std::getline(ss, item, ',')) {
      // Trim item
      size_t start = item.find_first_not_of(" \t\r\n");
      if (start == std::string::npos) continue;
      size_t end = item.find_last_not_of(" \t\r\n");
      item = item.substr(start, end - start + 1);

      size_t eq_pos = item.find('=');
      if (eq_pos == std::string::npos || eq_pos == 0 || eq_pos == item.size() - 1) {
        out_error = "Malformed worker profile entry: '" + item + "' (expected identifier=budget)";
        return false;
      }

      std::string id = item.substr(0, eq_pos);
      std::string budget_str = item.substr(eq_pos + 1);

      // Trim id
      size_t id_start = id.find_first_not_of(" \t");
      size_t id_end = id.find_last_not_of(" \t");
      if (id_start == std::string::npos) {
        out_error = "Empty identifier in profile entry: '" + item + "'";
        return false;
      }
      id = id.substr(id_start, id_end - id_start + 1);

      // Trim budget_str
      size_t b_start = budget_str.find_first_not_of(" \t");
      size_t b_end = budget_str.find_last_not_of(" \t");
      if (b_start == std::string::npos) {
        out_error = "Empty budget in profile entry for '" + id + "'";
        return false;
      }
      budget_str = budget_str.substr(b_start, b_end - b_start + 1);

      // Check for duplicate profile
      if (out_profiles.find(id) != out_profiles.end()) {
        out_error = "Duplicate worker profile definition for '" + id + "'";
        return false;
      }

      uint64_t bytes = 0;
      if (!parse_memory_unit(budget_str, bytes)) {
        out_error = "Invalid or overflowing budget value '" + budget_str + "' for worker '" + id + "'";
        return false;
      }

      DeviceProfile profile;
      profile.identifier = id;
      profile.virtual_budget_bytes = bytes;
      profile.is_configured = true;
      out_profiles[id] = profile;
    }

    return true;
  }

  static PlacementPolicyType parse_policy_type(const std::string& str) {
    if (str == "resource_aware") return PlacementPolicyType::RESOURCE_AWARE;
    if (str == "dynamic" || str == "dynamic_resource_aware") return PlacementPolicyType::DYNAMIC;
    return PlacementPolicyType::NONE;
  }

  // Candidate device info passed in the exact order intended for model_params.devices
  struct CandidateDevice {
    std::string primary_id;     // e.g. "127.0.0.1:50052" or "local-cuda-0"
    std::string secondary_id;   // e.g. "RPC0" or "CUDA0"
    std::string device_name;
    std::string backend_type;
    bool is_loopback = false;
    std::string memory_scope;
    uint64_t physical_memory_free = 0;
    uint64_t physical_memory_total = 0;

    // Telemetry fields for dynamic placement
    bool has_agent_telemetry = false;
    bool is_stale = false;
    uint64_t telemetry_age_ms = 0;
    std::string provenance = "UNKNOWN";
    uint64_t agent_ram_total = 0;
    uint64_t agent_ram_available = 0;
    uint64_t agent_vram_total = 0;
    bool is_simulated = false;
  };

  // Compute resource-aware or dynamic placement plan
  static PlacementPolicyResult evaluate(
      PlacementPolicyType policy_type,
      const std::vector<CandidateDevice>& candidate_devices,
      const std::unordered_map<std::string, DeviceProfile>& profiles,
      int total_model_layers,      // e.g. 36 (transformer layers)
      int requested_gpu_layers,    // e.g. 4 or -1 (all)
      size_t max_llama_devices,    // llama_max_devices()
      uint64_t bytes_per_layer = DEFAULT_ESTIMATED_BYTES_PER_LAYER,
      uint64_t reserved_headroom_ram = ConservativeCapacityEstimator::DEFAULT_HEADROOM_RAM_BYTES,
      uint64_t reserved_headroom_vram = ConservativeCapacityEstimator::DEFAULT_HEADROOM_VRAM_BYTES,
      int n_ctx = 2048,
      uint64_t now_ms = 0) {

    PlacementPolicyResult res;
    res.policy_type = policy_type;
    res.success = false;

    int n_all_with_output = total_model_layers + 1; // 37 (layers 0..35 plus output layer 36)
    int act_gpu_layers = 0;
    if (requested_gpu_layers < 0) {
      act_gpu_layers = n_all_with_output; // all 37 layers
    } else {
      act_gpu_layers = std::min(requested_gpu_layers, n_all_with_output);
    }
    res.total_offload_layers_requested = act_gpu_layers;

    if (candidate_devices.empty()) {
      res.error_message = "No candidate devices provided for placement evaluation";
      return res;
    }

    if (policy_type == PlacementPolicyType::NONE) {
      // Default baseline: no tensor_split override
      res.success = true;
      res.total_capacity_available = act_gpu_layers;
      for (size_t i = 0; i < candidate_devices.size(); ++i) {
        const auto& cd = candidate_devices[i];
        DevicePlacementPlan plan;
        plan.device_index = i;
        plan.device_identifier = cd.primary_id;
        plan.device_name = cd.device_name;
        plan.backend_type = cd.backend_type;
        plan.is_loopback = cd.is_loopback;
        plan.memory_scope = cd.memory_scope;
        plan.virtual_budget_bytes = 0;
        plan.estimated_layer_capacity = -1; // Unconstrained by policy
        plan.capped_layer_capacity = -1;
        plan.split_weight = 0.0f;
        res.plans.push_back(plan);
      }
      return res;
    }

    // DYNAMIC telemetry-driven placement policy evaluation
    if (policy_type == PlacementPolicyType::DYNAMIC) {
      uint64_t eff_layer_cost = ConservativeCapacityEstimator::estimate_bytes_per_layer(n_ctx, bytes_per_layer);
      std::vector<BackendCapacityAssessment> assessments;
      assessments.reserve(candidate_devices.size());

      for (size_t i = 0; i < candidate_devices.size(); ++i) {
        const auto& cd = candidate_devices[i];
        BackendTelemetryInfo info;
        info.primary_id = cd.primary_id;
        info.secondary_id = cd.secondary_id;
        info.device_name = cd.device_name;
        info.backend_type = cd.backend_type;
        info.is_loopback = cd.is_loopback;
        info.memory_scope = cd.memory_scope;
        info.ggml_memory_total = cd.physical_memory_total;
        info.ggml_memory_free = cd.physical_memory_free;
        info.has_ggml_props = (cd.physical_memory_total > 0);
        info.has_agent_telemetry = cd.has_agent_telemetry;
        info.is_stale = cd.is_stale;
        info.telemetry_age_ms = cd.telemetry_age_ms;
        info.provenance = cd.provenance;
        info.agent_ram_total = cd.agent_ram_total;
        info.agent_ram_available = cd.agent_ram_available;
        info.agent_vram_total = cd.agent_vram_total;
        info.is_simulated = cd.is_simulated;

        BackendCapacityAssessment ca = ConservativeCapacityEstimator::assess_device(
            info, reserved_headroom_ram, reserved_headroom_vram, now_ms);

        if (!ca.is_valid) {
          res.success = false;
          res.error_message = "Dynamic placement telemetry validation failed for '" + cd.primary_id + "': " + ca.status_reason;
          return res;
        }
        assessments.push_back(ca);
      }

      // Deduplicate and partition shared host RAM across loopback workers
      ConservativeCapacityEstimator::deduplicate_and_partition_shared_hosts(assessments);

      res.plans.resize(candidate_devices.size());
      res.tensor_split.assign(std::max(max_llama_devices, candidate_devices.size()), 0.0f);
      int dynamic_capacity_sum = 0;

      for (size_t i = 0; i < candidate_devices.size(); ++i) {
        const auto& cd = candidate_devices[i];
        const auto& ca = assessments[i];
        DevicePlacementPlan& plan = res.plans[i];
        plan.device_index = i;
        plan.device_identifier = cd.primary_id;
        plan.device_name = cd.device_name;
        plan.backend_type = cd.backend_type;
        plan.is_loopback = cd.is_loopback;
        plan.memory_scope = cd.memory_scope;
        plan.virtual_budget_bytes = ca.usable_budget_bytes;
        plan.measured_total_bytes = ca.measured_total_bytes;
        plan.measured_available_bytes = ca.measured_available_bytes;
        plan.reserved_headroom_bytes = ca.reserved_headroom_bytes;
        plan.usable_budget_bytes = ca.usable_budget_bytes;
        plan.provenance = ca.provenance;

        int est_cap = static_cast<int>(ca.usable_budget_bytes / eff_layer_cost);
        plan.estimated_layer_capacity = est_cap;
        int capped_cap = std::min(est_cap, act_gpu_layers);
        plan.capped_layer_capacity = capped_cap;
        plan.split_weight = static_cast<float>(capped_cap);
        res.tensor_split[i] = plan.split_weight;

        dynamic_capacity_sum += capped_cap;
      }

      res.total_capacity_available = dynamic_capacity_sum;

      if (dynamic_capacity_sum < act_gpu_layers) {
        res.success = false;
        res.error_message = "Insufficient dynamic capacity: total available layer capacity (" +
                            std::to_string(dynamic_capacity_sum) + ") is less than requested offload layers (" +
                            std::to_string(act_gpu_layers) + ")";
        return res;
      }

      // Exact GGML cumulative normalized split simulation
      std::vector<float> splits(candidate_devices.size(), 0.0f);
      for (size_t i = 0; i < candidate_devices.size(); ++i) {
        splits[i] = res.plans[i].split_weight;
      }

      float split_sum = 0.0f;
      for (size_t i = 0; i < splits.size(); ++i) {
        split_sum += splits[i];
        splits[i] = split_sum;
      }

      if (split_sum <= 0.0f) {
        res.success = false;
        res.error_message = "All eligible dynamic backends have zero capacity";
        return res;
      }

      for (size_t i = 0; i < splits.size(); ++i) {
        splits[i] /= split_sum;
      }

      int i_gpu_start = std::max(n_all_with_output - act_gpu_layers, 0);
      for (int il = i_gpu_start; il < n_all_with_output; ++il) {
        float fraction = static_cast<float>(il - i_gpu_start) / static_cast<float>(act_gpu_layers);
        auto it_bound = std::upper_bound(splits.begin(), splits.end(), fraction);
        size_t dev_idx = std::distance(splits.begin(), it_bound);
        if (dev_idx >= res.plans.size()) {
          dev_idx = res.plans.size() - 1;
        }
        res.plans[dev_idx].predicted_layers.push_back(il);
      }

      res.success = true;
      return res;
    }

    // RESOURCE_AWARE policy evaluation
    res.plans.resize(candidate_devices.size());
    res.tensor_split.assign(std::max(max_llama_devices, candidate_devices.size()), 0.0f);

    int total_capacity_sum = 0;

    for (size_t i = 0; i < candidate_devices.size(); ++i) {
      const auto& cd = candidate_devices[i];
      DevicePlacementPlan& plan = res.plans[i];
      plan.device_index = i;
      plan.device_identifier = cd.primary_id;
      plan.device_name = cd.device_name;
      plan.backend_type = cd.backend_type;
      plan.is_loopback = cd.is_loopback;
      plan.memory_scope = cd.memory_scope;

      // Find profile by primary or secondary id
      uint64_t budget = 0;
      auto it = profiles.find(cd.primary_id);
      if (it != profiles.end()) {
        budget = it->second.virtual_budget_bytes;
      } else {
        auto it2 = profiles.find(cd.secondary_id);
        if (it2 != profiles.end()) {
          budget = it2->second.virtual_budget_bytes;
        } else {
          // If no virtual profile configured, fallback to physical free memory
          budget = cd.physical_memory_free;
        }
      }

      plan.virtual_budget_bytes = budget;

      // 1. Estimate layer capacity: floor(budget / bytes_per_layer)
      int est_cap = static_cast<int>(budget / bytes_per_layer);
      plan.estimated_layer_capacity = est_cap;

      // 2. Cap capacity at total offload layers considered
      int capped_cap = std::min(est_cap, act_gpu_layers);
      plan.capped_layer_capacity = capped_cap;

      // 3. Split weight is proportional to capped capacity
      plan.split_weight = static_cast<float>(capped_cap);
      res.tensor_split[i] = plan.split_weight;

      total_capacity_sum += capped_cap;
    }

    res.total_capacity_available = total_capacity_sum;

    // Check if total simulated capacity satisfies requested offload layers
    if (total_capacity_sum < act_gpu_layers) {
      res.success = false;
      res.error_message = "Insufficient simulated capacity: total available layer capacity (" +
                          std::to_string(total_capacity_sum) +
                          ") is less than requested offload layers (" +
                          std::to_string(act_gpu_layers) + ")";
      return res;
    }

    // 4. Simulate exact GGML cumulative normalized split to compute predicted layers
    std::vector<float> splits(candidate_devices.size(), 0.0f);
    for (size_t i = 0; i < candidate_devices.size(); ++i) {
      splits[i] = res.plans[i].split_weight;
    }

    float split_sum = 0.0f;
    for (size_t i = 0; i < splits.size(); ++i) {
      split_sum += splits[i];
      splits[i] = split_sum;
    }

    if (split_sum <= 0.0f) {
      res.success = false;
      res.error_message = "All eligible backends have zero capacity";
      return res;
    }

    for (size_t i = 0; i < splits.size(); ++i) {
      splits[i] /= split_sum;
    }

    // Determine layer start index matching llama-model.cpp:
    // const int i_gpu_start = std::max(n_layer_all + 1 - n_gpu_layers, 0);
    int i_gpu_start = std::max(n_all_with_output - act_gpu_layers, 0);

    for (int il = i_gpu_start; il < n_all_with_output; ++il) {
      float fraction = static_cast<float>(il - i_gpu_start) / static_cast<float>(act_gpu_layers);
      auto it_bound = std::upper_bound(splits.begin(), splits.end(), fraction);
      size_t dev_idx = std::distance(splits.begin(), it_bound);
      if (dev_idx >= res.plans.size()) {
        dev_idx = res.plans.size() - 1;
      }
      res.plans[dev_idx].predicted_layers.push_back(il);
    }

    res.success = true;
    return res;
  }
};

} // namespace swarm
