#include "ggml-backend.h"
#include "httplib.h"
#include "json.hpp"
#include "llama.h"

#include <array>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <chrono>
#include <ctime>
#include <optional>
#include <algorithm>
#include <unordered_map>

#ifdef _WIN32
#include <windows.h>
#include <signal.h>
#endif

#include "config.h"
#include "worker.h"
#include "placement.h"
#include "policy.h"
#include "node.h"
#include "logger.h"
#include "metrics_collector.h"
#include "inference_engine.h"
#include "coordinator_http.h"
#include "rpc_telemetry.h"

using namespace swarm;
using json = nlohmann::json;

// Global state for signal handling and lifecycle
static std::atomic<bool> g_running{true};
static httplib::Server* g_server = nullptr;
static WorkerManager* g_worker_manager = nullptr;
static PlacementTracker g_placement_tracker;
static NodeInventory g_node_inventory;
static MetricsCollector g_metrics;

#ifdef _WIN32
static BOOL CtrlHandler(DWORD fdwCtrlType) {
    if (fdwCtrlType == CTRL_C_EVENT || fdwCtrlType == CTRL_BREAK_EVENT ||
        fdwCtrlType == CTRL_CLOSE_EVENT || fdwCtrlType == CTRL_LOGOFF_EVENT ||
        fdwCtrlType == CTRL_SHUTDOWN_EVENT) {
        g_running = false;
        if (g_server) {
            g_server->stop();
        }
        if (g_worker_manager) {
            g_worker_manager->stop_local_workers();
        }
        return TRUE;
    }
    return FALSE;
}
#endif

static ggml_backend_dev_t add_rpc_server(const char *endpoint) {
    log_info("[RPC] Connecting to RPC worker at: " + std::string(endpoint));
    ggml_backend_load_all();
    ggml_backend_reg_t rpc_reg = ggml_backend_reg_by_name("RPC");
    if (!rpc_reg) {
        log_error("[RPC Error] RPC backend module not found!");
        return nullptr;
    }

    using add_server_fn = ggml_backend_reg_t (*)(const char *);
    auto add_server =
        reinterpret_cast<add_server_fn>(ggml_backend_reg_get_proc_address(
            rpc_reg, "ggml_backend_rpc_add_server"));
    if (!add_server) {
        log_error("[RPC Error] ggml_backend_rpc_add_server symbol not found!");
        return nullptr;
    }

    ggml_backend_reg_t server_reg = add_server(endpoint);
    if (!server_reg) {
        log_error("[RPC Error] Failed to connect to RPC server at " + std::string(endpoint) +
                  ".\n[RPC Help] Ensure 'rpc-server' is running on " + std::string(endpoint) +
                  " and firewall port 50052 is open.");
        return nullptr;
    }
    ggml_backend_register(server_reg);
    log_info("[RPC] Successfully connected to RPC worker at " + std::string(endpoint));
    return ggml_backend_reg_dev_get(server_reg, 0);
}

static const char *device_type_name(enum ggml_backend_dev_type type) {
    switch (type) {
    case GGML_BACKEND_DEVICE_TYPE_CPU: return "CPU";
    case GGML_BACKEND_DEVICE_TYPE_GPU: return "GPU";
    case GGML_BACKEND_DEVICE_TYPE_IGPU: return "integrated GPU";
    case GGML_BACKEND_DEVICE_TYPE_ACCEL: return "accelerator";
    case GGML_BACKEND_DEVICE_TYPE_META: return "meta";
    default: return "unknown";
    }
}

static std::string format_bytes(size_t bytes) {
    constexpr const char *units[] = {"B", "KiB", "MiB", "GiB", "TiB"};
    double value = static_cast<double>(bytes);
    size_t unit = 0;
    while (value >= 1024.0 && unit < 4) {
        value /= 1024.0;
        ++unit;
    }

    char result[64];
    std::snprintf(result, sizeof(result), "%.2f %s", value, units[unit]);
    return result;
}

static json get_device_report() {
    json report = {
        {"cpu", {"logical_processors", std::thread::hardware_concurrency()}},
        {"devices", json::array()},
    };

#ifdef _WIN32
    MEMORYSTATUSEX memory_status = {};
    memory_status.dwLength = sizeof(memory_status);
    if (GlobalMemoryStatusEx(&memory_status)) {
        report["cpu"]["ram_total_bytes"] = memory_status.ullTotalPhys;
        report["cpu"]["ram_available_bytes"] = memory_status.ullAvailPhys;
    }
#endif

    for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
        ggml_backend_dev_t device = ggml_backend_dev_get(i);
        ggml_backend_dev_props props = {};
        ggml_backend_dev_get_props(device, &props);

        json device_report = {
            {"index", i},
            {"name", props.name ? props.name : "unknown"},
            {"description", props.description ? props.description : ""},
            {"type", device_type_name(props.type)},
            {"memory_free_bytes", props.memory_free},
            {"memory_total_bytes", props.memory_total},
        };
        report["devices"].push_back(std::move(device_report));
    }

    return report;
}

