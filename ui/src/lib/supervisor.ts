import { invoke } from "@tauri-apps/api/core";

export interface RuntimeProfileMetadata {
  id: string;
  name: string;
  description: string;
  mode: string;
  use_rpc: boolean;
  min_ram_mb: number;
  min_vram_mb: number;
  context_size: number;
  is_default: boolean;
  is_opt_in_only: boolean;
  ram_eligible?: boolean;
  vram_eligible?: boolean;
  overall_eligible?: boolean;
  warning?: string;
}

export interface AvailableProfilesResponse {
  profiles: RuntimeProfileMetadata[];
  default_profile_id: string;
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

export interface WorkerProbeResult {
  reachable: boolean;
  host: string;
  port: number;
  latency_ms: number;
  status_state: "REACHABLE" | "CONNECTION_REFUSED" | "TIMED_OUT" | "INVALID_ADDRESS" | "ERROR" | string;
  message: string;
  actionable_recovery?: string;
}

export interface HostNetworkInfo {
  ip_addresses: string[];
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
}

export const isDesktopShell =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

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
        profile_id: profileId,
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
      // Browser preview mode: mock response
      await new Promise((r) => setTimeout(r, 400));
      return {
        reachable: false,
        host,
        port,
        latency_ms: 400,
        status_state: "CONNECTION_REFUSED",
        message: `Connection refused by ${host}:${port}. (Browser preview: native TCP probe requires desktop shell).`,
        actionable_recovery: `Start the worker on Computer B: .\\Start-RemoteWorker.ps1 -CoordinatorUrl 'http://<HOST_IP>:8080'`,
      };
    }
    return await invoke<WorkerProbeResult>("supervisor_probe_worker_endpoint", {
      host,
      port,
      timeout_ms: timeoutMs,
    });
  },

  async getHostNetworkInfo(): Promise<HostNetworkInfo | null> {
    if (!isDesktopShell) {
      return {
        ip_addresses: ["192.168.204.41", "192.168.0.110"],
        preferred_ip: "192.168.204.41",
        coordinator_port: 8080,
        telemetry_token: "production-telemetry-secret-key-2026",
        hostname: "SWARM-HOST",
      };
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

  async removeWorker(id: string): Promise<RemoteWorkerConfig[]> {
    if (!isDesktopShell) {
      const list = (await supervisor.getRegisteredWorkers()).filter((w) => w.id !== id && `${w.host}:${w.port}` !== id);
      localStorage.setItem("swarm_registered_workers", JSON.stringify(list));
      return list;
    }
    return await invoke<RemoteWorkerConfig[]>("supervisor_remove_worker", { id });
  },

  async getAllocationConfig(): Promise<GetAllocationConfigResponse | null> {
    if (!isDesktopShell) {
      const saved = localStorage.getItem("swarm_allocation_config");
      const config: ComputeAllocationConfig = saved ? JSON.parse(saved) : {
        mode: "automatic",
        total_offload_layers: -1,
        reserved_headroom_ram_mb: 1024,
        reserved_headroom_vram_mb: 256,
        context_size: 2048,
        device_settings: [],
        updated_at_ms: Date.now(),
      };
      return { config, has_backup: false, active_policy: "dynamic" };
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
      return {
        mode: config.mode,
        total_model_layers: 37,
        planned_offload_layers: 37,
        context_size: config.context_size,
        estimated_bytes_per_layer: 97517568,
        total_cluster_capacity_layers: 42,
        placement_policy_env: config.mode === "automatic" ? "dynamic" : "resource_aware",
        worker_profiles_env: "",
        device_plans: [],
        is_valid: true,
        validation_errors: [],
        validation_warnings: [],
        risk_level: "SAFE",
      };
    }
    try {
      return await invoke<AllocationPlanPreview>("supervisor_preview_allocation_plan", {
        config,
        custom_candidates: customCandidates,
      });
    } catch (err) {
      console.warn("Failed to preview allocation plan:", err);
      return null;
    }
  },

  async applyAllocationConfig(config: ComputeAllocationConfig, restartCoordinator: boolean = false): Promise<ApplyAllocationResult> {
    if (!isDesktopShell) {
      localStorage.setItem("swarm_allocation_config", JSON.stringify(config));
      const preview = (await supervisor.previewAllocationPlan(config))!;
      return {
        success: true,
        preview,
        message: "Saved in browser storage.",
        coordinator_restarted: false,
      };
    }
    return await invoke<ApplyAllocationResult>("supervisor_apply_allocation_config", {
      config,
      restart_coordinator: restartCoordinator,
    });
  },

  async rollbackAllocationConfig(restartCoordinator: boolean = false): Promise<RollbackAllocationResult> {
    if (!isDesktopShell) {
      throw new Error("Rollback is only supported in desktop supervisor mode.");
    }
    return await invoke<RollbackAllocationResult>("supervisor_rollback_allocation_config", {
      restart_coordinator: restartCoordinator,
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
};

export interface DeviceAllocationSetting {
  device_id: string;
  device_name: string;
  backend_type: string;
  enabled: boolean;
  memory_budget_mb: number;
  is_loopback: boolean;
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
  memory_budget_mb: number;
  usable_budget_mb: number;
  estimated_layer_capacity: number;
  planned_layer_count: number;
  planned_layer_ranges: [number, number][];
  split_weight_percent: number;
  control_type: string;
  warnings: string[];
}

export interface AllocationPlanPreview {
  mode: string;
  total_model_layers: number;
  planned_offload_layers: number;
  context_size: number;
  estimated_bytes_per_layer: number;
  total_cluster_capacity_layers: number;
  placement_policy_env: string;
  worker_profiles_env: string;
  device_plans: DevicePlanSummary[];
  is_valid: boolean;
  validation_errors: string[];
  validation_warnings: string[];
  risk_level: "SAFE" | "WARNING" | "HIGH_RISK" | "INVALID";
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
