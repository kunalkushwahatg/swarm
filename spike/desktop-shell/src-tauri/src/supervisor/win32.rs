//! Win32 FFI bindings and definitions for Windows Process and Job Object supervision.
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals, dead_code)]

use std::ffi::c_void;

pub type HANDLE = *mut c_void;
pub type BOOL = i32;
pub type DWORD = u32;
pub type WORD = u16;
pub type LPWSTR = *mut u16;
pub type LPCWSTR = *const u16;
pub type LPVOID = *mut c_void;
pub type LPCVOID = *const c_void;
pub type SIZE_T = usize;
pub type ULONG_PTR = usize;

pub const TRUE: BOOL = 1;
pub const FALSE: BOOL = 0;
pub const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;

// Process creation flags
pub const CREATE_SUSPENDED: DWORD = 0x00000004;
pub const CREATE_NEW_CONSOLE: DWORD = 0x00000010;
pub const CREATE_NEW_PROCESS_GROUP: DWORD = 0x00000200;
pub const CREATE_NO_WINDOW: DWORD = 0x08000000;
pub const CREATE_UNICODE_ENVIRONMENT: DWORD = 0x00000400;
pub const STARTF_USESTDHANDLES: DWORD = 0x00000100;
pub const STARTF_USESHOWWINDOW: DWORD = 0x00000001;
pub const SW_HIDE: WORD = 0;
pub const SW_SHOW: WORD = 5;
pub const HANDLE_FLAG_INHERIT: DWORD = 0x00000001;

// Job Object limits
pub const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: DWORD = 0x00002000;
pub const JobObjectExtendedLimitInformation: DWORD = 9;

// Console control events
pub const CTRL_C_EVENT: DWORD = 0;
pub const CTRL_BREAK_EVENT: DWORD = 1;

// Wait constants
pub const WAIT_OBJECT_0: DWORD = 0x00000000;
pub const WAIT_TIMEOUT: DWORD = 0x00000102;
pub const STILL_ACTIVE: DWORD = 259;

#[repr(C)]
pub struct SECURITY_ATTRIBUTES {
    pub nLength: DWORD,
    pub lpSecurityDescriptor: LPVOID,
    pub bInheritHandle: BOOL,
}

#[repr(C)]
pub struct STARTUPINFOW {
    pub cb: DWORD,
    pub lpReserved: LPWSTR,
    pub lpDesktop: LPWSTR,
    pub lpTitle: LPWSTR,
    pub dwX: DWORD,
    pub dwY: DWORD,
    pub dwXSize: DWORD,
    pub dwYSize: DWORD,
    pub dwXCountChars: DWORD,
    pub dwYCountChars: DWORD,
    pub dwFillAttribute: DWORD,
    pub dwFlags: DWORD,
    pub wShowWindow: WORD,
    pub cbReserved2: WORD,
    pub lpReserved2: *mut u8,
    pub hStdInput: HANDLE,
    pub hStdOutput: HANDLE,
    pub hStdError: HANDLE,
}

#[repr(C)]
pub struct PROCESS_INFORMATION {
    pub hProcess: HANDLE,
    pub hThread: HANDLE,
    pub dwProcessId: DWORD,
    pub dwThreadId: DWORD,
}

#[repr(C)]
#[derive(Default)]
pub struct IO_COUNTERS {
    pub ReadOperationCount: u64,
    pub WriteOperationCount: u64,
    pub OtherOperationCount: u64,
    pub ReadTransferCount: u64,
    pub WriteTransferCount: u64,
    pub OtherTransferCount: u64,
}

#[repr(C)]
#[derive(Default)]
pub struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    pub PerProcessUserTimeLimit: i64,
    pub PerJobUserTimeLimit: i64,
    pub LimitFlags: DWORD,
    pub MinimumWorkingSetSize: SIZE_T,
    pub MaximumWorkingSetSize: SIZE_T,
    pub ActiveProcessLimit: DWORD,
    pub Affinity: ULONG_PTR,
    pub PriorityClass: DWORD,
    pub SchedulingClass: DWORD,
}

