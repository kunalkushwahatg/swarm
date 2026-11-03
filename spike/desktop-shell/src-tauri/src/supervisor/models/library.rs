use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};

use super::gguf::parse_gguf_metadata;
use super::types::{CatalogModel, GgufMetadata, HuggingFaceFileEntry, HuggingFaceRepoInfo, InstalledModel, ModelLibraryState};

const OFFICIAL_QWEN_FILENAME: &str = "qwen2.5-3b-instruct-q4_k_m.official-check.gguf";
const OFFICIAL_QWEN_SHA256: &str = "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedLibraryConfig {
    pub models_directory: String,
    pub selected_model_id: Option<String>,
    pub selected_model_path: Option<String>,
    pub known_models: Vec<PersistedModelRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedModelRecord {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub path: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
    pub is_official_verified: bool,
    pub source_repo: Option<String>,
    pub installed_at_ms: u64,
    #[serde(default)]
    pub verified_size_bytes: Option<u64>,
    #[serde(default)]
    pub verified_modified_ms: Option<u64>,
    #[serde(default)]
    pub gguf: Option<GgufMetadata>,
}

#[derive(Clone)]
pub struct ModelLibraryManager {
    workspace_root: PathBuf,
    models_dir: Arc<Mutex<PathBuf>>,
    selected_model_id: Arc<Mutex<Option<String>>>,
    selected_model_path: Arc<Mutex<Option<PathBuf>>>,
    installed_models: Arc<Mutex<Vec<InstalledModel>>>,
}

impl ModelLibraryManager {
    pub fn new(workspace_root: PathBuf) -> Self {
        let default_models_dir = resolve_canonical_models_dir(&workspace_root);
        let _ = fs::create_dir_all(&default_models_dir);

        let manager = Self {
            workspace_root: workspace_root.clone(),
            models_dir: Arc::new(Mutex::new(default_models_dir)),
            selected_model_id: Arc::new(Mutex::new(None)),
            selected_model_path: Arc::new(Mutex::new(None)),
            installed_models: Arc::new(Mutex::new(Vec::new())),
        };

        // Load persisted config and scan installed models
        manager.load_and_rescan();
        manager
    }

    pub fn get_models_dir(&self) -> PathBuf {
        self.models_dir.lock().unwrap().clone()
    }

    pub fn set_models_dir(&self, new_dir: PathBuf) -> Result<(), String> {
        fs::create_dir_all(&new_dir).map_err(|e| e.to_string())?;
        *self.models_dir.lock().unwrap() = new_dir;
        // Do not call load_and_rescan here: it reloads the persisted
        // models_directory value and would immediately undo this assignment.
        self.rescan();
        self.persist();
        Ok(())
    }

    pub fn get_selected_model_path(&self) -> Option<PathBuf> {
        let guard = self.selected_model_path.lock().unwrap();
        guard.clone()
    }

    pub fn get_installed_models(&self) -> Vec<InstalledModel> {
        self.installed_models.lock().unwrap().clone()
    }

    pub fn select_model(&self, model_id: &str) -> Result<InstalledModel, String> {
        let models = self.installed_models.lock().unwrap();
        let model = models
            .iter()
            .find(|m| m.id == model_id)
            .cloned()
            .ok_or_else(|| format!("Model with id '{}' not found in library", model_id))?;

        if !model.path.exists() {
            return Err(format!(
                "Model file not found on disk at: {}",
                model.path.display()
            ));
        }

        *self.selected_model_id.lock().unwrap() = Some(model.id.clone());
        *self.selected_model_path.lock().unwrap() = Some(model.path.clone());

        // Update environment variable for inference coordinator
        unsafe {
            std::env::set_var("SWARM_MODEL_PATH", &model.path);
        }

        drop(models);
        self.persist();
        Ok(model)
    }

    pub fn get_state(&self) -> ModelLibraryState {
        self.rescan();
        ModelLibraryState {
            models_directory: self.get_models_dir(),
            selected_model_id: self.selected_model_id.lock().unwrap().clone(),
            selected_model_path: self.selected_model_path.lock().unwrap().clone(),
            installed_models: self.installed_models.lock().unwrap().clone(),
            active_downloads: Vec::new(),
        }
    }

