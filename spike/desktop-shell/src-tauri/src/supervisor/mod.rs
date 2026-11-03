pub mod win32;
pub mod job;
pub mod config;
pub mod process;
pub mod shutdown;
pub mod orchestrator;
pub mod commands;
pub mod paths;
pub mod planning;
pub mod worker_mode;
pub mod models;
pub mod discovery;
pub mod tunnel;

#[cfg(target_os = "android")]
pub mod android_worker;

pub use job::JobObject;
pub use process::ProcessManager;
pub use orchestrator::{ClusterLifecycleState, ClusterStatus, Orchestrator, StagedLaunchConfig};
pub use commands::SupervisorState;
pub use paths::{RuntimePaths, resolve_model_file, resolve_native_runtime, ensure_telemetry_token_for_profile};
pub use planning::{ComputeAllocationConfig, DeviceAllocationSetting, AllocationPlanPreview, AllocationPlanner};
pub use worker_mode::{WorkerModeManager, WorkerModeConfig, WorkerModeStatus, WorkerStartResult, WorkerHardwareTelemetry};
pub use models::{DownloadManager, ModelLibraryManager};

