// ─────────────────────────────────────────────
//  Swarm HTTP API client
// ─────────────────────────────────────────────
import type {
  HealthResponse,
  BackendsResponse,
  NodeInventory,
  ChatRequest,
  SSEDelta,
  SSETimings,
  SwarmMetrics,
  RpcTelemetryDetail,
} from "../types/api";

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { supervisor } from "./supervisor";

export const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

let activeCoordinatorPort = 8080;

export function getBaseUrl(): string {
  if (import.meta.env.VITE_SWARM_API_URL) {
    return import.meta.env.VITE_SWARM_API_URL;
  }
  return isTauri ? `http://127.0.0.1:${activeCoordinatorPort}` : "";
}

export const BASE_URL =
  import.meta.env.VITE_SWARM_API_URL ??
  (isTauri ? "http://127.0.0.1:8080" : "");

async function appFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (isTauri) {
    try {
      return await tauriFetch(input, init);
    } catch {
      return window.fetch(input, init);
    }
  }
  return window.fetch(input, init);
}

let telemetryTokenPromise: Promise<string | null> | null = null;

/**
 * The desktop supervisor provisions a shared telemetry bearer token for the
 * coordinator. The detail endpoint is protected by it, so fetch the token once
 * per session and reuse it. Browser/dev mode has no supervisor and therefore no
 * token (the dev coordinator runs unauthenticated on loopback).
 */
function getTelemetryToken(): Promise<string | null> {
  if (!isTauri) return Promise.resolve(null);
  if (!telemetryTokenPromise) {
    telemetryTokenPromise = supervisor
      .getHostNetworkInfo()
      .then((info) => {
        if (info?.coordinator_port) {
          activeCoordinatorPort = info.coordinator_port;
        }
        return info?.telemetry_token ?? null;
      })
      .catch(() => null);
  }
  return telemetryTokenPromise;
}

function parsePrometheus(text: string): SwarmMetrics {
  const m: SwarmMetrics = {
    requestsTotal: 0,
    activeRequests: 0,
    tokensGeneratedTotal: 0,
    lastTokensPerSec: 0,
    promptEvalSecondsSum: 0,
    promptEvalCount: 0,
    tokenGenSecondsSum: 0,
    tokenGenCount: 0,
    inferenceSecondsSum: 0,
    inferenceCount: 0,
    rawText: text,
  };
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const key = parts[0];
    const val = parseFloat(parts[1]);
    if (isNaN(val)) continue;

    if (key === "swarm_requests_total") m.requestsTotal = val;
    else if (key === "swarm_active_requests") m.activeRequests = val;
    else if (key === "swarm_inference_tokens_generated_total") m.tokensGeneratedTotal = val;
    else if (key === "swarm_inference_tokens_per_second") m.lastTokensPerSec = val;
    else if (key === "swarm_inference_prompt_eval_duration_seconds_sum") m.promptEvalSecondsSum = val;
    else if (key === "swarm_inference_prompt_eval_duration_seconds_count") m.promptEvalCount = val;
    else if (key === "swarm_inference_token_gen_duration_seconds_sum") m.tokenGenSecondsSum = val;
    else if (key === "swarm_inference_token_gen_duration_seconds_count") m.tokenGenCount = val;
    else if (key === "swarm_inference_duration_seconds_sum") m.inferenceSecondsSum = val;
    else if (key === "swarm_inference_duration_seconds_count") m.inferenceCount = val;
  }
  return m;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await appFetch(`${getBaseUrl()}${path}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.json() as Promise<T>;
}

export const api = {
  health: (signal?: AbortSignal) => get<HealthResponse>("/health", signal),
  backends: (signal?: AbortSignal) => get<BackendsResponse>("/backends", signal),
  nodes: (signal?: AbortSignal) => get<NodeInventory>("/nodes", signal),
  metrics: async (signal?: AbortSignal): Promise<SwarmMetrics> => {
    const res = await appFetch(`${getBaseUrl()}/metrics`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} on /metrics`);
    const text = await res.text();
    return parsePrometheus(text);
  },
  rpcTelemetry: async (
    requestId: number,
    signal?: AbortSignal,
  ): Promise<RpcTelemetryDetail> => {
    const token = await getTelemetryToken();
    const res = await appFetch(
      `${getBaseUrl()}/telemetry/request?id=${encodeURIComponent(String(requestId))}`,
      {
        signal,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      },
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} on /telemetry/request`);
    }
    return res.json() as Promise<RpcTelemetryDetail>;
  },

  /** Stream a chat completion. Calls onDelta for each content chunk, onTimings once at the end. */
  chat: async (
    request: ChatRequest,
    onDelta: (text: string) => void,
    onTimings: (t: SSETimings["timings"]) => void,
    onError: (msg: string) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const res = await appFetch(`${getBaseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      onError(`HTTP ${res.status}: ${text}`);
      return;
    }

    if (!res.body) {
      onError("No response body");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload) as
              | SSEDelta
              | SSETimings
              | { error?: string };
            if ("error" in parsed && typeof parsed.error === "string") {
              onError(parsed.error);
              void reader.cancel().catch(() => {});
              return;
            }
            if ("timings" in parsed) {
              onTimings((parsed as SSETimings).timings);
            } else {
              const delta = (parsed as SSEDelta).choices?.[0]?.delta?.content;
              if (delta) onDelta(delta);
            }
          } catch {
            // malformed chunk — skip
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError((err as Error).message);
      }
    }
  },
};
