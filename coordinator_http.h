#pragma once

#include "httplib.h"
#include "config.h"
#include "worker.h"
#include "placement.h"
#include "node.h"
#include "inference_engine.h"
#include "metrics_collector.h"

#include <atomic>

namespace swarm {

bool check_telemetry_auth(const httplib::Request &req, httplib::Response &res, const std::string &configured_token);

void setup_coordinator_routes(
    httplib::Server& server,
    const SwarmConfig& config,
    ::WorkerManager& worker_manager,
    ::PlacementTracker& placement_tracker,
    NodeInventory& node_inventory,
    InferenceEngine& inference_engine,
    MetricsCollector& metrics,
    std::atomic<bool>& g_running
);

} // namespace swarm
