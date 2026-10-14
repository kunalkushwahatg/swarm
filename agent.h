#ifndef SWARM_AGENT_H
#define SWARM_AGENT_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <string>
#include <vector>
#include <optional>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <sstream>
#include <fstream>

#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>
#include <dxgi.h>
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "advapi32.lib")
#endif

#include "json.hpp"

using json = nlohmann::json;

namespace swarm {

namespace security {

// Constant-time string equality to prevent timing side-channel attacks on authentication tokens
inline bool constant_time_equals(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) {
        return false;
    }
    volatile unsigned char diff = 0;
    for (size_t i = 0; i < a.size(); ++i) {
        diff |= static_cast<unsigned char>(a[i] ^ b[i]);
    }
    return diff == 0;
}

// Extract Bearer token from HTTP Authorization header
inline bool extract_bearer_token(const std::string& auth_header, std::string& token) {
    if (auth_header.empty()) {
        return false;
    }
    std::string prefix = "Bearer ";
    if (auth_header.size() > 7 &&
        (auth_header.compare(0, 7, "Bearer ") == 0 || auth_header.compare(0, 7, "bearer ") == 0)) {
        token = auth_header.substr(7);
        while (!token.empty() && (token.front() == ' ' || token.front() == '\t')) {
            token.erase(token.begin());
        }
        while (!token.empty() && (token.back() == ' ' || token.back() == '\t')) {
            token.pop_back();
        }
        return !token.empty();
    }
    return false;
}

inline bool is_loopback_address(const std::string& addr) {
    if (addr.empty()) return true;
    if (addr == "127.0.0.1" || addr == "::1" || addr == "localhost") return true;
    if (addr.rfind("127.", 0) == 0) return true;
    return false;
}

// Read secret token securely from file, trimming whitespace
inline bool read_secret_from_file(const std::string& path, std::string& out_secret) {
    if (path.empty()) return false;
    std::ifstream file(path);
    if (!file.is_open()) return false;
    std::string line;
    if (std::getline(file, line)) {
        size_t first = line.find_first_not_of(" \t\r\n");
        if (first != std::string::npos) {
            size_t last = line.find_last_not_of(" \t\r\n");
            out_secret = line.substr(first, last - first + 1);
            return !out_secret.empty();
        }
    }
    return false;
}


enum class AuthResult {
    OK,
    MISSING_AUTH,
    INVALID_FORMAT,
    INVALID_TOKEN,
    REMOTE_UNAUTHENTICATED_FORBIDDEN
};

// Evaluate telemetry authentication for an incoming HTTP request
inline AuthResult verify_telemetry_request(
    const std::string& remote_addr,
    bool has_auth_header,
    const std::string& auth_header_value,
    const std::string& configured_token)
{
    // If coordinator has configured a telemetry auth token:
    if (!configured_token.empty()) {
        if (!has_auth_header) {
            return AuthResult::MISSING_AUTH;
        }
        std::string token;
        if (!extract_bearer_token(auth_header_value, token)) {
            return AuthResult::INVALID_FORMAT;
        }
        if (!constant_time_equals(token, configured_token)) {
            return AuthResult::INVALID_TOKEN;
        }
        return AuthResult::OK;
    }

    // If configured_token is empty (development mode):
    // Only loopback requests are allowed without authentication.
    // Remote unauthenticated requests are rejected.
    if (!remote_addr.empty() && !is_loopback_address(remote_addr)) {
        return AuthResult::REMOTE_UNAUTHENTICATED_FORBIDDEN;
    }

    return AuthResult::OK;
}

} // namespace security

struct AgentCpuInfo {
    std::string architecture = "unknown";
    int processor_count = 0;
    std::string model_name = "Generic CPU";

    json to_json() const {
        return {
            {"architecture", architecture},
            {"processor_count", processor_count},
            {"model_name", model_name},
            {"source", "win32_system_info"},
            {"provenance", "measured"}
        };
    }
};

