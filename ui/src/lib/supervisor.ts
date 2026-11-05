import { invoke } from "@tauri-apps/api/core";

export type ResourceEligibilityStatus =
  | "Satisfied"
  | { Deficit: { current: number; required: number } }
  | { Unavailable: { reason: string } };

export interface ProfileResourceEligibility {
  satisfies_ram: boolean | null;
  satisfies_vram: boolean | null;
  ram_status: ResourceEligibilityStatus;
  vram_status: ResourceEligibilityStatus;
  ports_available: boolean | null;
  can_launch_now: boolean;
  note: string;
}

export interface ProfileEnvVar {
  key: string;
  value: string;
}

export interface RuntimeProfileMetadata {
  id: string;
  display_name: string;
  description: string;
  is_default: boolean;
  required_ram_mb: number;
  required_vram_mb: number | null;
  coordinator_port: number;
  rpc_port: number | null;
  requires_rpc_worker: boolean;
  requires_real_authorization: boolean;
  env_vars: ProfileEnvVar[];
  eligibility: ProfileResourceEligibility;
}

export interface AvailableProfilesResponse {
  profiles: RuntimeProfileMetadata[];
  default_profile_id: string;
  queried_ram_mb?: number | null;
  queried_vram_mb?: number | null;
  query_timestamp?: string;
}

export type ClusterLifecycleState =
  | "Stopped"
  | "StartingRpc"
  | "StartingCoordinator"
  | "Healthy"
  | "Stopping"
  | "Failed"
  | "Cancelled"
  | string;

export interface ClusterStatus {
  state: ClusterLifecycleState | { Error?: string };
  active_profile?: string;
  rpc_pid?: number;
  coordinator_pid?: number;
  last_error?: string;
  rpc_ready: boolean;
  coord_healthy: boolean;
}

export interface StartEngineOptions {
  mode?: "simulated" | "real";
  profile?: string; // "default" | "low_memory_cuda_standalone"
  allow_real_runtime?: boolean;
  simulate_failure?: string;
}

export interface PreflightReport {
  can_launch: boolean;
  issues: string[];
  warnings: string[];
}

export interface EngineStartResult {
  success: boolean;
  status: ClusterStatus;
  message: string;
  preflight?: PreflightReport;
  available_ram_mb?: number;
  total_ram_mb?: number;
  available_vram_mb?: number;
  total_vram_mb?: number;
}

export interface TransportCandidate {
  transport: "tcp" | "iroh" | "usb" | string;
  name: string;
  reachable: boolean;
  p50_ms: number;
  p95_ms: number;
  jitter_ms: number;
  quality: string;
  is_recommended: boolean;
}

export interface WorkerProbeResult {
  reachable: boolean;
  host: string;
  port: number;
  /** Omitted when a measurement was not taken (e.g. while the worker is serving). */
  latency_ms?: number;
  status_state: "REACHABLE" | "CONNECTION_REFUSED" | "TIMED_OUT" | "INVALID_ADDRESS" | "ERROR" | string;
  message: string;
  actionable_recovery?: string;
  protocol_version?: string;
  network_quality?: string;
  link_type?: string;
  p50_ms?: number;
  p95_ms?: number;
  jitter_ms?: number;
  transport?: string;
  candidates?: TransportCandidate[];
  /** True when the worker is already serving the live cluster (no probe taken). */
  serving?: boolean;
}

export interface HostNetworkInfo {
  ip_addresses: string[];
  ip_names?: Record<string, string>;
  preferred_ip: string;
  coordinator_port: number;
  telemetry_token?: string;
  hostname: string;
}

export interface RemoteWorkerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  added_at_ms: number;
  is_active: boolean;
  transport?: "tcp" | "iroh" | "auto";
  endpoint_id?: string;
  direct_addr?: string;
  pairing_code?: string;
  relay_url?: string;
  tunnel_local_port?: number;
}

/** Result of pairing a phone or remote machine with a short code. */
export interface PairWorkerResult {
  success: boolean;
  message: string;
  worker: RemoteWorkerConfig | null;
  probe: WorkerProbeResult | null;
  workers: RemoteWorkerConfig[];
}

