#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

#include "worker.h"
#include <iostream>
#include <sstream>
#include <algorithm>
#include <thread>
#include <chrono>
#include <fstream>
#include <cstdlib>

#ifdef _WIN32
#include <windows.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <iphlpapi.h>
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "iphlpapi.lib")
#else
#include <unistd.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <signal.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#endif

std::string worker_state_to_string(WorkerState state) {
    switch (state) {
        case WorkerState::STOPPED: return "STOPPED";
        case WorkerState::STARTING: return "STARTING";
        case WorkerState::READY: return "READY";
        case WorkerState::BUSY: return "BUSY";
        case WorkerState::UNAVAILABLE: return "UNAVAILABLE";
        case WorkerState::FAILED: return "ERROR";
        case WorkerState::STOPPING: return "STOPPING";
        default: return "UNKNOWN";
    }
}

std::string worker_type_to_string(WorkerType type) {
    switch (type) {
        case WorkerType::LOCAL_RPC: return "LOCAL_RPC";
        case WorkerType::REMOTE_RPC: return "REMOTE_RPC";
        case WorkerType::LOCAL_CUDA: return "LOCAL_CUDA";
        case WorkerType::UNKNOWN: return "UNKNOWN";
        default: return "UNKNOWN";
    }
}

static bool is_loopback_host(const std::string& host) {
    return (host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "0.0.0.0");
}

#ifdef _WIN32
static bool is_local_port_listening(uint16_t port) {
    DWORD size = 0;
    GetExtendedTcpTable(NULL, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
    if (size == 0) {
        return false;
    }

    std::vector<BYTE> buffer(size);
    PMIB_TCPTABLE_OWNER_PID pTcpTable = reinterpret_cast<PMIB_TCPTABLE_OWNER_PID>(buffer.data());
    if (GetExtendedTcpTable(pTcpTable, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0) != NO_ERROR) {
        return false;
    }

    for (DWORD i = 0; i < pTcpTable->dwNumEntries; ++i) {
        uint16_t table_port = ntohs(static_cast<u_short>(pTcpTable->table[i].dwLocalPort));
        if (table_port == port) {
            return true;
        }
    }
    return false;
}
#endif

// Helper function to check if a port is available
bool is_port_available(const std::string& host, uint16_t port) {
#ifdef _WIN32
    if (is_loopback_host(host) && is_local_port_listening(port)) {
        return false;
    }
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        return false;
    }

    struct addrinfo hints = {};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;
    hints.ai_flags = AI_PASSIVE;

    struct addrinfo* res = nullptr;
    std::string port_str = std::to_string(port);
    const char* host_str = (host.empty() || host == "0.0.0.0") ? nullptr : host.c_str();
    if (getaddrinfo(host_str, port_str.c_str(), &hints, &res) != 0 || !res) {
        WSACleanup();
        return false;
    }

    bool available = false;
    for (struct addrinfo* p = res; p != nullptr; p = p->ai_next) {
        SOCKET sock = socket(p->ai_family, p->ai_socktype, p->ai_protocol);
        if (sock == INVALID_SOCKET) {
            continue;
        }

        int result = bind(sock, p->ai_addr, static_cast<int>(p->ai_addrlen));
        closesocket(sock);
        if (result == 0) {
            available = true;
            break;
        }
    }

    freeaddrinfo(res);
    WSACleanup();
    return available;
#else
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) {
        return false;
    }

    sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    inet_pton(AF_INET, host.c_str(), &addr.sin_addr);

    int result = bind(sock, (sockaddr*)&addr, sizeof(addr));
    close(sock);

    return result == 0;
#endif
}

