// ─────────────────────────────────────────────
//  Timing validation logic for inference generation
// ─────────────────────────────────────────────

import type { RpcTelemetrySummary, RpcTelemetryWorker } from "../types/api";

export interface ValidatedTimings {
  tokens_generated: number;
  tokens_per_sec?: number;
  prompt_eval_ms?: number;
  gen_ms?: number;
  total_ms?: number;
  ttfc_ms?: number;
  rpc_telemetry?: RpcTelemetrySummary;
  completed_at: number;
}

export function isValidTimingNumber(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val) && val >= 0;
}

function numberOrZero(val: unknown): number {
  return isValidTimingNumber(val) ? val : 0;
}

function booleanOrFalse(val: unknown): boolean {
  return val === true;
}

function stringOrEmpty(val: unknown): string {
  return typeof val === "string" ? val : "";
}

function validateRpcWorker(raw: unknown): RpcTelemetryWorker | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const id = stringOrEmpty(w.id);
  if (!id) return null;

  const layers = Array.isArray(w.assigned_layers)
    ? w.assigned_layers.filter((v): v is number => isValidTimingNumber(v))
    : [];

  return {
    id,
    endpoint: typeof w.endpoint === "string" ? w.endpoint : undefined,
    is_loopback: booleanOrFalse(w.is_loopback),
    assigned_layers: layers,
    wall_ms: numberOrZero(w.wall_ms),
    upload_ms: numberOrZero(w.upload_ms),
    remote_ms: numberOrZero(w.remote_ms),
    compute_ms: numberOrZero(w.compute_ms),
    download_ms: numberOrZero(w.download_ms),
    network_rtt_ms: numberOrZero(w.network_rtt_ms),
    bytes_sent: numberOrZero(w.bytes_sent),
    bytes_received: numberOrZero(w.bytes_received),
    tensor_bytes_sent: numberOrZero(w.tensor_bytes_sent),
    tensor_bytes_received: numberOrZero(w.tensor_bytes_received),
    tensor_count_sent: numberOrZero(w.tensor_count_sent),
    tensor_count_received: numberOrZero(w.tensor_count_received),
    rpc_messages_sent: numberOrZero(w.rpc_messages_sent),
    rpc_messages_received: numberOrZero(w.rpc_messages_received),
    probe_count: numberOrZero(w.probe_count),
    graph_count: numberOrZero(w.graph_count),
    worker_busy_count: numberOrZero(w.worker_busy_count),
    compute_measured: booleanOrFalse(w.compute_measured),
    partial: booleanOrFalse(w.partial),
  };
}

export function validateRpcTelemetry(raw: unknown): RpcTelemetrySummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (t.available !== true) return undefined;

  const rawWorkers = Array.isArray(t.workers) ? t.workers : [];
  const workers = rawWorkers
    .map(validateRpcWorker)
    .filter((w): w is RpcTelemetryWorker => w !== null);

  return {
    available: true,
    partial: booleanOrFalse(t.partial),
    request_id: isValidTimingNumber(t.request_id) ? t.request_id : undefined,
    wall_ms: numberOrZero(t.wall_ms),
    upload_ms: numberOrZero(t.upload_ms),
    remote_ms: numberOrZero(t.remote_ms),
    compute_ms: numberOrZero(t.compute_ms),
    download_ms: numberOrZero(t.download_ms),
    network_rtt_ms: numberOrZero(t.network_rtt_ms),
    total_rpc_ms: numberOrZero(t.total_rpc_ms),
    bytes_sent: numberOrZero(t.bytes_sent),
    bytes_received: numberOrZero(t.bytes_received),
    tensor_bytes_sent: numberOrZero(t.tensor_bytes_sent),
    tensor_bytes_received: numberOrZero(t.tensor_bytes_received),
    tensor_count_sent: numberOrZero(t.tensor_count_sent),
    tensor_count_received: numberOrZero(t.tensor_count_received),
    rpc_messages_sent: numberOrZero(t.rpc_messages_sent),
    rpc_messages_received: numberOrZero(t.rpc_messages_received),
    probe_count: numberOrZero(t.probe_count),
    graph_count: numberOrZero(t.graph_count),
    worker_busy_count: numberOrZero(t.worker_busy_count),
    compute_measured: booleanOrFalse(t.compute_measured),
    workers,
  };
}

export function validateTimings(raw: unknown, ttfcMs?: number): ValidatedTimings | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;

  if (!isValidTimingNumber(t.tokens_generated)) {
    return null;
  }

  const tokensGenerated = Math.floor(t.tokens_generated);
  const promptEvalMs = isValidTimingNumber(t.prompt_eval_ms) ? t.prompt_eval_ms : undefined;
  const genMs = isValidTimingNumber(t.gen_ms) ? t.gen_ms : undefined;
  const totalMs = isValidTimingNumber(t.total_ms) ? t.total_ms : undefined;

  let tokensPerSec: number | undefined = undefined;
  if (tokensGenerated === 0) {
    tokensPerSec = undefined;
  } else if (isValidTimingNumber(t.tokens_per_sec) && t.tokens_per_sec > 0) {
    tokensPerSec = t.tokens_per_sec;
  }

  const validTtfc = isValidTimingNumber(ttfcMs) ? ttfcMs : undefined;

  return {
    tokens_generated: tokensGenerated,
    tokens_per_sec: tokensPerSec,
    prompt_eval_ms: promptEvalMs,
    gen_ms: genMs,
    total_ms: totalMs,
    ttfc_ms: validTtfc,
    rpc_telemetry: validateRpcTelemetry(t.rpc_telemetry),
    completed_at: Date.now(),
  };
}
