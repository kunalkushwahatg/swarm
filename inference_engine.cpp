#ifndef NOMINMAX
#define NOMINMAX
#endif

#include "inference_engine.h"
#include "logger.h"
#include "llama.h"
#include "json.hpp"
#include "rpc_telemetry.h"

#include <cmath>
#include <chrono>
#include <algorithm>
#include <vector>
#include <string>
#include <thread>
#include <utility>
#include <memory>
#include <optional>

using json = nlohmann::json;

namespace swarm {

static json rpc_telemetry_json(const RpcTelemetrySummary& s) {
    if (!s.available) {
        return json{{"available", false}};
    }
    json workers = json::array();
    for (const auto& w : s.workers) {
        workers.push_back(json{
            {"id", w.id},
            {"endpoint", w.endpoint},
            {"is_loopback", w.is_loopback},
            {"assigned_layers", w.assigned_layers},
            {"wall_ms", w.wall_ms},
            {"upload_ms", w.upload_ms},
            {"remote_ms", w.remote_ms},
            {"compute_ms", w.compute_ms},
            {"download_ms", w.download_ms},
            {"network_rtt_ms", w.network_rtt_ms},
            {"bytes_sent", w.bytes_sent},
            {"bytes_received", w.bytes_received},
            {"tensor_bytes_sent", w.tensor_bytes_sent},
            {"tensor_bytes_received", w.tensor_bytes_received},
            {"tensor_count_sent", w.tensor_count_sent},
            {"tensor_count_received", w.tensor_count_received},
            {"rpc_messages_sent", w.rpc_messages_sent},
            {"rpc_messages_received", w.rpc_messages_received},
            {"probe_count", w.probe_count},
            {"graph_count", w.graph_count},
            {"worker_busy_count", w.worker_busy_count},
            {"compute_measured", w.compute_measured},
            {"partial", w.partial},
        });
    }
    return json{
        {"available", true},
        {"partial", s.partial},
        {"request_id", s.request_id},
        {"wall_ms", s.wall_ms},
        {"upload_ms", s.upload_ms},
        {"remote_ms", s.remote_ms},
        {"compute_ms", s.compute_ms},
        {"download_ms", s.download_ms},
        {"network_rtt_ms", s.network_rtt_ms},
        {"total_rpc_ms", s.total_rpc_ms},
        {"bytes_sent", s.bytes_sent},
        {"bytes_received", s.bytes_received},
        {"tensor_bytes_sent", s.tensor_bytes_sent},
        {"tensor_bytes_received", s.tensor_bytes_received},
        {"tensor_count_sent", s.tensor_count_sent},
        {"tensor_count_received", s.tensor_count_received},
        {"rpc_messages_sent", s.rpc_messages_sent},
        {"rpc_messages_received", s.rpc_messages_received},
        {"probe_count", s.probe_count},
        {"graph_count", s.graph_count},
        {"worker_busy_count", s.worker_busy_count},
        {"compute_measured", s.compute_measured},
        {"workers", std::move(workers)},
    };
}

InferenceEngine::InferenceEngine() = default;

InferenceEngine::~InferenceEngine() {
    shutdown();
}

bool InferenceEngine::init_model(
    const SwarmConfig& config,
    const std::vector<ggml_backend_dev_t>& devices,
    const float* tensor_split
) {
    std::lock_guard<std::mutex> lock(inference_mutex);
    if (model != nullptr) {
        return true;
    }

    int32_t n_gpu_layers = -1;
    const char* env_layers = std::getenv("SWARM_N_GPU_LAYERS");
    if (env_layers && *env_layers != '\0') {
        char *end = nullptr;
        const long parsed = std::strtol(env_layers, &end, 10);
        if (end != env_layers && *end == '\0' && parsed >= -1 && parsed <= INT32_MAX) {
            n_gpu_layers = static_cast<int32_t>(parsed);
        }
    }

    llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = n_gpu_layers;
    log_info("Requested GPU layers: " + std::to_string(n_gpu_layers) +
             (n_gpu_layers < 0 ? " (all)" : ""));
    model_params.devices = const_cast<ggml_backend_dev_t*>(devices.data());
    if (tensor_split != nullptr) {
        model_params.tensor_split = tensor_split;
        log_info("Applying custom tensor_split configuration to llama_model_params");
    }

    model = llama_model_load_from_file(config.model_path.c_str(), model_params);
    if (!model) {
        log_error("Failed to load model from: " + config.model_path);
        return false;
    }

    llama_context_params ctx_params = llama_context_default_params();
    ctx_params.n_ctx = config.ctx_size;
    ctx = llama_init_from_model(model, ctx_params);
    if (!ctx) {
        log_error("Failed to create context");
        llama_model_free(model);
        model = nullptr;
        return false;
    }

    vocab = llama_model_get_vocab(model);
    return true;
}

void InferenceEngine::shutdown() {
    std::lock_guard<std::mutex> lock(inference_mutex);
    if (ctx) {
        llama_free(ctx);
        ctx = nullptr;
    }
    if (model) {
        llama_model_free(model);
        model = nullptr;
    }
    vocab = nullptr;
}

void InferenceEngine::handle_chat_completion(
    uint64_t request_id,
    const httplib::Request& req,
    httplib::Response& res,
    WorkerManager& worker_manager,
    const SwarmConfig& config,
    MetricsCollector& metrics,
    const std::atomic<bool>& g_running
) {
    MetricsCollector::ActiveReqGuard active_guard(metrics);

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

    // Refuse to dispatch into a cluster with a missing required worker. The
    // GGML RPC backend cannot recover a dropped session at runtime: attempting
    // a graph that includes it aborts the entire coordinator process. Reporting
    // a clean 503 lets the caller fall back or restart the engine instead.
    {
        std::string unready_reason;
        for (const auto &worker : worker_manager.get_workers()) {
            if (worker.type != WorkerType::REMOTE_RPC && worker.type != WorkerType::LOCAL_RPC) {
                continue;
            }
            const bool required =
                !worker.assigned_layers.empty() ||
                !worker.assigned_layer_ranges.empty() ||
                (worker.model_buffer_bytes.has_value() && worker.model_buffer_bytes.value() > 0);
            if (!required) {
                continue;
            }
            if (worker.state != WorkerState::READY && worker.state != WorkerState::BUSY) {
                unready_reason = "RPC worker '" + worker.id + "' is " +
                                 worker_state_to_string(worker.state);
                break;
            }
        }
        if (!unready_reason.empty()) {
            log_warn("[" + std::to_string(request_id) +
                     "] Rejecting request, cluster is not ready: " + unready_reason);
            res.status = 503;
            json body = {
                {"error", "cluster not ready"},
                {"detail", unready_reason},
                {"hint", "Restart the engine to re-register worker backends."},
            };
            res.set_content(body.dump(), "application/json");
            return;
        }
    }

    if (!model || !ctx || !vocab) {
        log_error("[" + std::to_string(request_id) + "] Inference engine not initialized");
        res.status = 503;
        res.set_content(R"({"error":"inference engine not initialized"})", "application/json");
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
        worker_manager.check_worker_health(worker.id);
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

    struct InferenceWorkerGuard {
        WorkerManager& manager;
        std::vector<std::string> active_ids;
        explicit InferenceWorkerGuard(WorkerManager& wm)
            : manager(wm), active_ids(wm.begin_inference()) {}
        ~InferenceWorkerGuard() {
            manager.end_inference(active_ids);
        }
    };
    // The chunked content provider runs after this handler returns, so the mutex
    // and worker guard must live for the whole generation, not just this scope.
    struct GenerationSession {
        std::unique_lock<std::mutex> lock;
        InferenceWorkerGuard guard;
        uint64_t request_id;
        GenerationSession(std::mutex& mutex, WorkerManager& workers, uint64_t id)
            : lock(mutex), guard(workers), request_id(id) {}
        ~GenerationSession() {
            RpcTelemetryStore::instance().end_request(request_id);
        }
    };
    // Shared by every copy of the provider lambda (cpp-httplib may copy it) and
    // destroyed when the response finishes or the client disconnects.
    auto inference_session = std::make_shared<std::optional<GenerationSession>>();

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

    const int64_t context_size = static_cast<int64_t>(llama_n_ctx(ctx));
    const int64_t prompt_token_count = static_cast<int64_t>(prompt_tokens.size());
    if (prompt_token_count + static_cast<int64_t>(max_tokens) > context_size) {
        log_warn("[" + std::to_string(request_id) + "] Prompt exceeds context window: prompt_tokens=" +
                 std::to_string(prompt_token_count) + " max_tokens=" + std::to_string(max_tokens) +
                 " context_size=" + std::to_string(context_size));
        res.status = 400;
        json err_resp = {
            {"error", {
                {"message", "Prompt length plus max_tokens exceeds the model context window."},
                {"type", "invalid_request_error"},
                {"code", 400},
                {"prompt_tokens", prompt_token_count},
                {"max_tokens", max_tokens},
                {"context_size", context_size}
            }}
        };
        res.set_content(err_resp.dump(2), "application/json");
        return;
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
        [this, &worker_manager, &metrics, &g_running, request_id,
         prompt_tokens = std::move(prompt_tokens), sampler, max_tokens,
         inference_session](size_t, httplib::DataSink &sink) mutable {
            // Serialize generation on the shared llama_context. Acquired here
            // because httplib invokes the provider after the handler unlocked.
            if (!inference_session->has_value()) {
                RpcTelemetryStore::instance().begin_request(request_id);
                inference_session->emplace(inference_mutex, worker_manager, request_id);
                llama_memory_clear(llama_get_memory(ctx), true);
            }

            if (!g_running.load()) {
                llama_sampler_free(sampler);
                return false;
            }

            auto t_infer_start = std::chrono::steady_clock::now();

            auto t_prompt_start = std::chrono::steady_clock::now();
            int prompt_status = 0;
            const size_t batch_limit =
                std::max<size_t>(1, static_cast<size_t>(llama_n_batch(ctx)));
            for (size_t offset = 0; offset < prompt_tokens.size(); offset += batch_limit) {
                const size_t chunk_size = std::min(batch_limit, prompt_tokens.size() - offset);
                llama_batch batch = llama_batch_get_one(
                    prompt_tokens.data() + offset, static_cast<int32_t>(chunk_size));
                prompt_status = llama_decode(ctx, batch);
                if (prompt_status != 0) {
                    break;
                }
            }
            auto t_prompt_end = std::chrono::steady_clock::now();
            double prompt_eval_ms = std::chrono::duration<double, std::milli>(t_prompt_end - t_prompt_start).count();

            if (prompt_status != 0) {
                const std::string error = "data: {\"error\":\"prompt decode failed\"}\n\n";
                sink.write(error.c_str(), error.size());
                sink.done();
                llama_sampler_free(sampler);
                return false;
            }

            auto log_top_logits = [&](const char *phase) {
                const float *logits = llama_get_logits_ith(ctx, -1);
                if (!logits) {
                    log_error("[" + std::to_string(request_id) + "] " + phase + " logits unavailable at index -1");
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
                    details += " id=" + std::to_string(id) + " value=" + std::to_string(value);
                }
                log_info(details);
                return finite_count > 0;
            };

            if (!log_top_logits("prompt")) {
                const std::string error = "data: {\"error\":\"prompt logits unavailable\"}\n\n";
                sink.write(error.c_str(), error.size());
                sink.done();
                llama_sampler_free(sampler);
                return false;
            }

            auto t_gen_start = std::chrono::steady_clock::now();
            int generated = 0;
            for (; generated < max_tokens; ++generated) {
                if (!g_running.load()) {
                    llama_sampler_free(sampler);
                    return false;
                }

                llama_token token = llama_sampler_sample(sampler, ctx, -1);
                if (token < 0 || token >= llama_vocab_n_tokens(vocab)) {
                    const std::string error = "data: {\"error\":\"invalid sampled token\"}\n\n";
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
                    vocab, token, piece.data(), static_cast<int32_t>(piece.size()), 0, true);
                if (piece_size < 0) {
                    piece.resize(static_cast<size_t>(-piece_size));
                    piece_size = llama_token_to_piece(
                        vocab, token, piece.data(), static_cast<int32_t>(piece.size()), 0, true);
                }
                if (piece_size < 0 || piece_size > static_cast<int>(piece.size())) {
                    const std::string error = "data: {\"error\":\"token decoding failed\"}\n\n";
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
                        {"id", request_id}
                    };
                    const std::string event = "data: " + chunk.dump() + "\n\n";
                    if (!sink.write(event.c_str(), event.size())) {
                        llama_sampler_free(sampler);
                        return false;
                    }
                }

                llama_batch token_batch = llama_batch_get_one(&token, 1);
                if (llama_decode(ctx, token_batch) != 0) {
                    const std::string error = "data: {\"error\":\"token decode failed\"}\n\n";
                    sink.write(error.c_str(), error.size());
                    sink.done();
                    llama_sampler_free(sampler);
                    return false;
                }
                if (generated < 2 && !log_top_logits("next token")) {
                    const std::string error = "data: {\"error\":\"next-token logits unavailable\"}\n\n";
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

            // Drain any queued RPC work and close open worker-busy windows before
            // publishing the final timing event.
            llama_synchronize(ctx);
            RpcTelemetryStore::instance().flush(request_id, 500);
            const RpcTelemetrySummary rpc_summary =
                RpcTelemetryStore::instance().build_summary(request_id);

            metrics.record_inference(generated, prompt_eval_ms, gen_ms, total_infer_ms, tokens_per_sec);

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
                    {"tokens_per_sec", tokens_per_sec},
                    {"rpc_telemetry", rpc_telemetry_json(rpc_summary)}
                }}
            };
            const std::string timing_event = "data: " + timing_chunk.dump() + "\n\n";
            sink.write(timing_event.c_str(), timing_event.size());

            sink.write("data: [DONE]\n\n", 14);
            sink.done();
            RpcTelemetryStore::instance().end_request(request_id);
            llama_sampler_free(sampler);
            log_info("[" + std::to_string(request_id) + "] Request completed");
            return true;
        });
}

} // namespace swarm