/** A worker found by LAN auto-discovery, before it is registered. */
export interface DiscoveredWorker {
  name: string;
  host: string;
  port: number;
  endpoint_id: string | null;
  platform: string;
  last_seen_ms: number;
}

export const hasTauriIpc =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export const isDesktopShell = hasTauriIpc;

export const supervisor = {
  isDesktop: isDesktopShell,

  async getEngineStatus(): Promise<ClusterStatus | null> {
    if (!isDesktopShell) return null;
    try {
      return await invoke<ClusterStatus>("supervisor_get_engine_status");
    } catch (err) {
      console.warn("Failed to query engine status:", err);
      return null;
    }
  },

  async getAvailableProfiles(): Promise<AvailableProfilesResponse | null> {
    if (!isDesktopShell) return null;
    try {
      return await invoke<AvailableProfilesResponse>(
        "supervisor_get_available_profiles"
      );
    } catch (err) {
      console.warn("Failed to query available profiles:", err);
      return null;
    }
  },

  async preflightCheck(profileId?: string): Promise<PreflightReport | null> {
    if (!isDesktopShell) return null;
    try {
      return await invoke<PreflightReport>("supervisor_preflight_check", {
        profileId,
      });
    } catch (err) {
      console.warn("Preflight check failed:", err);
      return null;
    }
  },

  async startEngine(options?: StartEngineOptions): Promise<EngineStartResult> {
    if (!isDesktopShell) {
      throw new Error("Supervisor is only available in the desktop application.");
    }
    return await invoke<EngineStartResult>("supervisor_start_engine", { options });
  },

  async stopEngine(): Promise<ClusterStatus> {
    if (!isDesktopShell) {
      throw new Error("Supervisor is only available in the desktop application.");
    }
    return await invoke<ClusterStatus>("supervisor_stop_engine");
  },

  async cancelStartup(): Promise<void> {
    if (!isDesktopShell) return;
    return await invoke<void>("supervisor_cancel_startup");
  },

  async getDiagnostics(): Promise<unknown> {
    if (!isDesktopShell) return null;
    try {
      return await invoke<unknown>("supervisor_get_diagnostics");
    } catch (err) {
      console.warn("Failed to query diagnostics:", err);
      return null;
    }
  },

  async probeWorkerEndpoint(host: string, port: number, timeoutMs = 3000): Promise<WorkerProbeResult> {
    if (!isDesktopShell) {
      throw new Error("Live worker probing requires the Swarm desktop app.");
    }
    return await invoke<WorkerProbeResult>("supervisor_probe_worker_endpoint", {
      host,
      port,
      timeoutMs,
    });
  },

  async getHostNetworkInfo(): Promise<HostNetworkInfo | null> {
    if (!isDesktopShell) {
      return null;
    }
    try {
      return await invoke<HostNetworkInfo>("supervisor_get_host_network_info");
    } catch (err) {
      console.warn("Failed to query host network info:", err);
      return null;
    }
  },

  async getRegisteredWorkers(): Promise<RemoteWorkerConfig[]> {
    if (!isDesktopShell) {
      const saved = localStorage.getItem("swarm_registered_workers");
      return saved ? JSON.parse(saved) : [];
    }
    try {
      return await invoke<RemoteWorkerConfig[]>("supervisor_get_registered_workers");
    } catch (err) {
      console.warn("Failed to get registered workers:", err);
      return [];
    }
  },

  async registerWorker(worker: RemoteWorkerConfig): Promise<RemoteWorkerConfig[]> {
    if (!isDesktopShell) {
      const list = await supervisor.getRegisteredWorkers();
      const idx = list.findIndex((w) => w.id === worker.id || (w.host === worker.host && w.port === worker.port));
      if (idx >= 0) list[idx] = worker;
      else list.push(worker);
      localStorage.setItem("swarm_registered_workers", JSON.stringify(list));
      return list;
    }
    return await invoke<RemoteWorkerConfig[]>("supervisor_register_worker", { worker });
  },

  async pairWorker(code: string, name?: string): Promise<PairWorkerResult> {
    if (!isDesktopShell) {
      throw new Error("Pairing requires the desktop app.");
    }
    return await invoke<PairWorkerResult>("supervisor_pair_worker", {
      code,
      name: name ?? null,
    });
  },

  async removeWorker(id: string): Promise<RemoteWorkerConfig[]> {
    if (!isDesktopShell) {
      const list = (await supervisor.getRegisteredWorkers()).filter((w) => w.id !== id && `${w.host}:${w.port}` !== id);
      localStorage.setItem("swarm_registered_workers", JSON.stringify(list));
      return list;
    }
    return await invoke<RemoteWorkerConfig[]>("supervisor_remove_worker", { id });
  },

  /**
   * Broadcasts a LAN probe and returns workers that answered.
   * Devices that are not running the worker service simply do not reply.
   */
  async discoverWorkers(timeoutMs = 1200): Promise<DiscoveredWorker[]> {
    if (!isDesktopShell) return [];
    try {
      return await invoke<DiscoveredWorker[]>("supervisor_discover_workers", { timeoutMs });
    } catch (err) {
      console.warn("Worker discovery failed:", err);
      return [];
    }
  },

  async getAllocationConfig(): Promise<GetAllocationConfigResponse | null> {
    if (!isDesktopShell) {
      return null;
    }
    try {
      return await invoke<GetAllocationConfigResponse>("supervisor_get_allocation_config");
    } catch (err) {
      console.warn("Failed to get allocation config:", err);
      return null;
    }
  },

  async previewAllocationPlan(config: ComputeAllocationConfig, customCandidates?: CandidateDeviceTelemetry[]): Promise<AllocationPlanPreview | null> {
    if (!isDesktopShell) {
      return null;
    }
    try {
      return await invoke<AllocationPlanPreview>("supervisor_preview_allocation_plan", {
        config,
        customCandidates,
      });
    } catch (err) {
      console.warn("Failed to preview allocation plan:", err);
      return null;
    }
  },

  async applyAllocationConfig(config: ComputeAllocationConfig, restartCoordinator: boolean = false): Promise<ApplyAllocationResult> {
    if (!isDesktopShell) {
      throw new Error("Allocation changes require the Swarm desktop app.");
    }
    return await invoke<ApplyAllocationResult>("supervisor_apply_allocation_config", {
      config,
      restartCoordinator,
    });
  },

  async rollbackAllocationConfig(restartCoordinator: boolean = false): Promise<RollbackAllocationResult> {
    if (!isDesktopShell) {
      throw new Error("Rollback is only supported in desktop supervisor mode.");
    }
    return await invoke<RollbackAllocationResult>("supervisor_rollback_allocation_config", {
      restartCoordinator,
    });
  },

  async getRuntimePlacement(): Promise<RuntimePlacementReport> {
    if (!isDesktopShell) {
      return { is_running: false, policy_name: null, policy_evaluated: false, backends: [], raw_json: null };
    }
    try {
      return await invoke<RuntimePlacementReport>("supervisor_get_runtime_placement");
    } catch (err) {
      console.warn("Failed to get runtime placement:", err);
      return { is_running: false, policy_name: null, policy_evaluated: false, backends: [], raw_json: null };
    }
  },

  async getWorkerConfig(): Promise<WorkerModeConfig | null> {
    if (!isDesktopShell) {
      // Browser previews have no native worker. Do not synthesize a config;
      // the form supplies its own defaults and no worker can actually start.
      const stored = localStorage.getItem("swarm_worker_config");
      return stored ? JSON.parse(stored) : null;
    }
    try {
      return await invoke<WorkerModeConfig>("supervisor_get_worker_config");
    } catch (err) {
      console.warn("Failed to get worker config:", err);
      return null;
    }
  },

  async saveWorkerConfig(config: WorkerModeConfig): Promise<WorkerModeConfig> {
    if (!isDesktopShell) {
      localStorage.setItem("swarm_worker_config", JSON.stringify(config));
      return config;
    }
    return await invoke<WorkerModeConfig>("supervisor_save_worker_config", { config });
  },

  async getWorkerStatus(): Promise<WorkerModeStatus | null> {
    if (!isDesktopShell) {
      return null;
    }
    try {
      return await invoke<WorkerModeStatus>("supervisor_get_worker_status");
    } catch (err) {
      console.warn("Failed to get worker status:", err);
      return null;
    }
  },

  async startWorker(config?: WorkerModeConfig): Promise<WorkerStartResult> {
    if (!isDesktopShell) {
      throw new Error("Worker Mode is unavailable outside the Swarm desktop app.");
    }
    return await invoke<WorkerStartResult>("supervisor_start_worker", { config });
  },

  async stopWorker(): Promise<WorkerModeStatus> {
    if (!isDesktopShell) {
      throw new Error("Worker Mode is unavailable outside the Swarm desktop app.");
    }
    return await invoke<WorkerModeStatus>("supervisor_stop_worker");
  },

  async getWorkerHardware(): Promise<WorkerHardwareTelemetry | null> {
    if (!isDesktopShell) {
      return null;
    }
    try {
      return await invoke<WorkerHardwareTelemetry>("supervisor_get_worker_hardware");
    } catch (err) {
      console.warn("Failed to get worker hardware:", err);
      return null;
    }
  },

  async checkFirewallStatus(): Promise<boolean | null> {
    if (!isDesktopShell) return null;
    try {
      return await invoke<boolean | null>("supervisor_check_firewall_status");
    } catch {
      return null;
    }
  },

  async revokeRemoteAccess(): Promise<WorkerModeStatus> {
    if (!isDesktopShell) {
      throw new Error("Worker Mode is unavailable outside the Swarm desktop app.");
    }
    return await invoke<WorkerModeStatus>("supervisor_revoke_remote_access");
  },

  async applyFirewallRule(port?: number, controllerIp?: string): Promise<string> {
    if (!isDesktopShell) {
      throw new Error("Worker Mode is unavailable outside the Swarm desktop app.");
    }
    return await invoke<string>("supervisor_apply_firewall_rule", {
      port,
      controllerIp: controllerIp || "",
    });
  },

  async getWorkerLogs(count?: number): Promise<string[]> {
    if (!isDesktopShell) return [];
    try {
      return await invoke<string[]>("supervisor_get_worker_logs", { count });
    } catch {
      return [];
    }
  },

  async getProcessLogs(pid: number, count?: number): Promise<string[]> {
    if (!isDesktopShell) return [];
    try {
      return await invoke<string[]>("supervisor_get_logs", { pid, count });
    } catch {
      return [];
    }
  },
};

