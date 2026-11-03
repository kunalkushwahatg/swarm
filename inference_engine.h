#pragma once

#include <vector>
#include <string>
#include <mutex>
#include <atomic>
#include "httplib.h"
#include "config.h"
#include "worker.h"
#include "metrics_collector.h"

struct llama_model;
struct llama_context;
struct llama_vocab;
typedef struct ggml_backend_device * ggml_backend_dev_t;

namespace swarm {

class InferenceEngine {
public:
    InferenceEngine();
    ~InferenceEngine();

    bool init_model(
        const SwarmConfig& config,
        const std::vector<ggml_backend_dev_t>& devices,
        const float* tensor_split = nullptr
    );
    void shutdown();

    bool is_model_loaded() const { return model != nullptr; }
    bool is_context_ready() const { return ctx != nullptr; }

    llama_model* get_model() { return model; }
    llama_context* get_context() { return ctx; }

    void handle_chat_completion(
        uint64_t request_id,
        const httplib::Request& req,
        httplib::Response& res,
        WorkerManager& worker_manager,
        const SwarmConfig& config,
        MetricsCollector& metrics,
        const std::atomic<bool>& g_running
    );

private:
    llama_model* model = nullptr;
    llama_context* ctx = nullptr;
    const llama_vocab* vocab = nullptr;
    std::mutex inference_mutex;
};

} // namespace swarm