struct AgentRamInfo {
    uint64_t total_bytes = 0;
    uint64_t available_bytes = 0;

    json to_json() const {
        return {
            {"total_bytes", total_bytes},
            {"available_bytes", available_bytes},
            {"source", "win32_GlobalMemoryStatusEx"},
            {"provenance", "measured"}
        };
    }
};

struct AgentGpuInfo {
    bool detected = false;
    std::string device_name;
    uint64_t vram_total_bytes = 0;
    std::optional<uint64_t> vram_free_bytes = std::nullopt;

    json to_json() const {
        json j;
        j["detected"] = detected;
        if (detected) {
            j["device_name"] = device_name;
            j["vram_total_bytes"] = vram_total_bytes;
            if (vram_free_bytes.has_value()) {
                j["vram_free_bytes"] = vram_free_bytes.value();
            } else {
                j["vram_free_bytes"] = nullptr;
            }
            j["source"] = "win32_dxgi_adapter";
            j["provenance"] = "measured";
        } else {
            j["device_name"] = nullptr;
            j["vram_total_bytes"] = nullptr;
            j["vram_free_bytes"] = nullptr;
            j["source"] = "none_detected";
            j["provenance"] = "unknown";
        }
        return j;
    }
};

struct NodeReport {
    std::string schema_version = "1.0";
    std::string agent_version = "1.0.0";
    std::string agent_session_id;
    uint64_t sequence_number = 0;
    uint64_t timestamp_ms = 0;
    std::string node_id;
    std::string hostname;
    std::string endpoint;
    uint16_t rpc_port = 0;
    std::string status = "ONLINE";

    AgentCpuInfo cpu;
    AgentRamInfo ram;
    AgentGpuInfo gpu;
    std::vector<std::string> unsupported_metrics = {
        "cpu_temperature",
        "fan_speed",
        "process_working_set",
        "nvlink_bandwidth"
    };

    json to_json() const {
        json j;
        j["schema_version"] = schema_version;
        j["agent_version"] = agent_version;
        j["agent_session_id"] = agent_session_id;
        j["sequence_number"] = sequence_number;
        j["timestamp_ms"] = timestamp_ms;
        j["node_id"] = node_id;
        j["hostname"] = hostname;
        j["endpoint"] = endpoint;
        j["rpc_port"] = rpc_port;
        j["status"] = status;
        j["cpu"] = cpu.to_json();
        j["ram"] = ram.to_json();
        j["gpu"] = gpu.to_json();
        j["unsupported_metrics"] = unsupported_metrics;
        return j;
    }

