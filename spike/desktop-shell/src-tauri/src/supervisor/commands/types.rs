//! Shared data contracts and types for supervisor commands.

use std::path::PathBuf;
use std::sync::Arc;
use serde::{Deserialize, Serialize};

use crate::supervisor::config::{DetailedHttpHealth, DetailedRpcReachability, PreflightReport};
use crate::supervisor::process::{ChildProcessSnapshot, ProcessManager};
use crate::supervisor::orchestrator::{ClusterStatus, Orchestrator};
use crate::supervisor::planning::{ComputeAllocationConfig, AllocationPlanPreview};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransportCandidate {
    pub transport: String,
    pub name: String,
    pub reachable: bool,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub jitter_ms: u64,
    pub quality: String,
    pub is_recommended: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerProbeResult {
    pub reachable: bool,
    pub host: String,
    pub port: u16,
    pub latency_ms: u64,
    pub status_state: String,
    pub message: String,
    pub actionable_recovery: Option<String>,
    #[serde(default)]
    pub protocol_version: Option<String>,
    #[serde(default)]
    pub network_quality: Option<String>,
    #[serde(default)]
    pub link_type: Option<String>,
    #[serde(default)]
    pub p50_ms: Option<u64>,
    #[serde(default)]
    pub p95_ms: Option<u64>,
    #[serde(default)]
    pub jitter_ms: Option<u64>,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub candidates: Option<Vec<TransportCandidate>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostNetworkInfo {
    pub ip_addresses: Vec<String>,
    #[serde(default)]
    pub ip_names: std::collections::HashMap<String, String>,
    pub preferred_ip: String,
    pub coordinator_port: u16,
    pub telemetry_token: Option<String>,
    pub hostname: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DllDirectoryCheck {
    pub path: String,
    pub exists: bool,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutableCheck {
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFileCheck {
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
    pub extension_valid: bool,
    pub size_bytes: Option<u64>,
    pub recorded_sha256_provenance: Option<String>,
    pub fresh_verification_performed: bool,
    pub verification_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortCheck {
    pub port: u16,
    pub occupied: bool,
    pub listening: bool,
    pub occupant_ownership: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupervisorDiagnosticsReport {
    // 1. Supervisor Availability
    pub supervisor_initialized: bool,
    pub job_object_active: bool,
    pub host_platform: String,

    // 2. Process Tracking (Managed Children Only)
    pub managed_children_count: usize,
    pub managed_children: Vec<ChildProcessSnapshot>,

    // 3. Port Occupancy (Distinct from process ownership)
    pub coordinator_port: PortCheck,
    pub rpc_port: PortCheck,

    // 4. Preflight Path Checks
    pub coordinator_executable: ExecutableCheck,
    pub rpc_executable: ExecutableCheck,
    pub dll_directories: Vec<DllDirectoryCheck>,
    pub model_file: ModelFileCheck,

    // 5. Active Endpoint Observations (Read-only probers)
    pub coordinator_health: DetailedHttpHealth,
    pub rpc_reachability: DetailedRpcReachability,

    // 6. Diagnostics & Validation
    pub configuration_valid: bool,
    pub issues: Vec<String>,
    pub is_simulated_fixture: bool,
    pub fixture_name: Option<String>,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupervisorStatus {
    pub is_active: bool,
    pub managed_processes: Vec<ChildProcessSnapshot>,
    pub job_object_active: bool,
    pub coordinator_port_occupied: bool,
    pub rpc_port_occupied: bool,
    pub cluster_status: ClusterStatus,
}

#[derive(Clone)]
pub struct SupervisorState {
    pub manager: Arc<ProcessManager>,
    pub orchestrator: Arc<Orchestrator>,
    pub worker_manager: Arc<crate::supervisor::WorkerModeManager>,
    pub model_library: Arc<crate::supervisor::models::ModelLibraryManager>,
    pub download_manager: Arc<crate::supervisor::models::DownloadManager>,
    pub workspace_root: PathBuf,
}

impl SupervisorState {
    pub fn new(
        manager: Arc<ProcessManager>,
        orchestrator: Arc<Orchestrator>,
        worker_manager: Arc<crate::supervisor::WorkerModeManager>,
        workspace_root: PathBuf,
    ) -> Self {
        let model_library = Arc::new(crate::supervisor::models::ModelLibraryManager::new(workspace_root.clone()));
        let download_manager = Arc::new(crate::supervisor::models::DownloadManager::new(model_library.get_models_dir()));
        Self {
            manager,
            orchestrator,
            worker_manager,
            model_library,
            download_manager,
            workspace_root,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StartEngineOptions {
    pub mode: Option<String>, // "simulated" | "real"
    pub profile: Option<String>, // None | "default" | "low_memory_cuda_standalone"
    pub simulate_failure: Option<String>, // None | "rpc_fail" | "rpc_timeout" | "coord_fail" | "coord_timeout" | "port_conflict"
    pub allow_real_runtime: Option<bool>, // Explicit operator authorization required for real execution
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStartResult {
    pub success: bool,
    pub status: ClusterStatus,
    pub message: String,
    pub preflight: Option<PreflightReport>,
    pub available_ram_mb: Option<u64>,
    pub total_ram_mb: Option<u64>,
    pub available_vram_mb: Option<u64>,
    pub total_vram_mb: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetAllocationConfigResponse {
    pub config: crate::supervisor::planning::ComputeAllocationConfig,
    pub has_backup: bool,
    pub active_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyAllocationResult {
    pub success: bool,
    pub preview: crate::supervisor::planning::AllocationPlanPreview,
    pub message: String,
    pub coordinator_restarted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackAllocationResult {
    pub success: bool,
    pub restored_config: crate::supervisor::planning::ComputeAllocationConfig,
    pub message: String,
    pub coordinator_restarted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RuntimePlacementBackend {
    pub backend_id: String,
    pub device_name: String,
    pub description: String,
    pub endpoint: String,
    pub backend_type: String,
    pub is_loopback: bool,
    pub memory_scope: String,
    pub assigned_layers: Vec<i32>,
    pub assigned_layer_ranges: Vec<(i32, i32)>,
    pub model_buffer_bytes: u64,
    pub kv_buffer_bytes: u64,
    pub compute_buffer_bytes: u64,
    pub measurement_status: String,
    pub virtual_budget_bytes: Option<u64>,
    pub capped_capacity: Option<i32>,
    pub split_weight: Option<f32>,
    pub predicted_layers: Option<Vec<i32>>,
    pub policy_match: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RuntimePlacementReport {
    pub is_running: bool,
    pub policy_name: Option<String>,
    pub policy_evaluated: bool,
    pub backends: Vec<RuntimePlacementBackend>,
    pub raw_json: Option<String>,
}

