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

#[cfg(windows)]
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

    pub fn OpenProcess(dwDesiredAccess: DWORD, bInheritHandle: BOOL, dwProcessId: DWORD) -> HANDLE;
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

#[cfg(not(windows))]
pub unsafe fn CloseHandle(_h: HANDLE) -> BOOL { 1 }
#[cfg(not(windows))]
pub unsafe fn GetExitCodeProcess(_h: HANDLE, lp: *mut DWORD) -> BOOL { unsafe { if !lp.is_null() { *lp = 0; } } 1 }
#[cfg(not(windows))]
pub unsafe fn TerminateProcess(_h: HANDLE, _code: DWORD) -> BOOL { 1 }
#[cfg(not(windows))]
pub unsafe fn WaitForSingleObject(_h: HANDLE, _ms: DWORD) -> DWORD { 0 }
#[cfg(not(windows))]
pub unsafe fn ResumeThread(_h: HANDLE) -> DWORD { 0 }
#[cfg(not(windows))]
pub unsafe fn GetLastError() -> DWORD { 0 }
#[cfg(not(windows))]
pub unsafe fn OpenProcess(_access: DWORD, _inherit: BOOL, _pid: DWORD) -> HANDLE { std::ptr::null_mut() }
#[cfg(not(windows))]
pub unsafe fn CreateJobObjectW(_attr: *mut SECURITY_ATTRIBUTES, _name: LPCWSTR) -> HANDLE { 1 as HANDLE }
#[cfg(not(windows))]
pub unsafe fn SetInformationJobObject(_h: HANDLE, _class: DWORD, _info: LPVOID, _len: DWORD) -> BOOL { 1 }
#[cfg(not(windows))]
pub unsafe fn AssignProcessToJobObject(_h: HANDLE, _hp: HANDLE) -> BOOL { 1 }
#[cfg(not(windows))]
pub unsafe fn ReadFile(_h: HANDLE, _buf: LPVOID, _to_read: DWORD, read: *mut DWORD, _ov: LPVOID) -> BOOL { unsafe { if !read.is_null() { *read = 0; } } 0 }
#[cfg(not(windows))]
pub unsafe fn AttachConsole(_pid: DWORD) -> BOOL { 0 }
#[cfg(not(windows))]
pub unsafe fn FreeConsole() -> BOOL { 1 }
#[cfg(not(windows))]
pub unsafe fn GenerateConsoleCtrlEvent(_ev: DWORD, _grp: DWORD) -> BOOL { 0 }
#[cfg(not(windows))]
pub unsafe fn SetConsoleCtrlHandler(_handler: PHANDLER_ROUTINE, _add: BOOL) -> BOOL { 1 }

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

#[cfg(windows)]
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

#[cfg(not(windows))]
pub fn get_available_physical_memory() -> Option<(u64, u64)> {
    if let Ok(text) = std::fs::read_to_string("/proc/meminfo") {
        let mut total = None;
        let mut avail = None;
        for line in text.lines() {
            if line.starts_with("MemTotal:") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    total = parts[1].parse::<u64>().ok().map(|kb| kb * 1024);
                }
            } else if line.starts_with("MemAvailable:") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    avail = parts[1].parse::<u64>().ok().map(|kb| kb * 1024);
                }
            }
        }
        if let (Some(a), Some(t)) = (avail, total) {
            return Some((a, t));
        }
    }
    None
}

/// Queries the host NVIDIA GPU for available and total VRAM in MiB using nvidia-smi.
/// Returns Some((free_mb, total_mb)) if an NVIDIA GPU is present and responsive, or None.
#[cfg(windows)]
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

#[cfg(not(windows))]
pub fn get_available_vram_mb() -> Option<(u64, u64)> {
    None
}

#[cfg(windows)]
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
#[cfg(windows)]
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

