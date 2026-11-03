use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sha2::{Digest, Sha256};
use super::types::{DownloadStatus, DownloadTask};

pub struct ActiveDownloadHandle {
    pub cancel_flag: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct DownloadManager {
    tasks: Arc<Mutex<HashMap<String, DownloadTask>>>,
    active_handles: Arc<Mutex<HashMap<String, ActiveDownloadHandle>>>,
    models_dir: Arc<Mutex<PathBuf>>,
}

impl DownloadManager {
    pub fn new(models_dir: PathBuf) -> Self {
        Self {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            active_handles: Arc::new(Mutex::new(HashMap::new())),
            models_dir: Arc::new(Mutex::new(models_dir)),
        }
    }

    pub fn get_models_dir(&self) -> PathBuf {
        self.models_dir.lock().unwrap().clone()
    }

    pub fn set_models_dir(&self, new_dir: PathBuf) {
        *self.models_dir.lock().unwrap() = new_dir;
    }

    pub fn get_all_tasks(&self) -> Vec<DownloadTask> {
        let tasks = self.tasks.lock().unwrap();
        tasks.values().cloned().collect()
    }

    pub fn get_task(&self, task_id: &str) -> Option<DownloadTask> {
        let tasks = self.tasks.lock().unwrap();
        tasks.get(task_id).cloned()
    }

    pub fn cancel_download(&self, task_id: &str) -> Result<(), String> {
        let handles = self.active_handles.lock().unwrap();
        if let Some(handle) = handles.get(task_id) {
            handle.cancel_flag.store(true, Ordering::SeqCst);
        }

        let mut tasks = self.tasks.lock().unwrap();
        if let Some(task) = tasks.get_mut(task_id) {
            if task.status == DownloadStatus::Downloading || task.status == DownloadStatus::Queued {
                task.status = DownloadStatus::Cancelled;
                task.updated_at_ms = current_time_ms();
            }
        }
        Ok(())
    }

    pub fn clear_completed_tasks(&self) {
        let mut tasks = self.tasks.lock().unwrap();
        tasks.retain(|_, t| {
            t.status != DownloadStatus::Completed && t.status != DownloadStatus::Cancelled
        });
    }

