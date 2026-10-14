#include <iostream>
#include <string>
#include <vector>
#include <cassert>
#include <chrono>

#include "node.h"
#include "agent.h"

using namespace swarm;

void test_1_hardware_probe_and_report_serialization() {
    std::cout << "[Test 1] Hardware Probe & Report Serialization... ";

    NodeReport report = HardwareProbe::collect_report("node-test-1", "127.0.0.1:50052", 50052);
    assert(report.schema_version == "1.0");
    assert(report.agent_version == "1.0.0");
    assert(report.node_id == "node-test-1");
    assert(report.endpoint == "127.0.0.1:50052");
    assert(report.rpc_port == 50052);
    assert(report.status == "ONLINE");
    assert(report.ram.total_bytes > 0);
    assert(report.ram.available_bytes <= report.ram.total_bytes);
    assert(!report.cpu.architecture.empty());
    assert(report.cpu.processor_count > 0);

    // Serialization round-trip
    json j = report.to_json();
    assert(j["schema_version"] == "1.0");
    assert(j["ram"]["total_bytes"] == report.ram.total_bytes);
    assert(j["ram"]["available_bytes"] == report.ram.available_bytes);

    std::string err;
    auto parsed = NodeReport::from_json(j, err);
    assert(parsed.has_value());
    assert(parsed.value().node_id == "node-test-1");
    assert(parsed.value().ram.total_bytes == report.ram.total_bytes);

    std::cout << "PASS\n";
}

void test_2_malformed_report_rejection() {
    std::cout << "[Test 2] Malformed Report Rejection... ";

    NodeInventory inv;
    std::string err;
    uint64_t now_ms = 100000;

    // A. Wrong schema version
    json bad_schema = {
        {"schema_version", "2.0"},
        {"node_id", "node-bad"},
        {"endpoint", "127.0.0.1:50052"},
        {"ram", {{"total_bytes", 1000}, {"available_bytes", 500}}}
    };
    assert(!inv.ingest_agent_report(bad_schema, now_ms, err));
    assert(err.find("schema_version") != std::string::npos);

    // B. Missing node_id
    json missing_id = {
        {"schema_version", "1.0"},
        {"node_id", ""},
        {"endpoint", "127.0.0.1:50052"},
        {"ram", {{"total_bytes", 1000}, {"available_bytes", 500}}}
    };
    assert(!inv.ingest_agent_report(missing_id, now_ms, err));
    assert(err.find("node_id") != std::string::npos);

    // C. Available RAM > Total RAM
    json invalid_ram = {
        {"schema_version", "1.0"},
        {"node_id", "node-bad-ram"},
        {"endpoint", "127.0.0.1:50052"},
        {"ram", {{"total_bytes", 1000}, {"available_bytes", 2000}}}
    };
    assert(!inv.ingest_agent_report(invalid_ram, now_ms, err));
    assert(err.find("available_bytes") != std::string::npos);

    // D. Missing RAM block
    json no_ram = {
        {"schema_version", "1.0"},
        {"node_id", "node-no-ram"},
        {"endpoint", "127.0.0.1:50052"}
    };
    assert(!inv.ingest_agent_report(no_ram, now_ms, err));
    assert(err.find("ram") != std::string::npos);

    // E. Missing timestamp_ms
    json no_time = {
        {"schema_version", "1.0"},
        {"node_id", "node-no-time"},
        {"endpoint", "127.0.0.1:50052"},
        {"ram", {{"total_bytes", 1000}, {"available_bytes", 500}}}
    };
    assert(!inv.ingest_agent_report(no_time, now_ms, err));
    assert(err.find("timestamp_ms") != std::string::npos);

    // F. Malformed timestamp_ms (string)
    json bad_time = {
        {"schema_version", "1.0"},
        {"node_id", "node-bad-time"},
        {"endpoint", "127.0.0.1:50052"},
        {"timestamp_ms", "not_a_number"},
        {"ram", {{"total_bytes", 1000}, {"available_bytes", 500}}}
    };
    assert(!inv.ingest_agent_report(bad_time, now_ms, err));
    assert(err.find("timestamp_ms") != std::string::npos);

    // G. Implausible timestamp_ms (zero)
    json zero_time = {
        {"schema_version", "1.0"},
        {"node_id", "node-zero-time"},
        {"endpoint", "127.0.0.1:50052"},
        {"timestamp_ms", 0},
        {"ram", {{"total_bytes", 1000}, {"available_bytes", 500}}}
    };
    assert(!inv.ingest_agent_report(zero_time, now_ms, err));
    assert(err.find("timestamp_ms") != std::string::npos);

    std::cout << "PASS\n";
}