#[cfg(not(windows))]
pub fn generate_secure_random_hex(byte_count: usize) -> Result<String, String> {
    use std::io::Read;
    let mut buf = vec![0u8; byte_count];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut buf).is_ok() {
            return Ok(buf.iter().map(|b| format!("{:02x}", b)).collect());
        }
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    Ok(format!("{:016x}{:016x}", now, now.wrapping_mul(6364136223846793005)))
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

    // 2. Query PowerShell Get-NetIPAddress on Windows
    #[cfg(windows)]
    {
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
    }

    if ips.is_empty() {
        ips.push("127.0.0.1".to_string());
    }

    // Sort IP addresses so that reachable LAN/Hotspot interfaces appear ahead
    // of VPN tunnels (Cloudflare WARP 172.16.x, Tailscale 100.x, Docker, etc.).
    // This ensures QR codes and coordinator URLs default to an address that the
    // phone can actually reach on the local network.
    ips.sort_by_key(|ip| {
        if ip.starts_with("192.168.137.") { 0 } // Windows Mobile Hotspot
        else if ip.starts_with("10.154.") { 1 } // USB Tethering (RNDIS)
        else if ip.starts_with("192.168.") { 2 } // Standard home/office Wi-Fi
        else if ip.starts_with("10.") { 3 } // Private enterprise LAN
        else if ip.starts_with("172.") { 20 } // Cloudflare WARP / Docker
        else if ip.starts_with("100.") { 21 } // Tailscale CGNAT
        else { 10 }
    });

    ips
}

/// Cached IPv4 subnets belonging to USB tethering (RNDIS) adapters.
static USB_TETHER_SUBNETS: std::sync::OnceLock<
    std::sync::Mutex<(std::time::Instant, Vec<(std::net::Ipv4Addr, u8)>)>,
> = std::sync::OnceLock::new();

/// Returns IPv4 subnets owned by USB tethering adapters.
///
/// Android USB tethering surfaces on Windows as a "Remote NDIS" adapter, so
/// matching a worker address against these subnets is what lets the UI say
/// "USB" with confidence instead of guessing from the address alone.
/// Results are cached briefly because this shells out to PowerShell.
pub fn get_usb_tether_subnets() -> Vec<(std::net::Ipv4Addr, u8)> {
    let cache = USB_TETHER_SUBNETS.get_or_init(|| {
        // Force an immediate first query without risking an Instant underflow
        // on a freshly booted machine.
        let stale = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(60))
            .unwrap_or_else(std::time::Instant::now);
        std::sync::Mutex::new((stale, Vec::new()))
    });

    if let Ok(guard) = cache.lock() {
        if guard.0.elapsed() < std::time::Duration::from_secs(15) {
            return guard.1.clone();
        }
    }

    let subnets = query_usb_tether_subnets();
    if let Ok(mut guard) = cache.lock() {
        *guard = (std::time::Instant::now(), subnets.clone());
    }
    subnets
}

#[cfg(windows)]
fn query_usb_tether_subnets() -> Vec<(std::net::Ipv4Addr, u8)> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const SCRIPT: &str = "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -match 'NDIS' } | ForEach-Object { Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.IPAddress)/$($_.PrefixLength)\" } }";

    let mut out = Vec::new();
    if let Ok(output) = Command::new("powershell")
        .args(["-NoProfile", "-Command", SCRIPT])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if let Some((ip, prefix)) = line.trim().split_once('/') {
                    if let (Ok(ip), Ok(prefix)) = (ip.trim().parse(), prefix.trim().parse::<u8>()) {
                        if prefix <= 32 {
                            out.push((ip, prefix));
                        }
                    }
                }
            }
        }
    }
    out
}

#[cfg(not(windows))]
fn query_usb_tether_subnets() -> Vec<(std::net::Ipv4Addr, u8)> {
    Vec::new()
}

/// True when `ip` sits inside a local USB tethering subnet.
pub fn is_usb_tether_address(ip: std::net::Ipv4Addr) -> bool {
    let target = u32::from(ip);
    get_usb_tether_subnets().into_iter().any(|(net, prefix)| {
        let mask = if prefix == 0 {
            0
        } else {
            u32::MAX << (32 - prefix as u32)
        };
        (target & mask) == (u32::from(net) & mask)
    })
}

/// Verifies whether a given process ID corresponds to an actively executing process.
pub fn is_pid_alive(pid: u32) -> bool {    const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code: DWORD = 0;
        let ok = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        ok != 0 && exit_code == STILL_ACTIVE
    }
}
