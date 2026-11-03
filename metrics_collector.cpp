#ifndef NOMINMAX
#define NOMINMAX
#endif

#include "metrics_collector.h"
#include "worker.h"
#include "placement.h"
#include "node.h"

namespace swarm {

void MetricsCollector::record_inference(
    int tokens_generated,
    double prompt_eval_ms,
    double gen_ms,
    double total_ms,
    double tokens_per_sec
) {
    tokens_generated_total += tokens_generated;
    prompt_eval_seconds_sum = prompt_eval_seconds_sum.load() + (prompt_eval_ms / 1000.0);
    prompt_eval_count++;
    token_gen_seconds_sum = token_gen_seconds_sum.load() + (gen_ms / 1000.0);
    token_gen_count++;
    inference_seconds_sum = inference_seconds_sum.load() + (total_ms / 1000.0);
    inference_count++;
    last_tokens_per_sec = tokens_per_sec;
    last_prompt_eval_ms = prompt_eval_ms;
    last_gen_ms = gen_ms;
    last_total_ms = total_ms;
}

std::string MetricsCollector::render_prometheus(
    ::WorkerManager& worker_manager,
    ::PlacementTracker& placement_tracker,
    NodeInventory& node_inventory
) {
    std::string metrics;

    metrics += "# HELP swarm_requests_total Total number of HTTP requests\n";
    metrics += "# TYPE swarm_requests_total counter\n";
    metrics += "swarm_requests_total " + std::to_string(requests_total.load()) + "\n\n";

    metrics += "# HELP swarm_active_requests Number of active requests\n";
    metrics += "# TYPE swarm_active_requests gauge\n";
    metrics += "swarm_active_requests " + std::to_string(active_requests.load()) + "\n\n";

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
    for (const auto& node : node_inventory.get_all_nodes()) {
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
    for (const auto& bp : placement_tracker.get_all_backends()) {
        metrics += "swarm_backend_model_buffer_bytes{backend=\"" + bp.backend_id + "\",type=\"" + bp.backend_type + "\"} " + std::to_string(bp.model_buffer_bytes) + "\n";
    }
    metrics += "\n";

    metrics += "# HELP swarm_backend_kv_buffer_bytes KV cache buffer size allocated on backend in bytes\n";
    metrics += "# TYPE swarm_backend_kv_buffer_bytes gauge\n";
    for (const auto& bp : placement_tracker.get_all_backends()) {
        metrics += "swarm_backend_kv_buffer_bytes{backend=\"" + bp.backend_id + "\",type=\"" + bp.backend_type + "\"} " + std::to_string(bp.kv_buffer_bytes) + "\n";
    }
    metrics += "\n";

    metrics += "# HELP swarm_backend_compute_buffer_bytes Compute buffer size allocated on backend in bytes\n";
    metrics += "# TYPE swarm_backend_compute_buffer_bytes gauge\n";
    for (const auto& bp : placement_tracker.get_all_backends()) {
        metrics += "swarm_backend_compute_buffer_bytes{backend=\"" + bp.backend_id + "\",type=\"" + bp.backend_type + "\"} " + std::to_string(bp.compute_buffer_bytes) + "\n";
    }
    metrics += "\n";

    metrics += "# HELP swarm_backend_assigned_layers Number of layers assigned to backend\n";
    metrics += "# TYPE swarm_backend_assigned_layers gauge\n";
    for (const auto& bp : placement_tracker.get_all_backends()) {
        metrics += "swarm_backend_assigned_layers{backend=\"" + bp.backend_id + "\",type=\"" + bp.backend_type + "\"} " + std::to_string(bp.assigned_layers.size()) + "\n";
    }
    metrics += "\n";

    metrics += "# HELP swarm_backend_virtual_budget_bytes Configured virtual memory budget in bytes\n";
    metrics += "# TYPE swarm_backend_virtual_budget_bytes gauge\n";
    for (const auto& bp : placement_tracker.get_all_backends()) {
        if (bp.virtual_budget_bytes > 0) {
            metrics += "swarm_backend_virtual_budget_bytes{backend=\"" + bp.backend_id + "\"} " + std::to_string(bp.virtual_budget_bytes) + "\n";
        }
    }
    metrics += "\n";

    metrics += "# HELP swarm_backend_policy_match Whether actual placement matched prediction (1=match, 0=mismatch)\n";
    metrics += "# TYPE swarm_backend_policy_match gauge\n";
    for (const auto& bp : placement_tracker.get_all_backends()) {
        if (bp.policy_match.has_value()) {
            metrics += "swarm_backend_policy_match{backend=\"" + bp.backend_id + "\"} " + (bp.policy_match.value() ? "1" : "0") + "\n";
        }
    }
    metrics += "\n";

    metrics += "# HELP swarm_inference_tokens_generated_total Total number of tokens generated\n";
    metrics += "# TYPE swarm_inference_tokens_generated_total counter\n";
    metrics += "swarm_inference_tokens_generated_total " + std::to_string(tokens_generated_total.load()) + "\n\n";

    metrics += "# HELP swarm_inference_tokens_per_second Token generation rate of the most recent request\n";
    metrics += "# TYPE swarm_inference_tokens_per_second gauge\n";
    metrics += "swarm_inference_tokens_per_second " + std::to_string(last_tokens_per_sec.load()) + "\n\n";

    metrics += "# HELP swarm_inference_prompt_eval_duration_seconds Total prompt evaluation time in seconds\n";
    metrics += "# TYPE swarm_inference_prompt_eval_duration_seconds summary\n";
    metrics += "swarm_inference_prompt_eval_duration_seconds_sum " + std::to_string(prompt_eval_seconds_sum.load()) + "\n";
    metrics += "swarm_inference_prompt_eval_duration_seconds_count " + std::to_string(prompt_eval_count.load()) + "\n\n";

    metrics += "# HELP swarm_inference_token_gen_duration_seconds Total token generation time in seconds\n";
    metrics += "# TYPE swarm_inference_token_gen_duration_seconds summary\n";
    metrics += "swarm_inference_token_gen_duration_seconds_sum " + std::to_string(token_gen_seconds_sum.load()) + "\n";
    metrics += "swarm_inference_token_gen_duration_seconds_count " + std::to_string(token_gen_count.load()) + "\n\n";

    metrics += "# HELP swarm_inference_duration_seconds Total inference time in seconds\n";
    metrics += "# TYPE swarm_inference_duration_seconds summary\n";
    metrics += "swarm_inference_duration_seconds_sum " + std::to_string(inference_seconds_sum.load()) + "\n";
    metrics += "swarm_inference_duration_seconds_count " + std::to_string(inference_count.load()) + "\n";

    return metrics;
}

} // namespace swarm