#ifdef _WIN32
static bool is_process_tcp_connected_to_endpoint(const std::string& host, uint16_t port) {
    DWORD current_pid = GetCurrentProcessId();

    in_addr target_addr = {};
    if (inet_pton(AF_INET, host.c_str(), &target_addr) != 1) {
        struct addrinfo hints = {};
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_STREAM;
        struct addrinfo* res = nullptr;
        if (getaddrinfo(host.c_str(), nullptr, &hints, &res) == 0 && res) {
            target_addr = reinterpret_cast<sockaddr_in*>(res->ai_addr)->sin_addr;
            freeaddrinfo(res);
        } else {
            return false;
        }
    }

    DWORD size = 0;
    GetExtendedTcpTable(NULL, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
    if (size == 0) {
        return false;
    }

    std::vector<BYTE> buffer(size);
    PMIB_TCPTABLE_OWNER_PID pTcpTable = reinterpret_cast<PMIB_TCPTABLE_OWNER_PID>(buffer.data());
    if (GetExtendedTcpTable(pTcpTable, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) != NO_ERROR) {
        return false;
    }

    for (DWORD i = 0; i < pTcpTable->dwNumEntries; ++i) {
        const auto& row = pTcpTable->table[i];
        if (row.dwOwningPid == current_pid) {
            uint16_t remote_port = ntohs(static_cast<u_short>(row.dwRemotePort));
            if (remote_port == port && row.dwRemoteAddr == target_addr.s_addr) {
                if (row.dwState == MIB_TCP_STATE_ESTAB) {
                    return true;
                }
            }
        }
    }
    return false;
}
#else
static bool is_process_tcp_connected_to_endpoint(const std::string& host, uint16_t port) {
    (void)host;
    // On POSIX / Android, inspect /proc/net/tcp for an ESTABLISHED (01) connection on this port
    std::ifstream tcp_file("/proc/net/tcp");
    if (!tcp_file.is_open()) {
        return false;
    }
    char hex_port[16];
    std::snprintf(hex_port, sizeof(hex_port), ":%04X", port);
    std::string line;
    while (std::getline(tcp_file, line)) {
        if (line.find(hex_port) != std::string::npos && line.find(" 01 ") != std::string::npos) {
            return true;
        }
    }
    return false;
}
#endif

// Helper function to check if a worker is reachable via TCP.
// Defaults to 800 ms so offline remote workers never block coordinator route handlers.
bool is_worker_reachable(const std::string& host, uint16_t port, int timeout_ms = 800) {
#ifdef _WIN32
    if (is_loopback_host(host)) {
        return is_local_port_listening(port);
    }
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        return false;
    }

    struct addrinfo hints = {};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    struct addrinfo* res = nullptr;
    std::string port_str = std::to_string(port);
    if (getaddrinfo(host.c_str(), port_str.c_str(), &hints, &res) != 0 || !res) {
        WSACleanup();
        return false;
    }

    bool reachable = false;
    for (struct addrinfo* p = res; p != nullptr; p = p->ai_next) {
        SOCKET sock = socket(p->ai_family, p->ai_socktype, p->ai_protocol);
        if (sock == INVALID_SOCKET) {
            continue;
        }

        // Set non-blocking mode on Windows so select() accurately enforces timeout_ms
        u_long non_blocking = 1;
        ioctlsocket(sock, FIONBIO, &non_blocking);

        int result = connect(sock, p->ai_addr, static_cast<int>(p->ai_addrlen));
        if (result == 0) {
            reachable = true;
            closesocket(sock);
            break;
        } else if (WSAGetLastError() == WSAEWOULDBLOCK) {
            fd_set write_fds, err_fds;
            FD_ZERO(&write_fds);
            FD_SET(sock, &write_fds);
            FD_ZERO(&err_fds);
            FD_SET(sock, &err_fds);

            timeval tv;
            tv.tv_sec = timeout_ms / 1000;
            tv.tv_usec = (timeout_ms % 1000) * 1000;

            int sel_res = select(0, nullptr, &write_fds, &err_fds, &tv);
            if (sel_res > 0 && FD_ISSET(sock, &write_fds)) {
                int sock_err = 0;
                int opt_len = sizeof(sock_err);
                if (getsockopt(sock, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&sock_err), &opt_len) == 0 && sock_err == 0) {
                    reachable = true;
                }
            }
        }
        closesocket(sock);
        if (reachable) {
            break;
        }
    }

    freeaddrinfo(res);
    WSACleanup();
    return reachable;
#else
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) {
        return false;
    }

    // Set timeout
    timeval tv;
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    inet_pton(AF_INET, host.c_str(), &addr.sin_addr);

    int result = connect(sock, (sockaddr*)&addr, sizeof(addr));
    close(sock);

    return result == 0;
#endif
}

std::vector<ggml_backend_dev_t> get_worker_devices(const std::vector<WorkerInfo>& workers) {
    std::vector<ggml_backend_dev_t> devices;
    // For now, we'll focus on getting devices from ready workers
    // The actual RPC device creation will happen in main.cpp
    // This is a placeholder that will be replaced when we integrate with llama.cpp
    return devices;
}

bool is_worker_available(const WorkerInfo& worker) {
    // A worker is available if it's ready or busy (actually participating in inference)
    return worker.state == WorkerState::READY || worker.state == WorkerState::BUSY;
}

