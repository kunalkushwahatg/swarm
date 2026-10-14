use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Cost constants for Qwen 2.5 3B (37 total layers: layers 0..35 + output layer 36)
pub const TOTAL_MODEL_LAYERS: i32 = 37;
pub const BASE_WEIGHTS_PER_LAYER_BYTES: u64 = 73 * 1024 * 1024; // ~73 MiB (Q4_K_M baseline)
pub const BASE_WEIGHTS_Q5KM_BYTES: u64 = 85 * 1024 * 1024;     // ~85 MiB (Q5_K_M)
pub const BASE_WEIGHTS_Q8_0_BYTES: u64 = 115 * 1024 * 1024;    // ~115 MiB (Q8_0)
pub const BASE_WEIGHTS_F16_BYTES: u64 = 175 * 1024 * 1024;     // ~175 MiB (FP16)
pub const BASE_KV_CACHE_2048_BYTES: u64 = 16 * 1024 * 1024;     // ~16 MiB at n_ctx=2048
pub const COMPUTE_BUFFER_PER_LAYER_BYTES: u64 = 2_360_000;       // ~2.25 MiB
pub const DEFAULT_HEADROOM_RAM_MB: u64 = 1024;                  // 1 GiB OS headroom
pub const DEFAULT_HEADROOM_VRAM_MB: u64 = 256;                  // 256 MiB GPU headroom
pub const TELEMETRY_FRESHNESS_TTL_MS: u64 = 30_000;             // 30 seconds

/// Calculates conservative bytes per layer based on context size (Q4_K_M baseline)
pub fn estimate_bytes_per_layer(n_ctx: i32) -> u64 {
    estimate_bytes_per_layer_with_params(n_ctx, "Q4_K_M", 1)
}

/// Parameterized memory cost estimator accounting for quantization, context length, and batch scaling
pub fn estimate_bytes_per_layer_with_params(n_ctx: i32, quantization: &str, batch_size: i32) -> u64 {
    let weights = match quantization.to_uppercase().as_str() {
        "Q5_K_M" => BASE_WEIGHTS_Q5KM_BYTES,
        "Q8_0" => BASE_WEIGHTS_Q8_0_BYTES,
        "F16" | "FP16" => BASE_WEIGHTS_F16_BYTES,
        _ => BASE_WEIGHTS_PER_LAYER_BYTES,
    };
    let ctx_scale = if n_ctx > 0 { n_ctx as f64 / 2048.0 } else { 1.0 };
    let kv_scaled = (BASE_KV_CACHE_2048_BYTES as f64 * ctx_scale) as u64;
    let batch_scale = if batch_size > 1 { (batch_size as f64 / 512.0).max(1.0) } else { 1.0 };
    let compute_scaled = (COMPUTE_BUFFER_PER_LAYER_BYTES as f64 * batch_scale) as u64;
    let total = weights + kv_scaled + compute_scaled;
    // Conservative 2% margin to prevent rounding-induced OOM
    total + (total / 50)
}

/// User-configured settings for a single participating device
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeviceAllocationSetting {
    pub device_id: String,
    pub device_name: String,
    pub backend_type: String, // "cuda" | "rpc" | "cpu"
    pub enabled: bool,
    pub memory_budget_mb: u64, // Target budget in MB
    pub is_loopback: bool,
}

/// Compute Allocation Configuration persisted to disk
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComputeAllocationConfig {
    pub mode: String, // "automatic" | "manual" | "none"
    pub total_offload_layers: i32, // -1 for all 37, or specific count (e.g. 4, 37)
    pub reserved_headroom_ram_mb: u64,
    pub reserved_headroom_vram_mb: u64,
    pub context_size: i32, // default 2048
    pub device_settings: Vec<DeviceAllocationSetting>,
    pub updated_at_ms: u64,
}

impl Default for ComputeAllocationConfig {
    fn default() -> Self {
        Self {
            mode: "automatic".to_string(),
            total_offload_layers: -1, // all layers
            reserved_headroom_ram_mb: DEFAULT_HEADROOM_RAM_MB,
            reserved_headroom_vram_mb: DEFAULT_HEADROOM_VRAM_MB,
            context_size: 2048,
            device_settings: Vec::new(),
            updated_at_ms: 0,
        }
    }
}

