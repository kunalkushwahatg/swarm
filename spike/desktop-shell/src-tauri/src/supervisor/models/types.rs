use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Paused,
    Verifying,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    pub id: String,
    pub model_id: String,
    pub filename: String,
    pub source_url: String,
    pub repo_id: Option<String>,
    pub destination_path: PathBuf,
    pub temp_path: PathBuf,
    pub total_bytes: u64,
    pub downloaded_bytes: u64,
    pub status: DownloadStatus,
    pub speed_bytes_per_sec: u64,
    pub eta_seconds: Option<u64>,
    pub error_message: Option<String>,
    pub expected_sha256: Option<String>,
    pub computed_sha256: Option<String>,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub can_resume: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GgufMetadata {
    pub architecture: String,
    pub name: Option<String>,
    pub file_type_description: Option<String>,
    pub quantization: Option<String>,
    pub context_length: Option<u64>,
    pub block_count: Option<u64>,
    pub embedding_length: Option<u64>,
    pub tensor_count: u64,
    pub kv_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledModel {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub sha256: Option<String>,
    pub is_official_verified: bool,
    pub source_repo: Option<String>,
    pub installed_at_ms: u64,
    pub gguf: Option<GgufMetadata>,
    /// File identity captured when the digest was verified. Used to avoid
    /// trusting a persisted verification flag after the file is replaced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub repo_id: String,
    pub filename: String,
    pub download_url: String,
    pub revision: String,
    pub file_size_bytes: u64,
    pub quantization: String,
    pub architecture: String,
    pub context_length: u64,
    pub license: String,
    pub description: String,
    pub expected_sha256: Option<String>,
    pub is_curated: bool,
    pub is_gated: bool,
    pub min_ram_gb: f32,
    pub min_vram_gb: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelLibraryState {
    pub models_directory: PathBuf,
    pub selected_model_id: Option<String>,
    pub selected_model_path: Option<PathBuf>,
    pub installed_models: Vec<InstalledModel>,
    pub active_downloads: Vec<DownloadTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HuggingFaceFileEntry {
    pub filename: String,
    pub size_bytes: u64,
    pub download_url: String,
    pub sha256: Option<String>,
    pub quantization: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HuggingFaceRepoInfo {
    pub repo_id: String,
    pub files: Vec<HuggingFaceFileEntry>,
    pub is_gated: bool,
    pub license: Option<String>,
    pub error: Option<String>,
}