#[repr(C)]
#[derive(Default)]
pub struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    pub BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
    pub IoInfo: IO_COUNTERS,
    pub ProcessMemoryLimit: SIZE_T,
    pub JobMemoryLimit: SIZE_T,
    pub PeakProcessMemoryLimit: SIZE_T,
    pub PeakJobMemoryLimit: SIZE_T,
}

pub type PHANDLER_ROUTINE = Option<unsafe extern "system" fn(DWORD) -> BOOL>;

#[link(name = "kernel32")]
unsafe extern "system" {
    pub fn CreateJobObjectW(lpJobAttributes: *mut SECURITY_ATTRIBUTES, lpName: LPCWSTR) -> HANDLE;
    pub fn SetInformationJobObject(
        hJob: HANDLE,
        JobObjectInformationClass: DWORD,
        lpJobInformation: LPVOID,
        cbJobInformationLength: DWORD,
    ) -> BOOL;
    pub fn AssignProcessToJobObject(hJob: HANDLE, hProcess: HANDLE) -> BOOL;

    pub fn CreateProcessW(
        lpApplicationName: LPCWSTR,
        lpCommandLine: LPWSTR,
        lpProcessAttributes: *mut SECURITY_ATTRIBUTES,
        lpThreadAttributes: *mut SECURITY_ATTRIBUTES,
        bInheritHandles: BOOL,
        dwCreationFlags: DWORD,
        lpEnvironment: LPVOID,
        lpCurrentDirectory: LPCWSTR,
        lpStartupInfo: *mut STARTUPINFOW,
        lpProcessInformation: *mut PROCESS_INFORMATION,
    ) -> BOOL;

    pub fn ResumeThread(hThread: HANDLE) -> DWORD;
    pub fn TerminateProcess(hProcess: HANDLE, uExitCode: DWORD) -> BOOL;
    pub fn WaitForSingleObject(hHandle: HANDLE, dwMilliseconds: DWORD) -> DWORD;
    pub fn GetExitCodeProcess(hProcess: HANDLE, lpExitCode: *mut DWORD) -> BOOL;
    pub fn CloseHandle(hObject: HANDLE) -> BOOL;
    pub fn GetLastError() -> DWORD;

    pub fn CreatePipe(
        hReadPipe: *mut HANDLE,
        hWritePipe: *mut HANDLE,
        lpPipeAttributes: *mut SECURITY_ATTRIBUTES,
        nSize: DWORD,
    ) -> BOOL;
    pub fn SetHandleInformation(hObject: HANDLE, dwMask: DWORD, dwFlags: DWORD) -> BOOL;
    pub fn ReadFile(
        hFile: HANDLE,
        lpBuffer: LPVOID,
        nNumberOfBytesToRead: DWORD,
        lpNumberOfBytesRead: *mut DWORD,
        lpOverlapped: LPVOID,
    ) -> BOOL;
    pub fn PeekNamedPipe(
        hNamedPipe: HANDLE,
        lpBuffer: LPVOID,
        nBufferSize: DWORD,
        lpBytesRead: *mut DWORD,
        lpTotalBytesAvail: *mut DWORD,
        lpBytesLeftThisMessage: *mut DWORD,
    ) -> BOOL;

    pub fn AttachConsole(dwProcessId: DWORD) -> BOOL;
    pub fn FreeConsole() -> BOOL;
    pub fn GenerateConsoleCtrlEvent(dwCtrlEvent: DWORD, dwProcessGroupId: DWORD) -> BOOL;
    pub fn SetConsoleCtrlHandler(HandlerRoutine: PHANDLER_ROUTINE, Add: BOOL) -> BOOL;

    pub fn GlobalMemoryStatusEx(lpBuffer: *mut MEMORYSTATUSEX) -> BOOL;
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct MEMORYSTATUSEX {
    pub dwLength: DWORD,
    pub dwMemoryLoad: DWORD,
    pub ullTotalPhys: u64,
    pub ullAvailPhys: u64,
    pub ullTotalPageFile: u64,
    pub ullAvailPageFile: u64,
    pub ullTotalVirtual: u64,
    pub ullAvailVirtual: u64,
    pub ullAvailExtendedVirtual: u64,
}

impl Default for MEMORYSTATUSEX {
    fn default() -> Self {
        Self {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as DWORD,
            dwMemoryLoad: 0,
            ullTotalPhys: 0,
            ullAvailPhys: 0,
            ullTotalPageFile: 0,
            ullAvailPageFile: 0,
            ullTotalVirtual: 0,
            ullAvailVirtual: 0,
            ullAvailExtendedVirtual: 0,
        }
    }
}

pub fn get_available_physical_memory() -> Option<(u64, u64)> {
    let mut status = MEMORYSTATUSEX::default();
    unsafe {
        if GlobalMemoryStatusEx(&mut status) != 0 {
            Some((status.ullAvailPhys, status.ullTotalPhys))
        } else {
            None
        }
    }
}

/// Queries the host NVIDIA GPU for available and total VRAM in MiB using nvidia-smi.
/// Returns Some((free_mb, total_mb)) if an NVIDIA GPU is present and responsive, or None.
pub fn get_available_vram_mb() -> Option<(u64, u64)> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let output = Command::new("nvidia-smi")
        .args(&["--query-gpu=memory.free,memory.total", "--format=csv,noheader,nounits"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?;
    let mut parts = line.split(',');
    let free_str = parts.next()?.trim();
    let total_str = parts.next()?.trim();

    let free = free_str.parse::<u64>().ok()?;
    let total = total_str.parse::<u64>().ok()?;
    Some((free, total))
}

#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(
        hAlgorithm: LPVOID,
        pbBuffer: *mut u8,
        cbBuffer: DWORD,
        dwFlags: DWORD,
    ) -> DWORD;
}