/// Candidate device telemetry used by the planner
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateDeviceTelemetry {
    pub device_id: String,
    pub device_name: String,
    pub backend_type: String, // "cuda" | "rpc" | "cpu"
    pub is_loopback: bool,
    pub memory_total_mb: Option<u64>,
    pub memory_free_mb: Option<u64>,
    pub is_online: bool,
    pub is_stale: bool,
    pub telemetry_age_ms: u64,
    pub provenance: String, // "MEASURED" | "CONFIGURED_BUDGET" | "SIMULATED" | "UNAVAILABLE"
}

/// Planned placement summary for an individual device
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevicePlanSummary {
    pub device_id: String,
    pub device_name: String,
    pub backend_type: String,
    pub is_loopback: bool,
    pub enabled: bool,
    pub measured_total_mb: Option<u64>,
    pub measured_free_mb: Option<u64>,
    pub reserved_headroom_mb: u64,
    pub usable_budget_mb: u64,
    pub planned_budget_mb: u64,
    pub estimated_layer_capacity: i32,
    pub planned_layer_count: i32,
    pub planned_layer_ranges: Vec<(i32, i32)>,
    pub split_weight: f32,
    pub provenance: String,
    pub control_enforcement: String, // "HARD_ENFORCED" | "TARGET_SPLIT" | "ADVISORY_ESTIMATE"
    pub warning: Option<String>,
}

/// Complete plan preview returned before applying
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllocationPlanPreview {
    pub mode: String,
    pub is_valid: bool,
    pub validation_errors: Vec<String>,
    pub validation_warnings: Vec<String>,
    pub risk_level: String, // "SAFE" | "WARNING" | "HIGH_RISK" | "INVALID"
    pub risk_explanation: String,
    pub model_total_layers: i32,
    pub total_offload_layers: i32,
    pub estimated_bytes_per_layer: u64,
    pub assumptions_explanation: String,
    pub device_plans: Vec<DevicePlanSummary>,
    pub worker_profiles_env: String,
    pub placement_policy_env: String,
    pub rpc_endpoints_env: String,
}

pub struct AllocationPlanner;