    pub fn delete_model(&self, model_id: &str, active_engine_running: bool) -> Result<(), String> {
        let mut models = self.installed_models.lock().unwrap();
        let index = models
            .iter()
            .position(|m| m.id == model_id)
            .ok_or_else(|| format!("Model with id '{}' not found", model_id))?;

        let model = &models[index];
        let model_path = model.path.clone();

        let is_selected = self
            .selected_model_id
            .lock()
            .unwrap()
            .as_deref()
            == Some(model_id);

        if is_selected && active_engine_running {
            return Err("Cannot delete model while inference engine is active and running this model.".to_string());
        }

        // Delete file from disk if it exists
        if model_path.exists() {
            fs::remove_file(&model_path).map_err(|e| {
                format!("Failed to delete model file {}: {}", model_path.display(), e)
            })?;
        }

        models.remove(index);

        if is_selected {
            *self.selected_model_id.lock().unwrap() = None;
            *self.selected_model_path.lock().unwrap() = None;
        }

        drop(models);
        self.persist();
        Ok(())
    }

    pub fn register_file(&self, path: &Path, source_repo: Option<String>, sha256: Option<String>) -> Result<InstalledModel, String> {
        if !path.exists() || !path.is_file() {
            return Err(format!("File does not exist: {}", path.display()));
        }

        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("model.gguf")
            .to_string();

        let (size_bytes, modified_ms) = file_identity(path);
        let gguf_meta = parse_gguf_metadata(path).ok();

        let is_official = sha256
            .as_deref()
            .map(|hash| hash.eq_ignore_ascii_case(OFFICIAL_QWEN_SHA256))
            .unwrap_or(false);

        let friendly_name = if let Some(ref gg) = gguf_meta {
            if let Some(ref n) = gg.name {
                n.clone()
            } else {
                format!("{} ({})", gg.architecture.to_uppercase(), gg.quantization.as_deref().unwrap_or("GGUF"))
            }
        } else if is_official {
            "Qwen 2.5 3B Instruct".to_string()
        } else {
            filename.clone()
        };

        let id = format!("model_{}", sanitize_id(&filename));

        let entry = InstalledModel {
            id: id.clone(),
            name: friendly_name,
            filename,
            path: path.to_path_buf(),
            size_bytes,
            sha256,
            is_official_verified: is_official,
            source_repo,
            installed_at_ms: current_time_ms(),
            gguf: gguf_meta,
            verified_size_bytes: is_official.then_some(size_bytes),
            verified_modified_ms: is_official.then_some(modified_ms),
        };

        let mut models = self.installed_models.lock().unwrap();
        models.retain(|m| m.path != entry.path);
        models.push(entry.clone());

        // Auto-select if no model is currently selected
        let mut sel = self.selected_model_id.lock().unwrap();
        if sel.is_none() {
            *sel = Some(id);
            *self.selected_model_path.lock().unwrap() = Some(path.to_path_buf());
            unsafe {
                std::env::set_var("SWARM_MODEL_PATH", path);
            }
        }

        drop(models);
        drop(sel);
        self.persist();
        Ok(entry)
    }

