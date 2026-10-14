#include <iostream>
#include <cassert>
#include <chrono>
#include "node.h"

using namespace swarm;

void test_provenance_and_resource_values() {
    std::cout << "[Test 1] Provenance and Resource Values..." << std::endl;
    uint64_t now = 1700000000000ULL;

    auto m = ResourceValue<uint64_t>::measured(8589934592ULL, "win32_GlobalMemoryStatusEx", now);
    assert(m.provenance == ResourceProvenance::MEASURED);
    assert(m.value.has_value() && m.value.value() == 8589934592ULL);
    assert(m.source == "win32_GlobalMemoryStatusEx");

    auto c = ResourceValue<uint64_t>::configured(524288000ULL, "env_SWARM_WORKER_PROFILES", now);
    assert(c.provenance == ResourceProvenance::CONFIGURED_BUDGET);
    assert(c.value.has_value() && c.value.value() == 524288000ULL);

    auto s = ResourceValue<uint64_t>::simulated(17179869184ULL, "simulation_fixture", now);
    assert(s.provenance == ResourceProvenance::SIMULATED);
    assert(s.value.has_value() && s.value.value() == 17179869184ULL);

    auto u = ResourceValue<uint64_t>::unknown("no_gpu_device");
    assert(u.provenance == ResourceProvenance::UNKNOWN);
    assert(!u.value.has_value());
    assert(u.source == "no_gpu_device");

    json j_u = u.to_json();
    assert(j_u["value"].is_null());
    assert(j_u["provenance"] == "unknown");
    std::cout << "  PASS: Provenance categories strictly segregated." << std::endl;
}

void test_valid_and_invalid_node_metadata() {
    std::cout << "[Test 2] Valid and Invalid Node Metadata..." << std::endl;
    uint64_t now = 1700000000000ULL;

    // 2a. Valid node
    auto valid_node = NodeInventory::create_simulated_fixture(
        "node-valid-1", "192.168.1.100:50052", "192.168.1.100", 50052,
        false, "worker", "ONLINE",
        16000000000ULL, 8000000000ULL,
        8000000000ULL, 4000000000ULL,
        500000000ULL, {33, 34}, 98000000ULL, now);
    assert(valid_node.validation_errors.empty());
    assert(valid_node.is_required_by_model == true);

    // 2b. Inverted RAM (free > total)
    auto bad_ram_node = NodeInventory::create_simulated_fixture(
        "node-bad-ram", "192.168.1.101:50052", "192.168.1.101", 50052,
        false, "worker", "ONLINE",
        4000000000ULL, 8000000000ULL, // free > total!
        std::nullopt, std::nullopt,
        std::nullopt, {}, 0, now);
    assert(!bad_ram_node.validation_errors.empty());
    bool found_ram_err = false;
    for (const auto& err : bad_ram_node.validation_errors) {
        if (err.find("ram_free_bytes exceeds ram_total_bytes") != std::string::npos) {
            found_ram_err = true;
        }
    }
    assert(found_ram_err);

    // 2c. Invalid endpoint format
    auto bad_endpoint_node = NodeInventory::create_simulated_fixture(
        "node-bad-endpoint", "invalid_no_port", "invalid_no_port", 0,
        false, "worker", "ONLINE",
        std::nullopt, std::nullopt, std::nullopt, std::nullopt,
        std::nullopt, {}, 0, now);
    assert(!bad_endpoint_node.validation_errors.empty());

    // 2d. Invalid connection state
    auto bad_state_node = NodeInventory::create_simulated_fixture(
        "node-bad-state", "127.0.0.1:50052", "127.0.0.1", 50052,
        true, "worker", "EXPLODED",
        std::nullopt, std::nullopt, std::nullopt, std::nullopt,
        std::nullopt, {}, 0, now);
    assert(!bad_state_node.validation_errors.empty());

    std::cout << "  PASS: Validation logic caught all synthetic anomalies." << std::endl;
}