    static std::optional<NodeReport> from_json(const json& j, std::string& err) {
        NodeReport r;
        if (!j.is_object()) {
            err = "Report payload must be a JSON object";
            return std::nullopt;
        }

        r.schema_version = j.value("schema_version", "");
        if (r.schema_version != "1.0") {
            err = "Unsupported schema_version: '" + r.schema_version + "' (expected '1.0')";
            return std::nullopt;
        }

        r.agent_version = j.value("agent_version", "1.0.0");
        r.agent_session_id = j.value("agent_session_id", "");
        r.sequence_number = j.value("sequence_number", 0ULL);

        r.node_id = j.value("node_id", "");
        if (r.node_id.empty()) {
            err = "node_id cannot be empty";
            return std::nullopt;
        }

        r.hostname = j.value("hostname", "unknown-host");
        r.endpoint = j.value("endpoint", "");
        if (r.endpoint.empty()) {
            err = "endpoint cannot be empty";
            return std::nullopt;
        }

        r.rpc_port = j.value("rpc_port", static_cast<uint16_t>(0));
        r.status = j.value("status", "ONLINE");

        // Parse CPU
        if (j.contains("cpu") && j["cpu"].is_object()) {
            const auto& c = j["cpu"];
            r.cpu.architecture = c.value("architecture", "unknown");
            r.cpu.processor_count = c.value("processor_count", 0);
            r.cpu.model_name = c.value("model_name", "Generic CPU");
        }

        // Parse RAM
        if (j.contains("ram") && j["ram"].is_object()) {
            const auto& rm = j["ram"];
            r.ram.total_bytes = rm.value("total_bytes", 0ULL);
            r.ram.available_bytes = rm.value("available_bytes", 0ULL);
            if (r.ram.total_bytes == 0) {
                err = "ram.total_bytes must be greater than zero";
                return std::nullopt;
            }
            if (r.ram.available_bytes > r.ram.total_bytes) {
                err = "ram.available_bytes cannot exceed ram.total_bytes";
                return std::nullopt;
            }
        } else {
            err = "ram object is required in report";
            return std::nullopt;
        }

        // Timestamp parsing and validation
        if (j.contains("timestamp_ms")) {
            if (!j["timestamp_ms"].is_number_unsigned()) {
                err = "Malformed timestamp_ms: must be an unsigned integer";
                return std::nullopt;
            }
            r.timestamp_ms = j["timestamp_ms"].get<uint64_t>();
            if (r.timestamp_ms == 0) {
                err = "Missing or zero timestamp_ms: timestamp must be greater than zero";
                return std::nullopt;
            }
            if (r.timestamp_ms > 4102444800000ULL) {
                err = "Implausible timestamp_ms: timestamp exceeds plausible range";
                return std::nullopt;
            }
        } else if (j.contains("timestamp")) {
            if (!j["timestamp"].is_number_unsigned()) {
                err = "Malformed timestamp: must be an unsigned integer";
                return std::nullopt;
            }
            r.timestamp_ms = j["timestamp"].get<uint64_t>();
            if (r.timestamp_ms == 0) {
                err = "Missing or zero timestamp: timestamp must be greater than zero";
                return std::nullopt;
            }
            if (r.timestamp_ms > 4102444800000ULL) {
                err = "Implausible timestamp: timestamp exceeds plausible range";
                return std::nullopt;
            }
        } else {
            err = "Missing required field: timestamp_ms";
            return std::nullopt;
        }

        // Parse GPU
        if (j.contains("gpu") && j["gpu"].is_object()) {
            const auto& g = j["gpu"];
            r.gpu.detected = g.value("detected", false);
            if (r.gpu.detected) {
                r.gpu.device_name = g.value("device_name", "Unknown GPU");
                r.gpu.vram_total_bytes = g.value("vram_total_bytes", 0ULL);
                if (g.contains("vram_free_bytes") && !g["vram_free_bytes"].is_null()) {
                    r.gpu.vram_free_bytes = g["vram_free_bytes"].get<uint64_t>();
                }
            }
        }

        // Parse unsupported metrics
        if (j.contains("unsupported_metrics") && j["unsupported_metrics"].is_array()) {
            r.unsupported_metrics.clear();
            for (const auto& item : j["unsupported_metrics"]) {
                if (item.is_string()) {
                    r.unsupported_metrics.push_back(item.get<std::string>());
                }
            }
        }

        return r;
    }
};

class HardwareProbe {
public:
    static std::string probe_hostname() {
        char name[256] = {};
#ifdef _WIN32
        DWORD size = sizeof(name);
        if (GetComputerNameA(name, &size)) {
            return std::string(name);
        }
#endif
        return "localhost";
    }