impl AllocationPlanner {
    /// Evaluates a candidate allocation plan against current device telemetry
    pub fn evaluate_plan(
        config: &ComputeAllocationConfig,
        candidates: &[CandidateDeviceTelemetry],
    ) -> AllocationPlanPreview {
        let is_auto = config.mode == "automatic";
        let bytes_per_layer = estimate_bytes_per_layer(config.context_size);
        let mb_per_layer = ((bytes_per_layer + 1024 * 1024 - 1) / (1024 * 1024)).max(1);

        let target_layers = if config.total_offload_layers < 0 || config.total_offload_layers > TOTAL_MODEL_LAYERS {
            TOTAL_MODEL_LAYERS
        } else {
            config.total_offload_layers
        };

        let mut validation_errors = Vec::new();
        let mut validation_warnings = Vec::new();
        let mut device_plans = Vec::new();

        // Count loopback workers sharing host RAM
        let mut loopback_count = 0;
        for c in candidates {
            let setting = config.device_settings.iter().find(|s| s.device_id == c.device_id);
            let is_enabled = setting.map(|s| s.enabled).unwrap_or(true);
            if is_enabled && c.is_loopback && c.backend_type == "rpc" {
                loopback_count += 1;
            }
        }
        let loopback_divisor = if loopback_count > 1 { loopback_count as u64 } else { 1 };

        let mut total_capacity = 0;

        for c in candidates {
            let setting = config.device_settings.iter().find(|s| s.device_id == c.device_id);
            let is_enabled = setting.map(|s| s.enabled).unwrap_or(true);
            let is_cuda = c.backend_type == "cuda" || c.device_id.contains("cuda");

            let headroom = if is_cuda {
                config.reserved_headroom_vram_mb
            } else {
                config.reserved_headroom_ram_mb
            };

            let mut device_warning = None;

            // Check telemetry validity & staleness
            if c.is_stale || c.telemetry_age_ms > TELEMETRY_FRESHNESS_TTL_MS {
                let w = format!("Telemetry for '{}' is stale (>30s old). Metrics may not reflect live state.", c.device_id);
                validation_warnings.push(w.clone());
                device_warning = Some(w);
            }

            if is_enabled && !c.is_online {
                validation_errors.push(format!("Device '{}' is offline or unreachable but marked as enabled for inference.", c.device_id));
            }

            // Calculate usable budget
            let measured_free = c.memory_free_mb.unwrap_or(0);
            let measured_total = c.memory_total_mb.unwrap_or(0);

            // Deduplicate host RAM across loopback workers to prevent over-allocation
            let partitioned_free = if c.is_loopback && c.backend_type == "rpc" {
                measured_free / loopback_divisor
            } else {
                measured_free
            };

            let usable_mb = if partitioned_free > headroom {
                partitioned_free - headroom
            } else {
                0
            };

            let planned_budget_mb = if is_auto {
                usable_mb
            } else {
                let user_budget = setting.map(|s| s.memory_budget_mb).unwrap_or(usable_mb);
                if is_enabled && measured_total > 0 && user_budget > measured_total {
                    validation_errors.push(format!(
                        "Configured memory budget of {} MB for '{}' exceeds physical capacity ({} MB).",
                        user_budget, c.device_id, measured_total
                    ));
                } else if is_enabled && partitioned_free > 0 && user_budget > partitioned_free {
                    let w = format!(
                        "Configured memory budget of {} MB for '{}' exceeds currently free memory ({} MB). Allocation may swap or fail.",
                        user_budget, c.device_id, partitioned_free
                    );
                    validation_warnings.push(w.clone());
                    device_warning = Some(w);
                }
                user_budget
            };

            let estimated_capacity = if is_enabled {
                (planned_budget_mb / mb_per_layer) as i32
            } else {
                0
            };

            if is_enabled {
                total_capacity += estimated_capacity;
            }

            let control_enforcement = if c.backend_type == "rpc" && !is_enabled {
                "HARD_ENFORCED (Excluded from RPC endpoints)".to_string()
            } else if is_auto {
                "TARGET_SPLIT (Dynamic telemetry-derived split)".to_string()
            } else {
                "TARGET_SPLIT (Manual budget-derived split)".to_string()
            };

            device_plans.push(DevicePlanSummary {
                device_id: c.device_id.clone(),
                device_name: c.device_name.clone(),
                backend_type: c.backend_type.clone(),
                is_loopback: c.is_loopback,
                enabled: is_enabled,
                measured_total_mb: c.memory_total_mb,
                measured_free_mb: c.memory_free_mb,
                reserved_headroom_mb: headroom,
                usable_budget_mb: usable_mb,
                planned_budget_mb,
                estimated_layer_capacity: estimated_capacity,
                planned_layer_count: 0, // Populated below in distribution step
                planned_layer_ranges: Vec::new(),
                split_weight: 0.0,
                provenance: c.provenance.clone(),
                control_enforcement,
                warning: device_warning,
            });
        }

        // Layer distribution step across enabled devices
        let mut enabled_plans: Vec<usize> = device_plans
            .iter()
            .enumerate()
            .filter(|(_, p)| p.enabled && p.estimated_layer_capacity > 0)
            .map(|(i, _)| i)
            .collect();

        // Fastest local devices (CUDA) host initial layers (0..N) for lowest latency,
        // followed by distributed RPC workers and fallback devices.
        enabled_plans.sort_by_key(|&idx| {
            if device_plans[idx].backend_type == "cuda" {
                0
            } else if device_plans[idx].backend_type == "rpc" {
                1
            } else {
                2
            }
        });

        if enabled_plans.is_empty() {
            validation_errors.push("No enabled devices have sufficient memory capacity to host model layers.".to_string());
        } else if total_capacity < target_layers {
            validation_warnings.push(format!(
                "Total cluster layer capacity ({} layers) is less than requested offload ({} layers). Some layers will remain on host CPU.",
                total_capacity, target_layers
            ));
        }

        // Compute proportional layer distribution and sequential layer ranges
        let mut remaining_layers_to_assign = target_layers;
        let mut current_layer_idx = 0;

        for &idx in &enabled_plans {
            let cap = device_plans[idx].estimated_layer_capacity;
            let assigned = if total_capacity > 0 {
                let share = (cap as f64 / total_capacity as f64) * target_layers as f64;
                (share.round() as i32).min(cap).min(remaining_layers_to_assign)
            } else {
                0
            };

            device_plans[idx].planned_layer_count = assigned;
            if total_capacity > 0 {
                device_plans[idx].split_weight = cap as f32 / total_capacity as f32;
            }

            if assigned > 0 {
                let start = current_layer_idx;
                let end = current_layer_idx + assigned - 1;
                device_plans[idx].planned_layer_ranges.push((start, end));
                current_layer_idx += assigned;
                remaining_layers_to_assign -= assigned;
            }
        }

        // Assign any remainder to the highest-capacity device
        if remaining_layers_to_assign > 0 && !enabled_plans.is_empty() {
            let best_idx = enabled_plans[0];
            let additional = remaining_layers_to_assign.min(device_plans[best_idx].estimated_layer_capacity - device_plans[best_idx].planned_layer_count);
            if additional > 0 {
                device_plans[best_idx].planned_layer_count += additional;
                let start = current_layer_idx;
                let end = current_layer_idx + additional - 1;
                if device_plans[best_idx].planned_layer_ranges.is_empty() {
                    device_plans[best_idx].planned_layer_ranges.push((start, end));
                } else {
                    let range_len = device_plans[best_idx].planned_layer_ranges.len();
                    device_plans[best_idx].planned_layer_ranges[range_len - 1].1 += additional;
                }
            }
        }

        // Generate environment variable strings
        let placement_policy_env = if is_auto {
            "dynamic".to_string()
        } else {
            "resource_aware".to_string()
        };

        let mut profile_entries = Vec::new();
        let mut enabled_endpoints = Vec::new();

        for p in &device_plans {
            if p.enabled {
                if p.backend_type == "rpc" {
                    enabled_endpoints.push(p.device_id.clone());
                }
                profile_entries.push(format!("{}={}MB", p.device_id, p.planned_budget_mb));
            }
        }

        let worker_profiles_env = profile_entries.join(",");
        let rpc_endpoints_env = enabled_endpoints.join(",");

        // Determine risk level
        let is_valid = validation_errors.is_empty();
        let (risk_level, risk_explanation) = if !is_valid {
            ("INVALID".to_string(), format!("Configuration is invalid: {}", validation_errors.join("; ")))
        } else if !validation_warnings.is_empty() {
            ("WARNING".to_string(), format!("Plan is functional with caveats: {}", validation_warnings.join("; ")))
        } else if config.reserved_headroom_ram_mb < 512 || config.reserved_headroom_vram_mb < 128 {
            ("HIGH_RISK".to_string(), "Reserved memory headroom is set below recommended thresholds (<512 MB RAM or <128 MB VRAM). Risk of engine crash if OS demands memory.".to_string())
        } else {
            ("SAFE".to_string(), "Plan provides conservative headroom (>1,024 MB RAM) and valid device capacities across all participating computers.".to_string())
        };

        let assumptions_explanation = format!(
            "ASSUMPTIONS: Model Qwen 2.5 3B ({} layers total: 36 transformer blocks + 1 output layer). Cost per layer at n_ctx={}: ~{} MiB ({} MiB weights [Q4_K_M] + ~{} MiB KV cache + ~{} MiB compute buffer). Headroom reserved: {} MB RAM, {} MB VRAM. \
            INACCURACY CONDITIONS: 1) Non-Q4 quantizations (Q8_0 adds ~42 MiB/layer; FP16 adds ~102 MiB/layer); 2) Extended context lengths (KV cache expands to 64 MiB/layer at 8k ctx, 256 MiB/layer at 32k ctx); 3) Multi-sequence concurrent batches; 4) CUDA runtime driver overhead (~250-500 MB VRAM) and DWM display composition; 5) RPC network socket non-paged pool memory. \
            CONTROL ENFORCEMENT: Device memory budgets (SWARM_WORKER_PROFILES) are advisory targets used to calculate proportional tensor splits (model_params.tensor_split), NOT hard OS memory caps. The only genuinely hard-enforced control is endpoint exclusion from SWARM_RPC_ENDPOINTS.",
            TOTAL_MODEL_LAYERS,
            config.context_size,
            mb_per_layer,
            BASE_WEIGHTS_PER_LAYER_BYTES / (1024 * 1024),
            (BASE_KV_CACHE_2048_BYTES * (config.context_size as u64 / 2048)) / (1024 * 1024),
            COMPUTE_BUFFER_PER_LAYER_BYTES / (1024 * 1024),
            config.reserved_headroom_ram_mb,
            config.reserved_headroom_vram_mb,
        );

        AllocationPlanPreview {
            mode: config.mode.clone(),
            is_valid,
            validation_errors,
            validation_warnings,
            risk_level,
            risk_explanation,
            model_total_layers: TOTAL_MODEL_LAYERS,
            total_offload_layers: target_layers,
            estimated_bytes_per_layer: bytes_per_layer,
            assumptions_explanation,
            device_plans,
            worker_profiles_env,
            placement_policy_env,
            rpc_endpoints_env,
        }
    }
}

