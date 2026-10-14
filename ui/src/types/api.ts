// ─────────────────────────────────────────────
//  Swarm API types — derived from main.cpp routes
// ─────────────────────────────────────────────

export interface HealthResponse {
  status: "ok" | "error";
  timestamp: string;
  server: {
    state: string;
    host: string;
    port: number;
  };
  model: {
    loaded: boolean;
    path: string;
  };
  context: {
    created: boolean;
    size: number;
  };
  workers: WorkerInfo[];
  inference: {
    ready: boolean;
    ready_workers: number;
    total_rpc_workers: number;
    required_rpc_workers: number;
    ready_required_rpc_workers: number;
    total_workers: number;
    unready_reason?: string;
  };
}

export interface WorkerInfo {
  id: string;
  host: string;
  port: number;
  type: "LOCAL_RPC" | "REMOTE_RPC" | string;
  state: "STOPPED" | "STARTING" | "READY" | "BUSY" | "UNAVAILABLE" | "FAILED" | "STOPPING" | string;
  pid?: number;
  started_at: number;
  last_health_check: number;
  last_error: string;
  is_inference_active: boolean;
  inference_count: number;
  backend_id: string;
  backend_type: string;
  is_loopback: boolean;
  memory_scope: "shared_host" | "device_vram" | "unspecified" | string;
  assigned_layers: number[];
  assigned_layer_ranges: [number, number][];
  model_buffer_bytes?: number;
  kv_buffer_bytes?: number;
  compute_buffer_bytes?: number;
  measurement_status: string;
  log_derived: boolean;
  memory_total_bytes?: number;
  memory_free_bytes?: number;
  device_name?: string;
  device_type?: number;
}

export interface BackendPlacement {
  backend_id: string;
  backend_type: "cpu" | "local_cuda" | "loopback_rpc" | "remote_rpc" | string;
  description: string;
  endpoint: string;
  device_name: string;
  assigned_layers: number[];
  assigned_layer_ranges: [number, number][];
  model_buffer_bytes: number;
  kv_buffer_bytes: number;
  compute_buffer_bytes: number;
  measurement_status: string;
  log_derived: boolean;
  is_loopback: boolean;
  memory_scope: string;
  memory_total_bytes?: number;
  memory_free_bytes?: number;
  virtual_budget_bytes?: number;
  policy_match?: boolean;
}

export interface BackendsResponse {
  backends: BackendPlacement[];
  placement_policy: string;
  policy_evaluated: boolean;
  memory_accounting: {
    host_ram_total_bytes: number;
    host_ram_available_bytes: number;
    total_model_buffer_bytes: number;
    total_kv_buffer_bytes: number;
    total_compute_buffer_bytes: number;
    total_allocated_buffers_bytes: number;
    shared_host_memory_deduplicated: boolean;
    note: string;
  };
}

export interface NodeInventory {
  nodes: NodeInfo[];
  cluster_summary: ClusterSummary;
  generated_at_ms: number;
}

export interface NodeInfo {
  node_id: string;
  node_role?: "gateway" | "worker" | string;
  role?: "gateway" | "worker" | string;
  endpoint: string;
  host?: string;
  port?: number;
  is_loopback?: boolean;
  connection_state: "ONLINE" | "OFFLINE" | "UNAVAILABLE" | "READY" | string;
  is_required_by_model: boolean;
  is_stale?: boolean;
  agent_reported?: boolean;
  hostname?: string;
  cpu_info?: {
    architecture?: string;
    model_name?: string;
    processor_count?: number;
  };
  cpu_arch?: string;
  cpu_model?: string;
  ram_total_bytes?: { value: number | null; provenance: string; source: string; observed_at_ms: number };
  ram_free_bytes?: { value: number | null; provenance: string; source: string; observed_at_ms: number };
  vram_total_bytes?: { value: number | null; provenance: string; source: string; observed_at_ms: number };
  vram_free_bytes?: { value: number | null; provenance: string; source: string; observed_at_ms: number };
  ram_total?: { value: number; provenance: string; source: string; observed_at_ms: number };
  ram_available?: { value: number; provenance: string; source: string; observed_at_ms: number };
  gpu_vram?: { value: number; provenance: string; source: string; observed_at_ms: number };
  assigned_layers?: number[];
  assigned_layer_ranges?: [number, number][];
  model_buffer_bytes?: number;
  kv_buffer_bytes?: number;
  compute_buffer_bytes?: number;
  devices?: Array<{
    device_id: string;
    device_name: string;
    device_type: string;
    memory_total_bytes?: { value: number | null; provenance: string };
    memory_free_bytes?: { value: number | null; provenance: string };
  }>;
}

export interface ClusterSummary {
  total_nodes: number;
  online_nodes: number;
  ready_nodes?: number;
  required_nodes: number;
  unrequired_nodes?: number;
  loopback_nodes?: number;
  remote_nodes?: number;
  agent_reported_nodes: number;
  stale_nodes: number;
  memory_accounting?: {
    host_ram_deduplicated: boolean;
    independent_host_ram_bytes: number;
    note: string;
    total_model_buffer_bytes: number;
    total_kv_buffer_bytes: number;
    total_compute_buffer_bytes: number;
  };
}

// Chat / SSE
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  max_tokens?: number;
}

export interface SSEDelta {
  choices: { delta: { content?: string } }[];
  id?: number;
}

export interface SSETimings {
  choices: { delta: Record<string, never> }[];
  id: number;
  timings: {
    prompt_eval_ms: number;
    gen_ms: number;
    total_ms: number;
    tokens_generated: number;
    tokens_per_sec: number;
  };
}

export interface SwarmMetrics {
  requestsTotal: number;
  activeRequests: number;
  tokensGeneratedTotal: number;
  lastTokensPerSec: number;
  promptEvalSecondsSum: number;
  promptEvalCount: number;
  tokenGenSecondsSum: number;
  tokenGenCount: number;
  inferenceSecondsSum: number;
  inferenceCount: number;
  rawText: string;
}