void update_worker_state(WorkerInfo& worker, WorkerState new_state) {
    worker.state = new_state;
    if (new_state == WorkerState::READY || new_state == WorkerState::BUSY) {
        worker.last_health_check = std::chrono::system_clock::now();
        worker.last_error.clear(); // Clear error when worker becomes healthy
    }
}

// WorkerManager implementation
WorkerManager::WorkerManager() {
    // Initialize any necessary resources
#ifdef _WIN32
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);
#endif
}

WorkerManager::~WorkerManager() {
    // Cleanup: stop any remaining worker processes
    stop_local_workers();
#ifdef _WIN32
    WSACleanup();
#endif
}

bool WorkerManager::add_worker(const WorkerInfo& worker) {
    std::lock_guard<std::mutex> lock(mutex_);
    // Check for duplicate ID
    for (const auto& w : workers_) {
        if (w.id == worker.id) {
            std::cerr << "Worker with ID '" << worker.id << "' already exists" << std::endl;
            return false;
        }
    }

    // Check for conflicting endpoints (same host:port) for LOCAL_RPC workers
    if (worker.type == WorkerType::LOCAL_RPC) {
        for (const auto& w : workers_) {
            if (w.type == WorkerType::LOCAL_RPC && w.host == worker.host && w.port == worker.port) {
                std::cerr << "Endpoint conflict: " << worker.host << ":" << worker.port
                          << " already used by worker '" << w.id << "'" << std::endl;
                return false;
            }
        }
    }

    workers_.push_back(worker);
    return true;
}

bool WorkerManager::start_local_workers() {
    std::lock_guard<std::mutex> lock(mutex_);
    bool success = true;

    for (auto& worker : workers_) {
        if (worker.type == WorkerType::LOCAL_RPC &&
            worker.state == WorkerState::STOPPED) {

            // Check if port is available
            if (!is_port_available(worker.host, worker.port)) {
                worker.state = WorkerState::FAILED;
                worker.last_error = "Port " + std::to_string(worker.port) + " is already in use";
                std::cerr << "Failed to start worker '" << worker.id << "': " << worker.last_error << std::endl;
                success = false;
                continue;
            }

            // Update state
            worker.state = WorkerState::STARTING;
            worker.started_at = std::chrono::system_clock::now();

            // Build command to start the RPC worker
            std::stringstream cmd;
            cmd << "\"ggml-rpc-server.exe\" --host " << worker.host
                << " --port " << worker.port;

            // ggml-rpc-server only supports -c/--cache as a flag. The cache
            // directory is read from LLAMA_CACHE or the platform default.
            std::string cache_dir = worker.cache_dir.empty()
                ? "./worker_cache_" + worker.id
                : worker.cache_dir;
#ifdef _WIN32
            SetEnvironmentVariableA("LLAMA_CACHE", cache_dir.c_str());
#else
            setenv("LLAMA_CACHE", cache_dir.c_str(), 1);
#endif
            cmd << " --cache";

            std::cout << "Starting worker '" << worker.id << "': " << cmd.str() << std::endl;

            // Start the process
#ifdef _WIN32
            STARTUPINFOA si = { sizeof(si) };
            PROCESS_INFORMATION pi;
            ZeroMemory(&si, sizeof(si));
            si.cb = sizeof(si);
            ZeroMemory(&pi, sizeof(pi));

            std::string cmd_str = cmd.str();
            if (CreateProcessA(
                    NULL,           // No module name (use command line)
                    &cmd_str[0],    // Command line
                    NULL,           // Process handle not inheritable
                    NULL,           // Thread handle not inheritable
                    FALSE,          // Set handle inheritance to FALSE
                    0,              // No creation flags
                    NULL,           // Use parent's environment block
                    NULL,           // Use parent's starting directory
                    &si,            // Pointer to STARTUPINFO structure
                    &pi             // Pointer to PROCESS_INFORMATION structure
                )) {
                // Store the process handle so we can wait on it later
                worker_processes_.push_back(pi.hProcess);
                worker.pid = pi.dwProcessId;
                // Close the thread handle as we don't need it
                CloseHandle(pi.hThread);

                // Initially mark as STARTING, will be updated to READY when health check passes
                worker.state = WorkerState::STARTING;
            } else {
                DWORD error = GetLastError();
                worker.state = WorkerState::FAILED;
                worker.last_error = "Failed to start process: Error " + std::to_string(error);
                std::cerr << "Failed to start worker '" << worker.id << "': " << worker.last_error << std::endl;
                success = false;
            }
#else
            pid_t pid = fork();
            if (pid == 0) {
                // Child process: execute worker binary directly with vector args
                std::string port_str = std::to_string(worker.port);
                execlp("ggml-rpc-server", "ggml-rpc-server",
                       "--host", worker.host.c_str(),
                       "--port", port_str.c_str(),
                       "--cache", (char*)nullptr);
                _exit(127);
            } else if (pid > 0) {
                worker_processes_.push_back(pid);
                worker.pid = pid;
                worker.state = WorkerState::STARTING;
            } else {
                worker.state = WorkerState::FAILED;
                worker.last_error = "Failed to fork worker process";
                std::cerr << "Failed to start worker '" << worker.id << "': " << worker.last_error << std::endl;
                success = false;
            }
#endif
        }
    }

    return success;
}

