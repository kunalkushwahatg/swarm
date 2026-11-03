//! Graceful shutdown protocol, timeout enforcement, forced fallback, and socket release verification.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};

use super::config::is_loopback_port_available;
use super::process::{ManagedChild, ProcessStatus};
use super::win32::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShutdownResult {
    pub pid: u32,
    pub graceful_exit: bool,
    pub exit_code: Option<u32>,
    pub forced_termination: bool,
    pub duration_ms: u64,
    pub ports_released: bool,
}

#[derive(Debug)]
pub enum ShutdownError {
    ProcessNotManaged(u32),
    AlreadyExited(u32),
    TerminationFailed(u32, u32),
}

impl std::fmt::Display for ShutdownError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ShutdownError::ProcessNotManaged(pid) => {
                write!(f, "Refusing shutdown: PID {} is not a process owned or created by this supervisor", pid)
            }
            ShutdownError::AlreadyExited(pid) => {
                write!(f, "Process PID {} has already exited", pid)
            }
            ShutdownError::TerminationFailed(pid, err) => {
                write!(f, "TerminateProcess failed for PID {} (Win32 error {})", pid, err)
            }
        }
    }
}

unsafe extern "system" fn supervisor_ignore_ctrl(ctrl_type: DWORD) -> BOOL {
    if ctrl_type == CTRL_C_EVENT || ctrl_type == CTRL_BREAK_EVENT {
        return TRUE; // Consume and ignore in supervisor
    }
    FALSE
}

pub fn send_console_ctrl_break(pid: u32) -> bool {
    unsafe {
        // 1. Explicitly ignore both CTRL_C and CTRL_BREAK in supervisor
        SetConsoleCtrlHandler(Some(supervisor_ignore_ctrl), TRUE);

        // 2. Detach from current console (if any) so AttachConsole can succeed
        FreeConsole();

        // 3. Attach to target process console
        let attached = AttachConsole(pid);
        let mut sent = false;

        if attached != 0 {
            // Target specifically the child's process group (which equals pid under CREATE_NEW_PROCESS_GROUP)
            let ok = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid);
            if ok != 0 {
                sent = true;
            } else {
                let ok2 = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0);
                sent = ok2 != 0;
            }
            FreeConsole();
        } else {
            let err = GetLastError();
            log::warn!("[Shutdown] AttachConsole({}) failed with Win32 error {}", pid, err);
        }

        // 4. Remove supervisor ignore handler
        SetConsoleCtrlHandler(Some(supervisor_ignore_ctrl), FALSE);
        sent
    }
}

/// Shuts down an explicitly managed child process with graceful signaling,
/// bounded timeout, forced fallback, and independent socket release verification.
pub fn shutdown_managed_child(
    pid: u32,
    managed_children: &Arc<Mutex<std::collections::HashMap<u32, ManagedChild>>>,
    timeout_ms: u64,
) -> Result<ShutdownResult, ShutdownError> {
    let t0 = Instant::now();

    // 1. Extract process handle and metadata under brief lock
    let (h_process, bound_ports) = {
        let mut map = managed_children.lock().unwrap();
        let child = map.get_mut(&pid).ok_or(ShutdownError::ProcessNotManaged(pid))?;

        if let ProcessStatus::Exited { exit_code } = child.refresh_status() {
            let exit_code = *exit_code;
            // The process is already gone; drop its handles/map entry now
            // instead of retaining every stopped worker for the process
            // lifetime.
            map.remove(&pid);
            return Ok(ShutdownResult {
                pid,
                graceful_exit: true,
                exit_code: Some(exit_code),
                forced_termination: false,
                duration_ms: 0,
                ports_released: true,
            });
        }
        (child.h_process, child.bound_ports.clone())
    };

    // 2. Dispatch graceful shutdown signal
    log::info!("[Shutdown] Dispatching graceful CTRL_BREAK_EVENT to managed PID {}", pid);
    let signal_sent = send_console_ctrl_break(pid);
    log::info!("[Shutdown] Console break signal dispatch returned: {}", signal_sent);

    // 3. Bounded wait loop
    let wait_deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut exited_gracefully = false;
    let mut final_exit_code = None;

    while Instant::now() < wait_deadline {
        let wait_res = unsafe { WaitForSingleObject(h_process, 100) };
        if wait_res == WAIT_OBJECT_0 {
            let mut code: DWORD = 0;
            unsafe { GetExitCodeProcess(h_process, &mut code) };
            exited_gracefully = true;
            final_exit_code = Some(code);
            log::info!("[Shutdown] Managed PID {} exited gracefully within {} ms with code {}", pid, t0.elapsed().as_millis(), code);
            break;
        }
    }

    // 4. Forced fallback if child did not exit within timeout
    let mut forced_termination = false;
    if !exited_gracefully {
        log::warn!("[Shutdown] Managed PID {} failed to exit within {} ms timeout. Triggering forced termination.", pid, timeout_ms);
        unsafe {
            if TerminateProcess(h_process, 99) == 0 {
                let err = GetLastError();
                // Check if it exited just before TerminateProcess was called
                let mut code: DWORD = 0;
                if GetExitCodeProcess(h_process, &mut code) != 0 && code != STILL_ACTIVE {
                    final_exit_code = Some(code);
                } else {
                    return Err(ShutdownError::TerminationFailed(pid, err));
                }
            } else {
                forced_termination = true;
                final_exit_code = Some(99);
            }
        }
    }

    // 5. Update status in managed map
    {
        let mut map = managed_children.lock().unwrap();
        if let Some(child) = map.get_mut(&pid) {
            if forced_termination {
                child.status = ProcessStatus::Terminated;
            } else if let Some(code) = final_exit_code {
                child.status = ProcessStatus::Exited { exit_code: code };
            }
        }
    }

    // 6. Independently verify that bound ports are released
    let mut all_ports_released = true;
    for &port in &bound_ports {
        let port_deadline = Instant::now() + Duration::from_secs(3);
        let mut port_free = false;
        while Instant::now() < port_deadline {
            if is_loopback_port_available(port) {
                port_free = true;
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        if !port_free {
            log::warn!("[Shutdown] Port {} did not release within socket release verification timeout!", port);
            all_ports_released = false;
        } else {
            log::info!("[Shutdown] Port {} successfully verified in LISTEN-free state.", port);
        }
    }

    // The child has exited (or was forcibly terminated). Remove the map entry
    // so handles are closed and stale PIDs do not accumulate for the lifetime
    // of the supervisor.
    {
        let mut map = managed_children.lock().unwrap();
        map.remove(&pid);
    }

    Ok(ShutdownResult {
        pid,
        graceful_exit: exited_gracefully,
        exit_code: final_exit_code,
        forced_termination,
        duration_ms: t0.elapsed().as_millis() as u64,
        ports_released: all_ports_released,
    })
}