export interface WorkerModeConfig {
  role: "inference" | "worker" | "combined" | string;
  listen_host: string;
  rpc_port: number;
  threads: number;
  backend_device: string;
  authorized_controller_ip: string;
  allow_remote_access: boolean;
  enable_file_cache: boolean;
  target_ram_mb: number;
  target_vram_mb: number;
  reserved_headroom_ram_mb: number;
  reserved_headroom_vram_mb: number;
  background_run_enabled: boolean;
  updated_at_ms: number;
}

export interface WorkerHardwareTelemetry {
  cpu_name: string;
  logical_cores: number;
  total_ram_mb: number;
  available_ram_mb: number;
  total_vram_mb: number | null;
  available_vram_mb: number | null;
  gpu_name: string | null;
  supported_backends: string[];
  timestamp_ms: number;
}

export interface WorkerModeStatus {
  role: string;
  state: "Stopped" | "CheckingPrerequisites" | "Starting" | "Listening" | "Connected" | "Busy" | "Stopping" | "Failed" | string;
  pid: number | null;
  listen_endpoint: string | null;
  advertised_endpoint: string;
  endpoint_id?: string | null;
  relay_url?: string | null;
  pairing_code?: string | null;
  is_listening: boolean;
  uptime_secs: number;
  last_error: string | null;
  hardware: WorkerHardwareTelemetry;
  config: WorkerModeConfig;
  network_interfaces: string[];
  network_interface_names?: Record<string, string>;
  firewall_rule_installed: boolean | null;
  firewall_status: "NotRequired" | "RestrictedAndVerified" | "UnrestrictedWarning" | "MissingRule" | "ControllerMismatch" | "ElevationRequired" | string;
  firewall_remote_address: string | null;
  firewall_command: string;
  recent_logs: string[];
  unencrypted_transport_warning: boolean;
  transport_security_notice: string;
  active_client_connections: string[];
  canonical_config_path: string;
  is_remote_binding: boolean;
}