/// Resolves storage path for allocation configuration
pub fn resolve_allocation_config_file(workspace_root: &Path) -> PathBuf {
    if let Ok(program_data) = std::env::var("ProgramData") {
        let dir = PathBuf::from(program_data).join(r"Swarm\config");
        let _ = std::fs::create_dir_all(&dir);
        return dir.join("allocation_config.json");
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let dir = PathBuf::from(local_app_data).join(r"Swarm\config");
        let _ = std::fs::create_dir_all(&dir);
        return dir.join("allocation_config.json");
    }
    workspace_root.join(r"dist\allocation_config.json")
}

/// Resolves storage path for allocation configuration backup (for safe rollback)
pub fn resolve_allocation_backup_file(workspace_root: &Path) -> PathBuf {
    if let Ok(program_data) = std::env::var("ProgramData") {
        let dir = PathBuf::from(program_data).join(r"Swarm\config");
        let _ = std::fs::create_dir_all(&dir);
        return dir.join("allocation_config.backup.json");
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let dir = PathBuf::from(local_app_data).join(r"Swarm\config");
        let _ = std::fs::create_dir_all(&dir);
        return dir.join("allocation_config.backup.json");
    }
    workspace_root.join(r"dist\allocation_config.backup.json")
}

/// Loads allocation configuration if it exists
pub fn load_allocation_config(workspace_root: &Path) -> Option<ComputeAllocationConfig> {
    let p = resolve_allocation_config_file(workspace_root);
    if let Ok(content) = std::fs::read_to_string(&p) {
        if let Ok(config) = serde_json::from_str::<ComputeAllocationConfig>(&content) {
            return Some(config);
        }
    }
    None
}

