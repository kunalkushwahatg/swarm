use std::path::PathBuf;
use app_lib::supervisor::win32::{get_available_physical_memory, get_available_vram_mb};
use app_lib::supervisor::commands::{run_preflight_check, evaluate_standalone_resource_thresholds};
use app_lib::supervisor::config::CoordinatorConfig;

fn main() {
    let workspace_root = std::env::var("SWARM_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::current_dir()
                .ok()
                .and_then(|cwd| cwd.ancestors().find(|p| p.join("models").exists()).map(|p| p.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from("."))
        });
    println!("=== SUPERVISOR STANDALONE PREFLIGHT PROBE ===");

    let mem_info = get_available_physical_memory();
    let avail_ram_mb = mem_info.map(|(avail, _)| avail / (1024 * 1024));
    let total_ram_mb = mem_info.map(|(_, total)| total / (1024 * 1024));

    let vram_info = get_available_vram_mb();
    let avail_vram_mb = vram_info.map(|(free, _)| free);
    let total_vram_mb = vram_info.map(|(_, total)| total);

    println!("Physical RAM: Avail = {:?} MB, Total = {:?} MB", avail_ram_mb, total_ram_mb);
    println!("GPU VRAM:     Avail = {:?} MiB, Total = {:?} MiB", avail_vram_mb, total_vram_mb);

    let cfg = CoordinatorConfig {
        port: 8080,
        rpc_port: 0,
        gpu_layers: 37,
        threads: 2,
        model_path: String::new(),
        use_rpc: false,
    };

    let preflight = run_preflight_check(&workspace_root, cfg);
    println!("Preflight can_launch: {}", preflight.can_launch);
    println!("Preflight issues: {:?}", preflight.issues);
    println!("Coordinator port 8080 available: {}", preflight.coordinator_port_available);
    println!("Coordinator binary found: {}", preflight.coordinator_binary_found);
    println!("Model file found: {}", preflight.model_found);

    let eval_res = evaluate_standalone_resource_thresholds(avail_ram_mb, avail_vram_mb);
    match eval_res {
        Ok(()) => {
            println!("Threshold Evaluation: PASS (RAM >= 1000 MB, VRAM >= 3100 MiB)");
        }
        Err(e) => {
            println!("Threshold Evaluation: FAIL -> {}", e);
        }
    }
}
