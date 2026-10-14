#include "policy.h"
#include <iostream>
#include <cassert>
#include <vector>

using namespace swarm;

void test_unit_parsing() {
  uint64_t bytes = 0;
  // Valid units
  assert(PlacementPolicyEngine::parse_memory_unit("100B", bytes) && bytes == 100);
  assert(PlacementPolicyEngine::parse_memory_unit("10KB", bytes) && bytes == 10000);
  assert(PlacementPolicyEngine::parse_memory_unit("10KiB", bytes) && bytes == 10240);
  assert(PlacementPolicyEngine::parse_memory_unit("50MB", bytes) && bytes == 50000000);
  assert(PlacementPolicyEngine::parse_memory_unit("50MiB", bytes) && bytes == 52428800);
  assert(PlacementPolicyEngine::parse_memory_unit("4GB", bytes) && bytes == 4000000000ULL);
  assert(PlacementPolicyEngine::parse_memory_unit("4GiB", bytes) && bytes == 4294967296ULL);
  assert(PlacementPolicyEngine::parse_memory_unit("500", bytes) && bytes == 500);

  // Invalid / overflow
  assert(!PlacementPolicyEngine::parse_memory_unit("", bytes));
  assert(!PlacementPolicyEngine::parse_memory_unit("-50MB", bytes));
  assert(!PlacementPolicyEngine::parse_memory_unit("MB", bytes));
  assert(!PlacementPolicyEngine::parse_memory_unit("100XYZ", bytes));
  std::cout << "[PASS] test_unit_parsing" << std::endl;
}

void test_profile_string_parsing() {
  std::unordered_map<std::string, DeviceProfile> profiles;
  std::string err;

  // Valid
  assert(PlacementPolicyEngine::parse_worker_profiles(
      "127.0.0.1:50052=50MB, 127.0.0.1:50053=500MB, local-cuda-0=4000MB", profiles, err));
  assert(profiles.size() == 3);
  assert(profiles["127.0.0.1:50052"].virtual_budget_bytes == 50000000);
  assert(profiles["127.0.0.1:50053"].virtual_budget_bytes == 500000000);
  assert(profiles["local-cuda-0"].virtual_budget_bytes == 4000000000ULL);

  // Malformed: missing '='
  assert(!PlacementPolicyEngine::parse_worker_profiles("127.0.0.1:50052:50MB", profiles, err));
  assert(!err.empty());

  // Duplicate profile
  assert(!PlacementPolicyEngine::parse_worker_profiles("worker1=100MB, worker1=200MB", profiles, err));
  assert(!err.empty());

  // Empty budget
  assert(!PlacementPolicyEngine::parse_worker_profiles("worker1=", profiles, err));

  std::cout << "[PASS] test_profile_string_parsing" << std::endl;
}