void test_staleness_detection() {
    std::cout << "[Test 3] Staleness Detection..." << std::endl;
    uint64_t t0 = 100000;

    auto node = NodeInventory::create_simulated_fixture(
        "node-stale-test", "127.0.0.1:50052", "127.0.0.1", 50052,
        true, "worker", "ONLINE",
        8000000000ULL, 4000000000ULL, std::nullopt, std::nullopt,
        std::nullopt, {}, 0, t0);

    // Age: 10s (max allowed 30s) -> Not stale
    assert(!NodeInventory::is_stale(node, 30000, t0 + 10000));

    // Age: 35s (max allowed 30s) -> Stale
    assert(NodeInventory::is_stale(node, 30000, t0 + 35000));

    // Never observed (t = 0) -> Stale
    node.last_observed_ms = 0;
    assert(NodeInventory::is_stale(node, 30000, t0 + 1000));

    std::cout << "  PASS: Staleness evaluation verified across time offsets." << std::endl;
}

void test_disconnection_and_recovery() {
    std::cout << "[Test 4] Worker Disconnection and Recovery Transition..." << std::endl;
    NodeInventory inventory;
    uint64_t now = 1700000000000ULL;

    auto worker_node = NodeInventory::create_simulated_fixture(
        "node-worker-1", "127.0.0.1:50052", "127.0.0.1", 50052,
        true, "worker", "ONLINE",
        8000000000ULL, 4000000000ULL, std::nullopt, std::nullopt,
        500000000ULL, {33}, 50000000ULL, now);
    inventory.upsert_node(worker_node);

    json j_init = inventory.to_json(now);
    assert(j_init["cluster_summary"]["online_nodes"] == 1);
    assert(j_init["cluster_summary"]["ready_nodes"] == 1);

    // Disconnect worker
    worker_node.connection_state = "UNAVAILABLE";
    worker_node.is_ready_for_inference = false;
    inventory.upsert_node(worker_node);

    json j_down = inventory.to_json(now + 1000);
    assert(j_down["cluster_summary"]["online_nodes"] == 0);
    assert(j_down["cluster_summary"]["ready_nodes"] == 0);
    assert(j_down["cluster_summary"]["required_nodes"] == 1); // Still required by model

    // Recover worker
    worker_node.connection_state = "ONLINE";
    worker_node.is_ready_for_inference = true;
    worker_node.last_observed_ms = now + 2000;
    inventory.upsert_node(worker_node);

    json j_rec = inventory.to_json(now + 2000);
    assert(j_rec["cluster_summary"]["online_nodes"] == 1);
    assert(j_rec["cluster_summary"]["ready_nodes"] == 1);

    std::cout << "  PASS: State transitions accurately reflected in inventory." << std::endl;
}

void test_required_vs_zero_layer_reporting() {
    std::cout << "[Test 5] Required vs Zero-Layer Worker Reporting..." << std::endl;
    NodeInventory inventory;
    uint64_t now = 1700000000000ULL;

    // Zero-layer worker (budget too low)
    auto zero_worker = NodeInventory::create_simulated_fixture(
        "node-zero-layers", "127.0.0.1:50052", "127.0.0.1", 50052,
        true, "worker", "ONLINE",
        8000000000ULL, 4000000000ULL, std::nullopt, std::nullopt,
        50000000ULL, {}, 0, now); // 0 layers, 0 model buffer
    assert(!zero_worker.is_required_by_model);

    // Active worker (has layers)
    auto active_worker = NodeInventory::create_simulated_fixture(
        "node-active-layers", "127.0.0.1:50053", "127.0.0.1", 50053,
        true, "worker", "ONLINE",
        8000000000ULL, 4000000000ULL, std::nullopt, std::nullopt,
        500000000ULL, {33, 34}, 98000000ULL, now);
    assert(active_worker.is_required_by_model);

    inventory.upsert_node(zero_worker);
    inventory.upsert_node(active_worker);

    json j = inventory.to_json(now);
    assert(j["cluster_summary"]["total_nodes"] == 2);
    assert(j["cluster_summary"]["required_nodes"] == 1);
    assert(j["cluster_summary"]["unrequired_nodes"] == 1);

    std::cout << "  PASS: Zero-layer and required workers distinguished." << std::endl;
}