export interface WorkerStartResult {
  success: boolean;
  status: WorkerModeStatus;
  message: string;
}

export interface DeviceAllocationSetting {
  device_id: string;
  device_name?: string;
  backend_type?: string;
  enabled: boolean;
  memory_budget_mb?: number;
  is_loopback?: boolean;
  split_weight?: number;
  locked_split?: boolean;
}

export interface ComputeAllocationConfig {
  mode: "automatic" | "manual";
  total_offload_layers: number;
  reserved_headroom_ram_mb: number;
  reserved_headroom_vram_mb: number;
  context_size: number;
  device_settings: DeviceAllocationSetting[];
  updated_at_ms: number;
}

export interface CandidateDeviceTelemetry {
  device_id: string;
  device_name: string;
  backend_type: string;
  is_loopback: boolean;
  memory_total_mb: number | null;
  memory_free_mb: number | null;
  is_online: boolean;
  is_stale: boolean;
  telemetry_age_ms: number;
  provenance: string;
}

export interface DevicePlanSummary {
  device_id: string;
  device_name: string;
  backend_type: string;
  is_loopback: boolean;
  enabled: boolean;
  is_online?: boolean;
  is_stale?: boolean;
  memory_budget_mb?: number;
  planned_budget_mb?: number;
  usable_budget_mb: number;
  estimated_layer_capacity: number;
  planned_layer_count: number;
  planned_layer_ranges: [number, number][];
  split_weight?: number;
  split_weight_percent?: number;
  control_type?: string;
  control_enforcement?: string;
  warning?: string | null;
  warnings?: string[];
}

