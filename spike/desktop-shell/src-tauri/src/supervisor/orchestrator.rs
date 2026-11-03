//! Staged multi-process startup state machine for Swarm cluster orchestration.
//! Manages explicit lifecycle states: STOPPED -> STARTING_RPC -> WAITING_FOR_RPC
//! -> STARTING_COORDINATOR -> WAITING_FOR_COORDINATOR -> READY -> STOPPING -> ERROR.
//! Implements strict rollback on partial startup failure and non-destructive port guards.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};

use super::config::{check_http_health, is_loopback_port_available, is_port_listening};
use super::process::{ProcessManager, ProcessRole, ProcessStatus};
use super::shutdown::shutdown_managed_child;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClusterLifecycleState {
    Stopped,
    StartingRpc,
    WaitingForRpc,
    StartingCoordinator,
    WaitingForCoordinator,
    Ready,
    Stopping,
    Error { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterStatus {
    pub state: ClusterLifecycleState,
    pub rpc_pid: Option<u32>,
    pub coordinator_pid: Option<u32>,
    pub rpc_port: u16,
    pub coordinator_port: u16,
    pub last_error: Option<String>,
    #[serde(default)]
    pub active_profile: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StagedLaunchConfig {
    pub rpc_executable: PathBuf,
    pub rpc_working_dir: PathBuf,
    pub rpc_args: Vec<String>,
    pub rpc_extra_dll_dirs: Vec<PathBuf>,
    pub rpc_env: Vec<(String, String)>,
    pub rpc_port: u16,
    pub rpc_readiness_timeout_ms: u64,

    pub coord_executable: PathBuf,
    pub coord_working_dir: PathBuf,
    pub coord_args: Vec<String>,
    pub coord_extra_dll_dirs: Vec<PathBuf>,
    pub coord_env: Vec<(String, String)>,
    pub coord_port: u16,
    pub coord_health_path: String,
    pub coord_readiness_timeout_ms: u64,
}

struct OrchestratorInner {
    state: ClusterLifecycleState,
    rpc_pid: Option<u32>,
    coordinator_pid: Option<u32>,
    rpc_port: u16,
    coordinator_port: u16,
    last_error: Option<String>,
    active_profile: Option<String>,
}

pub struct Orchestrator {
    manager: Arc<ProcessManager>,
    inner: Arc<Mutex<OrchestratorInner>>,
    cancel_flag: Arc<AtomicBool>,
}

impl Orchestrator {
    pub fn new(manager: Arc<ProcessManager>) -> Self {
        Self {
            manager,
            inner: Arc::new(Mutex::new(OrchestratorInner {
                state: ClusterLifecycleState::Stopped,
                rpc_pid: None,
                coordinator_pid: None,
                rpc_port: 0,
                coordinator_port: 0,
                last_error: None,
                active_profile: None,
            })),
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Sets the active launch profile identifier (e.g. "default" or "low_memory_cuda_standalone").
    pub fn set_active_profile(&self, profile: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        inner.active_profile = profile;
    }

    /// Requests cancellation of any in-flight startup sequence.
    pub fn request_cancel(&self) {
        log::info!("[Orchestrator] Cancellation requested by operator");
        self.cancel_flag.store(true, Ordering::SeqCst);
    }

    /// Returns whether cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.cancel_flag.load(Ordering::SeqCst)
    }

    /// Detects children that died after the cluster reached Ready and moves the
    /// state to Error, so a crashed cluster no longer reports Ready forever.
    fn refresh_liveness(&self) {
        let (state, rpc_pid, coord_pid) = {
            let inner = self.inner.lock().unwrap();
            (inner.state.clone(), inner.rpc_pid, inner.coordinator_pid)
        };
        if state != ClusterLifecycleState::Ready {
            return;
        }

        let failure = {
            let mut map = self.manager.managed_children.lock().unwrap();
            let mut failure = None;
            for (pid_opt, label) in [(coord_pid, "Coordinator"), (rpc_pid, "RPC worker")] {
                let Some(pid) = pid_opt else { continue };
                failure = match map.get_mut(&pid).map(|child| child.refresh_status()) {
                    Some(ProcessStatus::Running) => None,
                    Some(ProcessStatus::Exited { exit_code }) => {
                        Some(format!("{} PID {} exited with code {}", label, pid, exit_code))
                    }
                    Some(ProcessStatus::Terminated) => {
                        Some(format!("{} PID {} was terminated", label, pid))
                    }
                    Some(ProcessStatus::Failed { reason }) => {
                        Some(format!("{} PID {} failed: {}", label, pid, reason))
                    }
                    None => Some(format!("{} PID {} is no longer tracked", label, pid)),
                };
                if failure.is_some() {
                    break;
                }
            }
            failure
        };

        let Some(reason) = failure else { return };

        let (rpc_pid, coord_pid) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.state == ClusterLifecycleState::Ready {
                log::error!("[Orchestrator] {}", reason);
                inner.state = ClusterLifecycleState::Error { reason: reason.clone() };
                inner.last_error = Some(reason);
                let pids = (inner.rpc_pid, inner.coordinator_pid);
                inner.rpc_pid = None;
                inner.coordinator_pid = None;
                pids
            } else {
                (None, None)
            }
        };

        // If one cluster process died, the cluster is broken. Terminate any surviving
        // sibling process immediately so it doesn't linger and hold ports open.
        if let Some(pid) = coord_pid {
            let _ = shutdown_managed_child(pid, &self.manager.managed_children, 1000);
        }
        if let Some(pid) = rpc_pid {
            let _ = shutdown_managed_child(pid, &self.manager.managed_children, 1000);
        }
    }

    /// Returns the current cluster orchestration status.
    pub fn get_status(&self) -> ClusterStatus {
        self.refresh_liveness();
        let inner = self.inner.lock().unwrap();
        ClusterStatus {
            state: inner.state.clone(),
            rpc_pid: inner.rpc_pid,
            coordinator_pid: inner.coordinator_pid,
            rpc_port: inner.rpc_port,
            coordinator_port: inner.coordinator_port,
            last_error: inner.last_error.clone(),
            active_profile: inner.active_profile.clone(),
        }
    }

    /// Executes the staged startup sequence corresponding to the audited Swarm launch model:
    /// 1. Non-destructive port conflict pre-checks (abort if occupied).
    /// 2. STARTING_RPC -> Launch RPC worker inside Job Object with hidden console.
    /// 3. WAITING_FOR_RPC -> Poll TCP listening endpoint on rpc_port.
    /// 4. STARTING_COORDINATOR -> Launch Coordinator inside Job Object with prepended DLL path.
    /// 5. WAITING_FOR_COORDINATOR -> Poll HTTP /health endpoint on coordinator_port.
    /// 6. READY -> Both processes verified healthy and contained.
    ///
    /// On failure at any step: Rollback tears down ONLY children created by this supervisor.
    pub fn start_staged(&self, config: &StagedLaunchConfig) -> Result<(), String> {
        // Reset cancellation flag for fresh launch sequence
        self.cancel_flag.store(false, Ordering::SeqCst);

        // 0. Preflight checks and state guard
        {
            let mut inner = self.inner.lock().unwrap();
            match &inner.state {
                ClusterLifecycleState::Stopped | ClusterLifecycleState::Error { .. } => {}
                current => {
                    return Err(format!("Cannot start: cluster is in state {:?}", current));
                }
            }

            // Non-destructive port checks: abort without touching existing services
            if config.rpc_port > 0 && !is_loopback_port_available(config.rpc_port) {
                let err = format!(
                    "RPC port {} is already in use by an external process. Supervisor refusing to overwrite.",
                    config.rpc_port
                );
                inner.state = ClusterLifecycleState::Error { reason: err.clone() };
                inner.last_error = Some(err.clone());
                return Err(err);
            }
            if !is_loopback_port_available(config.coord_port) {
                let err = format!(
                    "Coordinator port {} is already in use by an external process. Supervisor refusing to overwrite.",
                    config.coord_port
                );
                inner.state = ClusterLifecycleState::Error { reason: err.clone() };
                inner.last_error = Some(err.clone());
                return Err(err);
            }

            inner.rpc_port = config.rpc_port;
            inner.coordinator_port = config.coord_port;
            inner.rpc_pid = None;
            inner.coordinator_pid = None;
            inner.last_error = None;
        }

        // 1. STARTING_RPC (only if rpc_port > 0)
        let rpc_pid: Option<u32> = if config.rpc_port > 0 {
            self.set_state(ClusterLifecycleState::StartingRpc);
            log::info!("[Orchestrator] Starting RPC Worker on port {}", config.rpc_port);

            let rpc_args_str: Vec<&str> = config.rpc_args.iter().map(|s| s.as_str()).collect();
            let rpc_env_tuples: Vec<(&str, &str)> = config.rpc_env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            let rpc_dll_refs: Vec<&Path> = config.rpc_extra_dll_dirs.iter().map(|p| p.as_path()).collect();

            let pid = match self.manager.spawn_child(
                &config.rpc_executable,
                &rpc_args_str,
                &config.rpc_working_dir,
                &rpc_env_tuples,
                &rpc_dll_refs,
                ProcessRole::RpcWorker,
                vec![config.rpc_port],
                true, // with_console for graceful break
                true, // hide_console
            ) {
                Ok(pid) => {
                    let mut inner = self.inner.lock().unwrap();
                    inner.rpc_pid = Some(pid);
                    pid
                }
                Err(e) => {
                    let err = format!("Failed to spawn RPC worker: {}", e);
                    self.set_error(err.clone());
                    return Err(err);
                }
            };

            // 2. WAITING_FOR_RPC
            self.set_state(ClusterLifecycleState::WaitingForRpc);
            log::info!("[Orchestrator] Waiting for RPC Worker (PID {}) listening state...", pid);

            let rpc_deadline = Instant::now() + Duration::from_millis(config.rpc_readiness_timeout_ms);
            let mut rpc_ready = false;

            while Instant::now() < rpc_deadline {
                // Check for cancellation
                if self.cancel_flag.load(Ordering::SeqCst) {
                    let err = "Startup cancelled by operator".to_string();
                    log::info!("[Orchestrator] {}", err);
                    self.rollback_partial(Some(pid), None);
                    self.set_state(ClusterLifecycleState::Stopped);
                    return Err(err);
                }

                // Check if process unexpectedly died
                {
                    let mut map = self.manager.managed_children.lock().unwrap();
                    if let Some(child) = map.get_mut(&pid) {
                        let exit_code = match child.refresh_status() {
                            ProcessStatus::Exited { exit_code } => Some(*exit_code),
                            _ => None,
                        };
                        if let Some(exit_code) = exit_code {
                            let tail = child
                                .logs
                                .lock()
                                .map(|logs| logs.get_lines(Some(12)).join(" | "))
                                .unwrap_or_default();
                            let err = if tail.is_empty() {
                                format!("RPC worker PID {} exited prematurely with code {}", pid, exit_code)
                            } else {
                                format!(
                                    "RPC worker PID {} exited prematurely with code {}. Last output: {}",
                                    pid, exit_code, tail
                                )
                            };
                            drop(map);
                            self.rollback_partial(Some(pid), None);
                            self.set_error(err.clone());
                            return Err(err);
                        }
                    }
                }

                if is_port_listening(config.rpc_port) {
                    rpc_ready = true;
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }

            if !rpc_ready {
                let err = format!(
                    "RPC worker PID {} failed to listen on port {} within {} ms timeout",
                    pid, config.rpc_port, config.rpc_readiness_timeout_ms
                );
                log::error!("[Orchestrator] {}", err);
                self.rollback_partial(Some(pid), None);
                self.set_error(err.clone());
                return Err(err);
            }

            log::info!("[Orchestrator] RPC worker PID {} verified listening on port {}", pid, config.rpc_port);
            Some(pid)
        } else {
            log::info!("[Orchestrator] Standalone mode: RPC worker skipped (rpc_port == 0)");
            None
        };

        // 3. STARTING_COORDINATOR
        self.set_state(ClusterLifecycleState::StartingCoordinator);
        log::info!("[Orchestrator] Starting Coordinator on port {}", config.coord_port);

        let coord_args_str: Vec<&str> = config.coord_args.iter().map(|s| s.as_str()).collect();
        let coord_env_tuples: Vec<(&str, &str)> = config.coord_env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let coord_dll_refs: Vec<&Path> = config.coord_extra_dll_dirs.iter().map(|p| p.as_path()).collect();

        let coord_pid = match self.manager.spawn_child(
            &config.coord_executable,
            &coord_args_str,
            &config.coord_working_dir,
            &coord_env_tuples,
            &coord_dll_refs,
            ProcessRole::Coordinator,
            vec![config.coord_port],
            true, // with_console
            true, // hide_console
        ) {
            Ok(pid) => {
                let mut inner = self.inner.lock().unwrap();
                inner.coordinator_pid = Some(pid);
                pid
            }
            Err(e) => {
                let err = format!("Failed to spawn Coordinator: {}", e);
                self.rollback_partial(rpc_pid, None);
                self.set_error(err.clone());
                return Err(err);
            }
        };

        // 4. WAITING_FOR_COORDINATOR
        self.set_state(ClusterLifecycleState::WaitingForCoordinator);
        log::info!("[Orchestrator] Waiting for Coordinator (PID {}) /health readiness...", coord_pid);

        let coord_deadline = Instant::now() + Duration::from_millis(config.coord_readiness_timeout_ms);
        let mut coord_ready = false;

        while Instant::now() < coord_deadline {
            // Check for cancellation
            if self.cancel_flag.load(Ordering::SeqCst) {
                let err = "Startup cancelled by operator".to_string();
                log::info!("[Orchestrator] {}", err);
                self.rollback_partial(rpc_pid, Some(coord_pid));
                self.set_state(ClusterLifecycleState::Stopped);
                return Err(err);
            }

            // Check if either child process unexpectedly died
            {
                let mut map = self.manager.managed_children.lock().unwrap();
                if let Some(child) = map.get_mut(&coord_pid) {
                    let exit_code = match child.refresh_status() {
                        ProcessStatus::Exited { exit_code } => Some(*exit_code),
                        _ => None,
                    };
                    if let Some(exit_code) = exit_code {
                        let tail = child
                            .logs
                            .lock()
                            .map(|logs| logs.get_lines(Some(12)).join(" | "))
                            .unwrap_or_default();
                        let err = if tail.is_empty() {
                            format!("Coordinator PID {} exited prematurely with code {}", coord_pid, exit_code)
                        } else {
                            format!(
                                "Coordinator PID {} exited prematurely with code {}. Last output: {}",
                                coord_pid, exit_code, tail
                            )
                        };
                        drop(map);
                        self.rollback_partial(rpc_pid, Some(coord_pid));
                        self.set_error(err.clone());
                        return Err(err);
                    }
                }
            }

            if check_http_health(config.coord_port, &config.coord_health_path, 200) {
                coord_ready = true;
                break;
            }
            thread::sleep(Duration::from_millis(150));
        }

        if !coord_ready {
            let err = format!(
                "Coordinator PID {} health check on port {} timed out after {} ms",
                coord_pid, config.coord_port, config.coord_readiness_timeout_ms
            );
            log::error!("[Orchestrator] {}", err);
            self.rollback_partial(rpc_pid, Some(coord_pid));
            self.set_error(err.clone());
            return Err(err);
        }

        // 5. READY
        self.set_state(ClusterLifecycleState::Ready);
        match rpc_pid {
            Some(rpid) => log::info!("[Orchestrator] Cluster successfully orchestrated and READY (RPC PID {}, Coordinator PID {})", rpid, coord_pid),
            None => log::info!("[Orchestrator] Coordinator successfully orchestrated and READY in standalone mode (PID {})", coord_pid),
        }
        Ok(())
    }

    /// Gracefully stops the orchestrated cluster: Coordinator first, then RPC worker.
    pub fn stop_staged(&self, timeout_ms: u64) -> Result<(), String> {
        self.cancel_flag.store(true, Ordering::SeqCst);
        self.set_state(ClusterLifecycleState::Stopping);
        log::info!("[Orchestrator] Stopping cluster...");

        let (rpc_pid, coord_pid) = {
            let inner = self.inner.lock().unwrap();
            (inner.rpc_pid, inner.coordinator_pid)
        };

        // Stop coordinator first
        if let Some(pid) = coord_pid {
            log::info!("[Orchestrator] Shutting down Coordinator PID {}", pid);
            let _ = shutdown_managed_child(pid, &self.manager.managed_children, timeout_ms);
        }

        // Stop RPC worker second
        if let Some(pid) = rpc_pid {
            log::info!("[Orchestrator] Shutting down RPC Worker PID {}", pid);
            let _ = shutdown_managed_child(pid, &self.manager.managed_children, timeout_ms);
        }

        {
            let mut inner = self.inner.lock().unwrap();
            inner.rpc_pid = None;
            inner.coordinator_pid = None;
            inner.state = ClusterLifecycleState::Stopped;
        }

        log::info!("[Orchestrator] Cluster stopped cleanly.");
        Ok(())
    }

    fn rollback_partial(&self, rpc_pid: Option<u32>, coord_pid: Option<u32>) {
        self.set_state(ClusterLifecycleState::Stopping);
        log::warn!("[Orchestrator] Rolling back partial startup...");

        if let Some(pid) = coord_pid {
            let _ = shutdown_managed_child(pid, &self.manager.managed_children, 2000);
        }
        if let Some(pid) = rpc_pid {
            let _ = shutdown_managed_child(pid, &self.manager.managed_children, 2000);
        }

        let mut inner = self.inner.lock().unwrap();
        inner.rpc_pid = None;
        inner.coordinator_pid = None;
    }

    fn set_state(&self, state: ClusterLifecycleState) {
        let mut inner = self.inner.lock().unwrap();
        inner.state = state;
    }

    fn set_error(&self, reason: String) {
        let mut inner = self.inner.lock().unwrap();
        inner.state = ClusterLifecycleState::Error { reason: reason.clone() };
        inner.last_error = Some(reason);
    }
}