    pub fn mark_verification_failed(&self, path: &Path) {
        let changed = {
            let mut models = self.installed_models.lock().unwrap();
            match models.iter_mut().find(|model| model.path.as_path() == path) {
                Some(model) if model.is_official_verified => {
                    model.is_official_verified = false;
                    model.verified_size_bytes = None;
                    model.verified_modified_ms = None;
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.persist();
        }
    }

    pub fn load_and_rescan(&self) {
        let config_path = resolve_library_config_file(&self.workspace_root);
        if config_path.exists() {
            if let Ok(content) = fs::read_to_string(&config_path) {
                if let Ok(cfg) = serde_json::from_str::<PersistedLibraryConfig>(&content) {
                    let dir = PathBuf::from(cfg.models_directory);
                    if dir.exists() {
                        *self.models_dir.lock().unwrap() = dir;
                    }
                    if let Some(sel_id) = cfg.selected_model_id {
                        *self.selected_model_id.lock().unwrap() = Some(sel_id);
                    }
                    if let Some(sel_p) = cfg.selected_model_path {
                        let p = PathBuf::from(sel_p);
                        if p.exists() {
                            *self.selected_model_path.lock().unwrap() = Some(p);
                        }
                    }

                    // Restore persisted records so source metadata and verified
                    // digests survive a restart. Verification is only trusted
                    // when the stored digest and file identity still match.
                    let mut restored: Vec<InstalledModel> = Vec::new();
                    for record in cfg.known_models {
                        if let Some(model) = restore_persisted_model(record) {
                            if !restored.iter().any(|existing| existing.path == model.path) {
                                restored.push(model);
                            }
                        }
                    }
                    *self.installed_models.lock().unwrap() = restored;
                }
            }
        }
        self.rescan();
    }

    pub fn rescan(&self) {
        let models_dir = self.get_models_dir();
        let mut found_paths: Vec<PathBuf> = Vec::new();

        // 1. Scan primary models directory
        if let Ok(entries) = fs::read_dir(&models_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() && p.extension().map(|e| e.to_string_lossy().to_lowercase() == "gguf").unwrap_or(false) {
                    found_paths.push(p);
                }
            }
        }

        // 2. Scan workspace models directory if different
        let ws_models_dir = self.workspace_root.join("models");
        if ws_models_dir.exists() && ws_models_dir != models_dir {
            if let Ok(entries) = fs::read_dir(&ws_models_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_file() && p.extension().map(|e| e.to_string_lossy().to_lowercase() == "gguf").unwrap_or(false) {
                        let fn_name = p.file_name();
                        if !found_paths.iter().any(|existing| existing.file_name() == fn_name) {
                            found_paths.push(p);
                        }
                    }
                }
            }
        }

        // 3. Scan system ProgramData if present
        if let Ok(program_data) = std::env::var("ProgramData") {
            let pd_dir = PathBuf::from(program_data).join(r"Swarm\models");
            if pd_dir.exists() && pd_dir != models_dir {
                if let Ok(entries) = fs::read_dir(&pd_dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_file() && p.extension().map(|e| e.to_string_lossy().to_lowercase() == "gguf").unwrap_or(false) {
                            let fn_name = p.file_name();
                            if !found_paths.iter().any(|existing| existing.file_name() == fn_name) {
                                found_paths.push(p);
                            }
                        }
                    }
                }
            }
        }

        let mut models = self.installed_models.lock().unwrap();
        // Remove missing files and duplicates not in found_paths
        models.retain(|m| m.path.exists() && found_paths.iter().any(|fp| fp == &m.path));

        let catalog = Self::get_curated_catalog();

