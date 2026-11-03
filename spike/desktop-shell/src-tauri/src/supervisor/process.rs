//! Explicit child process creation, suspended Job Object assignment, and bounded logging.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::ffi::OsStr;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use serde::{Deserialize, Serialize};

use super::job::JobObject;
use super::win32::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProcessRole {
    Coordinator,
    RpcWorker,
    TestChild,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ProcessStatus {
    Running,
    Exited { exit_code: u32 },
    Terminated,
    Failed { reason: String },
}

/// A thread-safe bounded log buffer storing up to a maximum number of lines and bytes.
#[derive(Debug, Clone)]
pub struct LogRingBuffer {
    lines: VecDeque<String>,
    max_lines: usize,
    total_bytes: usize,
    max_bytes: usize,
}

impl LogRingBuffer {
    pub fn new(max_lines: usize, max_bytes: usize) -> Self {
        Self {
            lines: VecDeque::with_capacity(max_lines),
            max_lines,
            total_bytes: 0,
            max_bytes,
        }
    }

    pub fn push(&mut self, line: String) {
        self.total_bytes += line.len();
        self.lines.push_back(line);

        while self.lines.len() > self.max_lines || self.total_bytes > self.max_bytes {
            if let Some(removed) = self.lines.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(removed.len());
            } else {
                break;
            }
        }
    }

    pub fn get_lines(&self, count: Option<usize>) -> Vec<String> {
        match count {
            Some(n) => self.lines.iter().rev().take(n).cloned().collect::<Vec<_>>().into_iter().rev().collect(),
            None => self.lines.iter().cloned().collect(),
        }
    }
}

/// Represents an explicitly created and tracked child process.
pub struct ManagedChild {
    pub pid: u32,
    pub role: ProcessRole,
    pub executable_path: PathBuf,
    pub h_process: HANDLE,
    pub h_thread: HANDLE,
    pub started_at: Instant,
    pub status: ProcessStatus,
    pub bound_ports: Vec<u16>,
    pub logs: Arc<Mutex<LogRingBuffer>>,
}

unsafe impl Send for ManagedChild {}
unsafe impl Sync for ManagedChild {}