void WorkerManager::stop_local_workers() {
    std::lock_guard<std::mutex> lock(mutex_);
    // Signal all worker processes to stop and wait for them
#ifdef _WIN32
    for (size_t i = 0; i < worker_processes_.size(); ++i) {
        if (worker_processes_[i] != NULL) {
            // Terminate process
            TerminateProcess(worker_processes_[i], 0);
            // Wait for process to exit
            WaitForSingleObject(worker_processes_[i], 5000); // Wait up to 5 seconds
            CloseHandle(worker_processes_[i]);
            worker_processes_[i] = NULL;
        }
    }
    worker_processes_.clear();
#else
    for (pid_t pid : worker_processes_) {
        if (pid > 0) {
            kill(pid, SIGTERM);
        }
    }
    for (pid_t pid : worker_processes_) {
        if (pid > 0) {
            int status = 0;
            waitpid(pid, &status, 0);
        }
    }
    worker_processes_.clear();
#endif

    // Update worker states
    for (auto& worker : workers_) {
        if (worker.type == WorkerType::LOCAL_RPC &&
            (worker.state == WorkerState::STARTING ||
             worker.state == WorkerState::READY ||
             worker.state == WorkerState::BUSY)) {
            worker.state = WorkerState::STOPPED;
            worker.pid.reset();
        }
    }
}

bool WorkerManager::is_worker_connected_or_reachable(const WorkerInfo& worker, int timeout_ms) {
#ifdef _WIN32
    if (is_process_tcp_connected_to_endpoint(worker.host, worker.port)) {
        return true;
    }
#endif
    return is_worker_reachable(worker.host, worker.port, timeout_ms);
}