        // Add or update found files
        for path in found_paths {
            let filename = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("model.gguf")
                .to_string();

            let is_official_name = filename == OFFICIAL_QWEN_FILENAME;
            let (size_bytes, modified_ms) = file_identity(&path);

            let cached_gguf = models.iter().find(|m| m.path == path).and_then(|m| {
                if m.size_bytes == size_bytes && m.gguf.is_some() {
                    m.gguf.clone()
                } else {
                    None
                }
            });

            let gguf_meta = match cached_gguf {
                Some(cached) => Some(cached),
                None => parse_gguf_metadata(&path).ok(),
            };

            let catalog_match = catalog.iter().find(|c| {
                c.filename.eq_ignore_ascii_case(&filename)
                    || (filename.to_lowercase().contains("smollm2-135m") && c.id.contains("135m"))
                    || (filename.to_lowercase().contains("smollm2-360m") && c.id.contains("360m"))
                    || (filename.to_lowercase().contains("qwen2.5-3b") && c.id.contains("qwen2.5-3b"))
            });

            let friendly_name = if let Some(cat) = catalog_match {
                cat.name.clone()
            } else if is_official_name {
                "Qwen 2.5 3B Instruct".to_string()
            } else if let Some(ref gg) = gguf_meta {
                let is_raw_run_name = gg.name.as_ref().map(|n| {
                    let lower = n.to_lowercase();
                    lower.contains("mix") || lower.contains("ep") || lower.contains("lc100k") || lower.contains("checkpoint")
                }).unwrap_or(false);

                if let Some(ref n) = gg.name {
                    if !is_raw_run_name {
                        n.clone()
                    } else {
                        clean_filename_title(&filename, gg.quantization.as_deref())
                    }
                } else {
                    clean_filename_title(&filename, gg.quantization.as_deref())
                }
            } else {
                clean_filename_title(&filename, None)
            };

            let id = format!("model_{}", sanitize_id(&filename));

            if let Some(existing) = models.iter_mut().find(|m| m.path == path) {
                existing.name = friendly_name;
                existing.id = id;
                existing.gguf = gguf_meta;

                let identity_matches = existing.verified_size_bytes == Some(size_bytes)
                    && existing.verified_modified_ms == Some(modified_ms);
                if existing.is_official_verified && !identity_matches {
                    // The file changed since it was verified. Do not keep a
                    // trusted badge for content we have not hashed.
                    existing.is_official_verified = false;
                    existing.sha256 = None;
                    existing.verified_size_bytes = None;
                    existing.verified_modified_ms = None;
                } else if !existing.is_official_verified
                    && existing.size_bytes != size_bytes
                {
                    // A digest recorded for a different file size is stale.
                    existing.sha256 = None;
                }
                existing.size_bytes = size_bytes;
            } else {
                models.push(InstalledModel {
                    id,
                    name: friendly_name,
                    filename,
                    path: path.clone(),
                    size_bytes,
                    sha256: None,
                    is_official_verified: false,
                    source_repo: if is_official_name { Some("Qwen/Qwen2.5-3B-Instruct-GGUF".to_string()) } else { None },
                    installed_at_ms: current_time_ms(),
                    gguf: gguf_meta,
                    verified_size_bytes: None,
                    verified_modified_ms: None,
                });
            }
        }

        // If no model is currently selected, pick official or first available
        let mut sel_id = self.selected_model_id.lock().unwrap();
        let mut sel_path = self.selected_model_path.lock().unwrap();

        let valid_selection = if let Some(ref id) = *sel_id {
            models.iter().any(|m| &m.id == id && m.path.exists())
        } else {
            false
        };