void test_loopback_memory_deduplication() {
    std::cout << "[Test 6] Loopback Host Memory Deduplication..." << std::endl;
    NodeInventory inventory;
    uint64_t now = 1700000000000ULL;
    uint64_t host_phys_ram = 8422543360ULL; // ~7.84 GiB physical host RAM

    auto loopback0 = NodeInventory::create_simulated_fixture(
        "node-loopback-0", "127.0.0.1:50052", "127.0.0.1", 50052,
        true, "worker", "ONLINE",
        host_phys_ram, 2000000000ULL, std::nullopt, std::nullopt,
        50000000ULL, {}, 0, now);

    auto loopback1 = NodeInventory::create_simulated_fixture(
        "node-loopback-1", "127.0.0.1:50053", "127.0.0.1", 50053,
        true, "worker", "ONLINE",
        host_phys_ram, 2000000000ULL, std::nullopt, std::nullopt,
        500000000ULL, {33, 34}, 98000000ULL, now);

    inventory.upsert_node(loopback0);
    inventory.upsert_node(loopback1);

    json j = inventory.to_json(now);
    assert(j["cluster_summary"]["loopback_nodes"] == 2);
    assert(j["cluster_summary"]["memory_accounting"]["host_ram_deduplicated"] == true);
    assert(j["cluster_summary"]["memory_accounting"]["independent_host_ram_bytes"] == host_phys_ram);
    // Verified that host RAM is NOT doubled (not 2 * 8422543360)
    assert(j["cluster_summary"]["memory_accounting"]["independent_host_ram_bytes"].get<uint64_t>() < 2 * host_phys_ram);

    std::cout << "  PASS: Loopback memory correctly deduplicated." << std::endl;
}

void test_simulated_flag_isolation() {
    std::cout << "[Test 7] Simulated Flag Isolation..." << std::endl;
    auto sim_node = NodeInventory::create_simulated_fixture(
        "sim-1", "10.0.0.5:50052", "10.0.0.5", 50052,
        false, "worker", "ONLINE",
        32000000000ULL, 16000000000ULL,
        24000000000ULL, 12000000000ULL,
        10000000000ULL, {10, 11, 12}, 500000000ULL, 1700000000ULL);

    assert(sim_node.is_simulated == true);
    assert(sim_node.ram_total_bytes.provenance == ResourceProvenance::SIMULATED);
    assert(sim_node.vram_total_bytes.provenance == ResourceProvenance::SIMULATED);

    json j = sim_node.to_json();
    assert(j["is_simulated"] == true);
    assert(j["ram_total_bytes"]["provenance"] == "simulated");
    assert(j["vram_total_bytes"]["provenance"] == "simulated");

    std::cout << "  PASS: Simulated fixtures clearly flagged and isolated." << std::endl;
}

int main() {
    std::cout << "================================================================" << std::endl;
    std::cout << " SWARM MILESTONE 7: NODE INVENTORY OFFLINE UNIT TEST SUITE      " << std::endl;
    std::cout << "================================================================" << std::endl;

    test_provenance_and_resource_values();
    test_valid_and_invalid_node_metadata();
    test_staleness_detection();
    test_disconnection_and_recovery();
    test_required_vs_zero_layer_reporting();
    test_loopback_memory_deduplication();
    test_simulated_flag_isolation();

    std::cout << "================================================================" << std::endl;
    std::cout << " ALL OFFLINE NODE INVENTORY TESTS PASSED!                      " << std::endl;
    std::cout << "================================================================" << std::endl;
    return 0;
}