static void print_device_report(const json &report) {
    const auto &cpu = report.at("cpu");
    log_info("  CPU logical processors: " + std::to_string(cpu.value("logical_processors", 0)));
    if (cpu.contains("ram_total_bytes")) {
        log_info("  System RAM: " +
                 format_bytes(cpu.at("ram_total_bytes").get<size_t>()) + " total, " +
                 format_bytes(cpu.at("ram_available_bytes").get<size_t>()) + " available");
    }

    for (const auto &device : report.at("devices")) {
        log_info("  [" + std::to_string(device.at("index").get<int>()) + "] " +
                 device.at("type").get<std::string>() + ": " +
                 device.at("name").get<std::string>());
        log_info("      " + device.at("description").get<std::string>());
        log_info("      VRAM/device memory: " +
                 format_bytes(device.at("memory_total_bytes").get<size_t>()) + " total, " +
                 format_bytes(device.at("memory_free_bytes").get<size_t>()) + " free");
    }
}

static std::optional<ggml_backend_dev_t> create_rpc_device_from_worker(
    const WorkerInfo& worker,
    std::vector<std::shared_ptr<RpcTelemetryProxy>>& telemetry_proxies) {
    if ((worker.type != WorkerType::LOCAL_RPC && worker.type != WorkerType::REMOTE_RPC) ||
        (worker.state != WorkerState::READY && worker.state != WorkerState::BUSY)) {
        return std::nullopt;
    }

    const std::string real_endpoint = worker.host + ":" + std::to_string(worker.port);
    const bool is_loopback = PlacementTracker::is_loopback_address(worker.host);
    RpcTelemetryStore::instance().register_worker(worker.id, real_endpoint, is_loopback);

    std::string endpoint = real_endpoint;
    auto proxy = std::make_shared<RpcTelemetryProxy>(
        worker.id, worker.id, worker.host, worker.port);
    if (proxy->start()) {
        endpoint = proxy->local_endpoint();
        RpcTelemetryStore::instance().register_proxy(proxy);
        telemetry_proxies.push_back(proxy);
    } else {
        log_warn("[RPC Telemetry] Continuing without per-message telemetry for worker '" +
                 worker.id + "'");
    }

    ggml_backend_dev_t device = add_rpc_server(endpoint.c_str());
    if (device) {
        return device;
    }
    return std::nullopt;
}

static bool parse_gpu_layer_setting(const char *value, int32_t &n_gpu_layers) {
    if (!value || *value == '\0') {
        n_gpu_layers = -1;
        return true;
    }

    char *end = nullptr;
    const long parsed = std::strtol(value, &end, 10);
    if (end == value || *end != '\0' || parsed < -1 || parsed > INT32_MAX) {
        return false;
    }

    n_gpu_layers = static_cast<int32_t>(parsed);
    return true;
}