        if !valid_selection {
            if let Some(official) = models.iter().find(|m| m.is_official_verified) {
                *sel_id = Some(official.id.clone());
                *sel_path = Some(official.path.clone());
                unsafe {
                    std::env::set_var("SWARM_MODEL_PATH", &official.path);
                }
            } else if let Some(first) = models.first() {
                *sel_id = Some(first.id.clone());
                *sel_path = Some(first.path.clone());
                unsafe {
                    std::env::set_var("SWARM_MODEL_PATH", &first.path);
                }
            } else {
                *sel_id = None;
                *sel_path = None;
            }
        }
    }

    pub fn persist(&self) {
        let config_path = resolve_library_config_file(&self.workspace_root);
        if let Some(parent) = config_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let models = self.installed_models.lock().unwrap();
        let records: Vec<PersistedModelRecord> = models
            .iter()
            .map(|m| PersistedModelRecord {
                id: m.id.clone(),
                name: m.name.clone(),
                filename: m.filename.clone(),
                path: m.path.to_string_lossy().to_string(),
                size_bytes: m.size_bytes,
                sha256: m.sha256.clone(),
                is_official_verified: m.is_official_verified,
                source_repo: m.source_repo.clone(),
                installed_at_ms: m.installed_at_ms,
                verified_size_bytes: m.verified_size_bytes,
                verified_modified_ms: m.verified_modified_ms,
                gguf: m.gguf.clone(),
            })
            .collect();

        let config = PersistedLibraryConfig {
            models_directory: self.get_models_dir().to_string_lossy().to_string(),
            selected_model_id: self.selected_model_id.lock().unwrap().clone(),
            selected_model_path: self
                .selected_model_path
                .lock()
                .unwrap()
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            known_models: records,
        };

        if let Ok(json) = serde_json::to_string_pretty(&config) {
            let _ = fs::write(&config_path, json);
        }
    }

    pub fn get_curated_catalog() -> Vec<CatalogModel> {
        vec![
            CatalogModel {
                id: "qwen2.5-3b-instruct-q4km".to_string(),
                name: "Qwen 2.5 3B Instruct".to_string(),
                publisher: "Alibaba / Qwen".to_string(),
                repo_id: "Qwen/Qwen2.5-3B-Instruct-GGUF".to_string(),
                filename: OFFICIAL_QWEN_FILENAME.to_string(),
                download_url: format!(
                    "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/{}",
                    "qwen2.5-3b-instruct-q4_k_m.gguf"
                ),
                revision: "main".to_string(),
                file_size_bytes: 2_104_932_768,
                quantization: "Q4_K_M".to_string(),
                architecture: "qwen2".to_string(),
                context_length: 32768,
                license: "Apache-2.0".to_string(),
                description: "Swarm Official Model. Highly capable 3B general and coding instruction model with 32k context."
                    .to_string(),
                expected_sha256: Some(OFFICIAL_QWEN_SHA256.to_string()),
                is_curated: true,
                is_gated: false,
                min_ram_gb: 4.0,
                min_vram_gb: 2.5,
            },
            CatalogModel {
                id: "smollm2-135m-instruct-q4km".to_string(),
                name: "SmolLM2 135M Instruct".to_string(),
                publisher: "Hugging Face / bartowski".to_string(),
                repo_id: "bartowski/SmolLM2-135M-Instruct-GGUF".to_string(),
                filename: "SmolLM2-135M-Instruct-Q4_K_M.gguf".to_string(),
                download_url: "https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q4_K_M.gguf"
                    .to_string(),
                revision: "main".to_string(),
                file_size_bytes: 105_454_432,
                quantization: "Q4_K_M".to_string(),
                architecture: "llama".to_string(),
                context_length: 8192,
                license: "Apache-2.0".to_string(),
                description: "Ultra-compact 135M parameter instruction model. Ideal for low-resource devices and rapid integration testing."
                    .to_string(),
                expected_sha256: None,
                is_curated: true,
                is_gated: false,
                min_ram_gb: 1.0,
                min_vram_gb: 0.5,
            },
            CatalogModel {
                id: "smollm2-360m-instruct-q4km".to_string(),
                name: "SmolLM2 360M Instruct".to_string(),
                publisher: "Hugging Face / bartowski".to_string(),
                repo_id: "bartowski/SmolLM2-360M-Instruct-GGUF".to_string(),
                filename: "SmolLM2-360M-Instruct-Q4_K_M.gguf".to_string(),
                download_url: "https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf"
                    .to_string(),
                revision: "main".to_string(),
                file_size_bytes: 270_590_880,
                quantization: "Q4_K_M".to_string(),
                architecture: "llama".to_string(),
                context_length: 8192,
                license: "Apache-2.0".to_string(),
                description: "Lightweight 360M model balanced for speed, edge devices, and basic reasoning."
                    .to_string(),
                expected_sha256: None,
                is_curated: true,
                is_gated: false,
                min_ram_gb: 1.5,
                min_vram_gb: 0.8,
            },
            CatalogModel {
                id: "qwen2.5-0.5b-instruct-q4km".to_string(),
                name: "Qwen 2.5 0.5B Instruct".to_string(),
                publisher: "Alibaba / Qwen".to_string(),
                repo_id: "Qwen/Qwen2.5-0.5B-Instruct-GGUF".to_string(),
                filename: "qwen2.5-0.5b-instruct-q4_k_m.gguf".to_string(),
                download_url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
                    .to_string(),
                revision: "main".to_string(),
                file_size_bytes: 397_738_112,
                quantization: "Q4_K_M".to_string(),
                architecture: "qwen2".to_string(),
                context_length: 32768,
                license: "Apache-2.0".to_string(),
                description: "Compact 500M model from Qwen 2.5 series with 32k context and strong instruction-following."
                    .to_string(),
                expected_sha256: None,
                is_curated: true,
                is_gated: false,
                min_ram_gb: 2.0,
                min_vram_gb: 1.0,
            },
            CatalogModel {
                id: "qwen2.5-1.5b-instruct-q4km".to_string(),
                name: "Qwen 2.5 1.5B Instruct".to_string(),
                publisher: "Alibaba / Qwen".to_string(),
                repo_id: "Qwen/Qwen2.5-1.5B-Instruct-GGUF".to_string(),
                filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf".to_string(),
                download_url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"
                    .to_string(),
                revision: "main".to_string(),
                file_size_bytes: 986_214_560,
                quantization: "Q4_K_M".to_string(),
                architecture: "qwen2".to_string(),
                context_length: 32768,
                license: "Apache-2.0".to_string(),
                description: "Mid-sized 1.5B model offering exceptional balance of speed, accuracy, and memory."
                    .to_string(),
                expected_sha256: None,
                is_curated: true,
                is_gated: false,
                min_ram_gb: 3.0,
                min_vram_gb: 1.8,
            },
            CatalogModel {
                id: "llama3.2-1b-instruct-q4km".to_string(),
                name: "Llama 3.2 1B Instruct".to_string(),
                publisher: "Meta / bartowski".to_string(),
                repo_id: "bartowski/Llama-3.2-1B-Instruct-GGUF".to_string(),
                filename: "Llama-3.2-1B-Instruct-Q4_K_M.gguf".to_string(),
                download_url: "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf"
                    .to_string(),
                revision: "main".to_string(),
                file_size_bytes: 808_480_896,
                quantization: "Q4_K_M".to_string(),
                architecture: "llama".to_string(),
                context_length: 131072,
                license: "Llama 3.2 Community License".to_string(),
                description: "Meta's lightweight 1B model with 128k context length for on-device applications."
                    .to_string(),
                expected_sha256: None,
                is_curated: true,
                is_gated: false,
                min_ram_gb: 2.5,
                min_vram_gb: 1.5,
            },
            CatalogModel {
                id: "llama3.2-3b-instruct-q4km".to_string(),
                name: "Llama 3.2 3B Instruct".to_string(),
                publisher: "Meta / bartowski".to_string(),
                repo_id: "bartowski/Llama-3.2-3B-Instruct-GGUF".to_string(),
                filename: "Llama-3.2-3B-Instruct-Q4_K_M.gguf".to_string(),
                download_url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf"
                    .to_string(),
                revision: "main".to_string(),
                file_size_bytes: 2_018_977_920,
                quantization: "Q4_K_M".to_string(),
                architecture: "llama".to_string(),
                context_length: 131072,
                license: "Llama 3.2 Community License".to_string(),
                description: "Meta's high-efficiency 3B model with 128k context length, great for summarization and agentic tasks."
                    .to_string(),
                expected_sha256: None,
                is_curated: true,
                is_gated: false,
                min_ram_gb: 4.0,
                min_vram_gb: 2.5,
            },
            CatalogModel {
                id: "phi3.5-mini-instruct-q4km".to_string(),
                name: "Phi-3.5 Mini Instruct".to_string(),
                publisher: "Microsoft / bartowski".to_string(),
                repo_id: "bartowski/Phi-3.5-mini-instruct-GGUF".to_string(),
                filename: "Phi-3.5-mini-instruct-Q4_K_M.gguf".to_string(),
                download_url: "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf"
                    .to_string(),
                revision: "main".to_string(),
                file_size_bytes: 2_394_054_848,
                quantization: "Q4_K_M".to_string(),
                architecture: "phi3".to_string(),
                context_length: 131072,
                license: "MIT".to_string(),
                description: "Microsoft's 3.8B model with state-of-the-art multilingual and reasoning capabilities."
                    .to_string(),
                expected_sha256: None,
                is_curated: true,
                is_gated: false,
                min_ram_gb: 4.5,
                min_vram_gb: 3.0,
            },
        ]
    }
}