void test_policy_evaluation_scenarios() {
  // 3 candidates in model_params.devices order: RPC0, RPC1, CUDA0
  std::vector<PlacementPolicyEngine::CandidateDevice> candidates = {
      {"127.0.0.1:50052", "RPC0", "RPC Server 0", "loopback_rpc", true, "shared_host", 8000000000ULL, 8000000000ULL},
      {"127.0.0.1:50053", "RPC1", "RPC Server 1", "loopback_rpc", true, "shared_host", 8000000000ULL, 8000000000ULL},
      {"local-cuda-0", "CUDA0", "NVIDIA GTX 1050", "cuda", false, "device_local", 4000000000ULL, 4000000000ULL}
  };

  // Scenario 1: Policy NONE (baseline)
  {
    std::unordered_map<std::string, DeviceProfile> profiles;
    auto res = PlacementPolicyEngine::evaluate(
        PlacementPolicyType::NONE, candidates, profiles, 36, 4, 16);
    assert(res.success);
    assert(res.tensor_split.empty());
    assert(res.plans[0].virtual_budget_bytes == 0);
    std::cout << "[PASS] Scenario 1: Policy NONE" << std::endl;
  }

  // Scenario 2: Deterministic test - 4 offloaded layers, capacity predicting 2 layers per eligible backend
  // RPC0: budget for 0 layers (< 92 MiB)
  // RPC1: budget for 2 layers (2 * 92 MiB = 184 MiB)
  // CUDA0: budget for 2 layers (2 * 92 MiB = 184 MiB)
  {
    std::unordered_map<std::string, DeviceProfile> profiles;
    profiles["127.0.0.1:50052"] = {"127.0.0.1:50052", 50ULL * 1024ULL * 1024ULL, true}; // 50 MiB -> 0 layers
    profiles["127.0.0.1:50053"] = {"127.0.0.1:50053", 184ULL * 1024ULL * 1024ULL, true}; // 184 MiB -> 2 layers
    profiles["local-cuda-0"] = {"local-cuda-0", 184ULL * 1024ULL * 1024ULL, true}; // 184 MiB -> 2 layers

    auto res = PlacementPolicyEngine::evaluate(
        PlacementPolicyType::RESOURCE_AWARE, candidates, profiles, 36, 4, 16);
    assert(res.success);
    assert(res.plans[0].capped_layer_capacity == 0);
    assert(res.plans[1].capped_layer_capacity == 2);
    assert(res.plans[2].capped_layer_capacity == 2);

    assert(res.tensor_split[0] == 0.0f);
    assert(res.tensor_split[1] == 2.0f);
    assert(res.tensor_split[2] == 2.0f);

    // Predicted layers: 4 offloaded layers are 33, 34, 35, 36
    // RPC0 gets 0 layers
    assert(res.plans[0].predicted_layers.empty());
    // RPC1 gets 2 layers (33, 34)
    assert(res.plans[1].predicted_layers.size() == 2);
    assert(res.plans[1].predicted_layers[0] == 33);
    assert(res.plans[1].predicted_layers[1] == 34);
    // CUDA0 gets 2 layers (35, 36)
    assert(res.plans[2].predicted_layers.size() == 2);
    assert(res.plans[2].predicted_layers[0] == 35);
    assert(res.plans[2].predicted_layers[1] == 36);

    std::cout << "[PASS] Scenario 2: RPC0=0, RPC1=2, CUDA0=2" << std::endl;
  }

  // Scenario 3: RPC0 gets 2 layers, RPC1 gets 0 layers, CUDA0 gets 2 layers
  {
    std::unordered_map<std::string, DeviceProfile> profiles;
    profiles["127.0.0.1:50052"] = {"127.0.0.1:50052", 200ULL * 1024ULL * 1024ULL, true}; // 2 layers
    profiles["127.0.0.1:50053"] = {"127.0.0.1:50053", 50ULL * 1024ULL * 1024ULL, true};  // 0 layers
    profiles["local-cuda-0"] = {"local-cuda-0", 200ULL * 1024ULL * 1024ULL, true}; // 2 layers

    auto res = PlacementPolicyEngine::evaluate(
        PlacementPolicyType::RESOURCE_AWARE, candidates, profiles, 36, 4, 16);
    assert(res.success);
    assert(res.plans[0].capped_layer_capacity == 2);
    assert(res.plans[1].capped_layer_capacity == 0);
    assert(res.plans[2].capped_layer_capacity == 2);

    assert(res.tensor_split[0] == 2.0f);
    assert(res.tensor_split[1] == 0.0f);
    assert(res.tensor_split[2] == 2.0f);

    // RPC0 gets 33, 34
    assert(res.plans[0].predicted_layers.size() == 2);
    assert(res.plans[0].predicted_layers[0] == 33);
    assert(res.plans[0].predicted_layers[1] == 34);
    // RPC1 gets empty
    assert(res.plans[1].predicted_layers.empty());
    // CUDA0 gets 35, 36
    assert(res.plans[2].predicted_layers.size() == 2);
    assert(res.plans[2].predicted_layers[0] == 35);
    assert(res.plans[2].predicted_layers[1] == 36);

    std::cout << "[PASS] Scenario 3: RPC0=2, RPC1=0, CUDA0=2" << std::endl;
  }

  // Scenario 4: Both RPC workers have 0 capacity (50 MB each), CUDA0 has capacity for all 4 layers
  {
    std::unordered_map<std::string, DeviceProfile> profiles;
    profiles["127.0.0.1:50052"] = {"127.0.0.1:50052", 50ULL * 1024ULL * 1024ULL, true};
    profiles["127.0.0.1:50053"] = {"127.0.0.1:50053", 50ULL * 1024ULL * 1024ULL, true};
    profiles["local-cuda-0"] = {"local-cuda-0", 4000ULL * 1024ULL * 1024ULL, true}; // ample capacity

    auto res = PlacementPolicyEngine::evaluate(
        PlacementPolicyType::RESOURCE_AWARE, candidates, profiles, 36, 4, 16);
    assert(res.success);
    assert(res.plans[0].capped_layer_capacity == 0);
    assert(res.plans[1].capped_layer_capacity == 0);
    assert(res.plans[2].capped_layer_capacity == 4);

    assert(res.tensor_split[0] == 0.0f);
    assert(res.tensor_split[1] == 0.0f);
    assert(res.tensor_split[2] == 4.0f);

    assert(res.plans[0].predicted_layers.empty());
    assert(res.plans[1].predicted_layers.empty());
    assert(res.plans[2].predicted_layers.size() == 4);
    assert(res.plans[2].predicted_layers[0] == 33);
    assert(res.plans[2].predicted_layers[1] == 34);
    assert(res.plans[2].predicted_layers[2] == 35);
    assert(res.plans[2].predicted_layers[3] == 36);

    std::cout << "[PASS] Scenario 4: RPC0=0, RPC1=0, CUDA0=4" << std::endl;
  }

  // Scenario 5: Insufficient total capacity (total capacity = 2 < 4 requested layers)
  {
    std::unordered_map<std::string, DeviceProfile> profiles;
    profiles["127.0.0.1:50052"] = {"127.0.0.1:50052", 50ULL * 1024ULL * 1024ULL, true};  // 0 layers
    profiles["127.0.0.1:50053"] = {"127.0.0.1:50053", 50ULL * 1024ULL * 1024ULL, true};  // 0 layers
    profiles["local-cuda-0"] = {"local-cuda-0", 184ULL * 1024ULL * 1024ULL, true};        // 2 layers

    auto res = PlacementPolicyEngine::evaluate(
        PlacementPolicyType::RESOURCE_AWARE, candidates, profiles, 36, 4, 16);
    assert(!res.success);
    assert(!res.error_message.empty());
    std::cout << "[PASS] Scenario 5: Insufficient capacity error caught: " << res.error_message << std::endl;
  }
}

int main() {
  std::cout << "Running policy unit tests..." << std::endl;
  test_unit_parsing();
  test_profile_string_parsing();
  test_policy_evaluation_scenarios();
  std::cout << "All policy unit tests PASSED!" << std::endl;
  return 0;
}