void test_3_unsupported_metrics_and_provenance() {
    std::cout << "[Test 3] Unsupported Metrics & Provenance Distinction... ";

    NodeInventory inv;
    std::string err;
    uint64_t now_ms = 100000;

    json report_json = {
        {"schema_version", "1.0"},
        {"agent_version", "1.0.0"},
        {"timestamp_ms", now_ms},
        {"node_id", "node-provenance-test"},
        {"endpoint", "127.0.0.1:50052"},
        {"hostname", "testhost"},
        {"rpc_port", 50052},
        {"status", "ONLINE"},
        {"cpu", {{"architecture", "x86_64"}, {"processor_count", 8}, {"model_name", "Test CPU"}}},
        {"ram", {{"total_bytes", 16000000000ULL}, {"available_bytes", 8000000000ULL}}},
        {"gpu", {{"detected", false}}},
        {"unsupported_metrics", {"cpu_temperature", "fan_speed", "process_working_set"}}
    };

    assert(inv.ingest_agent_report(report_json, now_ms, err));
    auto node_opt = inv.get_node("node-provenance-test");
    assert(node_opt.has_value());
    const auto& node = node_opt.value();

    // RAM must be MEASURED
    assert(node.ram_total_bytes.provenance == ResourceProvenance::MEASURED);
    assert(node.ram_total_bytes.source == "agent_GlobalMemoryStatusEx");
    assert(node.ram_total_bytes.value.value() == 16000000000ULL);

    // GPU was not detected, must be UNKNOWN, NOT fabricated
    assert(node.vram_total_bytes.provenance == ResourceProvenance::UNKNOWN);
    assert(!node.vram_total_bytes.value.has_value());

    // Unsupported metrics recorded
    assert(node.unsupported_metrics.size() == 3);
    assert(node.unsupported_metrics[0] == "cpu_temperature");

    std::cout << "PASS\n";
}

void test_4_freshness_and_staleness_safety() {
    std::cout << "[Test 4] Freshness & Staleness Safety... ";

    NodeInventory inv;
    std::string err;
    uint64_t t0 = 100000;

    json report_json = {
        {"schema_version", "1.0"},
        {"agent_version", "1.0.0"},
        {"timestamp_ms", t0},
        {"node_id", "node-stale-test"},
        {"endpoint", "127.0.0.1:50052"},
        {"hostname", "testhost"},
        {"rpc_port", 50052},
        {"status", "ONLINE"},
        {"cpu", {{"architecture", "x86_64"}, {"processor_count", 8}}},
        {"ram", {{"total_bytes", 16000000000ULL}, {"available_bytes", 8000000000ULL}}}
    };

    assert(inv.ingest_agent_report(report_json, t0, err));

    // Fresh at t0 + 10s (under 30s threshold)
    json j_fresh = inv.to_json(t0 + 10000);
    assert(j_fresh["nodes"][0]["is_stale"] == false);
    assert(j_fresh["nodes"][0]["connection_state"] == "ONLINE");
    assert(j_fresh["cluster_summary"]["stale_nodes"] == 0);

    // Stale at t0 + 40s (> 30s threshold)
    json j_stale = inv.to_json(t0 + 40000);
    assert(j_stale["nodes"][0]["is_stale"] == true);
    assert(j_stale["nodes"][0]["connection_state"] == "UNAVAILABLE");
    assert(j_stale["nodes"][0]["is_ready_for_inference"] == false);
    assert(j_stale["cluster_summary"]["stale_nodes"] == 1);

    std::cout << "PASS\n";
}

void test_5_agent_disconnect_and_reconnection() {
    std::cout << "[Test 5] Agent Disconnect & Reconnection... ";

    NodeInventory inv;
    std::string err;
    uint64_t t0 = 100000;

    json report_json = {
        {"schema_version", "1.0"},
        {"agent_version", "1.0.0"},
        {"agent_session_id", "session-reconn-1"},
        {"sequence_number", 1ULL},
        {"timestamp_ms", t0},
        {"node_id", "node-reconn"},
        {"endpoint", "127.0.0.1:50052"},
        {"hostname", "testhost"},
        {"rpc_port", 50052},
        {"status", "ONLINE"},
        {"cpu", {{"architecture", "x86_64"}, {"processor_count", 4}}},
        {"ram", {{"total_bytes", 8000000000ULL}, {"available_bytes", 4000000000ULL}}}
    };

    inv.ingest_agent_report(report_json, t0, err);

    // Stale after disconnect
    json j_stale = inv.to_json(t0 + 45000);
    assert(j_stale["nodes"][0]["is_stale"] == true);
    assert(j_stale["nodes"][0]["connection_state"] == "UNAVAILABLE");

    // Agent reconnects and reports at t0 + 50s with sequence 2
    report_json["ram"]["available_bytes"] = 3500000000ULL;
    report_json["sequence_number"] = 2ULL;
    report_json["timestamp_ms"] = t0 + 50000;
    assert(inv.ingest_agent_report(report_json, t0 + 50000, err));

    // Fresh again
    json j_recovered = inv.to_json(t0 + 51000);
    assert(j_recovered["nodes"][0]["is_stale"] == false);
    assert(j_recovered["nodes"][0]["connection_state"] == "ONLINE");
    assert(j_recovered["nodes"][0]["ram_free_bytes"]["value"] == 3500000000ULL);
    assert(j_recovered["cluster_summary"]["stale_nodes"] == 0);

    std::cout << "PASS\n";
}