pub async fn query_huggingface_repo(repo_id: &str) -> HuggingFaceRepoInfo {
    let clean_repo = repo_id.trim();
    if clean_repo.is_empty() {
        return HuggingFaceRepoInfo {
            repo_id: repo_id.to_string(),
            files: Vec::new(),
            is_gated: false,
            license: None,
            error: Some("Repository ID cannot be empty".to_string()),
        };
    }

    let url = format!("https://huggingface.co/api/models/{}?blobs=true", clean_repo);
    let client = reqwest::Client::builder()
        .user_agent("Swarm-Desktop/1.0 (Windows NT 10.0; Win64; x64)")
        .timeout(std::time::Duration::from_secs(15))
        .build();

    let client = match client {
        Ok(c) => c,
        Err(e) => {
            return HuggingFaceRepoInfo {
                repo_id: clean_repo.to_string(),
                files: Vec::new(),
                is_gated: false,
                license: None,
                error: Some(format!("Failed to build HTTP client: {}", e)),
            };
        }
    };

    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            return HuggingFaceRepoInfo {
                repo_id: clean_repo.to_string(),
                files: Vec::new(),
                is_gated: false,
                license: None,
                error: Some(format!("Failed to connect to Hugging Face API: {}", e)),
            };
        }
    };

    let status = resp.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::UNAUTHORIZED {
        return HuggingFaceRepoInfo {
            repo_id: clean_repo.to_string(),
            files: Vec::new(),
            is_gated: true,
            license: None,
            error: Some("This repository is gated or private. Access requires user agreement and authentic access on huggingface.co.".to_string()),
        };
    }

    if status == reqwest::StatusCode::NOT_FOUND {
        return HuggingFaceRepoInfo {
            repo_id: clean_repo.to_string(),
            files: Vec::new(),
            is_gated: false,
            license: None,
            error: Some("Repository not found on Hugging Face".to_string()),
        };
    }

    if !status.is_success() {
        return HuggingFaceRepoInfo {
            repo_id: clean_repo.to_string(),
            files: Vec::new(),
            is_gated: false,
            license: None,
            error: Some(format!("Hugging Face API returned error status: {}", status)),
        };
    }

    let body_json: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            return HuggingFaceRepoInfo {
                repo_id: clean_repo.to_string(),
                files: Vec::new(),
                is_gated: false,
                license: None,
                error: Some(format!("Failed to parse response JSON: {}", e)),
            };
        }
    };

    let is_gated = body_json.get("gated").map(|g| g.as_bool().unwrap_or(false) || g.is_string()).unwrap_or(false);
    let license = body_json
        .get("cardData")
        .and_then(|c| c.get("license"))
        .and_then(|l| l.as_str())
        .map(|s| s.to_string());

    let mut gguf_files = Vec::new();

    if let Some(siblings) = body_json.get("siblings").and_then(|s| s.as_array()) {
        for sib in siblings {
            if let Some(rfilename) = sib.get("rfilename").and_then(|f| f.as_str()) {
                if rfilename.to_lowercase().ends_with(".gguf") {
                    let download_url = format!(
                        "https://huggingface.co/{}/resolve/main/{}",
                        clean_repo, rfilename
                    );
                    let size = sib.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
                    let sha = sib
                        .get("lfs")
                        .and_then(|l| l.get("sha256").or_else(|| l.get("oid")))
                        .and_then(|s| s.as_str())
                        .map(|s| s.strip_prefix("sha256:").unwrap_or(s).to_string());

                    // Infer quantization from filename
                    let quant = infer_quantization_from_filename(rfilename);

                    gguf_files.push(HuggingFaceFileEntry {
                        filename: rfilename.to_string(),
                        size_bytes: size,
                        download_url,
                        sha256: sha,
                        quantization: Some(quant),
                    });
                }
            }
        }
    }

    HuggingFaceRepoInfo {
        repo_id: clean_repo.to_string(),
        files: gguf_files,
        is_gated,
        license,
        error: None,
    }
}

