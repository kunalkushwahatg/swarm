#pragma once

#include <atomic>
#include <string>
#include <cstdint>

class WorkerManager;
class PlacementTracker;

namespace swarm {

class NodeInventory;

class MetricsCollector {
public:
    std::atomic<uint64_t> requests_total{0};
    std::atomic<uint64_t> active_requests{0};
    std::atomic<uint64_t> tokens_generated_total{0};
    std::atomic<double> prompt_eval_seconds_sum{0.0};
    std::atomic<uint64_t> prompt_eval_count{0};
    std::atomic<double> token_gen_seconds_sum{0.0};
    std::atomic<uint64_t> token_gen_count{0};
    std::atomic<double> inference_seconds_sum{0.0};
    std::atomic<uint64_t> inference_count{0};
    std::atomic<double> last_tokens_per_sec{0.0};
    std::atomic<double> last_prompt_eval_ms{0.0};
    std::atomic<double> last_gen_ms{0.0};
    std::atomic<double> last_total_ms{0.0};

    struct ActiveReqGuard {
        MetricsCollector& collector;
        explicit ActiveReqGuard(MetricsCollector& c) : collector(c) {
            collector.requests_total++;
            collector.active_requests++;
        }
        ~ActiveReqGuard() {
            collector.active_requests--;
        }
    };

    void record_inference(int tokens_generated, double prompt_eval_ms, double gen_ms, double total_ms, double tokens_per_sec);

    std::string render_prometheus(
        ::WorkerManager& worker_manager,
        ::PlacementTracker& placement_tracker,
        NodeInventory& node_inventory
    );
};

} // namespace swarm