/// Generates a cryptographically secure random hexadecimal string of the requested byte length
/// using the Windows CNG kernel CSPRNG (BCryptGenRandom with BCRYPT_USE_SYSTEM_PREFERRED_RNG).
pub fn generate_secure_random_hex(byte_count: usize) -> Result<String, String> {
    let mut buf = vec![0u8; byte_count];
    // BCRYPT_USE_SYSTEM_PREFERRED_RNG = 0x00000002
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buf.as_mut_ptr(),
            buf.len() as DWORD,
            0x00000002,
        )
    };
    if status == 0 {
        let hex: String = buf.iter().map(|b| format!("{:02x}", b)).collect();
        Ok(hex)
    } else {
        Err(format!("BCryptGenRandom failed with NTSTATUS 0x{:08x}", status))
    }
}

/// Queries the host operating system for available private IPv4 addresses (LAN / VPN),
/// filtering out loopback and link-local APIPA addresses.
pub fn get_local_ip_addresses() -> Vec<String> {
    let mut ips: Vec<String> = Vec::new();

    // 1. Try kernel routing table lookup via dummy UDP connect (zero network traffic sent)
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(local_addr) = socket.local_addr() {
                let ip = local_addr.ip().to_string();
                if ip != "0.0.0.0" && ip != "127.0.0.1" && !ip.starts_with("169.254.") {
                    ips.push(ip);
                }
            }
        }
    }

    // 2. Query PowerShell Get-NetIPAddress for complete list of active network adapter addresses
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    if let Ok(output) = Command::new("powershell")
        .args(&[
            "-NoProfile",
            "-Command",
            "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }).IPAddress",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() && !ips.contains(&trimmed.to_string()) {
                    ips.push(trimmed.to_string());
                }
            }
        }
    }

    if ips.is_empty() {
        ips.push("127.0.0.1".to_string());
    }

    ips
}