void test_6_stable_identity_and_merge() {
    std::cout << "[Test 6] Stable Node Identity & Worker Merge... ";

    NodeInventory inv;
    std::string err;

    // Simulate an existing node created by worker_manager
    NodeRecord rpc_node;
    rpc_node.node_id = "node-127.0.0.1-50052";
    rpc_node.endpoint = "127.0.0.1:50052";
    rpc_node.host = "127.0.0.1";
    rpc_node.port = 50052;
    rpc_node.node_role = "worker";
    rpc_node.connection_state = "READY";
    rpc_node.is_ready_for_inference = true;
    rpc_node.assigned_layers = {33, 34};
    rpc_node.is_required_by_model = true;
    rpc_node.placement_budget_bytes = ResourceValue<uint64_t>::configured(500000000ULL, "SWARM_WORKER_PROFILES", 100);
    inv.upsert_node(rpc_node);

    // Ingest agent report for this same endpoint
    json report_json = {
        {"schema_version", "1.0"},
        {"agent_version", "1.0.0"},
        {"timestamp_ms", 200ULL},
        {"node_id", "node-127.0.0.1-50052"},
        {"endpoint", "127.0.0.1:50052"},
        {"hostname", "DESKTOP-ABC"},
        {"rpc_port", 50052},
        {"status", "ONLINE"},
        {"cpu", {{"architecture", "x86_64"}, {"processor_count", 12}, {"model_name", "Intel Core i7"}}},
        {"ram", {{"total_bytes", 32000000000ULL}, {"available_bytes", 18000000000ULL}}}
    };

    assert(inv.ingest_agent_report(report_json, 200, err));

    // Must still have exactly 1 node (merged, not duplicated)
    assert(inv.get_all_nodes().size() == 1);
    auto node = inv.get_node("node-127.0.0.1-50052").value();

    assert(node.agent_reported == true);
    assert(node.cpu_processor_count == 12);
    assert(node.ram_total_bytes.value.value() == 32000000000ULL);
    // Configured placement budget must remain strictly untouched!
    assert(node.placement_budget_bytes.provenance == ResourceProvenance::CONFIGURED_BUDGET);
    assert(node.placement_budget_bytes.value.value() == 500000000ULL);
    // Model assignment must remain preserved
    assert(node.assigned_layers.size() == 2);
    assert(node.is_required_by_model == true);

    std::cout << "PASS\n";
}

void test_7_loopback_ram_deduplication() {
    std::cout << "[Test 7] Loopback RAM Deduplication... ";

    NodeInventory inv;
    std::string err;

    // Node A on loopback 50052
    json r1 = {
        {"schema_version", "1.0"},
        {"timestamp_ms", 100ULL},
        {"node_id", "node-loopback-1"},
        {"endpoint", "127.0.0.1:50052"},
        {"hostname", "LOCAL-PC"},
        {"rpc_port", 50052},
        {"status", "ONLINE"},
        {"cpu", {{"architecture", "x86_64"}, {"processor_count", 8}}},
        {"ram", {{"total_bytes", 16000000000ULL}, {"available_bytes", 8000000000ULL}}}
    };
    inv.ingest_agent_report(r1, 100, err);

    // Node B on loopback 50053
    json r2 = {
        {"schema_version", "1.0"},
        {"timestamp_ms", 100ULL},
        {"node_id", "node-loopback-2"},
        {"endpoint", "127.0.0.1:50053"},
        {"hostname", "LOCAL-PC"},
        {"rpc_port", 50053},
        {"status", "ONLINE"},
        {"cpu", {{"architecture", "x86_64"}, {"processor_count", 8}}},
        {"ram", {{"total_bytes", 16000000000ULL}, {"available_bytes", 8000000000ULL}}}
    };
    inv.ingest_agent_report(r2, 100, err);

    json j = inv.to_json(100);
    assert(j["cluster_summary"]["loopback_nodes"] == 2);
    assert(j["cluster_summary"]["memory_accounting"]["host_ram_deduplicated"] == true);
    // Deduplicated RAM should equal 16 GB, NOT 32 GB!
    assert(j["cluster_summary"]["memory_accounting"]["independent_host_ram_bytes"] == 16000000000ULL);

    std::cout << "PASS\n";
}

int main() {
    std::cout << "=== Swarm Milestone 8 Offline Unit Tests ===" << std::endl;
    test_1_hardware_probe_and_report_serialization();
    test_2_malformed_report_rejection();
    test_3_unsupported_metrics_and_provenance();
    test_4_freshness_and_staleness_safety();
    test_5_agent_disconnect_and_reconnection();
    test_6_stable_identity_and_merge();
    test_7_loopback_ram_deduplication();
    std::cout << "=== All 7 Milestone 8 Unit Tests PASSED ===" << std::endl;
    return 0;
}