impl ManagedChild {
    /// Polls Win32 kernel to check if process has exited.
    pub fn refresh_status(&mut self) -> &ProcessStatus {
        if matches!(self.status, ProcessStatus::Running) {
            unsafe {
                let mut exit_code: DWORD = 0;
                if GetExitCodeProcess(self.h_process, &mut exit_code) != 0 {
                    if exit_code != STILL_ACTIVE {
                        self.status = ProcessStatus::Exited { exit_code };
                    }
                }
            }
        }
        &self.status
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        unsafe {
            if !self.h_thread.is_null() && self.h_thread != INVALID_HANDLE_VALUE {
                CloseHandle(self.h_thread);
                self.h_thread = ptr::null_mut();
            }
            if !self.h_process.is_null() && self.h_process != INVALID_HANDLE_VALUE {
                CloseHandle(self.h_process);
                self.h_process = ptr::null_mut();
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChildProcessSnapshot {
    pub pid: u32,
    pub role: ProcessRole,
    pub executable: String,
    pub status: ProcessStatus,
    pub bound_ports: Vec<u16>,
    pub uptime_secs: u64,
}

pub struct ProcessManager {
    pub job_object: Arc<JobObject>,
    pub managed_children: Arc<Mutex<HashMap<u32, ManagedChild>>>,
}

impl ProcessManager {
    pub fn new(job_object: Arc<JobObject>) -> Self {
        Self {
            job_object,
            managed_children: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawns an explicit child process inside the Job Object using race-free suspended creation.
    #[cfg(windows)]
    pub fn spawn_child(
        &self,
        executable: &Path,
        args: &[&str],
        working_dir: &Path,
        env_vars: &[(&str, &str)],
        extra_dll_dirs: &[&Path],
        role: ProcessRole,
        bound_ports: Vec<u16>,
        with_console: bool,
        hide_console: bool,
    ) -> Result<u32, String> {
        if !executable.exists() {
            return Err(format!("Executable not found: {}", executable.display()));
        }
        if !working_dir.exists() {
            return Err(format!("Working directory not found: {}", working_dir.display()));
        }

        for dll_dir in extra_dll_dirs {
            if !dll_dir.exists() {
                return Err(format!("Required DLL directory not found: {}", dll_dir.display()));
            }
        }

        // Prepare wide application name and command line
        let mut cmd_line_str = format!("\"{}\"", executable.display());
        for arg in args {
            cmd_line_str.push(' ');
            if arg.contains(' ') || arg.contains('\t') {
                cmd_line_str.push('"');
                cmd_line_str.push_str(arg);
                cmd_line_str.push('"');
            } else {
                cmd_line_str.push_str(arg);
            }
        }

        let mut cmd_line_wide: Vec<u16> = OsStr::new(&cmd_line_str).encode_wide().chain(Some(0)).collect();
        let app_name_wide: Vec<u16> = executable.as_os_str().encode_wide().chain(Some(0)).collect();
        let work_dir_wide: Vec<u16> = working_dir.as_os_str().encode_wide().chain(Some(0)).collect();

        // Build validated, sorted, normalized UTF-16 environment block
        let env_block = build_windows_environment_block(env_vars, extra_dll_dirs)?;

        // Create anonymous pipe for stdout/stderr capture
        let mut h_read_pipe: HANDLE = ptr::null_mut();
        let mut h_write_pipe: HANDLE = ptr::null_mut();

        let mut sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as DWORD,
            lpSecurityDescriptor: ptr::null_mut(),
            bInheritHandle: TRUE,
        };

        unsafe {
            if CreatePipe(&mut h_read_pipe, &mut h_write_pipe, &mut sa, 0) == 0 {
                return Err(format!("Failed to create stdout pipe (Win32 error {})", GetLastError()));
            }
            // Ensure read handle is NOT inherited by child
            SetHandleInformation(h_read_pipe, HANDLE_FLAG_INHERIT, 0);
        }

        let mut si = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as DWORD,
            lpReserved: ptr::null_mut(),
            lpDesktop: ptr::null_mut(),
            lpTitle: ptr::null_mut(),
            dwX: 0,
            dwY: 0,
            dwXSize: 0,
            dwYSize: 0,
            dwXCountChars: 0,
            dwYCountChars: 0,
            dwFillAttribute: 0,
            dwFlags: STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW,
            wShowWindow: if hide_console { SW_HIDE } else { SW_SHOW },
            cbReserved2: 0,
            lpReserved2: ptr::null_mut(),
            hStdInput: ptr::null_mut(),
            hStdOutput: h_write_pipe,
            hStdError: h_write_pipe,
        };

        let mut pi = PROCESS_INFORMATION {
            hProcess: ptr::null_mut(),
            hThread: ptr::null_mut(),
            dwProcessId: 0,
            dwThreadId: 0,
        };

        // Creation flags: MUST include CREATE_SUSPENDED, CREATE_NEW_PROCESS_GROUP, and CREATE_UNICODE_ENVIRONMENT
        let mut creation_flags = CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT;
        if with_console {
            creation_flags |= CREATE_NEW_CONSOLE;
        } else {
            creation_flags |= CREATE_NO_WINDOW;
        }

        unsafe {
            let env_ptr = env_block.as_ptr() as LPVOID;

            let ok = CreateProcessW(
                app_name_wide.as_ptr(),
                cmd_line_wide.as_mut_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                TRUE, // inherit pipe write handle
                creation_flags,
                env_ptr,
                work_dir_wide.as_ptr(),
                &mut si,
                &mut pi,
            );

            // Close write handle in parent now that child has inherited it
            CloseHandle(h_write_pipe);

            if ok == 0 {
                let err = GetLastError();
                CloseHandle(h_read_pipe);
                return Err(format!("CreateProcessW failed for '{}' (Win32 error {})", executable.display(), err));
            }

            // CRITICAL STEP: Assign to Job Object while STILL SUSPENDED
            if let Err(job_err) = self.job_object.assign_process(pi.hProcess) {
                // Terminate immediately so it cannot execute a single instruction outside the job
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                CloseHandle(h_read_pipe);
                return Err(format!("Failed to assign suspended child to Job Object: {}. Terminated.", job_err));
            }

            // Resume thread now that process is safely contained in the Job Object
            if ResumeThread(pi.hThread) == u32::MAX {
                let err = GetLastError();
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                CloseHandle(h_read_pipe);
                return Err(format!("ResumeThread failed (Win32 error {})", err));
            }

            let pid = pi.dwProcessId;
            let log_buffer = Arc::new(Mutex::new(LogRingBuffer::new(2000, 512 * 1024)));

            let pipe_usize = h_read_pipe as usize;
            let reader_logs = Arc::clone(&log_buffer);

            thread::spawn(move || {
                run_pipe_reader(pipe_usize, reader_logs);
            });

            let child = ManagedChild {
                pid,
                role,
                executable_path: executable.to_path_buf(),
                h_process: pi.hProcess,
                h_thread: pi.hThread,
                started_at: Instant::now(),
                status: ProcessStatus::Running,
                bound_ports,
                logs: log_buffer,
            };

            let mut map = self.managed_children.lock().unwrap();
            map.insert(pid, child);

            log::info!("[ProcessManager] Spawned {:?} child PID {} inside Job Object", role, pid);
            Ok(pid)
        }
    }

    #[cfg(not(windows))]
    pub fn spawn_child(
        &self,
        executable: &Path,
        args: &[&str],
        working_dir: &Path,
        env_vars: &[(&str, &str)],
        _extra_dll_dirs: &[&Path],
        role: ProcessRole,
        bound_ports: Vec<u16>,
        _with_console: bool,
        _hide_console: bool,
    ) -> Result<u32, String> {
        use std::process::{Command, Stdio};
        use std::io::{BufRead, BufReader};

        let mut cmd = Command::new(executable);
        cmd.args(args);
        cmd.current_dir(working_dir);
        for &(k, v) in env_vars {
            cmd.env(k, v);
        }
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(crate::supervisor::win32::CREATE_NO_WINDOW);
        }

        let mut child_proc = cmd.spawn().map_err(|e| format!("Failed to spawn {}: {}", executable.display(), e))?;
        let pid = child_proc.id();
        let log_buffer = Arc::new(Mutex::new(LogRingBuffer::new(2000, 512 * 1024)));

        if let Some(stdout) = child_proc.stdout.take() {
            let reader_logs = Arc::clone(&log_buffer);
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().flatten() {
                    let mut buf = reader_logs.lock().unwrap();
                    buf.push(line);
                }
            });
        }

        let child = ManagedChild {
            pid,
            role,
            executable_path: executable.to_path_buf(),
            h_process: ptr::null_mut(),
            h_thread: ptr::null_mut(),
            started_at: Instant::now(),
            status: ProcessStatus::Running,
            bound_ports,
            logs: log_buffer,
        };

        let mut map = self.managed_children.lock().unwrap();
        map.insert(pid, child);
        log::info!("[ProcessManager] Spawned {:?} child PID {}", role, pid);
        Ok(pid)
    }

    /// Takes a point-in-time status snapshot of all managed processes.
    pub fn get_snapshots(&self) -> Vec<ChildProcessSnapshot> {
        let mut map = self.managed_children.lock().unwrap();
        let mut snapshots = Vec::new();
        for child in map.values_mut() {
            child.refresh_status();
            snapshots.push(ChildProcessSnapshot {
                pid: child.pid,
                role: child.role,
                executable: child.executable_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                status: child.status.clone(),
                bound_ports: child.bound_ports.clone(),
                uptime_secs: child.started_at.elapsed().as_secs(),
            });
        }
        snapshots
    }

    /// Retrieves bounded logs for a managed PID.
    pub fn get_logs(&self, pid: u32, count: Option<usize>) -> Option<Vec<String>> {
        let map = self.managed_children.lock().unwrap();
        map.get(&pid).map(|child| {
            let logs = child.logs.lock().unwrap();
            logs.get_lines(count)
        })
    }
}

fn run_pipe_reader(pipe_usize: usize, logs: Arc<Mutex<LogRingBuffer>>) {
    let pipe = pipe_usize as HANDLE;
    let mut buf = [0u8; 4096];
    let mut line_acc = Vec::new();

    loop {
        let mut bytes_read: DWORD = 0;
        let success = unsafe {
            ReadFile(
                pipe,
                buf.as_mut_ptr() as LPVOID,
                buf.len() as DWORD,
                &mut bytes_read,
                ptr::null_mut(),
            )
        };

        if success == 0 || bytes_read == 0 {
            break;
        }

        for &b in &buf[..bytes_read as usize] {
            if b == b'\n' {
                let line = String::from_utf8_lossy(&line_acc).trim_end().to_string();
                if !line.is_empty() {
                    if let Ok(mut l) = logs.lock() {
                        l.push(line);
                    }
                }
                line_acc.clear();
            } else if b != b'\r' {
                line_acc.push(b);
            }
        }
    }

    if !line_acc.is_empty() {
        let line = String::from_utf8_lossy(&line_acc).trim_end().to_string();
        if !line.is_empty() {
            if let Ok(mut l) = logs.lock() {
                l.push(line);
            }
        }
    }

    unsafe { CloseHandle(pipe) };
}

/// Builds a validated, alphabetically sorted, double-null-terminated UTF-16 environment block.
/// Resolves Windows environment variable keys case-insensitively, preventing duplicates (e.g. `Path` vs `PATH`).
/// Automatically prepends `extra_dll_dirs` to the `PATH` variable.
#[cfg(windows)]
pub fn build_windows_environment_block(
    env_vars: &[(&str, &str)],
    extra_dll_dirs: &[&Path],
) -> Result<Vec<u16>, String> {
    // Case-insensitive lookup map: uppercase key -> (canonical name, value)
    let mut env_map: BTreeMap<String, (String, String)> = BTreeMap::new();

    // 1. Inherit existing environment variables
    for (k, v) in std::env::vars() {
        let key_upper = k.to_ascii_uppercase();
        let canonical = if key_upper == "PATH" { "PATH".to_string() } else { k };
        env_map.insert(key_upper, (canonical, v));
    }

    // 2. Apply user-specified overrides
    for (k, v) in env_vars {
        let trimmed = k.trim();
        if trimmed.is_empty() {
            return Err("Environment variable name cannot be empty".to_string());
        }
        if trimmed.contains('=') {
            return Err(format!("Environment variable name '{}' cannot contain '='", k));
        }
        let key_upper = trimmed.to_ascii_uppercase();
        let canonical = if key_upper == "PATH" { "PATH".to_string() } else { trimmed.to_string() };
        env_map.insert(key_upper, (canonical, v.to_string()));
    }

    // 3. Prepend required extra DLL directories to PATH
    if !extra_dll_dirs.is_empty() {
        let mut prepend_parts = Vec::new();
        for dir in extra_dll_dirs {
            let s = dir.to_string_lossy().to_string();
            if !s.is_empty() {
                prepend_parts.push(s);
            }
        }
        let prepend_str = prepend_parts.join(";");

        let existing_path = env_map.get("PATH").map(|(_, v)| v.clone()).unwrap_or_default();
        let new_path = if existing_path.is_empty() {
            prepend_str
        } else {
            format!("{};{}", prepend_str, existing_path)
        };
        env_map.insert("PATH".to_string(), ("PATH".to_string(), new_path));
    }

    // 4. Build sorted double-null-terminated UTF-16 environment block
    let mut wide_block = Vec::new();
    for (_upper, (canonical, val)) in env_map {
        let entry = format!("{}={}\0", canonical, val);
        wide_block.extend(OsStr::new(&entry).encode_wide());
    }
    wide_block.push(0); // Final terminating null

    Ok(wide_block)
}

#[cfg(not(windows))]
pub fn build_windows_environment_block(
    _env_vars: &[(&str, &str)],
    _extra_dll_dirs: &[&Path],
) -> Result<Vec<u16>, String> {
    Ok(Vec::new())
}

/// Helper for tests: decodes a double-null-terminated UTF-16 environment block into a HashMap.
pub fn parse_environment_block_for_test(block: &[u16]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut current_chars = Vec::new();

    for &ch in block {
        if ch == 0 {
            if current_chars.is_empty() {
                break; // End of block (double null)
            }
            let s = String::from_utf16_lossy(&current_chars);
            if let Some((k, v)) = s.split_once('=') {
                map.insert(k.to_string(), v.to_string());
            }
            current_chars.clear();
        } else {
            current_chars.push(ch);
        }
    }

    map
}