    static AgentCpuInfo probe_cpu() {
        AgentCpuInfo info;
#ifdef _WIN32
        SYSTEM_INFO sys_info = {};
        GetNativeSystemInfo(&sys_info);
        info.processor_count = static_cast<int>(sys_info.dwNumberOfProcessors);
        switch (sys_info.wProcessorArchitecture) {
            case PROCESSOR_ARCHITECTURE_AMD64: info.architecture = "x86_64"; break;
            case PROCESSOR_ARCHITECTURE_ARM64: info.architecture = "arm64"; break;
            case PROCESSOR_ARCHITECTURE_INTEL: info.architecture = "x86"; break;
            default: info.architecture = "unknown"; break;
        }

        HKEY hKey;
        if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, "HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0", 0, KEY_READ, &hKey) == ERROR_SUCCESS) {
            char buf[256] = {};
            DWORD buf_size = sizeof(buf);
            if (RegQueryValueExA(hKey, "ProcessorNameString", NULL, NULL, (LPBYTE)buf, &buf_size) == ERROR_SUCCESS) {
                info.model_name = buf;
                while (!info.model_name.empty() && (info.model_name.front() == ' ' || info.model_name.front() == '\t')) {
                    info.model_name.erase(info.model_name.begin());
                }
                while (!info.model_name.empty() && (info.model_name.back() == ' ' || info.model_name.back() == '\t')) {
                    info.model_name.pop_back();
                }
            }
            RegCloseKey(hKey);
        }
        if (info.model_name.empty()) {
            info.model_name = "Generic CPU";
        }
#else
        info.architecture = "unknown";
        info.processor_count = 1;
        info.model_name = "Generic CPU";
#endif
        return info;
    }

    static AgentRamInfo probe_ram() {
        AgentRamInfo info;
#ifdef _WIN32
        MEMORYSTATUSEX mem_st = {};
        mem_st.dwLength = sizeof(mem_st);
        if (GlobalMemoryStatusEx(&mem_st)) {
            info.total_bytes = mem_st.ullTotalPhys;
            info.available_bytes = mem_st.ullAvailPhys;
        }
#endif
        return info;
    }

    static AgentGpuInfo probe_gpu() {
        AgentGpuInfo info;
#ifdef _WIN32
        IDXGIFactory* factory = nullptr;
        HRESULT hr = CreateDXGIFactory(__uuidof(IDXGIFactory), (void**)&factory);
        if (SUCCEEDED(hr) && factory) {
            IDXGIAdapter* adapter = nullptr;
            UINT i = 0;
            uint64_t max_vram = 0;
            while (factory->EnumAdapters(i, &adapter) != DXGI_ERROR_NOT_FOUND) {
                DXGI_ADAPTER_DESC desc;
                if (SUCCEEDED(adapter->GetDesc(&desc))) {
                    if (desc.DedicatedVideoMemory > max_vram) {
                        max_vram = desc.DedicatedVideoMemory;
                        info.detected = true;
                        char name_buf[256] = {};
                        WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, name_buf, sizeof(name_buf) - 1, NULL, NULL);
                        info.device_name = name_buf;
                        info.vram_total_bytes = desc.DedicatedVideoMemory;
                        info.vram_free_bytes = std::nullopt; // Not measurable via DXGI without DX12 query
                    }
                }
                adapter->Release();
                i++;
            }
            factory->Release();
        }
#endif
        return info;
    }

    static NodeReport collect_report(const std::string& custom_node_id,
                                     const std::string& endpoint,
                                     uint16_t rpc_port,
                                     const std::string& agent_session_id = "",
                                     uint64_t sequence_number = 0) {
        NodeReport report;
        report.schema_version = "1.0";
        report.agent_version = "1.0.0";
        report.agent_session_id = agent_session_id;
        report.sequence_number = sequence_number;
        report.hostname = probe_hostname();

        if (!custom_node_id.empty()) {
            report.node_id = custom_node_id;
        } else {
            report.node_id = "node-" + report.hostname + "-" + std::to_string(rpc_port);
        }

        report.endpoint = endpoint.empty() ? ("127.0.0.1:" + std::to_string(rpc_port)) : endpoint;
        report.rpc_port = rpc_port;
        report.status = "ONLINE";

        auto now = std::chrono::system_clock::now();
        report.timestamp_ms = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count());

        report.cpu = probe_cpu();
        report.ram = probe_ram();
        report.gpu = probe_gpu();
        return report;
    }
};

} // namespace swarm

#endif // SWARM_AGENT_H


