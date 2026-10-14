#ifndef SWARM_WORKER_H
#define SWARM_WORKER_H

#include <string>
#include <vector>
#include <optional>
#include <chrono>
#include <cstdint>
#include <ggml-backend.h>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

enum class WorkerType {
    LOCAL_RPC,     // Locally managed RPC worker process
    REMOTE_RPC,    // Remote RPC worker (not managed by Swarm)
    LOCAL_CUDA,    // Local CUDA device (not a process)
    UNKNOWN
};

enum class WorkerState {
    STOPPED,       // Not running
    STARTING,      // Process starting or connecting
    READY,         // Running and available for inference
    BUSY,          // Currently participating in inference
    UNAVAILABLE,   // Running but not available (e.g., health check failed)
    FAILED,        // In error state
    STOPPING       // In process of stopping
};

struct WorkerInfo {
    std::string id;                    // Stable worker ID (UUID or user-defined)
    std::string host;                  // Hostname or IP address
    uint16_t port;                     // Port number
    WorkerType type;                   // Worker type
    WorkerState state;                 // Current state
    std::optional<uint32_t> pid;       // Process ID for locally managed workers
    std::chrono::system_clock::time_point started_at;  // Start time
    std::chrono::system_clock::time_point last_health_check; // Last health check
    std::string last_error;            // Last error message
    bool is_inference_active;          // Whether currently participating in inference
    bool has_active_backend_connection; // Whether coordinator holds active persistent RPC connection
    size_t inference_count;            // Number of inferences participated in

    // Resource information (when available)
    std::optional<size_t> memory_total_bytes;
    std::optional<size_t> memory_free_bytes;
    std::optional<std::string> device_name;
    std::optional<enum ggml_backend_dev_type> device_type;

    // Backend placement & observability
    std::optional<std::string> backend_id;
    std::optional<std::string> backend_type;
    bool is_loopback;
    std::string memory_scope;
    std::vector<int> assigned_layers;
    std::vector<std::pair<int, int>> assigned_layer_ranges;
    std::optional<size_t> model_buffer_bytes;
    std::optional<size_t> kv_buffer_bytes;
    std::optional<size_t> compute_buffer_bytes;
    std::string measurement_status;
    bool log_derived;

    // Constructor
    WorkerInfo() :
        port(0),
        type(WorkerType::UNKNOWN),
        state(WorkerState::STOPPED),
        is_inference_active(false),
        has_active_backend_connection(false),
        inference_count(0),
        is_loopback(false),
        measurement_status("unavailable"),
        log_derived(false) {}
};

// Forward declaration
class WorkerManager;

// Function declarations for worker management
std::vector<ggml_backend_dev_t> get_worker_devices(const std::vector<WorkerInfo>& workers);
bool is_worker_available(const WorkerInfo& worker);
void update_worker_state(WorkerInfo& worker, WorkerState new_state);
std::string worker_state_to_string(WorkerState state);
std::string worker_type_to_string(WorkerType type);

class WorkerManager {
public:
    WorkerManager();
    ~WorkerManager();

    // Add a worker configuration
    bool add_worker(const WorkerInfo& worker);

    // Start all local workers (LOCAL_RPC) that are enabled
    bool start_local_workers();

    // Stop all local workers that we started
    void stop_local_workers();

    // Check the readiness of a worker (by trying to connect to its RPC port)
    // Updates the worker state accordingly
    void check_worker_health(WorkerInfo& worker);

    // Checks if the coordinator has an active TCP connection to this worker or if it is reachable
    bool is_worker_connected_or_reachable(const WorkerInfo& worker, int timeout_ms = 2000);

    // Get the list of ggml_backend_dev_t for all ready RPC workers
    std::vector<ggml_backend_dev_t> get_rpc_devices();

    // Retain a registered RPC device for the lifetime of the model.
    void add_rpc_device(ggml_backend_dev_t device);

    // Get a reference to the worker info by ID (for updating state, etc.)
    std::optional<std::reference_wrapper<WorkerInfo>> get_worker(const std::string& id);

    // Get all workers
    std::vector<WorkerInfo>& get_workers();
    const std::vector<WorkerInfo>& get_workers() const;

private:
    std::vector<WorkerInfo> workers_;
    std::vector<HANDLE> worker_processes_; // For Windows, to track the processes we started
    std::vector<ggml_backend_dev_t> rpc_devices_;
};

#endif // SWARM_WORKER_H