namespace {

struct WorkerHealthObservation {
    bool connected = false;
    bool reachable = false;
    bool process_checked = false;
    bool process_running = false;
};

void apply_health_observation(WorkerInfo& worker, const WorkerHealthObservation& observation) {
    // If the worker is currently participating in active inference, do not
    // disrupt the synchronous RPC connection.
    if (worker.is_inference_active || worker.state == WorkerState::BUSY) {
        return;
    }

    worker.last_health_check = std::chrono::system_clock::now();

    if (worker.type == WorkerType::LOCAL_CUDA) {
        // Local CUDA devices run in-process and have no network endpoint to probe.
        if (worker.state == WorkerState::STOPPED ||
            worker.state == WorkerState::STARTING ||
            worker.state == WorkerState::UNAVAILABLE ||
            worker.state == WorkerState::FAILED) {
            worker.state = WorkerState::READY;
            worker.last_error.clear();
        }
        return;
    }

    if (worker.type != WorkerType::LOCAL_RPC) {
        // For non-local workers (REMOTE_RPC):
        // 1. Check if our coordinator process already has an established TCP
        //    connection to this worker endpoint (e.g. via GGML RPC backend).
        if (observation.connected) {
            worker.has_active_backend_connection = true;
            if (worker.state == WorkerState::STOPPED ||
                worker.state == WorkerState::STARTING ||
                worker.state == WorkerState::UNAVAILABLE) {
                worker.state = WorkerState::READY;
                worker.last_error.clear();
                std::cout << "Worker '" << worker.id << "' is ready (active RPC backend session)" << std::endl;
            }
            return;
        }

        // 2. If the worker previously had an active backend connection with
        //    assigned model layers, but that connection is gone and the endpoint
        //    is no longer reachable, report loss.
        if (worker.has_active_backend_connection &&
            (!worker.assigned_layers.empty() ||
             (worker.model_buffer_bytes.has_value() && worker.model_buffer_bytes.value() > 0))) {
            if (!observation.reachable) {
                if (worker.state == WorkerState::READY || worker.state == WorkerState::BUSY) {
                    worker.state = WorkerState::UNAVAILABLE;
                    worker.last_error = "RPC backend connection to " + worker.host + ":" +
                                        std::to_string(worker.port) + " was lost";
                    std::cerr << "Worker '" << worker.id << "' is now unavailable: "
                              << worker.last_error << std::endl;
                }
                return;
            }
        }

        // 3a. A worker that owned model layers over a GGML RPC session whose
        //     socket has since died must never be promoted back to READY just
        //     because its port answers a fresh TCP handshake. The old backend
        //     session is gone for good: ggml-rpc aborts the whole coordinator
        //     process the moment a graph is dispatched into it ("A registered
        //     backend disconnected or failed during tensor execution"). Only a
        //     model reload can re-register the backend, so keep reporting the
        //     worker as unavailable until the operator restarts the engine.
        if (worker.has_active_backend_connection &&
            (!worker.assigned_layers.empty() || !worker.assigned_layer_ranges.empty())) {
            const bool was_unavailable = worker.state == WorkerState::UNAVAILABLE;
            worker.state = WorkerState::UNAVAILABLE;
            worker.last_error = "RPC backend session to " + worker.host + ":" +
                                std::to_string(worker.port) +
                                " was lost; restart the engine to re-register it";
            if (!was_unavailable) {
                std::cerr << "Worker '" << worker.id << "' requires an engine restart: "
                          << worker.last_error << std::endl;
            }
            return;
        }

        // 3b. Otherwise (pre-connection, idle before model load, or recovery):
        if (observation.reachable) {
            if (worker.state == WorkerState::STOPPED ||
                worker.state == WorkerState::STARTING ||
                worker.state == WorkerState::UNAVAILABLE) {
                worker.state = WorkerState::READY;
                worker.last_error.clear();
                std::cout << "Worker '" << worker.id << "' is now ready" << std::endl;
            }
        } else if (worker.state == WorkerState::STARTING ||
                   worker.state == WorkerState::READY) {
            worker.state = WorkerState::UNAVAILABLE;
            worker.last_error = "Worker is not reachable at " + worker.host + ":" +
                                std::to_string(worker.port);
            std::cerr << "Worker '" << worker.id << "' is now unavailable: "
                      << worker.last_error << std::endl;
        }
        return;
    }

    // For LOCAL_RPC workers that we manage.
    if (worker.state == WorkerState::STOPPED) {
        return;
    }

    if (worker.state == WorkerState::STARTING) {
        if (!observation.process_checked || !observation.process_running) {
            worker.state = WorkerState::FAILED;
            worker.last_error = "Process terminated unexpectedly";
            std::cerr << "Worker '" << worker.id << "' failed to start: "
                      << worker.last_error << std::endl;
            return;
        }

        if (observation.reachable) {
            worker.state = WorkerState::READY;
            worker.last_error.clear();
            std::cout << "Worker '" << worker.id << "' is now ready" << std::endl;
        }
        return;
    }

    if (worker.state == WorkerState::READY) {
        if (!observation.connected && !observation.reachable) {
            worker.state = WorkerState::UNAVAILABLE;
            worker.last_error = "Worker became unreachable";
            std::cerr << "Worker '" << worker.id << "' is now unavailable: "
                      << worker.last_error << std::endl;
        }
    } else if (worker.state == WorkerState::FAILED || worker.state == WorkerState::UNAVAILABLE) {
        if (observation.connected || observation.reachable) {
            worker.state = WorkerState::READY;
            worker.last_error.clear();
            std::cout << "Worker '" << worker.id << "' has recovered and is now ready" << std::endl;
        }
    }
}

} // namespace

bool WorkerManager::is_managed_process_running_locked(const WorkerInfo& worker) const {
#ifdef _WIN32
    if (worker.pid.has_value()) {
        for (auto handle : worker_processes_) {
            if (handle != NULL && GetProcessId(handle) == *worker.pid) {
                DWORD exit_code = 0;
                return GetExitCodeProcess(handle, &exit_code) && exit_code == STILL_ACTIVE;
            }
        }
        return false;
    }
    // Legacy path: no PID recorded for this worker.
    for (auto handle : worker_processes_) {
        if (handle != NULL) {
            DWORD exit_code = 0;
            if (GetExitCodeProcess(handle, &exit_code) && exit_code == STILL_ACTIVE) {
                return true;
            }
        }
    }
#else
    (void)worker;
#endif
    return false;
}