/// Saves allocation configuration
pub fn save_allocation_config(
    workspace_root: &Path,
    config: &ComputeAllocationConfig,
) -> Result<(), String> {
    let p = resolve_allocation_config_file(workspace_root);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json_str = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&p, json_str).map_err(|e| format!("Failed to write {}: {}", p.display(), e))
}

/// Creates a backup of the current allocation configuration
pub fn create_allocation_backup(workspace_root: &Path) -> Result<(), String> {
    let current_file = resolve_allocation_config_file(workspace_root);
    if current_file.exists() {
        let backup_file = resolve_allocation_backup_file(workspace_root);
        std::fs::copy(&current_file, &backup_file)
            .map_err(|e| format!("Failed to create backup: {}", e))?;
    }
    Ok(())
}

/// Checks if a backup exists
pub fn has_allocation_backup(workspace_root: &Path) -> bool {
    resolve_allocation_backup_file(workspace_root).exists()
}

/// Restores allocation configuration from backup (safe rollback)
pub fn restore_allocation_backup(
    workspace_root: &Path,
) -> Result<ComputeAllocationConfig, String> {
    let backup_file = resolve_allocation_backup_file(workspace_root);
    if !backup_file.exists() {
        return Err("No known-good allocation configuration backup exists to restore.".to_string());
    }
    let content = std::fs::read_to_string(&backup_file)
        .map_err(|e| format!("Failed to read backup file: {}", e))?;
    let config: ComputeAllocationConfig = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse backup configuration: {}", e))?;

    save_allocation_config(workspace_root, &config)?;
    Ok(config)
}