int main() {
    llama_backend_init();

    ggml_set_abort_callback([](const char * message) {
        std::cerr << "\n[FATAL GGML ABORT] " << (message ? message : "unspecified error")
                  << "\n[FATAL GGML ABORT] A registered backend disconnected or failed during tensor execution."
                  << "\n[FATAL GGML ABORT] In the current architecture, Swarm cannot recover dynamically and must terminate.\n"
                  << std::endl;
    });

    ggml_backend_load_all();

    SwarmConfig config = load_config_from_env();

    log_info("Starting Swarm API Gateway");
    log_info("Model path: " + config.model_path);

    bool is_production = (config.deployment_env == "production" || config.deployment_env == "prod");
    if (is_production) {
        if (config.telemetry_auth_token.empty()) {
            log_error("[FATAL SECURITY PREFLIGHT] SWARM_DEPLOYMENT_ENV is set to 'production', but no telemetry authentication token is configured!");
            log_error("[FATAL SECURITY PREFLIGHT] Production mode requires SWARM_TELEMETRY_TOKEN or SWARM_TELEMETRY_TOKEN_FILE to prevent unauthorized access.");
            llama_backend_free();
            return 1;
        }
        log_info("Deployment Environment: PRODUCTION (Strict security enforcement active)");
        log_info("Telemetry Auth: ENABLED (Bearer token configured)");
    } else {
        log_info("Deployment Environment: DEVELOPMENT");
        if (!config.telemetry_auth_token.empty()) {
            log_info("Telemetry Auth: ENABLED (Bearer token configured)");
        } else {
            log_warn("Telemetry Auth: DISABLED (Unauthenticated loopback development mode; remote reports will be rejected)");
        }
    }

    if (config.rpc_enabled) {
        for (const auto & endpoint : config.rpc_endpoints) {
            size_t colon = endpoint.find(':');
            std::string host = (colon != std::string::npos) ? endpoint.substr(0, colon) : endpoint;
            if (!swarm::security::is_loopback_address(host)) {
                if (is_production) {
                    log_warn("[SECURITY ADVISORY] Remote RPC worker endpoint detected: '" + endpoint + "'.");
                    log_warn("[SECURITY ADVISORY] Upstream GGML RPC is unencrypted and unauthenticated plain TCP. Ensure this endpoint is routed through an encrypted overlay network (WireGuard / Tailscale) and isolated by host firewall.");
                } else {
                    log_info("[SECURITY NOTICE] Remote RPC worker endpoint: '" + endpoint + "' (development mode).");
                }
            }
        }
    }

    log_info("RPC enabled: " + std::string(config.rpc_enabled ? "true" : "false"));
    if (config.rpc_enabled) {
        log_info("Legacy RPC endpoint: " + config.rpc_endpoint);
    }
    if (!config.rpc_endpoints.empty()) {
        log_info("RPC endpoints: " + std::to_string(config.rpc_endpoints.size()));
        for (const auto & endpoint : config.rpc_endpoints) {
            log_info("  " + endpoint);
        }
    }
    log_info("Number of workers configured: " + std::to_string(config.workers.size()));
    log_info("Context size: " + std::to_string(config.ctx_size));
    log_info("Default max tokens: " + std::to_string(config.max_tokens_default));
    log_info("Log timestamps: " + std::string(config.log_timestamps ? "true" : "false"));
    log_info("Max local workers: " + std::to_string(config.max_local_workers));
    log_info("Worker startup timeout: " + std::to_string(config.worker_startup_timeout_s) + "s");
    log_info("Worker health check interval: " + std::to_string(config.worker_health_check_interval_s) + "s");
    log_info("Worker connection timeout: " + std::to_string(config.worker_connection_timeout_s) + "s");

    WorkerManager worker_manager;
    g_worker_manager = &worker_manager;

    // Keeps the local telemetry proxies alive for the lifetime of the process.
    std::vector<std::shared_ptr<RpcTelemetryProxy>> telemetry_proxies;

    for (const auto& worker_config : config.workers) {
        if (!worker_config.enabled) {
            log_info("Skipping disabled worker: " + worker_config.id);
            continue;
        }

        WorkerInfo worker;
        worker.id = worker_config.id;
        worker.host = worker_config.host;
        worker.port = worker_config.port;
        worker.cache_dir = worker_config.cache_dir;
        worker.type = worker_config.managed_locally
            ? WorkerType::LOCAL_RPC
            : WorkerType::REMOTE_RPC;
        worker.state = WorkerState::STOPPED;

        if (worker.type == WorkerType::REMOTE_RPC &&
            (worker.host.empty() || worker.port == 0)) {
            log_error("Invalid RPC endpoint for worker '" + worker.id + "'; expected host:port");
            llama_backend_free();
            return 1;
        }

        if (!worker_manager.add_worker(worker)) {
            log_error("Failed to add worker: " + worker.id);
        }
    }

    if (!worker_manager.start_local_workers()) {
        log_error("Failed to start some local workers");
    }

    // Wait for locally managed workers to bind before probing or registering them.
    {
        const auto deadline = std::chrono::steady_clock::now() +
            std::chrono::seconds(config.worker_startup_timeout_s);
        while (std::chrono::steady_clock::now() < deadline) {
            bool any_starting = false;
            for (const auto& worker : worker_manager.get_workers()) {
                if (worker.type == WorkerType::LOCAL_RPC &&
                    worker.state == WorkerState::STARTING) {
                    any_starting = true;
                    break;
                }
            }
            if (!any_starting) {
                break;
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(200));
            for (auto& worker : worker_manager.get_workers()) {
                worker_manager.check_worker_health(worker.id);
            }
        }
    }

    for (auto& worker : worker_manager.get_workers()) {
        worker_manager.check_worker_health(worker.id);
    }

    for (auto& worker : worker_manager.get_workers()) {
        if (worker.type == WorkerType::REMOTE_RPC || worker.type == WorkerType::LOCAL_RPC) {
            auto device = create_rpc_device_from_worker(worker, telemetry_proxies);
            if (!device) {
                log_error("[RPC] Failed to register worker '" + worker.id + "' before model loading");
                worker_manager.stop_local_workers();
                llama_backend_free();
                return 1;
            }
            worker_manager.add_rpc_device(*device);
            ggml_backend_dev_props props;
            ggml_backend_dev_get_props(*device, &props);
            std::string dev_name = ggml_backend_dev_name(*device);
            std::string ep = worker.host + ":" + std::to_string(worker.port);
            bool is_loopback = PlacementTracker::is_loopback_address(worker.host);
            std::string mem_scope = is_loopback ? "shared_host" : ("remote_host:" + worker.host);
            worker_manager.update_worker(worker.id, [&](WorkerInfo& registered) {
                registered.device_name = dev_name;
                registered.has_active_backend_connection = true;
                registered.memory_total_bytes = props.memory_total;
                registered.memory_free_bytes = props.memory_free;
            });
            g_placement_tracker.register_backend(dev_name, dev_name, ep, ep,
                                                 is_loopback ? "loopback_rpc" : "remote_rpc",
                                                 is_loopback, mem_scope,
                                                 props.memory_total, props.memory_free);
            log_info("[RPC] Registered device for worker '" + worker.id + "': " + dev_name + " (" + ep + ")");
            log_info("[RPC] Device memory for '" + worker.id + "': " +
                     format_bytes(props.memory_free) + " free / " +
                     format_bytes(props.memory_total) + " total");
        }
    }

    ggml_backend_dev_t gpu_device = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU);
    std::string gpu_name = "None";
    ggml_backend_dev_props gpu_props = {};
    if (gpu_device) {
        ggml_backend_dev_get_props(gpu_device, &gpu_props);
        gpu_name = ggml_backend_dev_name(gpu_device);
        std::string gpu_desc = ggml_backend_dev_description(gpu_device);
        g_placement_tracker.register_backend(gpu_name, gpu_name, gpu_desc, "", "local_cuda", false, "device_vram", gpu_props.memory_total, gpu_props.memory_free);

        WorkerInfo gpu_worker;
        gpu_worker.id = "local-cuda-0";
        gpu_worker.host = "127.0.0.1";
        gpu_worker.port = 0;
        gpu_worker.type = WorkerType::LOCAL_CUDA;
        gpu_worker.state = WorkerState::READY;
        gpu_worker.device_name = gpu_name;
        gpu_worker.device_type = GGML_BACKEND_DEVICE_TYPE_GPU;
        gpu_worker.memory_total_bytes = gpu_props.memory_total;
        gpu_worker.memory_free_bytes = gpu_props.memory_free;
        worker_manager.add_worker(gpu_worker);
    } else {
        log_info("[Hardware] No dedicated GPU device found; running in host CPU mode.");
    }

    size_t host_ram_total = 0, host_ram_avail = 0;
