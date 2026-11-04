#ifndef NOMINMAX
#define NOMINMAX
#endif

#include "coordinator_http.h"
#include "logger.h"
#include "json.hpp"
#include "rpc_telemetry.h"

#ifdef _WIN32
#include <windows.h>
#endif

using json = nlohmann::json;

namespace swarm {

bool check_telemetry_auth(const httplib::Request &req, httplib::Response &res, const std::string &configured_token) {
    bool has_auth = req.has_header("Authorization");
    std::string auth_hdr = has_auth ? req.get_header_value("Authorization") : "";
    auto auth_res = swarm::security::verify_telemetry_request(req.remote_addr, has_auth, auth_hdr, configured_token);

    switch (auth_res) {
    case swarm::security::AuthResult::OK:
        return true;
    case swarm::security::AuthResult::MISSING_AUTH:
        res.status = 401;
        res.set_header("WWW-Authenticate", "Bearer realm=\"swarm-telemetry\"");
        res.set_content(nlohmann::json{
            {"error", "Unauthorized: Missing Authorization Bearer token"},
            {"code", 401}
        }.dump(2), "application/json");
        return false;
    case swarm::security::AuthResult::INVALID_FORMAT:
        res.status = 401;
        res.set_header("WWW-Authenticate", "Bearer error=\"invalid_token\", error_description=\"Malformed Authorization header\"");
        res.set_content(nlohmann::json{
            {"error", "Unauthorized: Malformed Authorization header, expected 'Bearer <token>'"},
            {"code", 401}
        }.dump(2), "application/json");
        return false;
    case swarm::security::AuthResult::INVALID_TOKEN:
        res.status = 403;
        res.set_content(nlohmann::json{
            {"error", "Forbidden: Invalid telemetry token"},
            {"code", 403}
        }.dump(2), "application/json");
        return false;
    case swarm::security::AuthResult::REMOTE_UNAUTHENTICATED_FORBIDDEN:
        res.status = 403;
        res.set_content(nlohmann::json{
            {"error", "Forbidden: Coordinator has no SWARM_TELEMETRY_TOKEN configured; unauthenticated reports are forbidden from remote addresses"},
            {"code", 403}
        }.dump(2), "application/json");
        return false;
    }
    return false;
}

static json serialize_worker_to_json(const WorkerInfo& worker) {
    json worker_json;
    worker_json["id"] = worker.id;
    worker_json["host"] = worker.host;
    worker_json["port"] = worker.port;
    worker_json["type"] = worker_type_to_string(worker.type);
    worker_json["state"] = worker_state_to_string(worker.state);
    if (worker.pid.has_value()) {
        worker_json["pid"] = worker.pid.value();
    }
    worker_json["started_at"] = worker.started_at.time_since_epoch().count();
    worker_json["last_health_check"] = worker.last_health_check.time_since_epoch().count();
    worker_json["last_error"] = worker.last_error;
    worker_json["is_inference_active"] = worker.is_inference_active;
    worker_json["inference_count"] = worker.inference_count;

    // Observability & placement
    worker_json["backend_id"] = worker.backend_id.value_or(worker.id);
    worker_json["backend_type"] = worker.backend_type.value_or(worker_type_to_string(worker.type));
    worker_json["is_loopback"] = worker.is_loopback;
    worker_json["memory_scope"] = worker.memory_scope.empty() ? (worker.is_loopback ? "shared_host" : "unspecified") : worker.memory_scope;
    worker_json["assigned_layers"] = worker.assigned_layers;
    json ranges = json::array();
    for (const auto& r : worker.assigned_layer_ranges) {
        ranges.push_back({r.first, r.second});
    }
    worker_json["assigned_layer_ranges"] = ranges;
    if (worker.model_buffer_bytes.has_value()) {
        worker_json["model_buffer_bytes"] = worker.model_buffer_bytes.value();
    }
    if (worker.kv_buffer_bytes.has_value()) {
        worker_json["kv_buffer_bytes"] = worker.kv_buffer_bytes.value();
    }
    if (worker.compute_buffer_bytes.has_value()) {
        worker_json["compute_buffer_bytes"] = worker.compute_buffer_bytes.value();
    }
    worker_json["measurement_status"] = worker.measurement_status;
    worker_json["log_derived"] = worker.log_derived;

    // Resource info if available
    if (worker.memory_total_bytes.has_value()) {
        worker_json["memory_total_bytes"] = worker.memory_total_bytes.value();
    }
    if (worker.memory_free_bytes.has_value()) {
        worker_json["memory_free_bytes"] = worker.memory_free_bytes.value();
    }
    if (worker.device_name.has_value()) {
        worker_json["device_name"] = worker.device_name.value();
    }
    if (worker.device_type.has_value()) {
        worker_json["device_type"] = static_cast<int>(worker.device_type.value());
    }
    return worker_json;
}

void setup_coordinator_routes(
    httplib::Server& server,
    const SwarmConfig& config,
    ::WorkerManager& worker_manager,
    ::PlacementTracker& placement_tracker,
    NodeInventory& node_inventory,
    InferenceEngine& inference_engine,
    MetricsCollector& metrics,
    std::atomic<bool>& g_running
) {
    // Security: Protect against DNS rebinding and cross-site request forgery.
    // The coordinator's API gateway must only accept loopback Host headers.
    server.set_pre_routing_handler([](const httplib::Request &req, httplib::Response &res) {
        if (req.has_header("Host")) {
            std::string host = req.get_header_value("Host");
            if (host.find("127.0.0.1") == std::string::npos &&
                host.find("localhost") == std::string::npos &&
                host.find("::1") == std::string::npos) {
                res.status = 403;
                res.set_content("{\"error\":\"Forbidden: Invalid Host header\"}", "application/json");
                return httplib::Server::HandlerResponse::Handled;
            }
        }
        return httplib::Server::HandlerResponse::Unhandled;
    });

    // Health endpoint
    server.Get("/health", [&](const httplib::Request &req, httplib::Response &res) {
        json health_status;
        health_status["status"] = "ok";
        health_status["timestamp"] = get_timestamp(false);

        health_status["server"] = {
            {"state", "running"},
            {"host", config.http_bind_address},
            {"port", config.http_port}
        };

        for (auto& worker : worker_manager.get_workers()) {
            worker_manager.check_worker_health(worker.id);
        }

        health_status["model"] = {
            {"loaded", inference_engine.is_model_loaded()},
            {"path", config.model_path}
        };

        health_status["context"] = {
            {"created", inference_engine.is_context_ready()},
            {"size", config.ctx_size}
        };

        json workers_json = json::array();
        for (const auto& worker : worker_manager.get_workers()) {
            workers_json.push_back(serialize_worker_to_json(worker));
        }
        health_status["workers"] = workers_json;

        bool inference_ready = inference_engine.is_model_loaded() && inference_engine.is_context_ready();
        int ready_workers = 0;
        int total_rpc_workers = 0;
        int required_rpc_workers = 0;
        int ready_required_rpc_workers = 0;
        std::string unready_reason;
        for (const auto& worker : worker_manager.get_workers()) {
            if (worker.type == WorkerType::REMOTE_RPC || worker.type == WorkerType::LOCAL_RPC) {
                total_rpc_workers++;
                const bool is_required = !worker.assigned_layers.empty() ||
                                         (worker.model_buffer_bytes.has_value() && worker.model_buffer_bytes.value() > 0);
                if (is_required) {
                    required_rpc_workers++;
                }
                if (worker.state == WorkerState::READY || worker.state == WorkerState::BUSY) {
                    ready_workers++;
                    if (is_required) {
                        ready_required_rpc_workers++;
                    }
                } else if (is_required && unready_reason.empty()) {
                    unready_reason = "Required RPC worker '" + worker.id + "' is " + worker_state_to_string(worker.state);
                }
            }
        }
        bool all_required_ready = (required_rpc_workers == 0) || (ready_required_rpc_workers == required_rpc_workers);
        health_status["inference"] = {
            {"ready", inference_ready && all_required_ready},
            {"ready_workers", ready_workers},
            {"total_rpc_workers", total_rpc_workers},
            {"required_rpc_workers", required_rpc_workers},
            {"ready_required_rpc_workers", ready_required_rpc_workers},
            {"total_workers", static_cast<int>(worker_manager.get_workers().size())}
        };
        if (!all_required_ready && !unready_reason.empty()) {
            health_status["inference"]["unready_reason"] = unready_reason;
        }

        res.set_content(health_status.dump(2), "application/json");
    });

    // Workers endpoint
    server.Get("/workers", [&](const httplib::Request &req, httplib::Response &res) {
        json workers_json = json::array();
        for (const auto& worker : worker_manager.get_workers()) {
            workers_json.push_back(serialize_worker_to_json(worker));
        }
        res.set_content(workers_json.dump(2), "application/json");
    });

    // Dedicated backends & placement endpoint
    server.Get("/backends", [&](const httplib::Request &req, httplib::Response &res) {
        size_t ram_total = 0, ram_avail = 0;
#ifdef _WIN32
        MEMORYSTATUSEX mem_st = {};
        mem_st.dwLength = sizeof(mem_st);
        if (GlobalMemoryStatusEx(&mem_st)) {
            ram_total = mem_st.ullTotalPhys;
            ram_avail = mem_st.ullAvailPhys;
        }
#endif
        json b_json = placement_tracker.to_json(ram_total, ram_avail);
        res.set_content(b_json.dump(2), "application/json");
    });

    // Node inventory endpoints (Milestone 7 & 8)
    auto handle_get_nodes = [&](const httplib::Request &req, httplib::Response &res) {
        for (auto& worker : worker_manager.get_workers()) {
            worker_manager.check_worker_health(worker.id);
        }

        size_t ram_total = 0, ram_avail = 0;
#ifdef _WIN32
        MEMORYSTATUSEX mem_st = {};
        mem_st.dwLength = sizeof(mem_st);
        if (GlobalMemoryStatusEx(&mem_st)) {
            ram_total = mem_st.ullTotalPhys;
            ram_avail = mem_st.ullAvailPhys;
        }
#endif
        auto now_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());
        node_inventory.update_from_live_state(worker_manager, placement_tracker, config.placement_policy, now_ms, ram_total, ram_avail);
        json n_json = node_inventory.to_json(now_ms);
        res.set_content(n_json.dump(2), "application/json");
    };

