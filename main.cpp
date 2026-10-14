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

#ifdef _WIN32
#include <windows.h>
#include <signal.h>
#endif

#include "config.h"
#include "worker.h"
#include "placement.h"
#include "policy.h"
#include "node.h"

using namespace swarm;

using json = nlohmann::json;

// Global variables for graceful shutdown
static bool g_running = true;
static httplib::Server* g_server = nullptr;
static WorkerManager* g_worker_manager = nullptr;
static PlacementTracker g_placement_tracker;
static NodeInventory g_node_inventory;

// Global metrics and timing instrumentation
static std::atomic<uint64_t> g_requests_total{0};
static std::atomic<uint64_t> g_active_requests{0};
static std::atomic<uint64_t> g_tokens_generated_total{0};
static std::atomic<double> g_prompt_eval_seconds_sum{0.0};
static std::atomic<uint64_t> g_prompt_eval_count{0};
static std::atomic<double> g_token_gen_seconds_sum{0.0};
static std::atomic<uint64_t> g_token_gen_count{0};
static std::atomic<double> g_inference_seconds_sum{0.0};
static std::atomic<uint64_t> g_inference_count{0};
static std::atomic<double> g_last_tokens_per_sec{0.0};
static std::atomic<double> g_last_prompt_eval_ms{0.0};
static std::atomic<double> g_last_gen_ms{0.0};
static std::atomic<double> g_last_total_ms{0.0};

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

static std::string get_timestamp(bool include_ms = true) {
    auto now = std::chrono::system_clock::now();
    auto time_t = std::chrono::system_clock::to_time_t(now);
    std::tm tm{};
    localtime_s(&tm, &time_t);

    char buffer[80];
    strftime(buffer, sizeof(buffer), "%Y-%m-%d %H:%M:%S", &tm);

    if (include_ms) {
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            now.time_since_epoch()) % 1000;
        char result[100];
        snprintf(result, sizeof(result), "%s.%03lld", buffer, ms.count());
        return std::string(result);
    }

    return std::string(buffer);
}

static void log_info(const std::string& message, bool include_timestamp = true) {
    if (include_timestamp) {
        std::cout << "[" << get_timestamp() << "] INFO: " << message << std::endl;
    } else {
        std::cout << "INFO: " << message << std::endl;
    }
}

static void log_warn(const std::string& message, bool include_timestamp = true) {
    if (include_timestamp) {
        std::cout << "[" << get_timestamp() << "] WARN: " << message << std::endl;
    } else {
        std::cout << "WARN: " << message << std::endl;
    }
}

static void log_error(const std::string& message, bool include_timestamp = true) {
    if (include_timestamp) {
        std::cerr << "[" << get_timestamp() << "] ERROR: " << message << std::endl;
    } else {
        std::cerr << "ERROR: " << message << std::endl;
    }
}

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
  case GGML_BACKEND_DEVICE_TYPE_CPU:
    return "CPU";
  case GGML_BACKEND_DEVICE_TYPE_GPU:
    return "GPU";
  case GGML_BACKEND_DEVICE_TYPE_IGPU:
    return "integrated GPU";
  case GGML_BACKEND_DEVICE_TYPE_ACCEL:
    return "accelerator";
  case GGML_BACKEND_DEVICE_TYPE_META:
    return "meta";
  default:
    return "unknown";
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

