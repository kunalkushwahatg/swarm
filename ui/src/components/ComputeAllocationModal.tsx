import React, { useState, useEffect } from "react";
import {
  supervisor,
  type ComputeAllocationConfig,
  type AllocationPlanPreview,
  type RuntimePlacementReport,
  type RuntimePlacementBackend,
} from "../lib/supervisor";
import { X, Sliders, Info, CheckCircle2, AlertTriangle, ShieldCheck, Loader2, RefreshCw } from "lucide-react";

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
  const [activePolicy, setActivePolicy] = useState("Unavailable");
  const [preview, setPreview] = useState<AllocationPlanPreview | null>(null);
  const [_savedConfig, setSavedConfig] = useState<ComputeAllocationConfig | null>(null);
  const [savedPreview, setSavedPreview] = useState<AllocationPlanPreview | null>(null);
  const [runtimePlacement, setRuntimePlacement] = useState<RuntimePlacementReport | null>(null);
  const [layerViewMode, setLayerViewMode] = useState<"proposed" | "saved" | "runtime">("proposed");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [showArchNotes, setShowArchNotes] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);

  const layerBasisFor = (cfg: ComputeAllocationConfig, plan: AllocationPlanPreview | null) => {
    const modelLayers = plan?.model_total_layers || plan?.total_model_layers || 0;
    return cfg.total_offload_layers > 0
      ? Math.min(cfg.total_offload_layers, modelLayers)
      : modelLayers;
  };

  const mbPerLayerFor = (plan: AllocationPlanPreview | null) =>
    Math.max(1, Math.ceil((plan?.estimated_bytes_per_layer || 93 * 1024 * 1024) / (1024 * 1024)));

  // Budgets are the value the native resource-aware policy actually consumes.
  // Round each device up by at most one layer so integer division in the native
  // capacity estimator cannot make a proportional split one layer short.
  const budgetForWeight = (weight: number, layerBasis: number, mbPerLayer: number) => {
    if (weight <= 0) return 0;
    const desiredLayers = Math.max(1, Math.ceil(weight * layerBasis));
    return desiredLayers * mbPerLayer + (mbPerLayer - 1);
  };

  const normalizeManualBudgets = (
    cfg: ComputeAllocationConfig,
    plan: AllocationPlanPreview | null,
    changedDeviceId?: string,
  ): ComputeAllocationConfig => {
    if (cfg.mode !== "manual") return cfg;

    const settings = cfg.device_settings.map((setting) => ({ ...setting }));
    const enabled = settings.filter((setting) => setting.enabled);
    if (enabled.length === 0) return cfg;

    const layerBasis = layerBasisFor(cfg, plan);
    const mbPerLayer = mbPerLayerFor(plan);
    const lockedWeight = enabled
      .filter((setting) => setting.locked_split)
      .reduce((sum, setting) => sum + Math.max(0, setting.split_weight || 0), 0);
    const unlocked = enabled.filter((setting) => !setting.locked_split);
    const targetUnlockedWeight = Math.max(0, 1 - lockedWeight);

    if (unlocked.length > 0) {
      if (changedDeviceId) {
        const moved = unlocked.find((setting) => setting.device_id === changedDeviceId);
        const others = unlocked.filter((setting) => setting.device_id !== changedDeviceId);
        if (moved) {
          moved.split_weight = Math.min(
            Math.max(0, moved.split_weight || 0),
            targetUnlockedWeight,
          );
          if (others.length === 0) {
            moved.split_weight = targetUnlockedWeight;
          } else {
            const remaining = Math.max(0, targetUnlockedWeight - (moved.split_weight || 0));
            const otherWeightSum = others.reduce(
              (sum, setting) => sum + Math.max(0, setting.split_weight || 0),
              0,
            );
            for (const setting of others) {
              setting.split_weight =
                otherWeightSum > 0
                  ? (remaining * Math.max(0, setting.split_weight || 0)) / otherWeightSum
                  : remaining / others.length;
            }
          }
        }
      } else {
        const currentWeightSum = unlocked.reduce(
          (sum, setting) => sum + Math.max(0, setting.split_weight || 0),
          0,
        );
        for (const setting of unlocked) {
          setting.split_weight =
            currentWeightSum > 0
              ? (targetUnlockedWeight * Math.max(0, setting.split_weight || 0)) / currentWeightSum
              : targetUnlockedWeight / unlocked.length;
        }
      }
    }

    for (const setting of enabled) {
      setting.memory_budget_mb = budgetForWeight(
        Math.max(0, setting.split_weight || 0),
        layerBasis,
        mbPerLayer,
      );
    }

    return { ...cfg, device_settings: settings };
  };

  // Load active allocation config & run initial preview
  const refreshConfig = async () => {
    setLoading(true);
    setActionMessage(null);
    try {
      const res = await supervisor.getAllocationConfig();
      if (res) {
        const savedPlan = await supervisor.previewAllocationPlan(res.config);
        let editableConfig = res.config;
        let editablePlan = savedPlan;
        if (res.config.mode === "manual" && savedPlan) {
          editableConfig = normalizeManualBudgets(res.config, savedPlan);
          editablePlan = await supervisor.previewAllocationPlan(editableConfig);
        }
        setConfig(editableConfig);
        setSavedConfig(res.config);
        setHasBackup(res.has_backup);
        setActivePolicy(res.active_policy);
        setPreview(editablePlan);
        setSavedPreview(savedPlan);
      } else if (supervisor.isDesktop) {
        setActionMessage({
          type: "error",
          text: "Allocation configuration could not be loaded from the desktop supervisor.",
        });
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
    if (!isOpen) return;

    // Clear the previous plan so the modal never flashes stale defaults such
    // as "All (37)" or "Unavailable" before the async preview resolves.
    setPreview(null);
    setSavedPreview(null);
    setRuntimePlacement(null);
    setLayerViewMode("proposed");
    setActionMessage(null);
    setLoading(true);
    void refreshConfig();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !applying) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, applying, onClose]);

  const updatePreview = async (updatedConfig: ComputeAllocationConfig) => {
    try {
      const p = await supervisor.previewAllocationPlan(updatedConfig);
      if (p) {
        setPreview(p);
      }
    } catch (err: any) {
      console.warn("Preview failed:", err);
    }
  };

  const handleModeChange = (mode: "automatic" | "manual") => {
    const base: ComputeAllocationConfig = { ...config, mode };
    const updated = mode === "manual" ? normalizeManualBudgets(base, preview) : base;
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
    const base: ComputeAllocationConfig = { ...config, total_offload_layers: layers };
    const updated = normalizeManualBudgets(base, preview);
    setConfig(updated);
    updatePreview(updated);
  };

  const handleDeviceToggle = (deviceId: string, enabled: boolean) => {
    const nextSettings = [...config.device_settings];
    const idx = nextSettings.findIndex((s) => s.device_id === deviceId);
    const devInfo = preview?.device_plans?.find((d) => d.device_id === deviceId);
    if (idx >= 0) {
      const seedWeight =
        enabled && (!nextSettings[idx].split_weight || nextSettings[idx].split_weight <= 0)
          ? 0.1
          : nextSettings[idx].split_weight;
      nextSettings[idx] = { ...nextSettings[idx], enabled, split_weight: seedWeight };
    } else {
      nextSettings.push({
        device_id: deviceId,
        device_name: devInfo?.device_name || deviceId,
        backend_type: devInfo?.backend_type || "rpc",
        enabled,
        memory_budget_mb: devInfo?.planned_budget_mb || 1024,
        is_loopback: devInfo?.is_loopback ?? false,
        split_weight: enabled ? 0.1 : 0,
        locked_split: false,
      });
    }
    const base: ComputeAllocationConfig = { ...config, device_settings: nextSettings };
    const updated = normalizeManualBudgets(base, preview);
    setConfig(updated);
    updatePreview(updated);
  };

  const handleDeviceSplitWeightChange = (deviceId: string, weightPct: number) => {
    const nextSettings = [...config.device_settings];
    const idx = nextSettings.findIndex((s) => s.device_id === deviceId);
    const weight = Math.max(0, Math.min(1, weightPct / 100.0));
    const devInfo = preview?.device_plans?.find((d) => d.device_id === deviceId);

    if (idx >= 0) {
      nextSettings[idx] = {
        ...nextSettings[idx],
        split_weight: weight,
        device_name: nextSettings[idx].device_name || devInfo?.device_name || deviceId,
        backend_type: nextSettings[idx].backend_type || devInfo?.backend_type || "rpc",
        is_loopback: nextSettings[idx].is_loopback ?? devInfo?.is_loopback ?? false,
      };
    } else {
      nextSettings.push({
        device_id: deviceId,
        device_name: devInfo?.device_name || deviceId,
        backend_type: devInfo?.backend_type || "rpc",
        enabled: true,
        split_weight: weight,
        memory_budget_mb: 0,
        is_loopback: devInfo?.is_loopback ?? false,
        locked_split: false,
      });
    }

    const base: ComputeAllocationConfig = { ...config, device_settings: nextSettings };
    const updated = normalizeManualBudgets(base, preview, deviceId);
    setConfig(updated);
    updatePreview(updated);
  };

  const handleDeviceLockToggle = (deviceId: string, locked: boolean) => {
    const nextSettings = [...config.device_settings];
    const idx = nextSettings.findIndex((s) => s.device_id === deviceId);
    const devInfo = preview?.device_plans?.find((d) => d.device_id === deviceId);
    if (idx >= 0) {
      nextSettings[idx] = { ...nextSettings[idx], locked_split: locked };
    } else {
      nextSettings.push({
        device_id: deviceId,
        device_name: devInfo?.device_name || deviceId,
        backend_type: devInfo?.backend_type || "rpc",
        enabled: true,
        memory_budget_mb: devInfo?.planned_budget_mb || 1024,
        is_loopback: devInfo?.is_loopback ?? false,
        split_weight: devInfo?.split_weight || 0,
        locked_split: locked,
      });
    }
    const updated: ComputeAllocationConfig = { ...config, device_settings: nextSettings };
    setConfig(updated);
    updatePreview(updated);
  };

  const handleUseOnlineDevices = () => {
    const plans = preview?.device_plans || [];
    if (plans.length === 0) return;

    const nextSettings = [...config.device_settings];
    for (const dev of plans) {
      const enabled = dev.is_online !== false;
      const idx = nextSettings.findIndex((setting) => setting.device_id === dev.device_id);
      if (idx >= 0) {
        nextSettings[idx] = {
          ...nextSettings[idx],
          enabled,
          split_weight: enabled
            ? Math.max(0.1, nextSettings[idx].split_weight || 0)
            : 0,
        };
      } else {
        nextSettings.push({
          device_id: dev.device_id,
          device_name: dev.device_name,
          backend_type: dev.backend_type,
          enabled,
          memory_budget_mb: enabled
            ? dev.planned_budget_mb || Math.max(1024, dev.usable_budget_mb || 0)
            : 0,
          is_loopback: dev.is_loopback,
          split_weight: enabled ? 0.1 : 0,
          locked_split: false,
        });
      }
    }

    const base: ComputeAllocationConfig = { ...config, device_settings: nextSettings };
    const updated = normalizeManualBudgets(base, preview);
    setConfig(updated);
    updatePreview(updated);
  };

  const handleSaveOnly = async () => {
    setApplying(true);
    setActionMessage(null);
    try {
      const res = await supervisor.applyAllocationConfig(config, false);
      if (res.success) {
        setActionMessage({
          type: "success",
          text: "Configuration saved to disk. Staged for the next engine start.",
        });
        setSavedConfig(config);
        setActivePolicy(config.mode === "automatic" ? "dynamic" : "resource_aware");
        const p = await supervisor.previewAllocationPlan(config);
        setSavedPreview(p);
        setHasBackup(true);
      } else {
        setActionMessage({ type: "error", text: res.message });
      }
    } catch (err: any) {
      setActionMessage({ type: "error", text: `Failed to save configuration: ${err?.message || err}` });
    } finally {
      setApplying(false);
    }
  };

  const handleApplyAndRestart = async () => {
    setApplying(true);
    setActionMessage(null);
    window.dispatchEvent(new CustomEvent("swarm-engine-starting"));
    try {
      const res = await supervisor.applyAllocationConfig(config, true);
      if (res.success) {
        setActionMessage({
          type: "success",
          text: res.coordinator_restarted
            ? "Configuration applied and coordinator restarted successfully."
            : res.message,
        });
        setSavedConfig(config);
        setActivePolicy(config.mode === "automatic" ? "dynamic" : "resource_aware");
        const p = await supervisor.previewAllocationPlan(config);
        setSavedPreview(p);
        setHasBackup(true);
        if (onPlanApplied) onPlanApplied();
        const refreshRuntime = async () => {
          try {
            const runtime = await supervisor.getRuntimePlacement();
            setRuntimePlacement(runtime);
            setLayerViewMode("runtime");
          } catch {}
        };
        setTimeout(refreshRuntime, 1500);
        setTimeout(refreshRuntime, 3500);
      } else {
        setActionMessage({ type: "error", text: res.message });
      }
    } catch (err: any) {
      setActionMessage({ type: "error", text: `Apply failed: ${err?.message || err}` });
    } finally {
      setApplying(false);
      window.dispatchEvent(new CustomEvent("swarm-engine-started"));
    }
  };

  const handleRollback = async () => {
    setApplying(true);
    setActionMessage(null);
    try {
      const runtime = await supervisor.getRuntimePlacement();
      const wasRunning = Boolean(runtime?.is_running);
      const res = await supervisor.rollbackAllocationConfig(wasRunning);
      if (res.success) {
        await refreshConfig();
        setActionMessage({
          type: "info",
          text: wasRunning && res.coordinator_restarted
            ? "Rolled back to the previous configuration and restarted the coordinator."
            : "Rolled back to the previous configuration. The restored plan will take effect on the next engine start.",
        });
      } else {
        setActionMessage({ type: "error", text: res.message });
      }
    } catch (err: any) {
      setActionMessage({ type: "error", text: `Rollback failed: ${err?.message || err}` });
    } finally {
      setApplying(false);
    }
  };

  if (!isOpen) return null;

  // Single source of truth for total layers and per-layer cost
  const totalLayers = preview?.model_total_layers ?? preview?.total_model_layers ?? 0;
  const estimatedMbPerLayer = mbPerLayerFor(preview);
  const showInitialLoading = loading && !preview;
  const isEngineRunning = runtimePlacement?.is_running === true;
  const offlineEnabledPlans = (preview?.device_plans || []).filter(
    (dev) => dev.enabled && dev.is_online === false,
  );
  const onlineDisabledPlans = (preview?.device_plans || []).filter(
    (dev) => !dev.enabled && dev.is_online !== false,
  );
  const canUseOnlineDevices =
    offlineEnabledPlans.length > 0 && onlineDisabledPlans.length > 0;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(28, 36, 30, 0.5)",
        backdropFilter: "blur(4px)",
      }}
      onClick={applying ? undefined : onClose}
    >
      <div
        className="card animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-label="Compute allocation and layer distribution"
        aria-busy={showInitialLoading || applying}
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          maxWidth: 880,
          maxHeight: "88vh",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius)",
          boxShadow: "0 16px 44px rgba(28, 36, 30, 0.16)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--color-border)",
            background: "var(--color-surface-subtle)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "var(--radius-sm)",
                background: "var(--color-accent-subtle)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--color-accent)",
              }}
            >
              <Sliders size={16} />
            </div>
            <div>
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text)", margin: 0 }}>
                Compute Allocation &amp; Layer Distribution
              </h2>
              <div style={{ fontSize: 11.5, color: "var(--color-text-2)", marginTop: 2 }}>
                {showInitialLoading ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <Loader2 size={11} className="animate-spin" />
                    Reading cluster telemetry…
                  </span>
                ) : (
                  <>
                    Active Policy: <span className="mono" style={{ color: "var(--color-accent)" }}>{activePolicy}</span> · Multi-backend proportional tensor split
                  </>
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            disabled={applying}
            style={{ padding: 4, height: 28, width: 28, borderRadius: "50%" }}
            title="Close dialog"
          >
            <X size={15} />
          </button>
        </div>

        {/* Scrollable Content Body */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
            padding: "18px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          {/* Action Message Banner */}
          {actionMessage && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                background:
                  actionMessage.type === "success"
                    ? "var(--color-ok-bg)"
                    : actionMessage.type === "error"
                    ? "var(--color-error-bg)"
                    : "var(--color-accent-subtle)",
                color:
                  actionMessage.type === "success"
                    ? "var(--color-ok)"
                    : actionMessage.type === "error"
                    ? "var(--color-error)"
                    : "var(--color-accent)",
                border: `1px solid ${
                  actionMessage.type === "success"
                    ? "rgba(16, 185, 129, 0.3)"
                    : actionMessage.type === "error"
                    ? "rgba(239, 68, 68, 0.3)"
                    : "rgba(14, 165, 233, 0.3)"
                }`,
              }}
            >
              {actionMessage.type === "success" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              <span>{actionMessage.text}</span>
            </div>
          )}

          {showInitialLoading ? (
            <div
              style={{
                flex: 1,
                minHeight: 320,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                padding: "40px 20px",
                textAlign: "center",
                color: "var(--color-text-2)",
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: "var(--color-accent-subtle)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--color-accent)",
                }}
              >
                <Loader2 size={21} className="animate-spin" />
              </div>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--color-text)" }}>
                  Reading cluster telemetry
                </div>
                <div style={{ fontSize: 11.5, marginTop: 4, maxWidth: 380 }}>
                  Checking available GPU, RPC, and CPU capacity before showing the allocation plan.
                </div>
              </div>
              <div
                style={{
                  width: 240,
                  height: 5,
                  borderRadius: 999,
                  overflow: "hidden",
                  background: "var(--color-surface-sunken)",
                }}
              >
                <div
                  style={{
                    width: "45%",
                    height: "100%",
                    borderRadius: 999,
                    background: "var(--color-accent)",
                    animation: "pulse 1.2s ease-in-out infinite",
                  }}
                />
              </div>
            </div>
          ) : !preview ? (
            <div
              style={{
                flex: 1,
                minHeight: 260,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                padding: "32px 20px",
                textAlign: "center",
              }}
            >
              <AlertTriangle size={22} style={{ color: "var(--color-warn)" }} />
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--color-text)" }}>
                Allocation plan unavailable
              </div>
              <div style={{ fontSize: 11.5, color: "var(--color-text-2)", maxWidth: 420 }}>
                The desktop supervisor did not return a device plan. Retry the preview, or restart the app if the issue persists.
              </div>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => void refreshConfig()}
                style={{ padding: "6px 14px", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}
              >
                <RefreshCw size={13} />
                <span>Retry preview</span>
              </button>
            </div>
          ) : (
            <>
          {/* Allocation Mode Selector & Global Headroom */}
          <div
            style={{
              padding: "14px 16px",
              background: "var(--color-surface-subtle)",
              borderRadius: "var(--radius)",
              border: "1px solid var(--color-border)",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
              <span className="section-label" style={{ fontWeight: 600 }}>Allocation Policy Mode</span>

              <div style={{ display: "flex", background: "var(--color-bg)", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)", padding: 2 }}>
                <button
                  type="button"
                  onClick={() => handleModeChange("automatic")}
                  style={{
                    padding: "4px 12px",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12,
                    fontWeight: 500,
                    border: "none",
                    cursor: "pointer",
                    background: config.mode === "automatic" ? "var(--color-accent)" : "transparent",
                    color: config.mode === "automatic" ? "var(--color-accent-fg)" : "var(--color-text-2)",
                    transition: "all var(--dur-fast)",
                  }}
                >
                  Automatic (Dynamic Split)
                </button>
                <button
                  type="button"
                  onClick={() => handleModeChange("manual")}
                  style={{
                    padding: "4px 12px",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12,
                    fontWeight: 500,
                    border: "none",
                    cursor: "pointer",
                    background: config.mode === "manual" ? "var(--color-accent)" : "transparent",
                    color: config.mode === "manual" ? "var(--color-accent-fg)" : "var(--color-text-2)",
                    transition: "all var(--dur-fast)",
                  }}
                >
                  Manual (Per-Device Budgets)
                </button>
              </div>
            </div>

            {/* Global Sliders: RAM Headroom & VRAM Headroom */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
              {/* RAM Headroom */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 4 }}>
                  <span style={{ color: "var(--color-text-2)" }}>Host RAM Safety Reserve:</span>
                  <span className="mono" style={{ fontWeight: 600, color: "var(--color-accent)" }}>{config.reserved_headroom_ram_mb} MB</span>
                </div>
                <input
                  type="range"
                  min="512"
                  max="4096"
                  step="256"
                  value={config.reserved_headroom_ram_mb}
                  onChange={(e) => handleRamHeadroomChange(Number(e.target.value))}
                  style={{ width: "100%", accentColor: "var(--color-accent)", height: 4, cursor: "pointer" }}
                />
                <div style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 3 }}>
                  Protected system memory for Windows OS processes.
                </div>
              </div>

              {/* VRAM Headroom */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 4 }}>
                  <span style={{ color: "var(--color-text-2)" }}>GPU VRAM Reserve:</span>
                  <span className="mono" style={{ fontWeight: 600, color: "var(--color-accent)" }}>{config.reserved_headroom_vram_mb} MB</span>
                </div>
                <input
                  type="range"
                  min="128"
                  max="1024"
                  step="64"
                  value={config.reserved_headroom_vram_mb}
                  onChange={(e) => handleVramHeadroomChange(Number(e.target.value))}
                  style={{ width: "100%", accentColor: "var(--color-accent)", height: 4, cursor: "pointer" }}
                />
                <div style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 3 }}>
                  Reserved for desktop display and DWM compositor.
                </div>
              </div>

              {/* Offloaded Layers Limit */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 4 }}>
                  <span style={{ color: "var(--color-text-2)" }}>Total Offloaded Layers:</span>
                  <span className="mono" style={{ fontWeight: 600, color: "var(--color-accent)" }}>
                    {config.total_offload_layers === -1 ? `All (${totalLayers})` : `${config.total_offload_layers} / ${totalLayers}`}
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max={totalLayers}
                  step="1"
                  value={config.total_offload_layers === -1 ? totalLayers : config.total_offload_layers}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    handleLayersChange(val === totalLayers ? -1 : val);
                  }}
                  style={{ width: "100%", accentColor: "var(--color-accent)", height: 4, cursor: "pointer" }}
                />
                <div style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 3 }}>
                  Remaining layers execute on Host CPU memory.
                </div>
              </div>
            </div>
          </div>

          {/* Layer Distribution Projection & Runtime Comparison */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="section-label" style={{ fontWeight: 600 }}>Compute Distribution</span>

                {/* 3-Way Mode Selector */}
                <div style={{ display: "flex", background: "var(--color-surface-subtle)", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)", padding: 2 }}>
                  <button
                    type="button"
                    onClick={() => setLayerViewMode("proposed")}
                    style={{
                      padding: "3px 10px",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 11,
                      fontWeight: 500,
                      border: "none",
                      cursor: "pointer",
                      background: layerViewMode === "proposed" ? "var(--color-surface-elevated)" : "transparent",
                      color: layerViewMode === "proposed" ? "var(--color-text)" : "var(--color-text-2)",
                    }}
                  >
                    Proposed Plan
                  </button>
                  <button
                    type="button"
                    onClick={() => setLayerViewMode("saved")}
                    style={{
                      padding: "3px 10px",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 11,
                      fontWeight: 500,
                      border: "none",
                      cursor: "pointer",
                      background: layerViewMode === "saved" ? "var(--color-accent-subtle)" : "transparent",
                      color: layerViewMode === "saved" ? "var(--color-accent)" : "var(--color-text-2)",
                    }}
                  >
                    Saved / Staged
                  </button>
                  <button
                    type="button"
                    onClick={() => setLayerViewMode("runtime")}
                    style={{
                      padding: "3px 10px",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 11,
                      fontWeight: 500,
                      border: "none",
                      cursor: "pointer",
                      background: layerViewMode === "runtime" ? "var(--color-ok-bg)" : "transparent",
                      color: layerViewMode === "runtime" ? "var(--color-ok)" : "var(--color-text-2)",
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <span>Confirmed Runtime</span>
                    {runtimePlacement?.is_running && <span className="dot dot-ok" style={{ width: 5, height: 5 }} />}
                  </button>
                </div>
              </div>

              {/* Status note */}
              <div className="mono" style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                {layerViewMode === "proposed"
                  ? `${preview?.planned_offload_layers ?? preview?.total_offload_layers ?? totalLayers} / ${totalLayers} offloaded`
                  : layerViewMode === "saved"
                  ? `${savedPreview?.planned_offload_layers ?? totalLayers} / ${totalLayers} staged`
                  : runtimePlacement?.is_running
                  ? "Live Native Placement"
                  : "Engine Inactive"}
              </div>
            </div>

            {/* Mode 1 & 2: Proposed or Saved Plan View */}
            {(layerViewMode === "proposed" || layerViewMode === "saved") && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {/* Visual Proportional Split Bar */}
                <div style={{ display: "flex", height: 28, background: "var(--color-surface-subtle)", borderRadius: "var(--radius-sm)", overflow: "hidden", border: "1px solid var(--color-border)" }}>
                  {(() => {
                    const activePlan = layerViewMode === "saved" ? savedPreview : preview;
                    const devices = activePlan?.device_plans || [];
                    const activeDevices = devices.filter((d) => d.enabled && (d.planned_layer_count > 0 || (d.split_weight_percent ?? 0) > 0));

                    if (activeDevices.length === 0) {
                      return (
                        <div style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--color-text-3)" }}>
                          100% Host CPU Memory
                        </div>
                      );
                    }

                    return activeDevices.map((dev) => {
                      const pct = dev.split_weight_percent || Math.round((dev.split_weight || 0) * 100);
                      const isCuda = dev.backend_type === "cuda" || dev.backend_type === "local_cuda";
                      const isRpc = dev.backend_type === "rpc";
                      const bg = isCuda ? "var(--color-cuda)" : isRpc ? "var(--color-rpc)" : "var(--color-accent)";

                      return (
                        <div
                          key={dev.device_id}
                          style={{
                            width: `${Math.max(5, pct)}%`,
                            background: bg,
                            color: "#fff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 10.5,
                            fontWeight: 600,
                            padding: "0 4px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={`${dev.device_name}: ${pct}% split weight (${dev.planned_layer_count} layers projected)`}
                        >
                          {dev.device_name} ({pct}%)
                        </div>
                      );
                    });
                  })()}
                </div>

                {/* Discrete Layer Projection Blocks */}
                <div style={{ display: "flex", height: 24, gap: 1, borderRadius: "var(--radius-sm)", overflow: "hidden", background: "var(--color-surface-subtle)", padding: 2, border: "1px solid var(--color-border)" }}>
                  {Array.from({ length: totalLayers }).map((_, idx) => {
                    const activePlan = layerViewMode === "saved" ? savedPreview : preview;
                    const devices = activePlan?.device_plans || [];
                    const assignedDev = devices.find((d) => {
                      const ranges = d.planned_layer_ranges || [];
                      return ranges.some(([start, end]: [number, number]) => idx >= start && idx <= end);
                    });

                    const isCuda = assignedDev?.backend_type === "cuda" || assignedDev?.backend_type === "local_cuda";
                    const isRpc = assignedDev?.backend_type === "rpc";
                    const bg = isCuda ? "var(--color-cuda)" : isRpc ? "var(--color-rpc)" : assignedDev ? "var(--color-accent)" : "var(--color-surface-elevated)";

                    return (
                      <div
                        key={idx}
                        style={{
                          flex: 1,
                          background: bg,
                          color: assignedDev ? "#fff" : "var(--color-text-3)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 9,
                          fontFamily: "var(--font-mono)",
                          fontWeight: 600,
                          cursor: "default",
                        }}
                        title={
                          assignedDev
                            ? `Layer ${idx}: ${assignedDev.device_name} (${assignedDev.backend_type.toUpperCase()}) — Projected`
                            : `Layer ${idx}: Host CPU Fallback`
                        }
                      >
                        {idx}
                      </div>
                    );
                  })}
                </div>

                {/* Legend */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, color: "var(--color-text-2)", paddingTop: 2 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--color-cuda)" }} />
                      <span>Host CUDA GPU</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--color-rpc)" }} />
                      <span>RPC Worker</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--color-surface-elevated)" }} />
                      <span>Host CPU Fallback</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowArchNotes(!showArchNotes)}
                    style={{ background: "transparent", border: "none", color: "var(--color-text-3)", display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11 }}
                  >
                    <Info size={12} />
                    <span>{showArchNotes ? "Hide Architecture Notes" : "Architecture & Calibration"}</span>
                  </button>
                </div>

                {/* Collapsible Architecture Notes */}
                {showArchNotes && (
                  <div
                    className="animate-fade-in"
                    style={{
                      padding: "10px 12px",
                      background: "var(--color-surface-subtle)",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--color-border)",
                      fontSize: 11.5,
                      color: "var(--color-text-2)",
                      lineHeight: 1.5,
                    }}
                  >
                    Llama.cpp splits model weights across devices using proportional split weights (<code className="mono" style={{ color: "var(--color-accent)" }}>model_params.tensor_split</code>). Discrete layer blocks above illustrate estimated placement boundaries based on ~{estimatedMbPerLayer} MiB/layer for the selected GGUF model and the configured device budgets.
                  </div>
                )}
              </div>
            )}

            {/* Mode 3: Confirmed Runtime Placement */}
            {layerViewMode === "runtime" && (
              <div
                style={{
                  minHeight: 110,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  padding: "16px",
                  background: "var(--color-surface-subtle)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-border)",
                  gap: 10,
                }}
              >
                {!runtimePlacement?.is_running ? (
                  <div style={{ textAlign: "center", color: "var(--color-text-2)" }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                      Native Inference Engine Stopped
                    </div>
                    <div style={{ fontSize: 11.5, marginTop: 4, maxWidth: 440, margin: "4px auto 0" }}>
                      Start or restart the coordinator to load the model across hardware backends and view confirmed live placement.
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {/* Visual Confirmed Runtime Split Bar */}
                    <div style={{ display: "flex", height: 28, borderRadius: "var(--radius-sm)", overflow: "hidden", border: "1px solid var(--color-border)" }}>
                      {(runtimePlacement?.backends || []).map((b: RuntimePlacementBackend) => {
                        const isCuda = b.backend_type === "cuda" || b.backend_type === "local_cuda";
                        const isRpc = b.backend_type === "rpc";
                        const bg = isCuda ? "var(--color-cuda)" : isRpc ? "var(--color-rpc)" : "var(--color-accent)";
                        
                        // Intelligent slice label based on layer counts and memory
                        let sliceLabel = b.device_name || b.backend_id;
                        if (isRpc) {
                          sliceLabel = b.assigned_layers.length > 0
                            ? `${b.device_name || "RPC"} (${b.assigned_layers.length}L)`
                            : `${b.device_name || "RPC"} (Remote)`;
                        } else if (b.model_buffer_bytes > 0) {
                          sliceLabel = b.assigned_layers.length > 0
                            ? `${b.device_name || "Device"} (${b.assigned_layers.length}L · ${formatBytes(b.model_buffer_bytes)})`
                            : `${b.device_name || "Device"} (${formatBytes(b.model_buffer_bytes)})`;
                        }

                        const tooltip = `${b.device_name || b.backend_id} (${b.backend_type.toUpperCase()}): ${
                          b.assigned_layers.length > 0
                            ? `${b.assigned_layers.length} layers assigned · `
                            : "Shared Overhead / Embeddings · "
                        }${b.model_buffer_bytes > 0 ? formatBytes(b.model_buffer_bytes) : "Remote Worker RAM"}`;

                        // Ensure narrow slices (like CPU overhead) have a minimum visible share and never overflow text
                        const weight = Math.max(0.08, b.split_weight || (b.assigned_layers.length > 0 ? b.assigned_layers.length / (totalLayers || 33) : 0.08));

                        return (
                          <div
                            key={b.backend_id || b.endpoint || Math.random().toString()}
                            style={{
                              flex: weight,
                              minWidth: 0,
                              background: bg,
                              color: "#fff",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 10.5,
                              fontWeight: 600,
                              padding: "0 6px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={tooltip}
                          >
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {sliceLabel}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Dedicated Backend Legend Breakdown */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
                      {(runtimePlacement?.backends || []).map((b: RuntimePlacementBackend) => {
                        const isCuda = b.backend_type === "cuda" || b.backend_type === "local_cuda";
                        const isRpc = b.backend_type === "rpc";
                        const bg = isCuda ? "var(--color-cuda)" : isRpc ? "var(--color-rpc)" : "var(--color-accent)";
                        const memStr = b.model_buffer_bytes > 0 ? formatBytes(b.model_buffer_bytes) : "Remote Worker RAM";
                        const layerStr = b.assigned_layers.length > 0 ? `${b.assigned_layers.length} layers` : "Shared Buffer";

                        return (
                          <div key={b.backend_id || b.endpoint || Math.random().toString()} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 2, background: bg, flexShrink: 0 }} />
                            <strong style={{ color: "var(--color-text)" }}>{b.device_name || b.backend_id}:</strong>
                            <span className="mono" style={{ color: "var(--color-text-2)" }}>{layerStr} ({memStr})</span>
                          </div>
                        );
                      })}
                    </div>

                    <div style={{ fontSize: 11, color: "var(--color-ok)", display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
                      <CheckCircle2 size={13} />
                      <span>Confirmed live hardware allocations via coordinator /backends IPC telemetry</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Participating Compute Devices Table */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span className="section-label" style={{ fontWeight: 600 }}>Participating Compute Devices</span>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(preview?.device_plans || []).map((dev) => {
                const setting = (config.device_settings || []).find((s) => s.device_id === dev.device_id);
                const isEnabled = setting ? setting.enabled : dev.enabled;
                const splitPct = dev.split_weight_percent ?? Math.round((dev.split_weight ?? 0) * 100);
                const isLocked = setting?.locked_split || false;
                const isOffline = dev.is_online === false;
                const isStale = dev.is_stale === true;

                return (
                  <div
                    key={dev.device_id}
                    style={{
                      padding: "12px 16px",
                      background: isEnabled ? "var(--color-surface-subtle)" : "var(--color-surface-sunken)",
                      border: `1px solid ${
                        isOffline && isEnabled ? "rgba(154, 103, 0, 0.32)" : "var(--color-border)"
                      }`,
                      borderRadius: "var(--radius-sm)",
                      opacity: isEnabled ? 1 : 0.6,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={(e) => handleDeviceToggle(dev.device_id, e.target.checked)}
                          title={
                            isOffline
                              ? "This device is offline or unreachable. Enabling it makes the plan invalid."
                              : `Include ${dev.device_name} in the allocation`
                          }
                          style={{ accentColor: "var(--color-accent)", cursor: "pointer" }}
                        />
                        <span style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                          {dev.device_name}
                        </span>
                        <span className="badge badge-idle" style={{ fontSize: 10 }}>
                          {dev.backend_type.toUpperCase()}
                        </span>
                        {dev.is_loopback && (
                          <span className="badge badge-warn" style={{ fontSize: 10 }}>
                            Shares Host RAM
                          </span>
                        )}
                        {isOffline && (
                          <span className="badge badge-offline" style={{ fontSize: 10 }}>
                            Offline
                          </span>
                        )}
                        {isStale && !isOffline && (
                          <span className="badge badge-warn" style={{ fontSize: 10 }}>
                            Stale telemetry
                          </span>
                        )}
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11.5 }}>
                        <span style={{ color: "var(--color-text-2)" }}>
                          Weight: <strong className="mono" style={{ color: "var(--color-accent)" }}>{splitPct}%</strong>
                        </span>
                        <span style={{ color: "var(--color-text-2)" }}>
                          Layers: <strong className="mono" style={{ color: "var(--color-text)" }}>{dev.planned_layer_count}</strong>
                        </span>
                        {config.mode === "manual" && (
                          <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", color: "var(--color-text-3)", fontSize: 11 }}>
                            <input
                              type="checkbox"
                              checked={isLocked}
                              onChange={(e) => handleDeviceLockToggle(dev.device_id, e.target.checked)}
                              style={{ accentColor: "var(--color-accent)" }}
                            />
                            <span>Lock split</span>
                          </label>
                        )}
                        {isOffline && isEnabled && (
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => handleDeviceToggle(dev.device_id, false)}
                            title={`Disable ${dev.device_name} so it no longer blocks this plan`}
                            style={{
                              padding: "3px 8px",
                              fontSize: 10.5,
                              color: "var(--color-warn)",
                              borderColor: "rgba(154, 103, 0, 0.3)",
                            }}
                          >
                            Disable
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Manual Mode Budget / Split Slider */}
                    {config.mode === "manual" && isEnabled && (
                      <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 4 }}>
                        <span style={{ fontSize: 11, color: "var(--color-text-3)", minWidth: 80 }}>Split Weight:</span>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="1"
                          value={splitPct}
                          disabled={isLocked}
                          onChange={(e) => handleDeviceSplitWeightChange(dev.device_id, Number(e.target.value))}
                          style={{ flex: 1, accentColor: "var(--color-accent)", height: 4, cursor: isLocked ? "not-allowed" : "pointer" }}
                        />
                        <span className="mono" style={{ fontSize: 11.5, minWidth: 40, textAlign: "right" }}>{splitPct}%</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Validation & Risk Assessment Banner */}
          <div
            style={{
              order: -1,
              padding: "10px 14px",
              borderRadius: "var(--radius-sm)",
              fontSize: 12,
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              background: preview.is_valid ? "var(--color-ok-bg)" : "var(--color-error-bg)",
              border: `1px solid ${preview.is_valid ? "rgba(30, 126, 89, 0.25)" : "rgba(185, 28, 28, 0.25)"}`,
              color: preview.is_valid ? "var(--color-ok)" : "var(--color-error)",
            }}
          >
            <ShieldCheck size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                <span>Safety Assessment: {preview.risk_level || "SAFE"}</span>
                {!preview.is_valid && (
                  <span className="badge badge-error" style={{ fontSize: 9.5 }}>
                    Action required
                  </span>
                )}
              </div>

              {preview.is_valid ? (
                <>
                  <div style={{ fontSize: 11.5, opacity: 0.9, marginTop: 2 }}>
                    {preview.planned_offload_layers ?? 0} / {preview.total_offload_layers ?? totalLayers} requested offload layers accommodated within hardware headroom margins.
                  </div>
                  {(preview.validation_warnings || []).length > 0 && (
                    <ul style={{ margin: "5px 0 0 16px", padding: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                      {(preview.validation_warnings || []).map((warning, idx) => (
                        <li key={`${idx}-${warning}`}>{warning}</li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <>
                  <ul style={{ margin: "5px 0 0 16px", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                    {(preview.validation_errors || []).length > 0 ? (
                      (preview.validation_errors || []).map((error, idx) => (
                        <li key={`${idx}-${error}`}>{error}</li>
                      ))
                    ) : (
                      <li>The current plan cannot be applied.</li>
                    )}
                  </ul>
                  <div style={{ fontSize: 11, opacity: 0.9, marginTop: 7 }}>
                    Resolve the issues above, or use online devices to recover a valid plan.
                  </div>
                  {canUseOnlineDevices && (
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={handleUseOnlineDevices}
                      style={{
                        marginTop: 8,
                        padding: "4px 10px",
                        fontSize: 11.5,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        borderColor: "var(--color-error)",
                        color: "var(--color-error)",
                        background: "var(--color-surface)",
                      }}
                      title="Enable online devices and disable offline devices"
                    >
                      <RefreshCw size={12} />
                      <span>Use online devices</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
            </>
          )}
        </div>

        {/* Modal Sticky Footer Actions */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 20px",
            borderTop: "1px solid var(--color-border)",
            background: "var(--color-surface-subtle)",
            flexShrink: 0,
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {hasBackup && (
              <button
                type="button"
                className="btn-ghost"
                onClick={handleRollback}
                disabled={applying || loading}
                style={{ padding: "6px 12px", fontSize: 12 }}
                title="Restore previous safe allocation backup"
              >
                Rollback to Backup
              </button>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              className="btn-ghost"
              onClick={onClose}
              disabled={applying}
              style={{ padding: "6px 14px", fontSize: 12 }}
            >
              Cancel
            </button>

            <button
              type="button"
              className="btn-ghost"
              onClick={handleSaveOnly}
              disabled={applying || loading || !preview?.is_valid}
              style={{ padding: "6px 14px", fontSize: 12, borderColor: "var(--color-accent)", color: "var(--color-accent)" }}
              title={
                !preview?.is_valid
                  ? "Resolve the validation errors before saving this plan."
                  : "Save to disk without restarting the coordinator"
              }
            >
              {applying ? "Saving…" : "Save Staged"}
            </button>

            <button
              type="button"
              className="btn-primary"
              onClick={handleApplyAndRestart}
              disabled={applying || loading || !preview?.is_valid}
              style={{ padding: "6px 16px", fontSize: 12 }}
              title={
                !preview?.is_valid
                  ? "Resolve the validation errors before applying this plan."
                  : isEngineRunning
                  ? "Save this plan and restart the running coordinator"
                  : "Save this plan; it will be used the next time the engine starts"
              }
            >
              {applying
                ? isEngineRunning
                  ? "Applying & Restarting…"
                  : "Applying…"
                : isEngineRunning
                ? "Apply & Restart Coordinator"
                : "Apply & Start Coordinator"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