export interface AllocationPlanPreview {
  mode: string;
  total_model_layers?: number;
  model_total_layers?: number;
  planned_offload_layers?: number;
  total_offload_layers?: number;
  context_size?: number;
  estimated_bytes_per_layer: number;
  total_cluster_capacity_layers?: number;
  placement_policy_env: string;
  worker_profiles_env: string;
  rpc_endpoints_env?: string;
  device_plans: DevicePlanSummary[];
  is_valid: boolean;
  validation_errors: string[];
  validation_warnings: string[];
  risk_level: "SAFE" | "WARNING" | "HIGH_RISK" | "INVALID";
  risk_explanation?: string;
}

export interface GetAllocationConfigResponse {
  config: ComputeAllocationConfig;
  has_backup: boolean;
  active_policy: string;
}

export interface ApplyAllocationResult {
  success: boolean;
  preview: AllocationPlanPreview;
  message: string;
  coordinator_restarted: boolean;
}

export interface RollbackAllocationResult {
  success: boolean;
  restored_config: ComputeAllocationConfig;
  message: string;
  coordinator_restarted: boolean;
}

export interface RuntimePlacementBackend {
  backend_id: string;
  device_name: string;
  description: string;
  endpoint: string;
  backend_type: string;
  is_loopback: boolean;
  memory_scope: string;
  assigned_layers: number[];
  assigned_layer_ranges: [number, number][];
  model_buffer_bytes: number;
  kv_buffer_bytes: number;
  compute_buffer_bytes: number;
  measurement_status: string;
  virtual_budget_bytes?: number;
  capped_capacity?: number;
  split_weight?: number;
  predicted_layers?: number[];
  policy_match?: boolean;
}

export interface RuntimePlacementReport {
  is_running: boolean;
  policy_name: string | null;
  policy_evaluated: boolean;
  backends: RuntimePlacementBackend[];
  raw_json: string | null;
}