fn infer_quantization_from_filename(filename: &str) -> String {
    let upper = filename.to_uppercase();
    let quants = [
        "Q4_K_M", "Q4_K_S", "Q5_K_M", "Q5_K_S", "Q8_0", "Q6_K", "Q3_K_M", "Q3_K_L",
        "Q3_K_S", "Q2_K", "Q4_0", "Q4_1", "Q5_0", "Q5_1", "BF16", "F16", "F32",
        "IQ4_NL", "IQ3_M", "IQ3_S", "IQ2_M", "IQ2_S", "IQ1_M", "IQ1_S",
    ];

    for q in quants {
        if upper.contains(q) {
            return q.to_string();
        }
    }
    "GGUF".to_string()
}

pub fn resolve_canonical_models_dir(workspace_root: &Path) -> PathBuf {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(local_app_data).join(r"Swarm\models");
        return p;
    }
    if let Ok(program_data) = std::env::var("ProgramData") {
        let p = PathBuf::from(program_data).join(r"Swarm\models");
        return p;
    }
    workspace_root.join("models")
}

pub fn resolve_library_config_file(workspace_root: &Path) -> PathBuf {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(local_app_data).join(r"Swarm\config\model_library.json");
        return p;
    }
    if let Ok(program_data) = std::env::var("ProgramData") {
        let p = PathBuf::from(program_data).join(r"Swarm\config\model_library.json");
        return p;
    }
    workspace_root.join(r"dist\model_library.json")
}

