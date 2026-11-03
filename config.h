#ifndef SWARM_CONFIG_H
#define SWARM_CONFIG_H

#include <string>
#include <vector>
#include <cstdlib>
#include <cstdint>
#include <cctype>
#include <optional>
#include <fstream>

namespace swarm_config_parse {

inline std::string trim_copy(const std::string& value) {
    const size_t begin = value.find_first_not_of(" \t\r\n");
    if (begin == std::string::npos) {
        return "";
    }
    const size_t end = value.find_last_not_of(" \t\r\n");
    return value.substr(begin, end - begin + 1);
}

inline bool parse_bool(const char* raw, bool& out) {
    if (!raw) {
        return false;
    }
    std::string value = trim_copy(raw);
    for (char& c : value) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }
    if (value == "1" || value == "true" || value == "yes" || value == "on") {
        out = true;
        return true;
    }
    if (value == "0" || value == "false" || value == "no" || value == "off") {
        out = false;
        return true;
    }
    return false;
}

inline bool parse_i64(const char* raw, long long& out) {
    if (!raw) {
        return false;
    }
    const std::string value = trim_copy(raw);
    if (value.empty()) {
        return false;
    }
    try {
        size_t consumed = 0;
        const long long parsed = std::stoll(value, &consumed);
        if (consumed != value.size()) {
            return false;
        }
        out = parsed;
        return true;
    } catch (...) {
        return false;
    }
}

inline bool parse_u16(const char* raw, uint16_t& out) {
    long long value = 0;
    if (!parse_i64(raw, value) || value <= 0 || value > 65535) {
        return false;
    }
    out = static_cast<uint16_t>(value);
    return true;
}

inline bool parse_u32(const char* raw, uint32_t& out) {
    long long value = 0;
    if (!parse_i64(raw, value) || value < 0 || value > 0xFFFFFFFFLL) {
        return false;
    }
    out = static_cast<uint32_t>(value);
    return true;
}

inline bool parse_u64(const char* raw, uint64_t& out) {
    long long value = 0;
    if (!parse_i64(raw, value) || value < 0) {
        return false;
    }
    out = static_cast<uint64_t>(value);
    return true;
}

inline bool parse_i32(const char* raw, int32_t& out) {
    long long value = 0;
    if (!parse_i64(raw, value) || value < -2147483647LL - 1 || value > 2147483647LL) {
        return false;
    }
    out = static_cast<int32_t>(value);
    return true;
}

} // namespace swarm_config_parse

// Forward declaration
struct WorkerConfig;

struct SwarmConfig {
    // Model configuration
    std::string model_path;

    // Server configuration
    std::string http_bind_address;
    uint16_t http_port;

    // RPC configuration (backward compatibility)
    bool rpc_enabled;
    std::string rpc_endpoint;
    std::vector<std::string> rpc_endpoints;

    // Multi-worker configuration
    std::vector<WorkerConfig> workers;

    // Operational deployment environment (Milestone 11)
    // "development" (default) or "production"
    std::string deployment_env;

    // Inference configuration
    int32_t ctx_size;
    int32_t max_tokens_default;

    // Logging
    bool log_timestamps;

    // Worker management settings
    uint32_t max_local_workers;
    uint32_t worker_startup_timeout_s;
    uint32_t worker_health_check_interval_s;
    uint32_t worker_connection_timeout_s;

    // Resource-aware placement policy
    std::string placement_policy;
    std::string worker_profiles;
    uint64_t headroom_ram_mb;
    uint64_t headroom_vram_mb;
    std::string agent_report_file;
    uint32_t discovery_timeout_ms;
    std::string telemetry_auth_token;
    std::string telemetry_auth_token_file;

    // Constructor with defaults
    SwarmConfig() :
        model_path("models/qwen2.5-3b-instruct-q4_k_m.gguf"),
        http_bind_address("0.0.0.0"),
        http_port(8080),
        rpc_enabled(false),
        rpc_endpoint("127.0.0.1:50052"),
        rpc_endpoints(),
        placement_policy("none"),
        worker_profiles(""),
        headroom_ram_mb(1024),
        headroom_vram_mb(256),
        agent_report_file(""),
        discovery_timeout_ms(0),
        telemetry_auth_token(""),
        telemetry_auth_token_file(""),
        deployment_env("development"),
        ctx_size(2048),
        max_tokens_default(50),
        log_timestamps(true),
        max_local_workers(4),
        worker_startup_timeout_s(30),
        worker_health_check_interval_s(10),
        worker_connection_timeout_s(5) {}
};