#ifdef _WIN32
    MEMORYSTATUSEX mem_status = {};
    mem_status.dwLength = sizeof(mem_status);
    if (GlobalMemoryStatusEx(&mem_status)) {
        host_ram_total = mem_status.ullTotalPhys;
        host_ram_avail = mem_status.ullAvailPhys;
    }
#else
    std::ifstream meminfo("/proc/meminfo");
    if (meminfo.is_open()) {
        std::string line;
        while (std::getline(meminfo, line)) {
            uint64_t kb = 0;
            if (std::sscanf(line.c_str(), "MemTotal: %llu kB", &kb) == 1) {
                host_ram_total = kb * 1024ULL;
            } else if (std::sscanf(line.c_str(), "MemAvailable: %llu kB", &kb) == 1) {
                host_ram_avail = kb * 1024ULL;
            }
        }
    }
#endif
    g_placement_tracker.register_backend("CPU", "CPU", "Host CPU", "", "cpu", false, "shared_host", host_ram_total, host_ram_avail);

    llama_log_set([](ggml_log_level level, const char * text, void * user_data) {
        if (text) {
            fputs(text, stderr);
            fflush(stderr);
            if (user_data) {
                auto * tracker = reinterpret_cast<PlacementTracker*>(user_data);
                tracker->feed_log_text(text);
            }
        }
    }, &g_placement_tracker);

    std::vector<ggml_backend_dev_t> devices;
    auto rpc_devices = worker_manager.get_rpc_devices();
    devices.insert(devices.end(), rpc_devices.begin(), rpc_devices.end());
    if (gpu_device) {
        devices.push_back(gpu_device);
    }
    devices.push_back(nullptr);

    if (devices.empty() || devices.back() != nullptr) {
        log_error("Failed to build valid device list");
        llama_backend_free();
        return 1;
    }

    int32_t n_gpu_layers = -1;
    if (!parse_gpu_layer_setting(std::getenv("SWARM_N_GPU_LAYERS"), n_gpu_layers)) {
        log_error("Invalid SWARM_N_GPU_LAYERS; expected -1, 0, or a non-negative integer");
        llama_backend_free();
        return 1;
    }

    PlacementPolicyType policy_type = PlacementPolicyEngine::parse_policy_type(config.placement_policy);
    if (config.placement_policy != "none" && !config.placement_policy.empty() &&
        config.placement_policy != "resource_aware" && config.placement_policy != "dynamic" &&
        config.placement_policy != "dynamic_resource_aware") {
        log_error("Unknown SWARM_PLACEMENT_POLICY: '" + config.placement_policy + "'. Expected 'none', 'resource_aware', or 'dynamic'.");
        llama_backend_free();
        return 1;
    }

    if (policy_type == PlacementPolicyType::DYNAMIC) {
        if (!config.agent_report_file.empty()) {
            std::string rep_err;
            auto cur_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count());
            if (!g_node_inventory.ingest_report_file(config.agent_report_file, cur_ms, rep_err)) {
                log_error("Failed to ingest SWARM_AGENT_REPORT_FILE '" + config.agent_report_file + "': " + rep_err);
                llama_backend_free();
                return 1;
            }
            log_info("Successfully ingested telemetry reports from '" + config.agent_report_file + "'");
        }

        if (config.discovery_timeout_ms > 0) {
            log_info("Starting discovery intake window for " + std::to_string(config.discovery_timeout_ms) +
                     "ms on port " + std::to_string(config.http_port) + "...");
            httplib::Server intake_srv;
            auto handle_intake = [&](const httplib::Request &req, httplib::Response &res) {
                if (req.body.size() > 65536) {
                    res.status = 413;
                    res.set_content("{\"error\":\"Payload exceeds 64KB limit\"}", "application/json");
                    return;
                }
                if (!check_telemetry_auth(req, res, config.telemetry_auth_token)) {
                    return;
                }
                std::string err;
                auto ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::system_clock::now().time_since_epoch()).count());
                if (g_node_inventory.ingest_agent_report(req.body, ms, err)) {
                    res.status = 200;
                    res.set_content("{\"status\":\"ok\"}", "application/json");
                } else {
                    res.status = 400;
                    res.set_content("{\"error\":\"" + err + "\"}", "application/json");
                }
            };
            intake_srv.Post("/api/v1/nodes/report", handle_intake);
            intake_srv.Post("/nodes/report", handle_intake);
            std::thread srv_th([&]() {
                intake_srv.listen(config.http_bind_address.c_str(), config.http_port);
            });
            std::this_thread::sleep_for(std::chrono::milliseconds(config.discovery_timeout_ms));
            intake_srv.stop();
            if (srv_th.joinable()) {
                srv_th.join();
            }
            log_info("Discovery intake window complete.");
        }
    }

    auto now_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());

    std::vector<PlacementPolicyEngine::CandidateDevice> candidate_devices;
    for (const auto& worker : worker_manager.get_workers()) {
        if (worker.type == WorkerType::REMOTE_RPC || worker.type == WorkerType::LOCAL_RPC) {
            if (worker.state == WorkerState::READY) {
                PlacementPolicyEngine::CandidateDevice cd;
                cd.primary_id = worker.host + ":" + std::to_string(worker.port);
                cd.secondary_id = worker.id;
                cd.device_name = worker.device_name.value_or("RPC");
                cd.backend_type = PlacementTracker::is_loopback_address(worker.host) ? "loopback_rpc" : "remote_rpc";
                cd.is_loopback = PlacementTracker::is_loopback_address(worker.host);
                cd.memory_scope = cd.is_loopback ? "shared_host" : ("remote_host:" + worker.host);
                cd.physical_memory_free = worker.memory_free_bytes.value_or(0);
                cd.physical_memory_total = worker.memory_total_bytes.value_or(0);

                auto node_opt = g_node_inventory.find_node(cd.primary_id, now_ms);
                if (!node_opt.has_value()) {
                    node_opt = g_node_inventory.find_node(cd.secondary_id, now_ms);
                }
                if (node_opt.has_value()) {
                    const auto& node = node_opt.value();
                    cd.has_agent_telemetry = node.agent_reported;
                    cd.telemetry_age_ms = (now_ms > node.last_receipt_time_ms) ? (now_ms - node.last_receipt_time_ms) : 0;
                    cd.is_stale = node.is_stale || (cd.telemetry_age_ms > 30000);
                    cd.provenance = provenance_to_string(node.ram_free_bytes.provenance);
                    cd.agent_ram_total = node.ram_total_bytes.value.value_or(0);
                    cd.agent_ram_available = node.ram_free_bytes.value.value_or(0);
                    cd.agent_vram_total = node.vram_total_bytes.value.value_or(0);
                    cd.is_simulated = node.is_simulated;
                }

                candidate_devices.push_back(cd);
            }
        }
    }
    if (gpu_device) {
        PlacementPolicyEngine::CandidateDevice cd;
        cd.primary_id = "local-cuda-0";
        cd.secondary_id = "CUDA0";
        cd.device_name = gpu_name;
        cd.backend_type = "cuda";
        cd.is_loopback = false;
        cd.memory_scope = "device_local";
        cd.physical_memory_free = gpu_props.memory_free;
        cd.physical_memory_total = gpu_props.memory_total;
        cd.provenance = "MEASURED";
        candidate_devices.push_back(cd);
    } else if (candidate_devices.empty()) {
        PlacementPolicyEngine::CandidateDevice cd;
        cd.primary_id = "CPU";
        cd.secondary_id = "CPU";
        cd.device_name = "Host CPU";
        cd.backend_type = "cpu";
        cd.is_loopback = true;
        cd.memory_scope = "shared_host";
        cd.physical_memory_free = host_ram_avail;
        cd.physical_memory_total = host_ram_total;
        cd.provenance = "MEASURED";
        candidate_devices.push_back(cd);
    }

    std::unordered_map<std::string, DeviceProfile> worker_profiles;
    if (policy_type == PlacementPolicyType::RESOURCE_AWARE) {
        std::string profile_err;
        if (!PlacementPolicyEngine::parse_worker_profiles(config.worker_profiles, worker_profiles, profile_err)) {
            log_error("Failed to parse SWARM_WORKER_PROFILES: " + profile_err);
            llama_backend_free();
            return 1;
        }
        log_info("Resource-aware placement policy enabled with " + std::to_string(worker_profiles.size()) + " configured profile(s).");
    } else if (policy_type == PlacementPolicyType::DYNAMIC) {
        log_info("Dynamic resource-aware placement policy enabled. Reserved RAM headroom: " +
                 std::to_string(config.headroom_ram_mb) + " MiB, VRAM headroom: " +
                 std::to_string(config.headroom_vram_mb) + " MiB.");
    }

    uint64_t hr_ram_bytes = config.headroom_ram_mb * 1024ULL * 1024ULL;
    uint64_t hr_vram_bytes = config.headroom_vram_mb * 1024ULL * 1024ULL;
    uint64_t layer_cost = ConservativeCapacityEstimator::estimate_bytes_per_layer(config.ctx_size);

    int32_t model_transformer_layers = 0;
    if (const char* raw_layers = std::getenv("SWARM_MODEL_TRANSFORMER_LAYERS")) {
        int32_t parsed_layers = 0;
        if (swarm_config_parse::parse_i32(raw_layers, parsed_layers) && parsed_layers > 0) {
            model_transformer_layers = parsed_layers;
        }
    }

    if (model_transformer_layers == 0 && !config.model_path.empty()) {
        struct gguf_init_params gparams = { true, nullptr };
        struct gguf_context * ctx_gguf = gguf_init_from_file(config.model_path.c_str(), gparams);
        if (ctx_gguf) {
            int arch_key_id = gguf_find_key(ctx_gguf, "general.architecture");
            if (arch_key_id >= 0) {
                const char* arch_name = gguf_get_val_str(ctx_gguf, arch_key_id);
                if (arch_name && *arch_name != '\0') {
                    std::string key = std::string(arch_name) + ".block_count";
                    int kid = gguf_find_key(ctx_gguf, key.c_str());
                    if (kid >= 0) {
                        model_transformer_layers = static_cast<int32_t>(gguf_get_val_u32(ctx_gguf, kid));
                        log_info("Detected " + std::to_string(model_transformer_layers) + " transformer blocks from GGUF architecture '" + arch_name + "'");
                    }
                }
            }
            if (model_transformer_layers <= 0) {
                for (const char* arch : {"qwen2", "llama", "phi3", "phi4", "deepseek2", "gemma", "gemma2", "command-r", "mistral", "smollm", "smollm2", "starcoder2", "falcon"}) {
                    std::string key = std::string(arch) + ".block_count";
                    int kid = gguf_find_key(ctx_gguf, key.c_str());
                    if (kid >= 0) {
                        model_transformer_layers = static_cast<int32_t>(gguf_get_val_u32(ctx_gguf, kid));
                        log_info("Detected " + std::to_string(model_transformer_layers) + " transformer blocks from GGUF metadata (" + key + ")");
                        break;
                    }
                }
            }
            gguf_free(ctx_gguf);
        }
    }

    if (model_transformer_layers <= 0) {
        model_transformer_layers = 36;
        log_warn("Falling back to default 36 transformer blocks");
    }

    if (const char* raw_layer_cost = std::getenv("SWARM_ESTIMATED_BYTES_PER_LAYER")) {
        uint64_t parsed_layer_cost = 0;
        if (swarm_config_parse::parse_u64(raw_layer_cost, parsed_layer_cost) && parsed_layer_cost > 0) {
            layer_cost = parsed_layer_cost;
        }
    } else if (model_transformer_layers > 0 && !config.model_path.empty()) {
        std::ifstream file(config.model_path, std::ifstream::ate | std::ifstream::binary);
        if (file.is_open()) {
            uint64_t file_size = static_cast<uint64_t>(file.tellg());
            if (file_size > 0) {
                uint64_t weight_per_layer = file_size / static_cast<uint64_t>(model_transformer_layers + 1);
                layer_cost = ConservativeCapacityEstimator::estimate_bytes_per_layer(config.ctx_size, weight_per_layer);
                log_info("Derived layer cost from model file size: " + std::to_string(layer_cost) + " bytes/layer");
            }
        }
    }
    log_info("Placement policy model profile: " + std::to_string(model_transformer_layers) +
             " transformer blocks, " + std::to_string(layer_cost) + " bytes per layer");

    PlacementPolicyResult policy_result = PlacementPolicyEngine::evaluate(
        policy_type, candidate_devices, worker_profiles, model_transformer_layers, n_gpu_layers, llama_max_devices(),
        layer_cost, hr_ram_bytes, hr_vram_bytes, config.ctx_size, now_ms);

    if (!policy_result.success) {
        log_error("Placement policy evaluation failed: " + policy_result.error_message);
        llama_backend_free();
        return 1;
    }

    if (policy_result.total_offload_layers_requested >= 0) {
        std::string clamped_str = std::to_string(policy_result.total_offload_layers_requested);
#ifdef _WIN32
        _putenv_s("SWARM_N_GPU_LAYERS", clamped_str.c_str());
#else
        setenv("SWARM_N_GPU_LAYERS", clamped_str.c_str(), 1);
#endif
        log_info("Placement policy active offload layers: " + clamped_str);
    }

    if (policy_type == PlacementPolicyType::RESOURCE_AWARE || policy_type == PlacementPolicyType::DYNAMIC) {
        std::string policy_label = (policy_type == PlacementPolicyType::DYNAMIC) ? "dynamic" : "resource_aware";
        g_placement_tracker.set_policy_name(policy_label);
        log_info("Placement policy plan derived " + std::to_string(policy_result.plans.size()) + " device assignments (" + policy_label + "):");
        for (size_t i = 0; i < policy_result.plans.size(); ++i) {
            const auto& plan = policy_result.plans[i];
            std::string pred_str = "[";
            for (size_t j = 0; j < plan.predicted_layers.size(); ++j) {
                if (j > 0) pred_str += ", ";
                pred_str += std::to_string(plan.predicted_layers[j]);
            }
            pred_str += "]";
            log_info("  Plan [" + std::to_string(i) + "] " + plan.device_identifier +
                     ": usable_budget=" + format_bytes(plan.virtual_budget_bytes) +
                     ", capped_capacity=" + std::to_string(plan.capped_layer_capacity) +
                     ", split_weight=" + std::to_string(plan.split_weight) +
                     ", provenance=" + plan.provenance +
                     ", predicted_layers=" + pred_str);
            g_placement_tracker.record_policy_plan(plan.device_identifier, plan.virtual_budget_bytes,
                                                   plan.capped_layer_capacity, plan.split_weight,
                                                   plan.predicted_layers);
        }
    }

    std::vector<float> aligned_tensor_split;
    const float* tensor_split_ptr = nullptr;

    if (policy_type != PlacementPolicyType::NONE && !policy_result.tensor_split.empty()) {
        aligned_tensor_split.assign(llama_max_devices(), 0.0f);
        size_t n_devs = devices.size();
        if (n_devs > 0 && devices.back() == nullptr) {
            n_devs--;
        }

        // Align candidate split weights to the exact native devices[] order
        for (size_t d = 0; d < n_devs && d < aligned_tensor_split.size(); ++d) {
            ggml_backend_dev_t dev = devices[d];
            std::string d_name = ggml_backend_dev_name(dev);
            std::string d_desc = ggml_backend_dev_description(dev);

            float assigned_weight = 0.0f;
            for (const auto& plan : policy_result.plans) {
                if (plan.device_identifier == d_name || plan.device_name == d_name ||
                    (d_name.find("CUDA") != std::string::npos && plan.backend_type == "cuda") ||
                    (!plan.device_identifier.empty() && d_desc.find(plan.device_identifier) != std::string::npos)) {
                    assigned_weight = plan.split_weight;
                    break;
                }
            }
            aligned_tensor_split[d] = assigned_weight;
        }

        float total_weight = 0.0f;
        for (size_t d = 0; d < n_devs; ++d) {
            total_weight += aligned_tensor_split[d];
        }

        if (total_weight > 0.0f) {
            tensor_split_ptr = aligned_tensor_split.data();
            std::string split_weights_str = "[";
            for (size_t d = 0; d < n_devs; ++d) {
                if (d > 0) split_weights_str += ", ";
                split_weights_str += std::string(ggml_backend_dev_name(devices[d])) + "=" + std::to_string(aligned_tensor_split[d]);
            }
            split_weights_str += "]";
            log_info("Passing verified native tensor_split to model loader: " + split_weights_str);
        } else {
            log_warn("Policy tensor_split summed to 0; falling back to default device allocation");
        }
    }

    InferenceEngine inference_engine;
    if (!inference_engine.init_model(config, devices, tensor_split_ptr)) {
        log_error("Failed to initialize model in InferenceEngine");
        llama_backend_free();
        return 1;
    }

    g_placement_tracker.finalize();
    g_placement_tracker.sync_to_workers(worker_manager);
    for (const auto& worker : worker_manager.get_workers()) {
        if (worker.type == WorkerType::REMOTE_RPC || worker.type == WorkerType::LOCAL_RPC) {
            RpcTelemetryStore::instance().update_worker_layers(worker.id, worker.assigned_layers);
        }
    }

    if (policy_type == PlacementPolicyType::RESOURCE_AWARE || policy_type == PlacementPolicyType::DYNAMIC) {
        std::string policy_label = (policy_type == PlacementPolicyType::DYNAMIC) ? "dynamic" : "resource_aware";
        log_info("=== Placement Policy Verification (" + policy_label + ") ===");
        bool all_matched = true;
        for (size_t i = 0; i < policy_result.plans.size(); ++i) {
            const auto& plan = policy_result.plans[i];
            std::vector<int> actual_layers;
            for (const auto& bp : g_placement_tracker.get_all_backends()) {
                if (bp.endpoint == plan.device_identifier || bp.backend_id == plan.device_identifier ||
                    (plan.device_identifier == "local-cuda-0" && bp.backend_id == "CUDA0") ||
                    (plan.device_identifier == "CUDA0" && bp.backend_id == "CUDA0")) {
                    actual_layers = bp.assigned_layers;
                    break;
                }
            }
            bool matched = (actual_layers == plan.predicted_layers);
            if (!matched) all_matched = false;
            std::string actual_str = "[";
            for (size_t j = 0; j < actual_layers.size(); ++j) {
                if (j > 0) actual_str += ", ";
                actual_str += std::to_string(actual_layers[j]);
            }
            actual_str += "]";
            std::string pred_str = "[";
            for (size_t j = 0; j < plan.predicted_layers.size(); ++j) {
                if (j > 0) pred_str += ", ";
                pred_str += std::to_string(plan.predicted_layers[j]);
            }
            pred_str += "]";
            log_info("  Device " + plan.device_identifier + ": " +
                     (matched ? "[MATCH]" : "[MISMATCH]") +
                     " predicted=" + pred_str + " actual=" + actual_str);
        }
        if (all_matched) {
            log_info("Outcome: All backend placements MATCHED the " + policy_label + " policy prediction.");
        } else {
            log_warn("Outcome: MISMATCH between " + policy_label + " policy prediction and GGML layer allocation.");
        }
    }

    log_info("=== Backend Placement & Resource Observability ===");
    for (const auto& bp : g_placement_tracker.get_all_backends()) {
        std::string layer_ranges_str = "[";
        for (size_t i = 0; i < bp.assigned_layer_ranges.size(); ++i) {
            if (i > 0) layer_ranges_str += ", ";
            layer_ranges_str += std::to_string(bp.assigned_layer_ranges[i].first) + "-" + std::to_string(bp.assigned_layer_ranges[i].second);
        }
        layer_ranges_str += "]";
        log_info("Backend: " + bp.backend_id + " (" + bp.backend_type + ", scope=" + bp.memory_scope + ")");
        log_info("  Layers assigned (" + std::to_string(bp.assigned_layers.size()) + "): " + layer_ranges_str);
        log_info("  Model buffer: " + format_bytes(bp.model_buffer_bytes) +
                 ", KV buffer: " + format_bytes(bp.kv_buffer_bytes) +
                 ", Compute buffer: " + format_bytes(bp.compute_buffer_bytes));
    }

    size_t init_ram_total = 0, init_ram_avail = 0;