// Helper function to convert WorkerInfo to ggml_backend_dev_t for RPC workers
static std::optional<ggml_backend_dev_t> create_rpc_device_from_worker(const WorkerInfo& worker) {
  if ((worker.type != WorkerType::LOCAL_RPC && worker.type != WorkerType::REMOTE_RPC) ||
      (worker.state != WorkerState::READY && worker.state != WorkerState::BUSY)) {
    return std::nullopt;
  }

  std::string endpoint = worker.host + ":" + std::to_string(worker.port);
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

static bool check_telemetry_auth(const httplib::Request &req, httplib::Response &res, const std::string &configured_token) {
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

int main() {
  llama_backend_init();

  ggml_set_abort_callback([](const char * message) {
    std::cerr << "\n[FATAL GGML ABORT] " << (message ? message : "unspecified error")
              << "\n[FATAL GGML ABORT] A registered backend disconnected or failed during tensor execution."
              << "\n[FATAL GGML ABORT] In the current architecture, Swarm cannot recover dynamically and must terminate.\n"
              << std::endl;
  });

  ggml_backend_load_all();

  // Load configuration
  SwarmConfig config = load_config_from_env();

  log_info("Starting Swarm API Gateway");
  log_info("Model path: " + config.model_path);
  // Preflight validation for deployment environment (Milestone 11)
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

  // Preflight check for remote RPC endpoints (Milestone 11)
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

  // Initialize worker manager
  WorkerManager worker_manager;
  g_worker_manager = &worker_manager; // Set global for signal handler

  // Add workers from configuration
  for (const auto& worker_config : config.workers) {
    WorkerInfo worker;
    worker.id = worker_config.id;
    worker.host = worker_config.host;
    worker.port = worker_config.port;
    worker.type = worker_config.managed_locally
        ? WorkerType::LOCAL_RPC
        : WorkerType::REMOTE_RPC;
    worker.state = WorkerState::STOPPED;

    if (worker.type == WorkerType::REMOTE_RPC &&
        (worker.host.empty() || worker.port == 0)) {
      log_error("Invalid RPC endpoint for worker '" + worker.id +
                "'; expected host:port");
      llama_backend_free();
      return 1;
    }

    if (!worker_manager.add_worker(worker)) {
      log_error("Failed to add worker: " + worker.id);
      // Continue with other workers
    }
  }

  // Start local workers
  if (!worker_manager.start_local_workers()) {
    log_error("Failed to start some local workers");
  }

  // Check worker health (non-blocking initial check)
  for (auto& worker : worker_manager.get_workers()) {
    worker_manager.check_worker_health(worker);
  }

  for (auto& worker : worker_manager.get_workers()) {
    if (worker.type == WorkerType::REMOTE_RPC ||
        worker.type == WorkerType::LOCAL_RPC) {
      auto device = create_rpc_device_from_worker(worker);
      if (!device) {
        log_error("[RPC] Failed to register worker '" + worker.id +
                  "' before model loading");
        worker_manager.stop_local_workers();
        llama_backend_free();
        return 1;
      }
      worker_manager.add_rpc_device(*device);
      ggml_backend_dev_props props;
      ggml_backend_dev_get_props(*device, &props);
      std::string dev_name = ggml_backend_dev_name(*device);
      std::string dev_desc = ggml_backend_dev_description(*device);
      std::string ep = worker.host + ":" + std::to_string(worker.port);
      bool is_loopback = PlacementTracker::is_loopback_address(worker.host);
      std::string mem_scope = is_loopback ? "shared_host" : ("remote_host:" + worker.host);
      worker.device_name = dev_name;
      worker.has_active_backend_connection = true;
      worker.memory_total_bytes = props.memory_total;
      worker.memory_free_bytes = props.memory_free;
      g_placement_tracker.register_backend(dev_name, dev_name, dev_desc, ep,
                                           is_loopback ? "loopback_rpc" : "remote_rpc",
                                           is_loopback, mem_scope,
                                           props.memory_total, props.memory_free);
      log_info("[RPC] Registered device for worker '" + worker.id +
               "': " + dev_name +
               " (" + dev_desc + ")");
      log_info("[RPC] Device memory for '" + worker.id + "': " +
               format_bytes(props.memory_free) + " free / " +
               format_bytes(props.memory_total) + " total");
    }
  }

  // Get local CUDA device
  ggml_backend_dev_t cuda_device =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU);
  if (!cuda_device) {
    log_error("No CUDA device found");
    llama_backend_free();
    return 1;
  }
  ggml_backend_dev_props cuda_props;
  ggml_backend_dev_get_props(cuda_device, &cuda_props);
  std::string cuda_name = ggml_backend_dev_name(cuda_device);
  std::string cuda_desc = ggml_backend_dev_description(cuda_device);
  g_placement_tracker.register_backend(cuda_name, cuda_name, cuda_desc, "", "local_cuda", false, "device_vram", cuda_props.memory_total, cuda_props.memory_free);

  // Register CPU backend
  size_t host_ram_total = 0, host_ram_avail = 0;
#ifdef _WIN32
  MEMORYSTATUSEX mem_status = {};
  mem_status.dwLength = sizeof(mem_status);
  if (GlobalMemoryStatusEx(&mem_status)) {
    host_ram_total = mem_status.ullTotalPhys;
    host_ram_avail = mem_status.ullAvailPhys;
  }
#endif
  g_placement_tracker.register_backend("CPU", "CPU", "Host CPU", "", "cpu", false, "shared_host", host_ram_total, host_ram_avail);

  // Add CUDA device as worker entry for observability in /workers
  WorkerInfo cuda_worker;
  cuda_worker.id = "local-cuda-0";
  cuda_worker.host = "127.0.0.1";
  cuda_worker.port = 0;
  cuda_worker.type = WorkerType::LOCAL_CUDA;
  cuda_worker.state = WorkerState::READY;
  cuda_worker.device_name = cuda_name;
  cuda_worker.device_type = GGML_BACKEND_DEVICE_TYPE_GPU;
  cuda_worker.memory_total_bytes = cuda_props.memory_total;
  cuda_worker.memory_free_bytes = cuda_props.memory_free;
  worker_manager.add_worker(cuda_worker);

  // Install log callback before model loading to capture placement and allocations
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

  // Build device list for llama.cpp: [RPC workers...] [CUDA device] [nullptr]
  std::vector<ggml_backend_dev_t> devices;

  // Add ready RPC workers
  auto rpc_devices = worker_manager.get_rpc_devices();
  devices.insert(devices.end(), rpc_devices.begin(), rpc_devices.end());

  // Add CUDA device
  devices.push_back(cuda_device);

  // Add null terminator
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

  // Determine policy mode
  PlacementPolicyType policy_type = PlacementPolicyEngine::parse_policy_type(config.placement_policy);
  if (config.placement_policy != "none" && !config.placement_policy.empty() &&
      config.placement_policy != "resource_aware" && config.placement_policy != "dynamic" &&
      config.placement_policy != "dynamic_resource_aware") {
    log_error("Unknown SWARM_PLACEMENT_POLICY: '" + config.placement_policy + "'. Expected 'none', 'resource_aware', or 'dynamic'.");
    llama_backend_free();
    return 1;
  }

  // If dynamic placement is requested, handle discovery intake and offline report ingestion
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
      intake_srv.Post("/api/v1/nodes/report", [&](const httplib::Request &req, httplib::Response &res) {
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
      });
      intake_srv.Post("/nodes/report", [&](const httplib::Request &req, httplib::Response &res) {
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
      });
      std::thread srv_th([&]() {
        intake_srv.listen("0.0.0.0", config.http_port);
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

  // Build candidate devices list for policy evaluation in exact device order:
  // RPC devices first, then CUDA device
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

        // Check if agent telemetry is present in NodeInventory
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
  // Local CUDA device
  {
    PlacementPolicyEngine::CandidateDevice cd;
    cd.primary_id = "local-cuda-0";
    cd.secondary_id = "CUDA0";
    cd.device_name = cuda_name;
    cd.backend_type = "cuda";
    cd.is_loopback = false;
    cd.memory_scope = "device_local";
    cd.physical_memory_free = cuda_props.memory_free;
    cd.physical_memory_total = cuda_props.memory_total;
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

  PlacementPolicyResult policy_result = PlacementPolicyEngine::evaluate(
      policy_type, candidate_devices, worker_profiles, 36, n_gpu_layers, llama_max_devices(),
      layer_cost, hr_ram_bytes, hr_vram_bytes, config.ctx_size, now_ms);

  if (!policy_result.success) {
    log_error("Placement policy evaluation failed: " + policy_result.error_message);
    llama_backend_free();
    return 1;
  }

  llama_model_params model_params = llama_model_default_params();
  model_params.n_gpu_layers = n_gpu_layers;
  log_info("Requested GPU layers: " + std::to_string(n_gpu_layers) +
           (n_gpu_layers < 0 ? " (all)" : ""));
  model_params.devices = devices.data();

  if (policy_type == PlacementPolicyType::RESOURCE_AWARE || policy_type == PlacementPolicyType::DYNAMIC) {
    model_params.tensor_split = policy_result.tensor_split.data();
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

  llama_model *model =
      llama_model_load_from_file(config.model_path.c_str(), model_params);
  if (!model) {
    log_error("Failed to load model from: " + config.model_path);
    llama_backend_free();
    return 1;
  }

  llama_context_params ctx_params = llama_context_default_params();
  ctx_params.n_ctx = config.ctx_size;
  llama_context *ctx = llama_init_from_model(model, ctx_params);
  if (!ctx) {
    log_error("Failed to create context");
    llama_model_free(model);
    llama_backend_free();
    return 1;
  }

  // Finalize placement tracking and sync into workers
  g_placement_tracker.finalize();
  g_placement_tracker.sync_to_workers(worker_manager);

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

  const llama_vocab *vocab = llama_model_get_vocab(model);
  std::mutex inference_mutex;

  // Initialize node inventory live snapshot (Milestone 7)
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
  g_server = &server; // Set global for signal handler

#ifdef _WIN32
  SetConsoleCtrlHandler((PHANDLER_ROUTINE)CtrlHandler, TRUE);
#endif

  // Health endpoint
  server.Get("/health", [&](const httplib::Request &req, httplib::Response &res) {
    json health_status;
    health_status["status"] = "ok";
    health_status["timestamp"] = get_timestamp(false);

    // Server status
    health_status["server"] = {
      {"state", "running"},
      {"host", config.http_bind_address},
      {"port", config.http_port}
    };

    // Update worker states for health checking (non-blocking)
    for (auto& worker : worker_manager.get_workers()) {
      worker_manager.check_worker_health(worker);
    }

    // Model status
    health_status["model"] = {
      {"loaded", model != nullptr},
      {"path", config.model_path}
    };

    // Context status
    health_status["context"] = {
      {"created", ctx != nullptr},
      {"size", config.ctx_size}
    };

    auto worker_to_json = [](const WorkerInfo& worker) {
      json worker_json;
      worker_json["id"] = worker.id;
      worker_json["host"] = worker.host;
      worker_json["port"] = worker.port;
      worker_json["type"] = worker_type_to_string(worker.type);
      worker_json["state"] = worker_state_to_string(worker.state);
      if (worker.pid.has_value()) {
        worker_json["pid"] = worker.pid.value();
      }
      worker_json["started_at"] =
        worker.started_at.time_since_epoch().count();
      worker_json["last_health_check"] =
        worker.last_health_check.time_since_epoch().count();
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
        worker_json["device_type"] =
          static_cast<int>(worker.device_type.value());
      }
      return worker_json;
    };

    // Worker status
    json workers_json = json::array();
    for (const auto& worker : worker_manager.get_workers()) {
      workers_json.push_back(worker_to_json(worker));
    }
    health_status["workers"] = workers_json;

    // Determine if inference is ready
    bool inference_ready = (model != nullptr) && (ctx != nullptr);
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
    auto worker_to_json = [](const WorkerInfo& worker) {
      json worker_json;
      worker_json["id"] = worker.id;
      worker_json["host"] = worker.host;
      worker_json["port"] = worker.port;
      worker_json["type"] = worker_type_to_string(worker.type);
      worker_json["state"] = worker_state_to_string(worker.state);
      if (worker.pid.has_value()) {
        worker_json["pid"] = worker.pid.value();
      }
      worker_json["started_at"] =
        worker.started_at.time_since_epoch().count();
      worker_json["last_health_check"] =
        worker.last_health_check.time_since_epoch().count();
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
        worker_json["device_type"] =
          static_cast<int>(worker.device_type.value());
      }
      return worker_json;
    };

    json workers_json = json::array();
    for (const auto& worker : worker_manager.get_workers()) {
      workers_json.push_back(worker_to_json(worker));
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
    json b_json = g_placement_tracker.to_json(ram_total, ram_avail);
    res.set_content(b_json.dump(2), "application/json");
  });

  // Node inventory and resource discovery endpoint (Milestone 7)
  auto handle_get_nodes = [&](const httplib::Request &req, httplib::Response &res) {
    // Refresh worker reachability states (non-blocking)
    for (auto& worker : worker_manager.get_workers()) {
      worker_manager.check_worker_health(worker);
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
    g_node_inventory.update_from_live_state(worker_manager, g_placement_tracker, config.placement_policy, now_ms, ram_total, ram_avail);
    json n_json = g_node_inventory.to_json(now_ms);
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
    if (!g_node_inventory.ingest_agent_report(report_json, now_ms, err)) {
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
    std::string metrics;

    metrics += "# HELP swarm_requests_total Total number of HTTP requests\n";
    metrics += "# TYPE swarm_requests_total counter\n";
    metrics += "swarm_requests_total " + std::to_string(g_requests_total.load()) + "\n\n";

    metrics += "# HELP swarm_active_requests Number of active requests\n";
    metrics += "# TYPE swarm_active_requests gauge\n";
    metrics += "swarm_active_requests " + std::to_string(g_active_requests.load()) + "\n\n";

    // Worker metrics
    int ready_workers = 0;
    int busy_workers = 0;
    int error_workers = 0;
    for (const auto& worker : worker_manager.get_workers()) {
      if (worker.state == WorkerState::READY) ready_workers++;
      if (worker.state == WorkerState::BUSY) busy_workers++;
      if (worker.state == WorkerState::FAILED) error_workers++;
    }

    metrics += "# HELP swarm_worker_state_total Number of workers by state\n";
    metrics += "# TYPE swarm_worker_state_total gauge\n";
    metrics += "swarm_worker_state_total{state=\"ready\"} " + std::to_string(ready_workers) + "\n";
    metrics += "swarm_worker_state_total{state=\"busy\"} " + std::to_string(busy_workers) + "\n";
    metrics += "swarm_worker_state_total{state=\"error\"} " + std::to_string(error_workers) + "\n\n";

    // Node inventory metrics (Milestone 7 & 8)
    int total_nodes = 0;
    int online_nodes = 0;
    int required_nodes = 0;
    int agent_reported_nodes = 0;
    int stale_nodes = 0;
    for (const auto& node : g_node_inventory.get_all_nodes()) {
      total_nodes++;
      if (node.connection_state == "ONLINE" || node.connection_state == "READY") online_nodes++;
      if (node.is_required_by_model) required_nodes++;
      if (node.agent_reported) agent_reported_nodes++;
      if (node.is_stale) stale_nodes++;
    }
    metrics += "# HELP swarm_nodes_total Total number of nodes in inventory\n";
    metrics += "# TYPE swarm_nodes_total gauge\n";
    metrics += "swarm_nodes_total " + std::to_string(total_nodes) + "\n";
    metrics += "# HELP swarm_nodes_online Total number of online nodes\n";
    metrics += "# TYPE swarm_nodes_online gauge\n";
    metrics += "swarm_nodes_online " + std::to_string(online_nodes) + "\n";
    metrics += "# HELP swarm_nodes_required Total number of required nodes for active model\n";
    metrics += "# TYPE swarm_nodes_required gauge\n";
    metrics += "swarm_nodes_required " + std::to_string(required_nodes) + "\n";
    metrics += "# HELP swarm_nodes_agent_reported Total number of nodes reporting via agent\n";
    metrics += "# TYPE swarm_nodes_agent_reported gauge\n";
    metrics += "swarm_nodes_agent_reported " + std::to_string(agent_reported_nodes) + "\n";
    metrics += "# HELP swarm_nodes_stale Total number of nodes with stale reports\n";
    metrics += "# TYPE swarm_nodes_stale gauge\n";
    metrics += "swarm_nodes_stale " + std::to_string(stale_nodes) + "\n\n";

    // Backend buffer allocations
    metrics += "# HELP swarm_backend_model_buffer_bytes Model buffer size allocated on backend in bytes\n";
    metrics += "# TYPE swarm_backend_model_buffer_bytes gauge\n";
    for (const auto& bp : g_placement_tracker.get_all_backends()) {
      metrics += "swarm_backend_model_buffer_bytes{backend=\"" + bp.backend_id + "\",type=\"" + bp.backend_type + "\"} " + std::to_string(bp.model_buffer_bytes) + "\n";
    }
    metrics += "\n";

    metrics += "# HELP swarm_backend_kv_buffer_bytes KV cache buffer size allocated on backend in bytes\n";
    metrics += "# TYPE swarm_backend_kv_buffer_bytes gauge\n";
    for (const auto& bp : g_placement_tracker.get_all_backends()) {
      metrics += "swarm_backend_kv_buffer_bytes{backend=\"" + bp.backend_id + "\",type=\"" + bp.backend_type + "\"} " + std::to_string(bp.kv_buffer_bytes) + "\n";
    }
    metrics += "\n";

    metrics += "# HELP swarm_backend_compute_buffer_bytes Compute buffer size allocated on backend in bytes\n";
    metrics += "# TYPE swarm_backend_compute_buffer_bytes gauge\n";
    for (const auto& bp : g_placement_tracker.get_all_backends()) {
      metrics += "swarm_backend_compute_buffer_bytes{backend=\"" + bp.backend_id + "\",type=\"" + bp.backend_type + "\"} " + std::to_string(bp.compute_buffer_bytes) + "\n";
    }
    metrics += "\n";

    metrics += "# HELP swarm_backend_layers_assigned Number of model layers assigned to backend\n";
    metrics += "# TYPE swarm_backend_layers_assigned gauge\n";
    for (const auto& bp : g_placement_tracker.get_all_backends()) {
      metrics += "swarm_backend_layers_assigned{backend=\"" + bp.backend_id + "\",type=\"" + bp.backend_type + "\"} " + std::to_string(bp.assigned_layers.size()) + "\n";
    }
    metrics += "\n";

    metrics += "# HELP swarm_policy_configured Placement policy mode (1 if active)\n";
    metrics += "# TYPE swarm_policy_configured gauge\n";
    metrics += "swarm_policy_configured{policy=\"" + config.placement_policy + "\"} 1\n\n";

    metrics += "# HELP swarm_backend_virtual_budget_bytes Configured virtual memory budget in bytes\n";
    metrics += "# TYPE swarm_backend_virtual_budget_bytes gauge\n";
    for (const auto& bp : g_placement_tracker.get_all_backends()) {
      if (bp.virtual_budget_bytes > 0) {
        metrics += "swarm_backend_virtual_budget_bytes{backend=\"" + bp.backend_id + "\"} " + std::to_string(bp.virtual_budget_bytes) + "\n";
      }
    }
    metrics += "\n";

    metrics += "# HELP swarm_backend_policy_match Whether actual placement matched prediction (1=match, 0=mismatch)\n";
    metrics += "# TYPE swarm_backend_policy_match gauge\n";
    for (const auto& bp : g_placement_tracker.get_all_backends()) {
      if (bp.policy_match.has_value()) {
        metrics += "swarm_backend_policy_match{backend=\"" + bp.backend_id + "\"} " + (bp.policy_match.value() ? "1" : "0") + "\n";
      }
    }
    metrics += "\n";

    metrics += "# HELP swarm_inference_tokens_generated_total Total number of tokens generated\n";
    metrics += "# TYPE swarm_inference_tokens_generated_total counter\n";
    metrics += "swarm_inference_tokens_generated_total " + std::to_string(g_tokens_generated_total.load()) + "\n\n";

    metrics += "# HELP swarm_inference_tokens_per_second Token generation rate of the most recent request\n";
    metrics += "# TYPE swarm_inference_tokens_per_second gauge\n";
    metrics += "swarm_inference_tokens_per_second " + std::to_string(g_last_tokens_per_sec.load()) + "\n\n";

    metrics += "# HELP swarm_inference_prompt_eval_duration_seconds Total prompt evaluation time in seconds\n";
    metrics += "# TYPE swarm_inference_prompt_eval_duration_seconds summary\n";
    metrics += "swarm_inference_prompt_eval_duration_seconds_sum " + std::to_string(g_prompt_eval_seconds_sum.load()) + "\n";
    metrics += "swarm_inference_prompt_eval_duration_seconds_count " + std::to_string(g_prompt_eval_count.load()) + "\n\n";

    metrics += "# HELP swarm_inference_token_gen_duration_seconds Total token generation time in seconds\n";
    metrics += "# TYPE swarm_inference_token_gen_duration_seconds summary\n";
    metrics += "swarm_inference_token_gen_duration_seconds_sum " + std::to_string(g_token_gen_seconds_sum.load()) + "\n";
    metrics += "swarm_inference_token_gen_duration_seconds_count " + std::to_string(g_token_gen_count.load()) + "\n\n";

    metrics += "# HELP swarm_inference_duration_seconds Total inference time in seconds\n";
    metrics += "# TYPE swarm_inference_duration_seconds summary\n";
    metrics += "swarm_inference_duration_seconds_sum " + std::to_string(g_inference_seconds_sum.load()) + "\n";
    metrics += "swarm_inference_duration_seconds_count " + std::to_string(g_inference_count.load()) + "\n";

    res.set_content(metrics, "text/plain");
  });

  server.Post("/v1/chat/completions", [&](const httplib::Request &req,
                                          httplib::Response &res) {
    // Generate request ID
    static std::atomic<uint64_t> request_counter{0};
    uint64_t request_id = ++request_counter;

    g_requests_total++;
    g_active_requests++;
    struct ActiveReqGuard {
      ~ActiveReqGuard() {
        g_active_requests--;
      }
    } active_guard;

    log_info("[" + std::to_string(request_id) + "] Received request");

    json request_json;
    try {
      request_json = json::parse(req.body);
    } catch (const json::parse_error &) {
      log_warn("[" + std::to_string(request_id) + "] Invalid JSON received");
      res.status = 400;
      res.set_content(R"({"error":"invalid JSON"})", "application/json");
      return;
    }

    if (!request_json.contains("messages") || !request_json["messages"].is_array() ||
        request_json["messages"].empty()) {
      log_warn("[" + std::to_string(request_id) + "] Missing or invalid messages field");
      res.status = 400;
      res.set_content(R"({"error":"messages is required"})", "application/json");
      return;
    }

    std::vector<std::string> message_roles;
    std::vector<std::string> message_contents;
    std::vector<llama_chat_message> chat_messages;
    message_roles.reserve(request_json["messages"].size());
    message_contents.reserve(request_json["messages"].size());
    chat_messages.reserve(request_json["messages"].size());
    for (const auto &message : request_json["messages"]) {
      if (message.is_object() && message.contains("content") &&
          message["content"].is_string()) {
        message_roles.push_back(message.value("role", "user"));
        message_contents.push_back(message["content"].get<std::string>());
        chat_messages.push_back({
            message_roles.back().c_str(),
            message_contents.back().c_str(),
        });
      }
    }
    if (chat_messages.empty()) {
      log_warn("[" + std::to_string(request_id) + "] Messages contain no text");
      res.status = 400;
      res.set_content(R"({"error":"messages contain no text"})", "application/json");
      return;
    }

    const int max_tokens = request_json.value("max_tokens", config.max_tokens_default);
    if (max_tokens < 1 || max_tokens > 512) {
      log_warn("[" + std::to_string(request_id) + "] Invalid max_tokens: " + std::to_string(max_tokens));
      res.status = 400;
      res.set_content(R"({"error":"max_tokens must be 1..512"})", "application/json");
      return;
    }

    const char *chat_template = llama_model_chat_template(model, nullptr);
    if (!chat_template) {
      log_error("[" + std::to_string(request_id) + "] Model has no chat template");
      res.status = 500;
      res.set_content(R"({"error":"model has no chat template"})", "application/json");
      return;
    }

    const int32_t formatted_size = llama_chat_apply_template(
        chat_template, chat_messages.data(), chat_messages.size(), true, nullptr, 0);
    if (formatted_size <= 0) {
      log_error("[" + std::to_string(request_id) + "] Chat template formatting failed");
      res.status = 500;
      res.set_content(R"({"error":"chat template formatting failed"})", "application/json");
      return;
    }

    std::string prompt(static_cast<size_t>(formatted_size), '\0');
    if (llama_chat_apply_template(
            chat_template, chat_messages.data(), chat_messages.size(), true,
            prompt.data(), formatted_size) < 0) {
      log_error("[" + std::to_string(request_id) + "] Chat template formatting failed");
      res.status = 500;
      res.set_content(R"({"error":"chat template formatting failed"})", "application/json");
      return;
    }

    log_info("[" + std::to_string(request_id) + "] Processing formatted prompt (max_tokens: " +
             std::to_string(max_tokens) + ", length: " + std::to_string(prompt.length()) + " chars)");

    // Update worker states for health checking (non-blocking)
    for (auto& worker : worker_manager.get_workers()) {
      worker_manager.check_worker_health(worker);
    }

    // Check if any active RPC backend required by the loaded model is unreachable
    std::string unavailable_desc;
    for (const auto& worker : worker_manager.get_workers()) {
      if (worker.type == WorkerType::REMOTE_RPC || worker.type == WorkerType::LOCAL_RPC) {
        const bool is_required = !worker.assigned_layers.empty() ||
                                 (worker.model_buffer_bytes.has_value() && worker.model_buffer_bytes.value() > 0);
        if (worker.state == WorkerState::UNAVAILABLE || worker.state == WorkerState::FAILED) {
          if (is_required) {
            unavailable_desc = worker.id + " (" + worker.host + ":" + std::to_string(worker.port) + ")";
            break;
          } else {
            log_warn("[" + std::to_string(request_id) + "] Unused registered RPC worker '" + worker.id +
                     "' (" + worker.host + ":" + std::to_string(worker.port) +
                     ") is unavailable, but has 0 assigned model layers. Proceeding with inference.");
          }
        }
      }
    }

    if (!unavailable_desc.empty()) {
      log_error("[" + std::to_string(request_id) + "] Inference request rejected: required RPC backend " +
                unavailable_desc + " is unavailable. A clean restart of Swarm is required.");
      res.status = 503;
      json err_resp = {
        {"error", {
          {"message", "RPC backend " + unavailable_desc + " is unavailable. Distributed inference cannot proceed."},
          {"type", "service_unavailable"},
          {"code", 503},
          {"details", "Model layers were placed on this backend during startup. The current runtime does not support dynamic device reallocation without restarting Swarm."}
        }}
      };
      res.set_content(err_resp.dump(2), "application/json");
      return;
    }

    // RPC devices and model placement are fixed during model loading. A health
    // check here does not change the existing model or context placement.

    std::lock_guard<std::mutex> lock(inference_mutex);
    struct InferenceWorkerGuard {
      std::vector<WorkerInfo>& workers;
      std::vector<std::string> active_ids;
      InferenceWorkerGuard(std::vector<WorkerInfo>& w) : workers(w) {
        for (auto& worker : workers) {
          const bool participates = !worker.assigned_layers.empty() ||
                                    (worker.model_buffer_bytes.has_value() && worker.model_buffer_bytes.value() > 0);
          if (participates) {
            worker.is_inference_active = true;
            if (worker.state == WorkerState::READY) {
              worker.state = WorkerState::BUSY;
            }
            worker.inference_count++;
            active_ids.push_back(worker.id);
          }
        }
      }
      ~InferenceWorkerGuard() {
        for (auto& worker : workers) {
          for (const auto& id : active_ids) {
            if (worker.id == id) {
              worker.is_inference_active = false;
              if (worker.state == WorkerState::BUSY) {
                worker.state = WorkerState::READY;
              }
              break;
            }
          }
        }
      }
    };
    InferenceWorkerGuard worker_guard(worker_manager.get_workers());
    llama_memory_clear(llama_get_memory(ctx), true);

    std::vector<llama_token> prompt_tokens(prompt.size() + 1);
    const int n_prompt_tokens = llama_tokenize(
        vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()),
        prompt_tokens.data(), static_cast<int32_t>(prompt_tokens.size()), true,
        true);
    if (n_prompt_tokens < 0) {
      prompt_tokens.resize(static_cast<size_t>(-n_prompt_tokens));
      const int retry_tokens = llama_tokenize(
          vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()),
          prompt_tokens.data(), static_cast<int32_t>(prompt_tokens.size()), true,
          true);
      if (retry_tokens < 0) {
        log_error("[" + std::to_string(request_id) + "] Prompt tokenization failed");
        res.status = 400;
        res.set_content(R"({"error":"prompt tokenization failed"})", "application/json");
        return;
      }
      prompt_tokens.resize(static_cast<size_t>(retry_tokens));
    } else {
      prompt_tokens.resize(static_cast<size_t>(n_prompt_tokens));
    }

    llama_sampler *sampler = llama_sampler_init_greedy();
    if (!sampler) {
      log_error("[" + std::to_string(request_id) + "] Sampler initialization failed");
      res.status = 500;
      res.set_content(R"({"error":"sampler initialization failed"})", "application/json");
      return;
    }

    res.set_header("Cache-Control", "no-cache");
    res.set_header("Connection", "keep-alive");
    res.set_chunked_content_provider(
        "text/event-stream",
        [&, request_id, prompt_tokens = std::move(prompt_tokens), sampler,
         max_tokens](size_t, httplib::DataSink &sink) mutable {
          // Check if we should still be running
          if (!g_running) {
            llama_sampler_free(sampler);
            return false;
          }

          auto t_infer_start = std::chrono::steady_clock::now();

          llama_batch batch =
              llama_batch_get_one(prompt_tokens.data(), prompt_tokens.size());
          auto t_prompt_start = std::chrono::steady_clock::now();
          int prompt_status = llama_decode(ctx, batch);
          auto t_prompt_end = std::chrono::steady_clock::now();
          double prompt_eval_ms = std::chrono::duration<double, std::milli>(t_prompt_end - t_prompt_start).count();

          if (prompt_status != 0) {
            const std::string error =
                "data: {\"error\":\"prompt decode failed\"}\n\n";
            sink.write(error.c_str(), error.size());
            sink.done();
            llama_sampler_free(sampler);
            return false;
          }

          auto log_top_logits = [&](const char *phase) {
            const float *logits = llama_get_logits_ith(ctx, -1);
            if (!logits) {
              log_error("[" + std::to_string(request_id) + "] " + phase +
                        " logits unavailable at index -1");
              return false;
            }

            std::vector<std::pair<float, llama_token>> top;
            top.reserve(5);
            size_t finite_count = 0;
            size_t nonfinite_count = 0;
            for (llama_token id = 0; id < llama_vocab_n_tokens(vocab); ++id) {
              const float value = logits[id];
              if (!std::isfinite(value)) {
                ++nonfinite_count;
                continue;
              }
              ++finite_count;
              auto position = std::lower_bound(
                  top.begin(), top.end(), value,
                  [](const auto &entry, float candidate) {
                    return entry.first > candidate;
                  });
              if (position != top.end() || top.size() < 5) {
                top.insert(position, {value, id});
                if (top.size() > 5) {
                  top.pop_back();
                }
              }
            }

            std::string details = "[" + std::to_string(request_id) + "] " +
                                 phase + " logits finite=" +
                                 std::to_string(finite_count) + " nonfinite=" +
                                 std::to_string(nonfinite_count) + " top:";
            for (const auto &[value, id] : top) {
              details += " id=" + std::to_string(id) +
                         " value=" + std::to_string(value);
            }
            log_info(details);
            return finite_count > 0;
          };

          if (!log_top_logits("prompt")) {
            const std::string error =
                "data: {\"error\":\"prompt logits unavailable\"}\n\n";
            sink.write(error.c_str(), error.size());
            sink.done();
            llama_sampler_free(sampler);
            return false;
          }

          auto t_gen_start = std::chrono::steady_clock::now();
          int generated = 0;
          for (; generated < max_tokens; ++generated) {
            // Check for shutdown signal during generation
            if (!g_running) {
              llama_sampler_free(sampler);
              return false;
            }

            llama_token token = llama_sampler_sample(sampler, ctx, -1);
            if (token < 0 || token >= llama_vocab_n_tokens(vocab)) {
              const std::string error =
                  "data: {\"error\":\"invalid sampled token\"}\n\n";
              sink.write(error.c_str(), error.size());
              sink.done();
              llama_sampler_free(sampler);
              return false;
            }
            if (llama_vocab_is_eog(vocab, token)) {
              break;
            }

            std::string piece(256, '\0');
            int piece_size = llama_token_to_piece(
                vocab, token, piece.data(), static_cast<int32_t>(piece.size()),
                0, true);
            if (piece_size < 0) {
              piece.resize(static_cast<size_t>(-piece_size));
              piece_size = llama_token_to_piece(
                  vocab, token, piece.data(), static_cast<int32_t>(piece.size()),
                  0, true);
            }
            if (piece_size < 0 || piece_size > static_cast<int>(piece.size())) {
              const std::string error =
                  "data: {\"error\":\"token decoding failed\"}\n\n";
              sink.write(error.c_str(), error.size());
              sink.done();
              llama_sampler_free(sampler);
              return false;
            }
            if (piece_size > 0) {
              piece.resize(piece_size);
              if (generated < 16) {
                log_info("[" + std::to_string(request_id) + "] token " +
                         std::to_string(generated) + " id=" +
                         std::to_string(token) + " text=\"" + piece + "\"");
              }
              const json chunk = {
                  {"choices", {{{"delta", {{"content", piece}}}}}},
                  {"id", request_id}  // Add request ID to response
              };
              const std::string event = "data: " + chunk.dump() + "\n\n";
              if (!sink.write(event.c_str(), event.size())) {
                llama_sampler_free(sampler);
                return false;
              }
            }

            batch = llama_batch_get_one(&token, 1);
            if (llama_decode(ctx, batch) != 0) {
              const std::string error =
                  "data: {\"error\":\"token decode failed\"}\n\n";
              sink.write(error.c_str(), error.size());
              sink.done();
              llama_sampler_free(sampler);
              return false;
            }
            if (generated < 2 && !log_top_logits("next token")) {
              const std::string error =
                  "data: {\"error\":\"next-token logits unavailable\"}\n\n";
              sink.write(error.c_str(), error.size());
              sink.done();
              llama_sampler_free(sampler);
              return false;
            }
          }

          auto t_gen_end = std::chrono::steady_clock::now();
          double gen_ms = std::chrono::duration<double, std::milli>(t_gen_end - t_gen_start).count();
          double total_infer_ms = std::chrono::duration<double, std::milli>(t_gen_end - t_infer_start).count();
          double tokens_per_sec = (gen_ms > 0.0 && generated > 0)
              ? (static_cast<double>(generated) / (gen_ms / 1000.0))
              : 0.0;

          // Record metrics
          g_tokens_generated_total += generated;
          g_prompt_eval_seconds_sum = g_prompt_eval_seconds_sum.load() + (prompt_eval_ms / 1000.0);
          g_prompt_eval_count++;
          g_token_gen_seconds_sum = g_token_gen_seconds_sum.load() + (gen_ms / 1000.0);
          g_token_gen_count++;
          g_inference_seconds_sum = g_inference_seconds_sum.load() + (total_infer_ms / 1000.0);
          g_inference_count++;
          g_last_tokens_per_sec = tokens_per_sec;
          g_last_prompt_eval_ms = prompt_eval_ms;
          g_last_gen_ms = gen_ms;
          g_last_total_ms = total_infer_ms;

          log_info("[" + std::to_string(request_id) + "] Inference completed: tokens=" +
                   std::to_string(generated) + ", prompt_eval_ms=" + std::to_string(prompt_eval_ms) +
                   ", gen_ms=" + std::to_string(gen_ms) + ", total_ms=" + std::to_string(total_infer_ms) +
                   ", speed=" + std::to_string(tokens_per_sec) + " tok/s");

          const json timing_chunk = {
              {"choices", {{{"delta", json::object()}}}},
              {"id", request_id},
              {"timings", {
                  {"prompt_eval_ms", prompt_eval_ms},
                  {"gen_ms", gen_ms},
                  {"total_ms", total_infer_ms},
                  {"tokens_generated", generated},
                  {"tokens_per_sec", tokens_per_sec}
              }}
          };
          const std::string timing_event = "data: " + timing_chunk.dump() + "\n\n";
          sink.write(timing_event.c_str(), timing_event.size());

          sink.write("data: [DONE]\n\n", 14);
          sink.done();
          llama_sampler_free(sampler);
          log_info("[" + std::to_string(request_id) + "] Request completed");
          return true;
        });
  });

  log_info("Swarm API Gateway running on http://" + config.http_bind_address + ":" +
           std::to_string(config.http_port));

  std::thread server_thread([&]() {
    if (!server.listen(config.http_bind_address.c_str(), config.http_port)) {
      log_error("Failed to listen on http://" + config.http_bind_address + ":" +
                std::to_string(config.http_port));
      g_running = false;
    }
  });

  // Main server loop with shutdown checking
  while (g_running) {
    // Periodic worker health checks (every second)
    static auto last_health_check = std::chrono::steady_clock::now();
    auto now = std::chrono::steady_clock::now();
    if (std::chrono::duration_cast<std::chrono::seconds>(now - last_health_check).count() >=
        static_cast<long long>(config.worker_health_check_interval_s)) {
      for (auto& worker : worker_manager.get_workers()) {
        worker_manager.check_worker_health(worker);
      }
      last_health_check = now;
    }

    // Small sleep to prevent busy loop
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }

  log_info("Shutting down server...");
  server.stop();
  if (server_thread.joinable()) {
    server_thread.join();
  }

  llama_free(ctx);
  llama_model_free(model);
  llama_backend_free();
  return 0;
}