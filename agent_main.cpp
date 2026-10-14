#include <iostream>
#include <string>
#include <chrono>
#include <thread>
#include <atomic>
#include <csignal>

#include "httplib.h"
#include "agent.h"

static std::atomic<bool> g_running{true};

static void signal_handler(int sig) {
    (void)sig;
    g_running = false;
}

static void print_usage(const char* prog) {
    std::cout << "Swarm Worker Resource Reporting Agent v1.0.0\n"
              << "Usage: " << prog << " [options]\n\n"
              << "Options:\n"
              << "  --coordinator <url>     Coordinator URL (default: http://127.0.0.1:8080)\n"
              << "  --token-file <path>     Path to protected file containing Bearer token (recommended)\n"
              << "  --token <token>         Bearer authentication token via CLI (process-exposed)\n"
              << "  --auth-token <token>    Alias for --token\n"
              << "  --node-id <id>          Stable node identifier (default: auto-generated)\n"
              << "  --endpoint <host:port>  Worker network endpoint (default: 127.0.0.1:50052)\n"
              << "  --rpc-port <port>       Worker GGML RPC port (default: 50052)\n"
              << "  --interval-ms <ms>      Reporting interval in milliseconds (default: 5000)\n"
              << "  --once                  Send a single report and exit\n"
              << "  --version               Print agent version and exit\n"
              << "  --help                  Show this help message\n";
}

static bool parse_url(const std::string& url, std::string& host, int& port, std::string& path_prefix) {
    std::string s = url;
    if (s.rfind("http://", 0) == 0) {
        s = s.substr(7);
    } else if (s.rfind("https://", 0) == 0) {
        s = s.substr(8);
    }

    size_t slash = s.find('/');
    std::string host_port = (slash != std::string::npos) ? s.substr(0, slash) : s;
    path_prefix = (slash != std::string::npos) ? s.substr(slash) : "";

    size_t colon = host_port.find(':');
    if (colon != std::string::npos) {
        host = host_port.substr(0, colon);
        try {
            port = std::stoi(host_port.substr(colon + 1));
        } catch (...) {
            return false;
        }
    } else {
        host = host_port;
        port = 80;
    }
    return !host.empty() && port > 0 && port <= 65535;
}

int main(int argc, char* argv[]) {
    std::string coordinator_url = "http://127.0.0.1:8080";
    std::string custom_node_id = "";
    std::string endpoint = "127.0.0.1:50052";
    std::string auth_token = "";
    std::string token_file = "";
    bool token_from_cli = false;
    uint16_t rpc_port = 50052;
    uint32_t interval_ms = 5000;
    bool once = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--coordinator" && i + 1 < argc) {
            coordinator_url = argv[++i];
        } else if (arg == "--token-file" && i + 1 < argc) {
            token_file = argv[++i];
        } else if ((arg == "--token" || arg == "--auth-token") && i + 1 < argc) {
            auth_token = argv[++i];
            token_from_cli = true;
        } else if (arg == "--node-id" && i + 1 < argc) {
            custom_node_id = argv[++i];
        } else if (arg == "--endpoint" && i + 1 < argc) {
            endpoint = argv[++i];
        } else if (arg == "--rpc-port" && i + 1 < argc) {
            rpc_port = static_cast<uint16_t>(std::stoi(argv[++i]));
        } else if (arg == "--interval-ms" && i + 1 < argc) {
            interval_ms = static_cast<uint32_t>(std::stoi(argv[++i]));
        } else if (arg == "--once") {
            once = true;
        } else if (arg == "--version") {
            std::cout << "swarm_agent version 1.0.0" << std::endl;
            return 0;
        } else if (arg == "--help") {
            print_usage(argv[0]);
            return 0;
        } else {
            std::cerr << "Unknown argument: " << arg << std::endl;
            print_usage(argv[0]);
            return 1;
        }
    }

    if (token_from_cli) {
        std::cerr << "[Agent Security Warning] Passing secrets via command-line arguments exposes tokens to local process listings (Get-Process / Task Manager). Prefer SWARM_TELEMETRY_TOKEN or --token-file in production." << std::endl;
    }

    // Resolve token: --token-file > SWARM_TELEMETRY_TOKEN_FILE > --token > SWARM_TELEMETRY_TOKEN
    if (!token_file.empty()) {
        std::string file_tok;
        if (swarm::security::read_secret_from_file(token_file, file_tok)) {
            auth_token = file_tok;
        } else {
            std::cerr << "[Agent Error] Failed to read token file: " << token_file << std::endl;
            return 1;
        }
    } else if (const char* env_tf = std::getenv("SWARM_TELEMETRY_TOKEN_FILE")) {
        std::string file_tok;
        if (swarm::security::read_secret_from_file(env_tf, file_tok)) {
            auth_token = file_tok;
        } else {
            std::cerr << "[Agent Error] Failed to read SWARM_TELEMETRY_TOKEN_FILE: " << env_tf << std::endl;
            return 1;
        }
    } else if (auth_token.empty()) {
        if (const char* env_token = std::getenv("SWARM_TELEMETRY_TOKEN")) {
            auth_token = env_token;
        } else if (const char* env_auth = std::getenv("SWARM_AUTH_TOKEN")) {
            auth_token = env_auth;
        }
    }

    std::string coord_host;
    int coord_port = 8080;
    std::string path_prefix;
    if (!parse_url(coordinator_url, coord_host, coord_port, path_prefix)) {
        std::cerr << "[Agent Error] Failed to parse coordinator URL: " << coordinator_url << std::endl;
        return 1;
    }

    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    std::cout << "[Agent] Swarm Resource Agent v1.0.0 started." << std::endl;
    std::cout << "[Agent] Coordinator: " << coord_host << ":" << coord_port << std::endl;
    std::cout << "[Agent] Worker Endpoint: " << endpoint << " (RPC port " << rpc_port << ")" << std::endl;
    std::cout << "[Agent] Reporting interval: " << interval_ms << " ms" << std::endl;
    if (!auth_token.empty()) {
        std::cout << "[Agent] Authentication: Bearer token configured (masked)" << std::endl;
    } else {
        std::cout << "[Agent] Authentication: None (loopback-only development mode)" << std::endl;
    }

    auto init_time_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