fn file_identity(path: &Path) -> (u64, u64) {
    let metadata = fs::metadata(path).ok();
    let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified_ms = metadata
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    (size, modified_ms)
}

fn restore_persisted_model(record: PersistedModelRecord) -> Option<InstalledModel> {
    let path = PathBuf::from(&record.path);
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() {
        return None;
    }

    let (size_bytes, modified_ms) = file_identity(&path);
    let size_matches = record.size_bytes == size_bytes;
    let identity_matches = record.verified_size_bytes == Some(size_bytes)
        && record.verified_modified_ms == Some(modified_ms);
    let digest_is_official = record
        .sha256
        .as_deref()
        .map(|hash| hash.eq_ignore_ascii_case(OFFICIAL_QWEN_SHA256))
        .unwrap_or(false);
    let verified = record.is_official_verified && digest_is_official && identity_matches;

    Some(InstalledModel {
        id: record.id,
        name: record.name,
        filename: record.filename,
        path: path.clone(),
        size_bytes,
        sha256: if size_matches { record.sha256 } else { None },
        is_official_verified: verified,
        source_repo: record.source_repo,
        installed_at_ms: record.installed_at_ms,
        gguf: if size_matches && record.gguf.is_some() {
            record.gguf
        } else {
            parse_gguf_metadata(&path).ok()
        },
        verified_size_bytes: if verified { Some(size_bytes) } else { None },
        verified_modified_ms: if verified { Some(modified_ms) } else { None },
    })
}

fn sanitize_id(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect()
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn clean_filename_title(filename: &str, quantization: Option<&str>) -> String {
    let lower = filename.to_lowercase();
    if lower.contains("smollm2-135m") || lower.contains("smollm2_135m") {
        return "SmolLM2 135M Instruct".to_string();
    }
    if lower.contains("smollm2-360m") || lower.contains("smollm2_360m") {
        return "SmolLM2 360M Instruct".to_string();
    }
    if lower.contains("smollm2-1.7b") || lower.contains("smollm2_1.7b") {
        return "SmolLM2 1.7B Instruct".to_string();
    }
    if lower.contains("qwen2.5-3b") || lower.contains("qwen2.5_3b") {
        return "Qwen 2.5 3B Instruct".to_string();
    }
    if lower.contains("qwen2.5-0.5b") || lower.contains("qwen2.5_0.5b") {
        return "Qwen 2.5 0.5B Instruct".to_string();
    }
    if lower.contains("qwen2.5-1.5b") || lower.contains("qwen2.5_1.5b") {
        return "Qwen 2.5 1.5B Instruct".to_string();
    }
    if lower.contains("llama-3.2-1b") || lower.contains("llama-3.2_1b") {
        return "Llama 3.2 1B Instruct".to_string();
    }
    if lower.contains("llama-3.2-3b") || lower.contains("llama-3.2_3b") {
        return "Llama 3.2 3B Instruct".to_string();
    }
    if lower.contains("phi-3.5-mini") || lower.contains("phi_3.5_mini") {
        return "Phi-3.5 Mini Instruct".to_string();
    }

    let mut base = filename.strip_suffix(".gguf").or_else(|| filename.strip_suffix(".GGUF")).unwrap_or(filename);
    base = base.strip_suffix(".official-check").unwrap_or(base);
    let cleaned = base.replace(['-', '_'], " ");
    if let Some(q) = quantization {
        format!("{} ({})", cleaned, q)
    } else {
        cleaned
    }
}