    server.Get("/nodes", handle_get_nodes);
    server.Get("/api/v1/nodes", handle_get_nodes);

    // Node reporting agent endpoint (Milestone 8)
    auto handle_node_report = [&](const httplib::Request &req, httplib::Response &res) {
        if (req.body.size() > 65536) {
            res.status = 413;
            res.set_content(json{{"error", "Payload Too Large: report exceeds 64KB limit"}}.dump(2), "application/json");
            return;
        }

        if (!check_telemetry_auth(req, res, config.telemetry_auth_token)) {
            return;
        }

        json report_json;
        try {
            report_json = json::parse(req.body);
        } catch (const std::exception& e) {
            res.status = 400;
            res.set_content(json{{"error", std::string("Malformed JSON payload: ") + e.what()}}.dump(2), "application/json");
            return;
        }

        auto now_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());
        std::string err;
        if (!node_inventory.ingest_agent_report(report_json, now_ms, err)) {
            res.status = 400;
            res.set_content(json{{"error", err}}.dump(2), "application/json");
            return;
        }

        std::string node_id = report_json.value("node_id", "unknown");
        res.status = 200;
        res.set_content(json{
            {"status", "accepted"},
            {"node_id", node_id},
            {"timestamp_ms", now_ms}
        }.dump(2), "application/json");
    };

    server.Post("/api/v1/nodes/report", handle_node_report);
    server.Post("/nodes/report", handle_node_report);

    // Metrics endpoint (Prometheus format)
    server.Get("/metrics", [&](const httplib::Request &req, httplib::Response &res) {
        std::string prometheus_data = metrics.render_prometheus(worker_manager, placement_tracker, node_inventory);
        res.set_content(prometheus_data, "text/plain");
    });

    // Per-request RPC telemetry detail. Lazy-loaded by the chat panel because
    // tensor lists can be large.
    server.Get("/telemetry/request", [&](const httplib::Request &req, httplib::Response &res) {
        if (!check_telemetry_auth(req, res, config.telemetry_auth_token)) {
            return;
        }
        if (!req.has_param("id")) {
            res.status = 400;
            res.set_content(json{{"error", "Missing required query parameter: id"}}.dump(2),
                            "application/json");
            return;
        }

        uint64_t request_id = 0;
        try {
            const std::string id_text = req.get_param_value("id");
            size_t consumed = 0;
            request_id = std::stoull(id_text, &consumed);
            if (consumed != id_text.size() || request_id == 0) {
                throw std::invalid_argument("invalid id");
            }
        } catch (const std::exception&) {
            res.status = 400;
            res.set_content(json{{"error", "Invalid request id"}}.dump(2), "application/json");
            return;
        }

        if (!RpcTelemetryStore::instance().has_request(request_id)) {
            res.status = 404;
            res.set_content(json{
                {"error", "Request telemetry not found"},
                {"request_id", request_id}
            }.dump(2), "application/json");
            return;
        }

        res.set_header("Cache-Control", "no-store");
        res.set_content(RpcTelemetryStore::instance().build_detail_json(request_id),
                        "application/json");
    });

    // Chat completions endpoint
    server.Post("/v1/chat/completions", [&](const httplib::Request &req, httplib::Response &res) {
        static std::atomic<uint64_t> request_counter{0};
        uint64_t request_id = ++request_counter;

        inference_engine.handle_chat_completion(
            request_id, req, res, worker_manager, config, metrics, g_running);
    });
}

} // namespace swarm
