import { useState, useEffect, useRef } from "react";
import { useSwarmSession } from "../hooks/useSwarmSession";
import { useSupervisor } from "../hooks/useSupervisor";
import { modelsApi, type InstalledModel } from "../lib/modelsApi";
import { friendlyModelTitle } from "../lib/utils";
import { isAndroid } from "../lib/platform";
import { Play, Square, Loader2, AlertTriangle, ChevronDown, Check, HardDrive, ArrowRight } from "lucide-react";

interface TopBarProps {
  onSelectView?: (view: "chat" | "devices" | "models" | "session" | "worker" | "settings") => void;
}

export function TopBar({ onSelectView }: TopBarProps) {
  const session = useSwarmSession(3000);
  const sup = useSupervisor(3000);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [installedModels, setInstalledModels] = useState<InstalledModel[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Track configured model selected in Model Library
  const [configuredModel, setConfiguredModel] = useState<{
    name: string;
    path: string;
    contextLength?: number;
  } | null>(() => {
    const p = localStorage.getItem("swarm_active_model_path");
    const n = localStorage.getItem("swarm_active_model_name");
    const ctx = localStorage.getItem("swarm_active_model_ctx");
    return p && n ? { name: n, path: p, contextLength: ctx ? Number(ctx) : undefined } : null;
  });

  const syncModel = async () => {
    try {
      const lib = await modelsApi.getLibrary();
      setInstalledModels(lib.installed_models || []);
      const sel = lib.installed_models.find((m) => m.id === lib.selected_model_id);
      if (sel) {
        setConfiguredModel({
          name: sel.name,
          path: sel.path,
          contextLength: sel.gguf?.context_length,
        });
        localStorage.setItem("swarm_active_model_path", sel.path);
        localStorage.setItem("swarm_active_model_name", sel.name);
        if (sel.gguf?.context_length) {
          localStorage.setItem("swarm_active_model_ctx", String(sel.gguf.context_length));
        }
      }
    } catch {}
  };

  useEffect(() => {
    syncModel();

    const handleModelChange = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail) {
        const model = customEvent.detail;
        setConfiguredModel({
          name: model.name,
          path: model.path,
          contextLength: model.gguf?.context_length,
        });
        localStorage.setItem("swarm_active_model_path", model.path);
        localStorage.setItem("swarm_active_model_name", model.name);
        if (model.gguf?.context_length) {
          localStorage.setItem("swarm_active_model_ctx", String(model.gguf.context_length));
        }
      }
      syncModel();
    };

    const handleStorage = (e: StorageEvent) => {
      if (e.key?.startsWith("swarm_active_model")) {
        const p = localStorage.getItem("swarm_active_model_path");
        const n = localStorage.getItem("swarm_active_model_name");
        const ctx = localStorage.getItem("swarm_active_model_ctx");
        if (p && n) {
          setConfiguredModel({ name: n, path: p, contextLength: ctx ? Number(ctx) : undefined });
        }
      }
    };

    window.addEventListener("swarm-model-changed", handleModelChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("swarm-model-changed", handleModelChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    if (isDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isDropdownOpen]);

  const handleSelectDropdownModel = async (model: InstalledModel) => {
    try {
      setIsDropdownOpen(false);
      const isEngineActive = sup.engineStatus?.coord_healthy === true || session.state === "ready" || session.state === "generating";
      if (isEngineActive) {
        // Direct to models view and trigger the switch confirmation modal
        onSelectView?.("models");
        window.dispatchEvent(new CustomEvent("swarm-request-model-switch", { detail: model.id }));
        return;
      }
      // Instant switch in Standby mode
      await modelsApi.selectModel(model.id, false);
      setConfiguredModel({
        name: model.name,
        path: model.path,
        contextLength: model.gguf?.context_length,
      });
      localStorage.setItem("swarm_active_model_path", model.path);
      localStorage.setItem("swarm_active_model_name", model.name);
      if (model.gguf?.context_length) {
        localStorage.setItem("swarm_active_model_ctx", String(model.gguf.context_length));
      }
      window.dispatchEvent(new CustomEvent("swarm-model-changed", { detail: model }));
      syncModel();
    } catch (e) {
      console.error("Failed to select model from topbar dropdown:", e);
    }
  };

  // Authoritative state reconciliation
  const isHealthy = sup.engineStatus?.coord_healthy === true || session.state === "ready" || session.state === "generating";
  const isStarting = sup.isStarting;
  const isStopping = sup.isStopping;
  const isGenerating = session.state === "generating";
  const displayedProfile = isHealthy
    ? (sup.activeProfile ?? sup.selectedProfile)
    : sup.selectedProfile;

  let statusLabel = "Standby";
  let dotClass = "dot-idle";

  if (isStarting) {
    statusLabel = "Starting…";
    dotClass = "dot-busy";
  } else if (isStopping) {
    statusLabel = "Stopping…";
    dotClass = "dot-warn";
  } else if (isGenerating) {
    statusLabel = "Generating";
    dotClass = "dot-busy";
  } else if (isHealthy) {
    statusLabel = "Ready";
    dotClass = "dot-ok";
  } else if (session.state === "paused") {
    statusLabel = "Paused";
    dotClass = "dot-warn";
  }

  // When engine is active, display running session model; when in Standby, display configured selected model
  const effectiveModelPath = isHealthy
    ? (session.modelPath || configuredModel?.path || session.modelName)
    : (configuredModel?.path || session.modelPath || session.modelName);

  const friendlyName = friendlyModelTitle(effectiveModelPath);
  const effectiveCtx = isHealthy
    ? session.contextWindow
    : (configuredModel?.contextLength ?? session.contextWindow);

  return (
    <header className="session-bar-header">
      {/* Brand Mark: Three dots on a thread */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontWeight: 600,
          fontSize: 13.5,
          letterSpacing: "-0.01em",
          color: "var(--color-text)",
          marginRight: 4,
          userSelect: "none",
        }}
      >
        <span style={{ color: "var(--color-accent)", fontSize: 13, letterSpacing: "-1px" }}>●—●—●</span>
        <span>Swarm</span>
      </div>

      <div style={{ width: 1, height: 16, background: "var(--color-border)" }} />

      {/* Model Name & Context Window with Interactive Quick Switcher */}
      <div ref={dropdownRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <button
          id="topbar-model-switcher-btn"
          onClick={() => {
            syncModel();
            setIsDropdownOpen((prev) => !prev);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontWeight: 600,
            fontSize: 13,
            color: "var(--color-text)",
            background: isDropdownOpen ? "var(--color-surface-sunken)" : "none",
            border: "none",
            borderRadius: "var(--radius-sm)",
            padding: "2px 6px",
            cursor: "pointer",
            transition: "all 0.15s ease",
          }}
          className="hover:bg-surface-sunken transition-colors"
          title={`Active Model: ${friendlyName}\nContext: ${effectiveCtx.toLocaleString()} tokens\nClick to switch model`}
        >
          <span className="topbar-model-title" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {friendlyName}
          </span>
          <ChevronDown
            size={13}
            style={{
              color: "var(--color-text-3)",
              transform: isDropdownOpen ? "rotate(180deg)" : "none",
              transition: "transform 0.15s ease",
              flexShrink: 0,
            }}
          />
        </button>

        <span
          className="mono hide-on-mobile"
          style={{ fontSize: 11, color: "var(--color-text-2)", whiteSpace: "nowrap", marginLeft: 6 }}
        >
          {effectiveCtx.toLocaleString()} ctx
        </span>

        {/* Quick Model Switcher Dropdown Popover */}
        {isDropdownOpen && (
          <div
            className="topbar-model-popover"
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              left: 0,
              zIndex: 100,
              minWidth: "min(320px, calc(100vw - 20px))",
              maxWidth: "min(420px, calc(100vw - 20px))",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border-strong)",
              borderRadius: "var(--radius-md)",
              boxShadow: "0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)",
              padding: "6px",
              animation: "fadeIn 0.12s ease-out",
            }}
          >
            <div style={{ padding: "6px 10px 4px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-3)" }}>
              Installed Models
            </div>

            <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
              {installedModels.length === 0 ? (
                <div style={{ padding: "12px 10px", fontSize: 12, color: "var(--color-text-3)", textAlign: "center" }}>
                  No models installed yet
                </div>
              ) : (
                installedModels.map((m) => {
                  const isCurrent = (configuredModel?.path && m.path === configuredModel.path) || (m.name === friendlyName || m.path === effectiveModelPath);
                  const sizeGb = (m.size_bytes / (1024 * 1024 * 1024)).toFixed(1);
                  const sizeStr = Number(sizeGb) >= 1 ? `${sizeGb} GB` : `${Math.round(m.size_bytes / (1024 * 1024))} MB`;

                  return (
                    <button
                      key={m.id}
                      onClick={() => handleSelectDropdownModel(m)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px 10px",
                        borderRadius: "var(--radius-sm)",
                        border: isCurrent ? "1px solid var(--color-accent)" : "1px solid transparent",
                        background: isCurrent ? "var(--color-accent-subtle)" : "transparent",
                        cursor: "pointer",
                        textAlign: "left",
                        width: "100%",
                        gap: 8,
                        transition: "all 0.12s ease",
                      }}
                      className="hover:bg-surface-sunken"
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 12.5, fontWeight: isCurrent ? 600 : 500, color: isCurrent ? "var(--color-accent)" : "var(--color-text)" }} className="truncate">
                            {m.name}
                          </span>
                          {isCurrent && (
                            <span style={{ fontSize: 10, background: "var(--color-accent)", color: "white", padding: "1px 5px", borderRadius: 4, fontWeight: 600 }}>
                              Active
                            </span>
                          )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--color-text-3)", marginTop: 2 }} className="font-mono">
                          <span>{sizeStr}</span>
                          <span>•</span>
                          <span>{m.gguf?.context_length ? `${Math.round(m.gguf.context_length / 1024)}k ctx` : "Std ctx"}</span>
                          <span>•</span>
                          <span>{m.gguf?.quantization || "Quantized"}</span>
                        </div>
                      </div>

                      {isCurrent && <Check size={14} style={{ color: "var(--color-accent)", flexShrink: 0 }} />}
                    </button>
                  );
                })
              )}
            </div>

            <div style={{ marginTop: 4, paddingTop: 6, borderTop: "1px solid var(--color-border)" }}>
              <button
                onClick={() => {
                  setIsDropdownOpen(false);
                  onSelectView?.("models");
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "6px 10px",
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--color-accent)",
                  background: "transparent",
                  border: "none",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                }}
                className="hover:bg-surface-sunken"
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <HardDrive size={13} />
                  <span>Model Library & Downloader</span>
                </span>
                <ArrowRight size={12} style={{ color: "var(--color-text-3)" }} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Right Controls: Profile Badge, Engine Status, Start/Stop Toggle */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        {sup.isDesktop && displayedProfile && (
          <span
            className="mono hide-on-mobile"
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface-subtle)",
              border: "1px solid var(--color-border)",
              color: isHealthy ? "var(--color-accent)" : "var(--color-text-2)",
            }}
            title={`Runtime Profile: ${displayedProfile.display_name} (${isHealthy ? "Active" : "Selected for Next Launch"})`}
          >
            {displayedProfile.id === "default"
              ? "Cluster"
              : isAndroid
                ? "On-Device"
                : "CUDA Standalone"}
          </span>
        )}

        {/* Engine Lifecycle State Pill */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 8px",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-surface-subtle)",
            border: "1px solid var(--color-border)",
            fontSize: 12,
            fontWeight: 500,
            color: "var(--color-text)",
          }}
        >
          <span className={`dot ${dotClass}`} />
          <span>{statusLabel}</span>
        </div>

        {/* Authoritative Primary Start / Stop Engine Action */}
        {sup.isDesktop && (
          isHealthy ? (
            <button
              id="topbar-stop-engine-btn"
              type="button"
              className="btn-ghost hide-on-mobile"
              onClick={sup.stopEngine}
              disabled={isStopping}
              style={{
                padding: "3px 10px",
                fontSize: 11.5,
                height: 26,
                borderRadius: "var(--radius-sm)",
                color: "var(--color-error)",
                border: "1px solid rgba(185, 28, 28, 0.25)",
                background: "var(--color-surface)",
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}
              title="Stop native engine processes"
            >
              {isStopping ? <Loader2 size={12} className="animate-spin" /> : <Square size={11} fill="currentColor" />}
              <span>{isStopping ? "Stopping…" : "Stop Engine"}</span>
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {sup.errorMessage && (
                <span
                  title={sup.errorMessage}
                  onClick={() => onSelectView?.("chat")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 11,
                    color: "#DC2626",
                    background: "#FEF2F2",
                    border: "1px solid #FCA5A5",
                    padding: "2px 8px",
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                    maxWidth: 160,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <AlertTriangle size={12} style={{ flexShrink: 0 }} />
                  <span>Notice</span>
                </span>
              )}
              <button
                id="topbar-start-engine-btn"
                type="button"
                className="btn-primary hide-on-mobile"
                onClick={() => sup.startEngine(true)}
                disabled={isStarting}
                style={{
                  padding: "3px 10px",
                  fontSize: 11.5,
                  height: 26,
                  borderRadius: "var(--radius-sm)",
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
                title={`Start native engine (${
                  sup.selectedProfileId === "low_memory_cuda_standalone"
                    ? isAndroid
                      ? "On-Device"
                      : "Standalone CUDA"
                    : "Cluster"
                })`}
              >
                {isStarting ? <Loader2 size={12} className="animate-spin" /> : <Play size={11} fill="currentColor" />}
                <span>{isStarting ? "Starting…" : "Start Engine"}</span>
              </button>
            </div>
          )
        )}

        {/* Devices Summary Button */}
        <button
          className="btn-ghost topbar-device-chip hide-on-mobile"
          onClick={() => onSelectView?.("devices")}
          style={{
            padding: "3px 9px",
            fontSize: 11.5,
            minHeight: "unset",
            height: 26,
            borderRadius: "var(--radius-sm)",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
          title="Click to view cluster device topology and allocation"
        >
          <span>{session.topBarDeviceLabel}</span>
        </button>
      </div>
    </header>
  );
}

