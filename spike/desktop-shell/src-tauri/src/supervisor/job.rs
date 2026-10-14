//! Safe RAII wrapper for Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.

use std::ptr;
use super::win32::*;

#[derive(Debug)]
pub enum JobError {
    CreateFailed(u32),
    SetLimitFailed(u32),
    AssignFailed(u32),
}

impl std::fmt::Display for JobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JobError::CreateFailed(code) => write!(f, "Failed to create Win32 Job Object (Win32 error {})", code),
            JobError::SetLimitFailed(code) => write!(f, "Failed to configure KILL_ON_JOB_CLOSE on Job Object (Win32 error {})", code),
            JobError::AssignFailed(code) => write!(f, "Failed to assign process to Job Object (Win32 error {})", code),
        }
    }
}

impl std::error::Error for JobError {}

/// An RAII-managed Windows Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
/// When this handle is closed (or when the supervisor process terminates abnormally),
/// the Windows kernel unconditionally terminates all associated processes.
pub struct JobObject {
    handle: HANDLE,
}

unsafe impl Send for JobObject {}
unsafe impl Sync for JobObject {}

impl JobObject {
    /// Creates a new anonymous Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` enforced.
    pub fn new() -> Result<Self, JobError> {
        unsafe {
            let handle = CreateJobObjectW(ptr::null_mut(), ptr::null());
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err(JobError::CreateFailed(GetLastError()));
            }

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as LPVOID,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as DWORD,
            );

            if ok == 0 {
                let err = GetLastError();
                CloseHandle(handle);
                return Err(JobError::SetLimitFailed(err));
            }

            log::info!("[JobObject] Successfully created anonymous Job Object with KILL_ON_JOB_CLOSE");
            Ok(Self { handle })
        }
    }

    /// Assigns a suspended or running Win32 process handle to this Job Object.
    /// To guarantee that no sub-processes escape, this must be called while the target
    /// process is in `CREATE_SUSPENDED` state before `ResumeThread` is called.
    pub fn assign_process(&self, process_handle: HANDLE) -> Result<(), JobError> {
        unsafe {
            let ok = AssignProcessToJobObject(self.handle, process_handle);
            if ok == 0 {
                let err = GetLastError();
                return Err(JobError::AssignFailed(err));
            }
            Ok(())
        }
    }

    /// Returns the raw Win32 HANDLE.
    pub fn raw_handle(&self) -> HANDLE {
        self.handle
    }
}

impl Drop for JobObject {
    fn drop(&mut self) {
        if !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
            unsafe {
                log::info!("[JobObject] Closing Job Object handle. Win32 kernel will terminate all assigned child processes.");
                CloseHandle(self.handle);
            }
            self.handle = ptr::null_mut();
        }
    }
}