// Worker configuration structure
struct WorkerConfig {
    std::string id;
    std::string host;
    uint16_t port;
    bool enabled;
    bool managed_locally;
    std::string cache_dir; // Optional cache directory

    // Constructor with defaults
    WorkerConfig() :
        port(0),
        enabled(false),
        managed_locally(true) {}
};

// Load configuration from environment variables with fallback to defaults
static SwarmConfig load_config_from_env() {
    SwarmConfig config;

    // Model path
    if (const char* env_model_path = std::getenv("SWARM_MODEL_PATH")) {
        config.model_path = env_model_path;
    }

    // HTTP bind address
    if (const char* env_http_bind = std::getenv("SWARM_HTTP_BIND")) {
        config.http_bind_address = env_http_bind;
    }

    // HTTP port
    if (const char* env_http_port = std::getenv("SWARM_HTTP_PORT")) {
        uint16_t parsed = 0;
        if (swarm_config_parse::parse_u16(env_http_port, parsed)) {
            config.http_port = parsed;
        }
    }

    // RPC enabled (backward compatibility)
    if (const char* env_use_rpc = std::getenv("SWARM_USE_RPC")) {
        bool parsed = false;
        if (swarm_config_parse::parse_bool(env_use_rpc, parsed)) {
            config.rpc_enabled = parsed;
        }
    }

    // RPC endpoint (backward compatibility)
    if (const char* env_rpc_endpoint = std::getenv("SWARM_RPC_ENDPOINT")) {
        config.rpc_endpoint = env_rpc_endpoint;
    }

    // Explicit remote RPC endpoints. Each endpoint is host:port, separated by
    // commas. The legacy singular variable remains supported below.
    if (const char* env_rpc_endpoints = std::getenv("SWARM_RPC_ENDPOINTS")) {
        std::string endpoints = env_rpc_endpoints;
        size_t start = 0;
        while (start <= endpoints.size()) {
            const size_t separator = endpoints.find(',', start);
            const size_t end = separator == std::string::npos ? endpoints.size() : separator;
            const std::string endpoint = endpoints.substr(start, end - start);
            const size_t first = endpoint.find_first_not_of(" \t\r\n");
            const size_t last = endpoint.find_last_not_of(" \t\r\n");
            if (first != std::string::npos && last != std::string::npos) {
                config.rpc_endpoints.push_back(endpoint.substr(first, last - first + 1));
            }
            if (separator == std::string::npos) {
                break;
            }
            start = separator + 1;
        }
    }

    // Context size
    if (const char* env_ctx_size = std::getenv("SWARM_CTX_SIZE")) {
        int32_t parsed = 0;
        if (swarm_config_parse::parse_i32(env_ctx_size, parsed) && parsed > 0) {
            config.ctx_size = parsed;
        }
    }

    // Default max tokens
    if (const char* env_max_tokens = std::getenv("SWARM_MAX_TOKENS_DEFAULT")) {
        int32_t parsed = 0;
        if (swarm_config_parse::parse_i32(env_max_tokens, parsed) && parsed > 0) {
            config.max_tokens_default = parsed;
        }
    }

    // Log timestamps
    if (const char* env_log_timestamps = std::getenv("SWARM_LOG_TIMESTAMPS")) {
        bool parsed = false;
        if (swarm_config_parse::parse_bool(env_log_timestamps, parsed)) {
            config.log_timestamps = parsed;
        }
    }

    // Placement policy
    if (const char* env_policy = std::getenv("SWARM_PLACEMENT_POLICY")) {
        config.placement_policy = env_policy;
    }

    // Worker profiles
    if (const char* env_profiles = std::getenv("SWARM_WORKER_PROFILES")) {
        config.worker_profiles = env_profiles;
    }

    // Dynamic placement headroom (RAM)
    if (const char* env_ram_hr = std::getenv("SWARM_RESERVED_HEADROOM_RAM_MB")) {
        uint64_t parsed = 0;
        if (swarm_config_parse::parse_u64(env_ram_hr, parsed)) {
            config.headroom_ram_mb = parsed;
        }
    }

    // Dynamic placement headroom (VRAM)
    if (const char* env_vram_hr = std::getenv("SWARM_RESERVED_HEADROOM_VRAM_MB")) {
        uint64_t parsed = 0;
        if (swarm_config_parse::parse_u64(env_vram_hr, parsed)) {
            config.headroom_vram_mb = parsed;
        }
    }

    // Agent report file for offline/deterministic fixtures
    if (const char* env_rep_file = std::getenv("SWARM_AGENT_REPORT_FILE")) {
        config.agent_report_file = env_rep_file;
    }

    // Discovery timeout for dynamic placement intake
    if (const char* env_disc_to = std::getenv("SWARM_DISCOVERY_TIMEOUT_MS")) {
        uint32_t parsed = 0;
        if (swarm_config_parse::parse_u32(env_disc_to, parsed)) {
            config.discovery_timeout_ms = parsed;
        }
    }

    // Deployment environment (Milestone 11)
    if (const char* env_dep = std::getenv("SWARM_DEPLOYMENT_ENV")) {
        config.deployment_env = env_dep;
    } else if (const char* env_mode = std::getenv("SWARM_MODE")) {
        config.deployment_env = env_mode;
    }

    // Telemetry authentication token file (Milestone 11)
    if (const char* env_token_file = std::getenv("SWARM_TELEMETRY_TOKEN_FILE")) {
        config.telemetry_auth_token_file = env_token_file;
        std::ifstream tf(env_token_file);
        if (tf.is_open()) {
            std::string line;
            if (std::getline(tf, line)) {
                size_t first = line.find_first_not_of(" \t\r\n");
                if (first != std::string::npos) {
                    size_t last = line.find_last_not_of(" \t\r\n");
                    config.telemetry_auth_token = line.substr(first, last - first + 1);
                }
            }
        }
    }

    // Telemetry authentication token (Milestone 10/11)
    if (config.telemetry_auth_token.empty()) {
        if (const char* env_token = std::getenv("SWARM_TELEMETRY_TOKEN")) {
            config.telemetry_auth_token = env_token;
        } else if (const char* env_auth = std::getenv("SWARM_AUTH_TOKEN")) {
            config.telemetry_auth_token = env_auth;
        }
    }

    // Max local workers
    if (const char* env_max_local_workers = std::getenv("SWARM_MAX_LOCAL_WORKERS")) {
        uint32_t parsed = 0;
        if (swarm_config_parse::parse_u32(env_max_local_workers, parsed)) {
            config.max_local_workers = parsed;
        }
    }

    // Worker startup timeout
    if (const char* env_worker_startup_timeout = std::getenv("SWARM_WORKER_STARTUP_TIMEOUT_S")) {
        uint32_t parsed = 0;
        if (swarm_config_parse::parse_u32(env_worker_startup_timeout, parsed)) {
            config.worker_startup_timeout_s = parsed;
        }
    }

    // Worker health check interval
    if (const char* env_worker_health_check_interval = std::getenv("SWARM_WORKER_HEALTH_CHECK_INTERVAL_S")) {
        uint32_t parsed = 0;
        if (swarm_config_parse::parse_u32(env_worker_health_check_interval, parsed)) {
            config.worker_health_check_interval_s = parsed;
        }
    }

    // Worker connection timeout
    if (const char* env_worker_connection_timeout = std::getenv("SWARM_WORKER_CONNECTION_TIMEOUT_S")) {
        uint32_t parsed = 0;
        if (swarm_config_parse::parse_u32(env_worker_connection_timeout, parsed)) {
            config.worker_connection_timeout_s = parsed;
        }
    }

    // Check for worker configuration via JSON
    if (const char* env_workers_json = std::getenv("SWARM_WORKERS_JSON")) {
        // In a real implementation, we would parse JSON here
        // For now, we'll fall back to individual worker variables
        // TODO: Implement JSON parsing for worker configuration
    }
    else {
        // Load individual worker configurations (up to max_local_workers)
        for (uint32_t i = 0; i < config.max_local_workers; ++i) {
            char id_env[64], host_env[64], port_env[64], enabled_env[64], cache_dir_env[256];

            snprintf(id_env, sizeof(id_env), "SWARM_WORKER_%u_ID", i);
            snprintf(host_env, sizeof(host_env), "SWARM_WORKER_%u_HOST", i);
            snprintf(port_env, sizeof(port_env), "SWARM_WORKER_%u_PORT", i);
            snprintf(enabled_env, sizeof(enabled_env), "SWARM_WORKER_%u_ENABLED", i);
            snprintf(cache_dir_env, sizeof(cache_dir_env), "SWARM_WORKER_%u_CACHE_DIR", i);

            WorkerConfig worker;

            // ID
            if (const char* env_id = std::getenv(id_env)) {
                worker.id = env_id;
            } else {
                // If no ID is specified, stop processing workers
                break;
            }

            // Host
            if (const char* env_host = std::getenv(host_env)) {
                worker.host = env_host;
            } else {
                worker.host = "127.0.0.1"; // Default
            }

            // Port
            if (const char* env_port = std::getenv(port_env)) {
                uint16_t parsed_port = 0;
                if (swarm_config_parse::parse_u16(env_port, parsed_port)) {
                    worker.port = parsed_port;
                } else {
                    worker.port = static_cast<uint16_t>(50052 + i); // Default port with offset
                }
            } else {
                worker.port = static_cast<uint16_t>(50052 + i); // Default port with offset
            }

            // Enabled
            if (const char* env_enabled = std::getenv(enabled_env)) {
                bool parsed_enabled = false;
                if (swarm_config_parse::parse_bool(env_enabled, parsed_enabled)) {
                    worker.enabled = parsed_enabled;
                }
            } else {
                // Default: first worker enabled, others disabled
                worker.enabled = (i == 0);
            }

            // Cache directory
            if (const char* env_cache_dir = std::getenv(cache_dir_env)) {
                worker.cache_dir = env_cache_dir;
            } else {
                worker.cache_dir = "./worker_cache_" + worker.id;
            }

            // Only add if we have an ID
            if (!worker.id.empty()) {
                config.workers.push_back(worker);
            }
        }
    }

    // Explicit RPC endpoints are externally managed and must not cause Swarm
    // to launch local worker processes.
    for (size_t i = 0; config.rpc_enabled && i < config.rpc_endpoints.size(); ++i) {
        WorkerConfig endpoint_worker;
        endpoint_worker.id = "rpc-endpoint-" + std::to_string(i);
        endpoint_worker.host = config.rpc_endpoints[i];
        const size_t colon_pos = endpoint_worker.host.rfind(':');
        if (colon_pos != std::string::npos) {
            const std::string port_text = endpoint_worker.host.substr(colon_pos + 1);
            endpoint_worker.host = endpoint_worker.host.substr(0, colon_pos);
            uint16_t parsed_port = 0;
            endpoint_worker.port =
                swarm_config_parse::parse_u16(port_text.c_str(), parsed_port) ? parsed_port : 0;
        }
        endpoint_worker.enabled = true;
        endpoint_worker.cache_dir = "./worker_cache_" + endpoint_worker.id;
        endpoint_worker.managed_locally = false;
        config.workers.push_back(endpoint_worker);
    }

    // Backward compatibility: if no workers configured but legacy RPC settings exist,
    // create a single worker from the legacy configuration
    if (config.workers.empty() && config.rpc_enabled && config.rpc_endpoints.empty()) {
        WorkerConfig legacy_worker;
        legacy_worker.id = "legacy-rpc-worker";
        legacy_worker.host = config.rpc_endpoint;
        // Extract port from endpoint (simplified)
        size_t colon_pos = config.rpc_endpoint.find(':');
        if (colon_pos != std::string::npos) {
            legacy_worker.host = config.rpc_endpoint.substr(0, colon_pos);
            const std::string port_text = config.rpc_endpoint.substr(colon_pos + 1);
            uint16_t parsed_port = 0;
            legacy_worker.port =
                swarm_config_parse::parse_u16(port_text.c_str(), parsed_port) ? parsed_port : 50052;
        } else {
            legacy_worker.host = config.rpc_endpoint;
            legacy_worker.port = 50052;
        }
        legacy_worker.enabled = true;
        legacy_worker.cache_dir = "./worker_cache_legacy";
        legacy_worker.managed_locally = false;
        config.workers.push_back(legacy_worker);
    }

    return config;
}

#endif // SWARM_CONFIG_H