    pub fn start_download(
        &self,
        model_id: String,
        filename: String,
        source_url: String,
        repo_id: Option<String>,
        expected_sha256: Option<String>,
        custom_destination: Option<PathBuf>,
    ) -> Result<String, String> {
        // Validate URL
        if !source_url.starts_with("http://") && !source_url.starts_with("https://") {
            return Err("Invalid source URL: must be http or https".to_string());
        }

        // Validate filename: exactly one normal path component. This rejects
        // traversal, separators, absolute paths, and Windows drive prefixes.
        let filename_path = Path::new(&filename);
        let mut components = filename_path.components();
        let is_plain_filename = matches!(
            components.next(),
            Some(std::path::Component::Normal(_))
        ) && components.next().is_none();
        if !is_plain_filename {
            return Err(
                "Invalid filename: must be a plain file name without directories or drive prefixes"
                    .to_string(),
            );
        }

        let destination_dir = custom_destination.unwrap_or_else(|| self.get_models_dir());
        fs::create_dir_all(&destination_dir).map_err(|e| {
            format!("Failed to create destination directory {}: {}", destination_dir.display(), e)
        })?;

        let destination_path = destination_dir.join(&filename);
        let temp_path = destination_dir.join(format!("{}.part", filename));

        // Prevent duplicate download of the same destination
        {
            let tasks = self.tasks.lock().unwrap();
            for task in tasks.values() {
                if task.destination_path == destination_path
                    && (task.status == DownloadStatus::Downloading || task.status == DownloadStatus::Queued)
                {
                    return Err(format!(
                        "Download already in progress for {}",
                        filename
                    ));
                }
            }
        }

        // Check if destination file already exists and is non-empty
        if destination_path.exists() {
            let meta = fs::metadata(&destination_path).map_err(|e| e.to_string())?;
            if meta.len() > 0 {
                // If sha256 matches expected, already downloaded!
                if let Some(ref exp_sha) = expected_sha256 {
                    if let Ok(calc_sha) = compute_file_sha256(&destination_path) {
                        if calc_sha.eq_ignore_ascii_case(exp_sha) {
                            return Err(format!(
                                "Model file already exists and matches expected checksum at {}",
                                destination_path.display()
                            ));
                        }
                    }
                }
            }
        }

        let task_id = format!("dl_{}_{}", model_id, current_time_ms());
        let cancel_flag = Arc::new(AtomicBool::new(false));

        let initial_task = DownloadTask {
            id: task_id.clone(),
            model_id,
            filename: filename.clone(),
            source_url: source_url.clone(),
            repo_id,
            destination_path: destination_path.clone(),
            temp_path: temp_path.clone(),
            total_bytes: 0,
            downloaded_bytes: 0,
            status: DownloadStatus::Queued,
            speed_bytes_per_sec: 0,
            eta_seconds: None,
            error_message: None,
            expected_sha256: expected_sha256.clone(),
            computed_sha256: None,
            started_at_ms: current_time_ms(),
            updated_at_ms: current_time_ms(),
            can_resume: true,
        };

        {
            let mut tasks = self.tasks.lock().unwrap();
            tasks.insert(task_id.clone(), initial_task);
        }

        {
            let mut handles = self.active_handles.lock().unwrap();
            handles.insert(task_id.clone(), ActiveDownloadHandle {
                cancel_flag: Arc::clone(&cancel_flag),
            });
        }

        let tasks_arc = Arc::clone(&self.tasks);
        let handles_arc = Arc::clone(&self.active_handles);
        let task_id_clone = task_id.clone();

        // Spawn asynchronous download worker on background OS thread
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();

            match rt {
                Ok(runtime) => {
                    runtime.block_on(async {
                        execute_download_task(
                            task_id_clone.clone(),
                            source_url,
                            temp_path,
                            destination_path,
                            expected_sha256,
                            cancel_flag,
                            tasks_arc,
                        ).await;
                    });
                }
                Err(e) => {
                    let mut tasks = tasks_arc.lock().unwrap();
                    if let Some(task) = tasks.get_mut(&task_id_clone) {
                        task.status = DownloadStatus::Failed;
                        task.error_message = Some(format!("Failed to initialize tokio runtime: {}", e));
                        task.updated_at_ms = current_time_ms();
                    }
                }
            }

            let mut handles = handles_arc.lock().unwrap();
            handles.remove(&task_id_clone);
        });

        Ok(task_id)
    }
}