#ifdef _WIN32
    DWORD pid = GetCurrentProcessId();
#else
    uint32_t pid = 1;
#endif
    std::string session_id = "agent-" + std::to_string(pid) + "-" + std::to_string(init_time_ms);
    uint64_t report_seq = 0;
    std::cout << "[Agent] Session ID: " << session_id << std::endl;

    httplib::Client cli(coord_host, coord_port);
    cli.set_connection_timeout(3, 0);
    cli.set_read_timeout(5, 0);

    do {
        report_seq++;
        swarm::NodeReport report = swarm::HardwareProbe::collect_report(
            custom_node_id, endpoint, rpc_port, session_id, report_seq);
        std::string payload = report.to_json().dump();

        std::string target_path = path_prefix + "/api/v1/nodes/report";
        httplib::Headers headers;
        if (!auth_token.empty()) {
            headers.emplace("Authorization", "Bearer " + auth_token);
        }
        auto res = cli.Post(target_path.c_str(), headers, payload, "application/json");

        if (res) {
            if (res->status == 200) {
                std::cout << "[Agent] Report accepted by coordinator (HTTP 200): " << res->body << std::endl;
            } else if (res->status == 401) {
                std::cerr << "[Agent Error] Coordinator rejected report (HTTP 401 Unauthorized - invalid or missing token): " << res->body << std::endl;
            } else if (res->status == 403) {
                std::cerr << "[Agent Error] Coordinator rejected report (HTTP 403 Forbidden - incorrect token or remote unauthenticated rejection): " << res->body << std::endl;
            } else if (res->status == 413) {
                std::cerr << "[Agent Error] Coordinator rejected report (HTTP 413 Payload Too Large): " << res->body << std::endl;
            } else if (res->status == 400) {
                std::cerr << "[Agent Error] Coordinator rejected report (HTTP 400 Bad Request): " << res->body << std::endl;
            } else {
                std::cerr << "[Agent Warning] Coordinator returned HTTP " << res->status << ": " << res->body << std::endl;
            }
        } else {
            auto err = res.error();
            std::cerr << "[Agent Warning] Failed to connect to coordinator at "
                      << coord_host << ":" << coord_port << " (error: " << static_cast<int>(err) << ")" << std::endl;
        }

        if (once) {
            return (res && res->status == 200) ? 0 : 1;
        }

        // Sleep in small increments to allow responsive shutdown
        uint32_t slept = 0;
        while (g_running && slept < interval_ms) {
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
            slept += 200;
        }
    } while (g_running);

    std::cout << "[Agent] Shutting down cleanly." << std::endl;
    return 0;
}