#ifdef _WIN32
    MEMORYSTATUSEX init_mem = {};
    init_mem.dwLength = sizeof(init_mem);
    if (GlobalMemoryStatusEx(&init_mem)) {
        init_ram_total = init_mem.ullTotalPhys;
        init_ram_avail = init_mem.ullAvailPhys;
    }
#endif
    auto init_now_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
    g_node_inventory.update_from_live_state(worker_manager, g_placement_tracker, config.placement_policy, init_now_ms, init_ram_total, init_ram_avail);

    httplib::Server server;
    g_server = &server;

#ifdef _WIN32
    SetConsoleCtrlHandler((PHANDLER_ROUTINE)CtrlHandler, TRUE);
#endif

    setup_coordinator_routes(server, config, worker_manager, g_placement_tracker, g_node_inventory, inference_engine, g_metrics, g_running);

    log_info("Swarm API Gateway running on http://" + config.http_bind_address + ":" +
             std::to_string(config.http_port));

    std::thread server_thread([&]() {
        if (!server.listen(config.http_bind_address.c_str(), config.http_port)) {
            log_error("Failed to listen on http://" + config.http_bind_address + ":" +
                      std::to_string(config.http_port));
            g_running = false;
        }
    });

    while (g_running) {
        static auto last_health_check = std::chrono::steady_clock::now();
        auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration_cast<std::chrono::seconds>(now - last_health_check).count() >=
            static_cast<long long>(config.worker_health_check_interval_s)) {
            for (auto& worker : worker_manager.get_workers()) {
                worker_manager.check_worker_health(worker.id);
            }
            last_health_check = now;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }

    log_info("Shutting down server...");
    server.stop();
    if (server_thread.joinable()) {
        server_thread.join();
    }

    inference_engine.shutdown();
    llama_backend_free();
    return 0;
}