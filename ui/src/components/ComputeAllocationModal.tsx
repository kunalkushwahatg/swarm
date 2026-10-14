import React, { useState, useEffect } from "react";
import {
  supervisor,
  type ComputeAllocationConfig,
  type AllocationPlanPreview,
  type RuntimePlacementReport,
  type RuntimePlacementBackend,
} from "../lib/supervisor";

interface ComputeAllocationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPlanApplied?: () => void;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "0 MB";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const ComputeAllocationModal: React.FC<ComputeAllocationModalProps> = ({
  isOpen,
  onClose,
  onPlanApplied,
}) => {
  const [config, setConfig] = useState<ComputeAllocationConfig>({
    mode: "automatic",
    total_offload_layers: -1,
    reserved_headroom_ram_mb: 1024,
    reserved_headroom_vram_mb: 256,
    context_size: 2048,
    device_settings: [],
    updated_at_ms: Date.now(),
  });
  const [hasBackup, setHasBackup] = useState(false);
  const [activePolicy, setActivePolicy] = useState("dynamic");
  const [preview, setPreview] = useState<AllocationPlanPreview | null>(null);
  const [savedConfig, setSavedConfig] = useState<ComputeAllocationConfig | null>(null);
  const [savedPreview, setSavedPreview] = useState<AllocationPlanPreview | null>(null);
  const [runtimePlacement, setRuntimePlacement] = useState<RuntimePlacementReport | null>(null);
  const [layerViewMode, setLayerViewMode] = useState<"proposed" | "saved" | "runtime">("proposed");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);

  // Load active allocation config & run initial preview
  const refreshConfig = async () => {
    setLoading(true);
    setActionMessage(null);
    try {
      const res = await supervisor.getAllocationConfig();
      if (res) {
        setConfig(res.config);
        setSavedConfig(res.config);
        setHasBackup(res.has_backup);
        setActivePolicy(res.active_policy);
        const p = await supervisor.previewAllocationPlan(res.config);
        setPreview(p);
        setSavedPreview(p);
      }
      const runtime = await supervisor.getRuntimePlacement();
      setRuntimePlacement(runtime);
      if (runtime && runtime.is_running && runtime.backends.some((b) => (b.assigned_layers && b.assigned_layers.length > 0) || (b.model_buffer_bytes && b.model_buffer_bytes > 0))) {
        setLayerViewMode("runtime");
      }
    } catch (err: any) {
      setActionMessage({ type: "error", text: `Failed to load allocation config: ${err?.message || err}` });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      refreshConfig();
    }
  }, [isOpen]);

  // Recalculate preview when user alters parameters
  const updatePreview = async (updatedConfig: ComputeAllocationConfig) => {
    try {
      const p = await supervisor.previewAllocationPlan(updatedConfig);
      setPreview(p);
    } catch (err: any) {
      console.warn("Preview failed:", err);
    }
  };

  const handleModeChange = (mode: "automatic" | "manual") => {
    const updated: ComputeAllocationConfig = { ...config, mode };
    setConfig(updated);
    updatePreview(updated);
  };

  const handleRamHeadroomChange = (mb: number) => {
    const updated: ComputeAllocationConfig = { ...config, reserved_headroom_ram_mb: mb };
    setConfig(updated);
    updatePreview(updated);
  };

  const handleVramHeadroomChange = (mb: number) => {
    const updated: ComputeAllocationConfig = { ...config, reserved_headroom_vram_mb: mb };
    setConfig(updated);
    updatePreview(updated);
  };

  const handleLayersChange = (layers: number) => {
    const updated: ComputeAllocationConfig = { ...config, total_offload_layers: layers };
    setConfig(updated);
    updatePreview(updated);
  };

  const handleDeviceToggle = (deviceId: string, enabled: boolean) => {
    const nextSettings = [...config.device_settings];
    const idx = nextSettings.findIndex((s) => s.device_id === deviceId);
    if (idx >= 0) {
      nextSettings[idx] = { ...nextSettings[idx], enabled };
    } else {
      nextSettings.push({
        device_id: deviceId,
        device_name: deviceId,
        backend_type: "rpc",
        enabled,
        memory_budget_mb: 2000,
        is_loopback: deviceId.includes("127.0.0.1"),
      });
    }
    const updated: ComputeAllocationConfig = { ...config, device_settings: nextSettings };
    setConfig(updated);
    updatePreview(updated);
  };

  const handleDeviceBudgetChange = (deviceId: string, budgetMb: number) => {
    const nextSettings = [...config.device_settings];
    const idx = nextSettings.findIndex((s) => s.device_id === deviceId);
    if (idx >= 0) {
      nextSettings[idx] = { ...nextSettings[idx], memory_budget_mb: budgetMb };
    } else {
      nextSettings.push({
        device_id: deviceId,
        device_name: deviceId,
        backend_type: "rpc",
        enabled: true,
        memory_budget_mb: budgetMb,
        is_loopback: deviceId.includes("127.0.0.1"),
      });
    }
    const updated: ComputeAllocationConfig = { ...config, device_settings: nextSettings };
    setConfig(updated);
    updatePreview(updated);
  };

  const handleSaveOnly = async () => {
    setApplying(true);
    setActionMessage(null);
    try {
      const res = await supervisor.applyAllocationConfig(config, false);
      setActionMessage({ type: "success", text: res.message });
      setHasBackup(true);
      setSavedConfig(config);
      setSavedPreview(preview);
      if (onPlanApplied) onPlanApplied();
    } catch (err: any) {
      setActionMessage({ type: "error", text: err?.message || String(err) });
    } finally {
      setApplying(false);
    }
  };

  const handleApplyAndRestart = async () => {
    setApplying(true);
    setActionMessage(null);
    try {
      const res = await supervisor.applyAllocationConfig(config, true);
      setActionMessage({ type: "success", text: res.message });
      setHasBackup(true);
      setSavedConfig(config);
      setSavedPreview(preview);
      const runtime = await supervisor.getRuntimePlacement();
      setRuntimePlacement(runtime);
      if (onPlanApplied) onPlanApplied();
    } catch (err: any) {
      setActionMessage({ type: "error", text: err?.message || String(err) });
    } finally {
      setApplying(false);
    }
  };

  const handleRollback = async () => {
    setApplying(true);
    setActionMessage(null);
    try {
      const res = await supervisor.rollbackAllocationConfig(true);
      setConfig(res.restored_config);
      setSavedConfig(res.restored_config);
      setActionMessage({ type: "success", text: res.message });
      const p = await supervisor.previewAllocationPlan(res.restored_config);
      setPreview(p);
      setSavedPreview(p);
      const runtime = await supervisor.getRuntimePlacement();
      setRuntimePlacement(runtime);
      if (onPlanApplied) onPlanApplied();
    } catch (err: any) {
      setActionMessage({ type: "error", text: err?.message || String(err) });
    } finally {
      setApplying(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-4xl max-h-[92vh] flex flex-col bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/60">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse" />
                Compute Allocation & Layer Distribution
              </h2>
              <span className="text-xs px-2.5 py-0.5 rounded-full font-mono uppercase bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">
                Policy: {preview?.placement_policy_env || activePolicy}
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-1">
              Configure tensor splitting, device memory budgets, and GPU/CPU offload for Qwen 2.5 3B (37 layers).
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200 p-2 rounded-lg hover:bg-zinc-800/80 transition-colors"
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-sm">
          
          {/* Action Message Alert */}
          {actionMessage && (
            <div
              className={`p-3.5 rounded-xl border text-xs flex items-center justify-between ${
                actionMessage.type === "success"
                  ? "bg-emerald-950/40 border-emerald-500/30 text-emerald-300"
                  : actionMessage.type === "error"
                  ? "bg-red-950/40 border-red-500/30 text-red-300"
                  : "bg-cyan-950/40 border-cyan-500/30 text-cyan-300"
              }`}
            >
              <span>{actionMessage.text}</span>
              <button
                onClick={() => setActionMessage(null)}
                className="ml-3 text-xs opacity-60 hover:opacity-100"
              >
                ✕
              </button>
            </div>
          )}

          {/* Allocation Mode Tabs */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
              Allocation Mode
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleModeChange("automatic")}
                className={`p-3.5 rounded-xl border text-left transition-all ${
                  config.mode === "automatic"
                    ? "bg-cyan-950/30 border-cyan-500/50 text-cyan-100 shadow-sm shadow-cyan-950/50"
                    : "bg-zinc-900/40 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                }`}
              >
                <div className="font-semibold text-sm flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${config.mode === "automatic" ? "bg-cyan-400" : "bg-zinc-600"}`} />
                  Automatic Allocation (Dynamic Telemetry)
                </div>
                <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                  Measures live candidate RAM and VRAM. Automatically preserves safety headroom and partitions all 37 layers to maximize throughput.
                </p>
              </button>

              <button
                type="button"
                onClick={() => handleModeChange("manual")}
                className={`p-3.5 rounded-xl border text-left transition-all ${
                  config.mode === "manual"
                    ? "bg-indigo-950/30 border-indigo-500/50 text-indigo-100 shadow-sm shadow-indigo-950/50"
                    : "bg-zinc-900/40 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                }`}
              >
                <div className="font-semibold text-sm flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${config.mode === "manual" ? "bg-indigo-400" : "bg-zinc-600"}`} />
                  Manual Allocation (Resource Aware)
                </div>
                <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                  Explicit per-device memory limits and layer offload target. Sets target memory budgets via <code className="text-indigo-300">SWARM_WORKER_PROFILES</code> to compute proportional tensor-split weights for model loading (note: advisory split weights, not an OS process memory ceiling).
                </p>
              </button>
            </div>
          </div>

          {/* Model Assumptions & Safety Headroom Controls */}
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800 space-y-4">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-zinc-300 text-xs uppercase tracking-wider">
                Model Assumptions & Protected Headroom
              </span>
              <span className="text-xs text-zinc-400 font-mono">
                Qwen 2.5 3B (Q4_K_M) • 37 Layers • ~93 MiB/layer (n_ctx=2048)
              </span>
            </div>
            <div className="text-[11px] text-zinc-400 leading-relaxed bg-zinc-950/60 p-2.5 rounded border border-zinc-800/80">
              <span className="text-zinc-300 font-semibold">Cost Calibration:</span> The 93 MiB/layer figure accounts for ~73 MiB weights + ~16 MiB KV cache (scaled linearly with context length) + ~2.25 MiB compute buffer + 2% margin. At context size 512, layer cost drops to ~81 MiB/layer; at context size 8192, layer cost increases to ~141 MiB/layer.
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* RAM Headroom */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-400">Host RAM Headroom:</span>
                  <span className="font-mono text-cyan-400 font-bold">{config.reserved_headroom_ram_mb} MB</span>
                </div>
                <input
                  type="range"
                  min="512"
                  max="4096"
                  step="256"
                  value={config.reserved_headroom_ram_mb}
                  onChange={(e) => handleRamHeadroomChange(Number(e.target.value))}
                  className="w-full accent-cyan-500 h-1.5 bg-zinc-800 rounded-lg cursor-pointer"
                />
                <p className="text-[11px] text-zinc-500 leading-tight">
                  Reserved for Windows OS, background apps, and RPC socket buffers.
                </p>
              </div>

              {/* VRAM Headroom */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-400">GPU VRAM Headroom:</span>
                  <span className="font-mono text-cyan-400 font-bold">{config.reserved_headroom_vram_mb} MB</span>
                </div>
                <input
                  type="range"
                  min="128"
                  max="1024"
                  step="64"
                  value={config.reserved_headroom_vram_mb}
                  onChange={(e) => handleVramHeadroomChange(Number(e.target.value))}
                  className="w-full accent-cyan-500 h-1.5 bg-zinc-800 rounded-lg cursor-pointer"
                />
                <p className="text-[11px] text-zinc-500 leading-tight">
                  Reserved for desktop display buffers and DWM compositor.
                </p>
              </div>

              {/* Total Layers Offloaded */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-400">Offloaded Layers:</span>
                  <span className="font-mono text-cyan-400 font-bold">
                    {config.total_offload_layers === -1 ? "All (37)" : `${config.total_offload_layers} / 37`}
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="37"
                  step="1"
                  value={config.total_offload_layers === -1 ? 37 : config.total_offload_layers}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    handleLayersChange(val === 37 ? -1 : val);
                  }}
                  className="w-full accent-cyan-500 h-1.5 bg-zinc-800 rounded-lg cursor-pointer"
                />
                <p className="text-[11px] text-zinc-500 leading-tight">
                  Layers beyond this limit remain on Host CPU memory.
                </p>
              </div>
            </div>
          </div>

          {/* Visual Layer Distribution Bar with Proposed, Saved, and Confirmed Runtime Modes */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-zinc-400 uppercase tracking-wider text-[11px]">
                  Compute Distribution
                </span>
                {/* 3-Way Mode Selector */}
                <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setLayerViewMode("proposed")}
                    className={`px-2.5 py-1 rounded font-medium transition-colors ${
                      layerViewMode === "proposed"
                        ? "bg-zinc-700 text-white"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    Proposed Plan
                  </button>
                  <button
                    type="button"
                    onClick={() => setLayerViewMode("saved")}
                    className={`px-2.5 py-1 rounded font-medium transition-colors ${
                      layerViewMode === "saved"
                        ? "bg-cyan-800 text-cyan-100"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    Saved / Staged
                  </button>
                  <button
                    type="button"
                    onClick={() => setLayerViewMode("runtime")}
                    className={`px-2.5 py-1 rounded font-medium flex items-center gap-1.5 transition-colors ${
                      layerViewMode === "runtime"
                        ? "bg-emerald-800 text-emerald-100"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <span>Confirmed Runtime</span>
                    {runtimePlacement?.is_running && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    )}
                  </button>
                </div>
              </div>

              <div className="text-zinc-500 font-mono text-[11px]">
                {layerViewMode === "proposed" ? (
                  <span>
                    {preview
                      ? `${preview.planned_offload_layers} / 37 Proposed Offload (${preview.total_cluster_capacity_layers} Cap)`
                      : "Calculating..."}
                  </span>
                ) : layerViewMode === "saved" ? (
                  <span>
                    {savedPreview
                      ? `${savedPreview.planned_offload_layers} / 37 Saved Offload (${savedPreview.total_cluster_capacity_layers} Cap)`
                      : "No saved profile"}
                  </span>
                ) : (
                  <span>
                    {runtimePlacement?.is_running
                      ? `Policy: ${runtimePlacement.policy_name || "active"}`
                      : "Engine Inactive"}
                  </span>
                )}
              </div>
            </div>

            {/* Mode 1 & 2: Proposed Plan or Saved/Staged Plan */}
            {(layerViewMode === "proposed" || layerViewMode === "saved") && (() => {
              const activePlan = layerViewMode === "proposed" ? preview : (savedPreview || preview);
              const isSavedMode = layerViewMode === "saved";
              const hasUnsavedChanges = Boolean(
                savedConfig && JSON.stringify(config) !== JSON.stringify(savedConfig)
              );

              if (!activePlan) {
                return (
                  <div className="p-4 rounded-lg bg-zinc-900 border border-zinc-800 text-center text-xs text-zinc-500">
                    No allocation plan available.
                  </div>
                );
              }

              return (
                <div className="space-y-3">
                  {/* Status Note */}
                  {isSavedMode && hasUnsavedChanges && (
                    <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-300 flex items-center justify-between">
                      <span>⚠️ Viewing saved configuration on disk. Sliders currently have unsaved changes in &quot;Proposed Plan&quot;.</span>
                      <button
                        type="button"
                        onClick={() => setLayerViewMode("proposed")}
                        className="underline hover:text-amber-100 font-semibold ml-2"
                      >
                        Switch to Proposed
                      </button>
                    </div>
                  )}

                  {/* Primary: Proportional Tensor Split Bar */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] text-zinc-400">
                      <span className="font-semibold text-zinc-300">
                        Primary: Proportional Tensor Split (model_params.tensor_split)
                      </span>
                      <span className="text-[10px] text-zinc-500 font-mono">
                        Policy: {activePlan.placement_policy_env || "auto"}
                      </span>
                    </div>

                    <div className="flex w-full h-9 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden p-0.5 gap-0.5">
                      {activePlan.device_plans
                        .filter((p) => p.enabled && p.planned_layer_count > 0)
                        .map((p) => {
                          const isCuda = p.backend_type === "cuda";
                          const isRpc = p.backend_type === "rpc";
                          const bgClass = isCuda
                            ? "bg-purple-600/90 text-purple-100"
                            : isRpc
                            ? "bg-cyan-600/90 text-cyan-100"
                            : "bg-zinc-700 text-zinc-200";

                          return (
                            <div
                              key={p.device_id}
                              style={{ width: `${Math.max(6, p.split_weight_percent)}%` }}
                              className={`flex flex-col items-center justify-center text-[10px] font-mono font-bold transition-all truncate px-1 rounded-sm ${bgClass}`}
                              title={`${p.device_name}: ${p.split_weight_percent}% split (~${p.planned_layer_count} layers)`}
                            >
                              <span className="truncate">{p.device_name}</span>
                              <span className="text-[9px] opacity-80">{p.split_weight_percent}% (~{p.planned_layer_count}L)</span>
                            </div>
                          );
                        })}

                      {/* CPU fallback segment */}
                      {activePlan.planned_offload_layers < 37 && (
                        <div
                          style={{
                            width: `${Math.max(
                              6,
                              Math.round(((37 - activePlan.planned_offload_layers) / 37) * 100)
                            )}%`,
                          }}
                          className="flex flex-col items-center justify-center text-[10px] font-mono font-bold transition-all truncate px-1 rounded-sm bg-zinc-800 text-zinc-400"
                          title={`Host CPU Fallback: ${37 - activePlan.planned_offload_layers} layers unallocated to accelerators`}
                        >
                          <span>Host CPU</span>
                          <span className="text-[9px] opacity-80">{37 - activePlan.planned_offload_layers}L</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Secondary: Simulated 37-Layer Slice Projection */}
                  <div className="space-y-1.5 pt-0.5">
                    <div className="flex items-center justify-between text-[11px] text-zinc-400">
                      <span className="text-zinc-400 font-medium">
                        Secondary: Simulated 37-Layer Slice Projection (~93 MiB/layer baseline)
                      </span>
                      <span className="text-[10px] text-zinc-500 italic">
                        Derived from cumulative split boundaries
                      </span>
                    </div>

                    <div className="flex w-full h-7 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden p-0.5 gap-0.5">
                      {Array.from({ length: 37 }).map((_, idx) => {
                        const assignedDevice = activePlan.device_plans.find((p) =>
                          p.planned_layer_ranges.some(([start, end]) => idx >= start && idx <= end)
                        );
                        const isCuda = assignedDevice?.backend_type === "cuda";
                        const isRpc = assignedDevice?.backend_type === "rpc";
                        const isOffloaded = Boolean(assignedDevice);

                        let bgClass = "bg-zinc-800 text-zinc-600";
                        if (isCuda) bgClass = "bg-purple-600 text-purple-100";
                        else if (isRpc) bgClass = "bg-cyan-600 text-cyan-100";
                        else if (!isOffloaded) bgClass = "bg-zinc-700/60 text-zinc-400";

                        return (
                          <div
                            key={idx}
                            title={
                              assignedDevice
                                ? `Layer ${idx}: ${assignedDevice.device_name} (${assignedDevice.backend_type.toUpperCase()}) — Projected`
                                : `Layer ${idx}: Host CPU Fallback`
                            }
                            className={`flex-1 flex items-center justify-center text-[9px] font-mono font-bold transition-all hover:opacity-80 cursor-default ${bgClass}`}
                          >
                            {idx}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Informational Disclosure Callout */}
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-zinc-950/70 border border-zinc-800/80 text-[11px] text-zinc-400">
                    <span className="text-cyan-400 font-bold shrink-0">ℹ️ Architecture Note:</span>
                    <p className="leading-relaxed">
                      Llama.cpp partitions model tensors across devices using proportional split weights (<code className="text-cyan-300">model_params.tensor_split</code>). Continuous layer slices above are simulated projections derived from cumulative normalized split boundaries and calibrated ~93 MiB/layer memory requirements.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center justify-between text-[11px] text-zinc-400 pt-0.5">
                    <div className="flex flex-wrap items-center gap-4">
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded bg-purple-600" />
                        <span>Local CUDA GPU ({isSavedMode ? "Saved" : "Proposed"})</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded bg-cyan-600" />
                        <span>Distributed RPC Worker ({isSavedMode ? "Saved" : "Proposed"})</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded bg-zinc-700/60" />
                        <span>Host CPU Fallback</span>
                      </div>
                    </div>
                    <span className="text-[10.5px] text-amber-400/90 font-medium">
                      {isSavedMode ? "Saved Profile (Ready for Next Start)" : "Proposed Plan (Pending Save/Restart)"}
                    </span>
                  </div>
                </div>
              );
            })()}

            {/* Mode 2: Confirmed Native Runtime Placement */}
            {layerViewMode === "runtime" && (
              <>
                {!runtimePlacement?.is_running ? (
                  <div className="p-4 rounded-lg bg-zinc-900 border border-dashed border-zinc-800 text-center space-y-1.5">
                    <div className="text-xs font-semibold text-zinc-300">
                      Native Inference Engine Stopped
                    </div>
                    <div className="text-[11px] text-zinc-500 max-w-md mx-auto">
                      Coordinator process is not currently running. Start or restart the coordinator to load the model and view live hardware placement.
                    </div>
                  </div>
                ) : runtimePlacement.backends.some((b: RuntimePlacementBackend) => b.assigned_layers && b.assigned_layers.length > 0) ? (
                  <>
                    <div className="flex w-full h-8 bg-zinc-900 border border-emerald-900/60 rounded-lg overflow-hidden p-0.5 gap-0.5">
                      {Array.from({ length: 37 }).map((_, idx) => {
                        const assignedBackend = runtimePlacement.backends.find(
                          (b: RuntimePlacementBackend) => b.assigned_layers && b.assigned_layers.includes(idx)
                        );
                        const isCuda = assignedBackend?.backend_type === "cuda";
                        const isRpc = assignedBackend?.backend_type === "rpc";
                        const isAssigned = Boolean(assignedBackend);

                        let bgClass = "bg-zinc-800 text-zinc-600";
                        if (isCuda) bgClass = "bg-purple-600 text-purple-100";
                        else if (isRpc) bgClass = "bg-cyan-600 text-cyan-100";
                        else if (!isAssigned) bgClass = "bg-zinc-700/60 text-zinc-400";

                        return (
                          <div
                            key={idx}
                            title={
                              assignedBackend
                                ? `Layer ${idx}: ${assignedBackend.device_name} (${assignedBackend.endpoint || assignedBackend.backend_type}) [CONFIRMED]`
                                : `Layer ${idx}: Host CPU Memory`
                            }
                            className={`flex-1 flex items-center justify-center text-[10px] font-mono font-bold transition-all hover:opacity-80 cursor-default ${bgClass}`}
                          >
                            {idx}
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex flex-wrap items-center justify-between text-[11px] text-zinc-400 pt-1">
                      <div className="flex flex-wrap items-center gap-4">
                        <div className="flex items-center gap-1.5">
                          <span className="w-3 h-3 rounded bg-purple-600" />
                          <span>Local CUDA GPU (Confirmed)</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="w-3 h-3 rounded bg-cyan-600" />
                          <span>Distributed RPC Worker (Confirmed)</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="w-3 h-3 rounded bg-zinc-700/60" />
                          <span>Host CPU</span>
                        </div>
                      </div>
                      <span className="text-[10.5px] text-emerald-400 font-semibold flex items-center gap-1">
                        <span>✓ Authoritative Placement Confirmed by Engine Loader Logs</span>
                      </span>
                    </div>

                    {/* Breakdown of confirmed layers per backend */}
                    <div className="mt-2 p-2 rounded bg-zinc-900/80 border border-zinc-800 text-[11px] space-y-1">
                      <div className="font-semibold text-zinc-300">
                        Confirmed Engine Allocations (/backends):
                      </div>
                      {runtimePlacement.backends.map((b: RuntimePlacementBackend) => (
                        <div
                          key={b.backend_id || b.endpoint}
                          className="flex items-center justify-between text-zinc-400 font-mono text-[10.5px]"
                        >
                          <span className="truncate max-w-[280px]">
                            {b.device_name || b.backend_id} ({b.endpoint || b.backend_type}):
                          </span>
                          <span>
                            {b.assigned_layers && b.assigned_layers.length > 0
                              ? `${b.assigned_layers.length} layers [${
                                  b.assigned_layer_ranges.length > 0
                                    ? b.assigned_layer_ranges.map(([s, e]: [number, number]) => `${s}..${e}`).join(", ")
                                    : b.assigned_layers.join(",")
                                }]`
                              : "0 layers (Fallback)"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    {/* Proportional Tensor Split Mode: When engine is active and splits tensors proportionally */}
                    <div className="space-y-2">
                      {/* Proportional Split Bar */}
                      <div className="flex w-full h-8 bg-zinc-900 border border-emerald-900/60 rounded-lg overflow-hidden p-0.5 gap-0.5">
                        {(() => {
                          const activeBackends = runtimePlacement.backends.filter(
                            (b: RuntimePlacementBackend) => (b.split_weight ?? 0) > 0 || (b.model_buffer_bytes ?? 0) > 0
                          );
                          const totalWeight = activeBackends.reduce(
                            (acc: number, b: RuntimePlacementBackend) => acc + (b.split_weight ?? (b.model_buffer_bytes > 0 ? 1 : 0)),
                            0
                          );

                          if (activeBackends.length === 0 || totalWeight <= 0) {
                            return (
                              <div className="w-full flex items-center justify-center text-xs text-zinc-500 font-mono">
                                100% Host CPU Memory
                              </div>
                            );
                          }

                          return activeBackends.map((b: RuntimePlacementBackend) => {
                            const weight = b.split_weight ?? (b.model_buffer_bytes > 0 ? 1 : 0);
                            const percent = Math.max(5, Math.round((weight / totalWeight) * 100));
                            const isCuda = b.backend_type === "cuda";
                            const isRpc = b.backend_type === "rpc";
                            const bgClass = isCuda
                              ? "bg-purple-600 text-purple-100"
                              : isRpc
                              ? "bg-cyan-600 text-cyan-100"
                              : "bg-zinc-700 text-zinc-200";

                            return (
                              <div
                                key={b.backend_id || b.endpoint}
                                style={{ width: `${percent}%` }}
                                title={`${b.device_name || b.backend_id}: ${percent}% tensor split (${formatBytes(b.model_buffer_bytes)} buffer)`}
                                className={`flex items-center justify-center text-[10px] font-mono font-bold transition-all truncate px-1 ${bgClass}`}
                              >
                                {b.device_name || b.backend_id} ({percent}%)
                              </div>
                            );
                          });
                        })()}
                      </div>

                      <div className="flex flex-wrap items-center justify-between text-[11px] text-zinc-400 pt-0.5">
                        <span className="text-[10.5px] text-emerald-400 font-semibold flex items-center gap-1">
                          <span>✓ Native Engine Active — Proportional Tensor Split Mode</span>
                        </span>
                        <span className="text-[10.5px] text-zinc-400 font-mono">
                          model_params.tensor_split
                        </span>
                      </div>

                      <div className="p-2.5 rounded bg-zinc-950/70 border border-zinc-800 text-[11px] space-y-1.5">
                        <p className="text-zinc-400 leading-relaxed">
                          The native llama.cpp / ggml-rpc runtime partitions model tensors across devices using proportional weights (<code className="text-indigo-300">model_params.tensor_split</code>). Discrete per-layer index ranges are only exposed when detailed loader debug logging is enabled. Confirmed memory allocations below reflect actual hardware buffers:
                        </p>
                        <div className="space-y-1 pt-1 border-t border-zinc-800/80">
                          {runtimePlacement.backends.map((b: RuntimePlacementBackend) => (
                            <div
                              key={b.backend_id || b.endpoint}
                              className="flex items-center justify-between text-zinc-300 font-mono text-[10.5px]"
                            >
                              <span className="truncate max-w-[280px]">
                                {b.device_name || b.backend_id} ({b.endpoint || b.backend_type}):
                              </span>
                              <span className="text-right">
                                Weights: <strong className="text-cyan-400">{formatBytes(b.model_buffer_bytes)}</strong> | KV: {formatBytes(b.kv_buffer_bytes)} | Split: {b.split_weight ?? 1.0}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {/* Candidate & Connected Devices Table */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-zinc-400 uppercase tracking-wider">
                Participating Compute Devices
              </span>
              <span className="text-zinc-500">
                Toggling off excludes device from <code className="text-zinc-400">SWARM_RPC_ENDPOINTS</code>
              </span>
            </div>

            <div className="space-y-2.5">
              {preview?.device_plans.map((dev) => {
                const setting = config.device_settings.find((s) => s.device_id === dev.device_id);
                const isEnabled = setting ? setting.enabled : dev.enabled;

                return (
                  <div
                    key={dev.device_id}
                    className={`p-4 rounded-xl border transition-all ${
                      isEnabled
                        ? "bg-zinc-900/70 border-zinc-800"
                        : "bg-zinc-950/40 border-zinc-900 opacity-60"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      {/* Checkbox & Details */}
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={(e) => handleDeviceToggle(dev.device_id, e.target.checked)}
                          className="w-4 h-4 rounded accent-cyan-500 cursor-pointer"
                        />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-zinc-200">{dev.device_name}</span>
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700 uppercase">
                              {dev.backend_type}
                            </span>
                            {dev.is_loopback && (
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800/60">
                                Host Shared RAM
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-zinc-400 font-mono mt-0.5">
                            {dev.device_id}
                          </div>
                        </div>
                      </div>

                      {/* Capacity & Ranges */}
                      <div className="text-right">
                        <div className="text-sm font-bold text-zinc-100 font-mono">
                          {dev.planned_layer_count} Layers{" "}
                          <span className="text-xs text-zinc-400 font-normal">
                            ({dev.split_weight_percent}% split)
                          </span>
                        </div>
                        <div className="text-xs text-cyan-400 font-mono mt-0.5">
                          {dev.planned_layer_ranges.length > 0
                            ? dev.planned_layer_ranges.map(([s, e]) => `Layers ${s} - ${e}`).join(", ")
                            : "No layers assigned"}
                        </div>
                      </div>
                    </div>

                    {/* Telemetry Metrics & Budget Input */}
                    <div className="mt-3 pt-3 border-t border-zinc-800/80 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                      <div>
                        <span className="text-zinc-500 block text-[11px]">Hardware Usable</span>
                        <span className="font-mono text-zinc-300 font-medium">{dev.usable_budget_mb} MB</span>
                      </div>

                      <div>
                        <span className="text-zinc-500 block text-[11px]">Max Layer Capacity</span>
                        <span className="font-mono text-zinc-300 font-medium">~{dev.estimated_layer_capacity} Layers</span>
                      </div>

                      {config.mode === "manual" ? (
                        <div className="col-span-2 flex items-center justify-end gap-2">
                          <label className="text-zinc-400 text-xs">Manual Budget:</label>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min="200"
                              max="32000"
                              step="100"
                              value={setting?.memory_budget_mb || dev.memory_budget_mb}
                              onChange={(e) => handleDeviceBudgetChange(dev.device_id, Number(e.target.value))}
                              disabled={!isEnabled}
                              className="w-24 px-2.5 py-1 bg-zinc-950 border border-zinc-700 rounded-lg text-right font-mono text-xs text-indigo-300 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                            />
                            <span className="text-zinc-500 text-xs">MB</span>
                          </div>
                        </div>
                      ) : (
                        <div className="col-span-2 text-right">
                          <span className="text-zinc-500 block text-[11px]">Control Enforcement</span>
                          <span className="text-cyan-400 font-mono text-xs">
                            {dev.control_type === "HARD_ENFORCED" ? "Hard-Enforced via RPC" : "Dynamic Tensor Split"}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Warnings */}
                    {dev.warnings.length > 0 && (
                      <div className="mt-2 text-[11px] text-amber-400/90 bg-amber-950/30 border border-amber-800/40 rounded-lg px-2.5 py-1">
                        ⚠️ {dev.warnings.join("; ")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Validation & Risk Assessment Banner */}
          {preview && (
            <div
              className={`p-4 rounded-xl border flex items-start gap-3 text-xs ${
                preview.risk_level === "SAFE"
                  ? "bg-emerald-950/20 border-emerald-500/30 text-emerald-300"
                  : preview.risk_level === "WARNING"
                  ? "bg-amber-950/20 border-amber-500/30 text-amber-300"
                  : preview.risk_level === "HIGH_RISK"
                  ? "bg-orange-950/20 border-orange-500/30 text-orange-300"
                  : "bg-red-950/20 border-red-500/30 text-red-300"
              }`}
            >
              <div className="text-base">
                {preview.risk_level === "SAFE" ? "🛡️" : preview.risk_level === "WARNING" ? "⚠️" : "🛑"}
              </div>
              <div className="flex-1 space-y-1">
                <div className="font-bold uppercase tracking-wider text-[11px]">
                  Safety Assessment: {preview.risk_level}
                </div>
                {preview.is_valid ? (
                  <p className="text-xs leading-relaxed opacity-90">
                    Configuration is valid. All {preview.planned_offload_layers} offload layers accommodated within cluster hardware limits with safe headroom margins.
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {preview.validation_errors.map((err, i) => (
                      <p key={i} className="text-xs font-medium">❌ {err}</p>
                    ))}
                  </div>
                )}
                {preview.validation_warnings.map((warn, i) => (
                  <p key={i} className="text-[11px] opacity-80">⚠️ {warn}</p>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-t border-zinc-800 bg-zinc-900/80">
          <div className="flex items-center gap-2">
            {hasBackup && (
              <button
                type="button"
                onClick={handleRollback}
                disabled={applying || loading}
                className="px-3.5 py-2 text-xs font-semibold rounded-xl bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-50"
              >
                Rollback to Previous Backup
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={applying}
              className="px-4 py-2 text-xs font-semibold rounded-xl border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              Close
            </button>

            <button
              type="button"
              onClick={handleSaveOnly}
              disabled={applying || loading || !preview?.is_valid}
              className="px-4 py-2 text-xs font-semibold rounded-xl bg-zinc-800 text-cyan-300 border border-cyan-500/40 hover:bg-zinc-700 transition-colors disabled:opacity-50"
            >
              {applying ? "Saving..." : "Save Configuration"}
            </button>

            <button
              type="button"
              onClick={handleApplyAndRestart}
              disabled={applying || loading || !preview?.is_valid}
              className="px-4 py-2 text-xs font-semibold rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 text-white font-medium hover:from-cyan-500 hover:to-blue-500 transition-all shadow-lg shadow-cyan-900/30 disabled:opacity-50"
            >
              {applying ? "Restarting..." : "Apply & Restart Coordinator"}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