void WorkerManager::check_worker_health(WorkerInfo& worker) {
    if (worker.is_inference_active || worker.state == WorkerState::BUSY) {
        return;
    }

    WorkerHealthObservation observation;

    if (worker.type == WorkerType::LOCAL_RPC && worker.state == WorkerState::STARTING) {
        std::lock_guard<std::mutex> lock(mutex_);
        observation.process_checked = true;
        observation.process_running = is_managed_process_running_locked(worker);
    }

    if (worker.type != WorkerType::LOCAL_CUDA &&
        !(observation.process_checked && !observation.process_running)) {
        observation.connected = is_process_tcp_connected_to_endpoint(worker.host, worker.port);
#ifndef _WIN32
        // On Android / POSIX, /proc/net/tcp is restricted by SELinux.
        // If a backend connection is established and healthy, do not open
        // a competing TCP connection that disrupts the single-threaded RPC server.
        if (!observation.connected && worker.has_active_backend_connection && worker.state == WorkerState::READY) {
            observation.connected = true;
        }
#endif
        observation.reachable = observation.connected ||
                                is_worker_reachable(worker.host, worker.port, 2000);
    }

    apply_health_observation(worker, observation);
}

void WorkerManager::check_worker_health(const std::string& id) {
    WorkerInfo snapshot;
    WorkerHealthObservation observation;

    {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = std::find_if(workers_.begin(), workers_.end(),
                               [&](const WorkerInfo& worker) { return worker.id == id; });
        if (it == workers_.end()) {
            return;
        }
        snapshot = *it;
        if (snapshot.is_inference_active || snapshot.state == WorkerState::BUSY) {
            return;
        }
        if (snapshot.type == WorkerType::LOCAL_RPC && snapshot.state == WorkerState::STARTING) {
            observation.process_checked = true;
            observation.process_running = is_managed_process_running_locked(snapshot);
        }
    }

    // Network probes deliberately run without the registry lock. They can take
    // up to the socket timeout and must not block HTTP status or inference.
    if (snapshot.type != WorkerType::LOCAL_CUDA &&
        !(observation.process_checked && !observation.process_running)) {
        observation.connected = is_process_tcp_connected_to_endpoint(snapshot.host, snapshot.port);
#ifndef _WIN32
        // On Android / POSIX, /proc/net/tcp is restricted by SELinux.
        // If a backend connection is established and healthy, do not open
        // a competing TCP connection that disrupts the single-threaded RPC server.
        if (!observation.connected && snapshot.has_active_backend_connection && snapshot.state == WorkerState::READY) {
            observation.connected = true;
        }
#endif
        observation.reachable = observation.connected ||
                                is_worker_reachable(snapshot.host, snapshot.port, 2000);
    }

    std::lock_guard<std::mutex> lock(mutex_);
    auto it = std::find_if(workers_.begin(), workers_.end(),
                           [&](const WorkerInfo& worker) { return worker.id == id; });
    if (it == workers_.end() || it->is_inference_active || it->state == WorkerState::BUSY) {
        return;
    }
    apply_health_observation(*it, observation);
}

std::vector<ggml_backend_dev_t> WorkerManager::get_rpc_devices() {
    std::lock_guard<std::mutex> lock(mutex_);
    return rpc_devices_;
}

void WorkerManager::add_rpc_device(ggml_backend_dev_t device) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (device && std::find(rpc_devices_.begin(), rpc_devices_.end(), device) == rpc_devices_.end()) {
        rpc_devices_.push_back(device);
    }
}

std::optional<WorkerInfo> WorkerManager::get_worker(const std::string& id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& worker : workers_) {
        if (worker.id == id) {
            return worker;
        }
    }
    return std::nullopt;
}

std::vector<WorkerInfo> WorkerManager::get_workers() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return workers_;
}

std::vector<std::string> WorkerManager::begin_inference() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<std::string> active_ids;
    for (auto& worker : workers_) {
        const bool participates = !worker.assigned_layers.empty() ||
                                  (worker.model_buffer_bytes.has_value() &&
                                   worker.model_buffer_bytes.value() > 0);
        if (!participates) {
            continue;
        }
        worker.is_inference_active = true;
        if (worker.state == WorkerState::READY) {
            worker.state = WorkerState::BUSY;
        }
        worker.inference_count++;
        active_ids.push_back(worker.id);
    }
    return active_ids;
}

void WorkerManager::end_inference(const std::vector<std::string>& ids) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& worker : workers_) {
        for (const auto& id : ids) {
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