async fn execute_download_task(
    task_id: String,
    source_url: String,
    temp_path: PathBuf,
    destination_path: PathBuf,
    expected_sha256: Option<String>,
    cancel_flag: Arc<AtomicBool>,
    tasks: Arc<Mutex<HashMap<String, DownloadTask>>>,
) {
    // Helper to update task
    let update_task = |status: DownloadStatus, err: Option<String>| {
        let mut guard = tasks.lock().unwrap();
        if let Some(t) = guard.get_mut(&task_id) {
            t.status = status;
            t.error_message = err;
            t.updated_at_ms = current_time_ms();
        }
    };

    update_task(DownloadStatus::Downloading, None);

    let client = reqwest::Client::builder()
        .user_agent("Swarm-Desktop/1.0 (Windows NT 10.0; Win64; x64)")
        .timeout(Duration::from_secs(3600))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build();

    let client = match client {
        Ok(c) => c,
        Err(e) => {
            update_task(DownloadStatus::Failed, Some(format!("HTTP client build failed: {}", e)));
            return;
        }
    };

    // Check if partial file exists for resume
    let existing_bytes = if temp_path.exists() {
        fs::metadata(&temp_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let mut request = client.get(&source_url);
    if existing_bytes > 0 {
        request = request.header("Range", format!("bytes={}-", existing_bytes));
    }

    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            update_task(DownloadStatus::Failed, Some(format!("Connection error: {}", e)));
            return;
        }
    };

    let (response, existing_bytes, is_partial) = if response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && existing_bytes > 0 {
        let _ = fs::remove_file(&temp_path);
        match client.get(&source_url).send().await {
            Ok(r) => {
                let st = r.status();
                if !st.is_success() {
                    update_task(
                        DownloadStatus::Failed,
                        Some(format!("HTTP server responded with status: {}", st)),
                    );
                    return;
                }
                (r, 0, false)
            }
            Err(e) => {
                update_task(DownloadStatus::Failed, Some(format!("Connection error: {}", e)));
                return;
            }
        }
    } else {
        let st = response.status();
        if !st.is_success() && st != reqwest::StatusCode::PARTIAL_CONTENT {
            update_task(
                DownloadStatus::Failed,
                Some(format!("HTTP server responded with status: {}", st)),
            );
            return;
        }
        let partial = st == reqwest::StatusCode::PARTIAL_CONTENT;
        (response, existing_bytes, partial)
    };
    let (mut downloaded_bytes, total_bytes, append_mode) = if is_partial {
        let content_range = response
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok());
        let (range_start, total) = content_range
            .map(parse_content_range)
            .unwrap_or((None, 0));

        if range_start != Some(existing_bytes) {
            if range_start == Some(0) {
                // Server ignored the requested offset and sent the file from
                // the beginning, so rewrite the partial file.
                (0, total, false)
            } else {
                let _ = fs::remove_file(&temp_path);
                update_task(
                    DownloadStatus::Failed,
                    Some(format!(
                        "Server returned an unexpected Content-Range start: expected {}, got {:?}. Partial file removed; retry will restart the download.",
                        existing_bytes, range_start
                    )),
                );
                return;
            }
        } else {
            (existing_bytes, total, existing_bytes > 0)
        }
    } else {
        // If server returned 200 instead of 206, server doesn't support Range resume or restarted from beginning
        let len = response.content_length().unwrap_or(0);
        (0, len, false)
    };

    {
        let mut guard = tasks.lock().unwrap();
        if let Some(t) = guard.get_mut(&task_id) {
            t.downloaded_bytes = downloaded_bytes;
            t.total_bytes = total_bytes;
            t.updated_at_ms = current_time_ms();
        }
    }

    // Open file in write or append mode
    let file = if append_mode && existing_bytes > 0 {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&temp_path)
    } else {
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temp_path)
    };

    let mut file = match file {
        Ok(f) => f,
        Err(e) => {
            update_task(
                DownloadStatus::Failed,
                Some(format!("Failed to open temp file {}: {}", temp_path.display(), e)),
            );
            return;
        }
    };

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();

    let mut last_progress_time = Instant::now();
    let mut bytes_since_last_progress: u64 = 0;
    let mut speed_bytes_per_sec: u64 = 0;

    while let Some(chunk_result) = stream.next().await {
        // Check cancellation
        if cancel_flag.load(Ordering::SeqCst) {
            let _ = file.flush();
            update_task(DownloadStatus::Cancelled, Some("Download cancelled by user".to_string()));
            return;
        }

        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                let _ = file.flush();
                update_task(
                    DownloadStatus::Failed,
                    Some(format!("Network stream interrupted: {}", e)),
                );
                return;
            }
        };

        if let Err(e) = file.write_all(&chunk) {
            update_task(
                DownloadStatus::Failed,
                Some(format!("Disk write failure (disk full?): {}", e)),
            );
            return;
        }

        downloaded_bytes += chunk.len() as u64;
        bytes_since_last_progress += chunk.len() as u64;

        let elapsed = last_progress_time.elapsed();
        if elapsed >= Duration::from_millis(500) {
            let secs = elapsed.as_secs_f64();
            if secs > 0.0 {
                speed_bytes_per_sec = (bytes_since_last_progress as f64 / secs) as u64;
            }
            bytes_since_last_progress = 0;
            last_progress_time = Instant::now();

            let eta_seconds = if speed_bytes_per_sec > 0 && total_bytes > downloaded_bytes {
                Some((total_bytes - downloaded_bytes) / speed_bytes_per_sec)
            } else {
                None
            };

            let mut guard = tasks.lock().unwrap();
            if let Some(t) = guard.get_mut(&task_id) {
                t.downloaded_bytes = downloaded_bytes;
                t.speed_bytes_per_sec = speed_bytes_per_sec;
                t.eta_seconds = eta_seconds;
                t.updated_at_ms = current_time_ms();
            }
        }
    }

    if let Err(e) = file.flush() {
        update_task(DownloadStatus::Failed, Some(format!("Flush error: {}", e)));
        return;
    }
    drop(file);

    if total_bytes > 0 && downloaded_bytes != total_bytes {
        update_task(
            DownloadStatus::Failed,
            Some(format!(
                "Incomplete download: expected {} bytes, received {} bytes",
                total_bytes, downloaded_bytes
            )),
        );
        return;
    }

    // Download streaming completed. Transition to Verifying state.
    update_task(DownloadStatus::Verifying, None);

    // Compute checksum
    let computed_sha = match compute_file_sha256(&temp_path) {
        Ok(hash) => hash,
        Err(e) => {
            update_task(
                DownloadStatus::Failed,
                Some(format!("Checksum computation failed: {}", e)),
            );
            return;
        }
    };

    // If expected SHA256 was provided, verify it
    if let Some(ref exp_sha) = expected_sha256 {
        if !computed_sha.eq_ignore_ascii_case(exp_sha) {
            let _ = fs::remove_file(&temp_path);
            update_task(
                DownloadStatus::Failed,
                Some(format!(
                    "Integrity verification mismatch: expected {}, computed {}",
                    exp_sha, computed_sha
                )),
            );
            return;
        }
    }

    // Atomically finalize: rename .part to final destination
    if destination_path.exists() {
        let _ = fs::remove_file(&destination_path);
    }

    if let Err(e) = fs::rename(&temp_path, &destination_path) {
        update_task(
            DownloadStatus::Failed,
            Some(format!(
                "Failed to finalize download (rename {} to {}): {}",
                temp_path.display(),
                destination_path.display(),
                e
            )),
        );
        return;
    }

    // Success! Update task state to Completed
    let mut guard = tasks.lock().unwrap();
    if let Some(t) = guard.get_mut(&task_id) {
        t.status = DownloadStatus::Completed;
        t.downloaded_bytes = downloaded_bytes;
        t.total_bytes = downloaded_bytes;
        t.computed_sha256 = Some(computed_sha);
        t.speed_bytes_per_sec = 0;
        t.eta_seconds = None;
        t.updated_at_ms = current_time_ms();
    }
}

fn parse_content_range(value: &str) -> (Option<u64>, u64) {
    let rest = match value.strip_prefix("bytes ") {
        Some(rest) => rest,
        None => return (None, 0),
    };
    let (range, total) = match rest.split_once('/') {
        Some(parts) => parts,
        None => return (None, 0),
    };
    let start = range
        .split_once('-')
        .and_then(|(start, _)| start.trim().parse::<u64>().ok());
    let total = total.trim().parse::<u64>().unwrap_or(0);
    (start, total)
}

pub fn compute_file_sha256(path: &Path) -> Result<String, std::io::Error> {
    let mut file = file_open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }

    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}

fn file_open(path: &Path) -> Result<std::fs::File, std::io::Error> {
    std::fs::File::open(path)
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
