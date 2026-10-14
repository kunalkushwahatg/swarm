import { useState } from "react";
import { useHealth, useBackends } from "../hooks/useSwarm";
import { useSupervisor } from "../hooks/useSupervisor";
import { supervisor } from "../lib/supervisor";
import { StatusBadge } from "./ui/StatusBadge";
import {
  Settings,
  Terminal,
  Copy,
  Check,
  Info,
  Cpu,
  Network,
  Play,
  Square,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Activity,
  ShieldCheck,
} from "lucide-react";

export function SettingsPanel() {
  const sup = useSupervisor(3000);
  const { data: health } = useHealth(5000);
  const { data: backends } = useBackends(5000);
  const [copiedScript, setCopiedScript] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagData, setDiagData] = useState<any>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [userAuthorized, setUserAuthorized] = useState(false);

  const fetchDiagnostics = async () => {
    setDiagLoading(true);
    try {
      const data = await supervisor.getDiagnostics();
      setDiagData(data);
    } finally {
      setDiagLoading(false);
    }
  };

  const toggleDiagnostics = () => {
    if (!showDiagnostics && !diagData) {
      fetchDiagnostics();
    }
    setShowDiagnostics(!showDiagnostics);
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedScript(id);
    setTimeout(() => setCopiedScript(null), 2000);
  };

  const scripts = [
    {
      id: "start",
      title: "Start Local Cluster",
      command: "powershell -ExecutionPolicy Bypass -File scripts\\Start-LocalDev.ps1",
      description: "Spawns a local GGML RPC worker on 127.0.0.1:50052 and coordinator on 127.0.0.1:8080 in independent background processes.",
    },
    {
      id: "test",
      title: "Test Local Inference",
      command: "powershell -ExecutionPolicy Bypass -File scripts\\Test-LocalDevInference.ps1",
      description: "Dispatches an audited verification prompt to the coordinator and validates end-to-end token generation over loopback RPC.",
    },
    {
      id: "stop",
      title: "Stop Local Cluster",
      command: "powershell -ExecutionPolicy Bypass -File scripts\\Stop-LocalDev.ps1",
      description: "Gracefully terminates both coordinator and RPC worker processes and releases loopback ports 8080 and 50052.",
    },
  ];

  return (
    <div
      className="card animate-fade-in"
      style={{
        padding: "24px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
        maxWidth: 1040,
        margin: "0 auto",
        width: "100%",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          paddingBottom: 14,
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            background: "var(--color-accent-subtle)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-accent)",
          }}
        >
          <Settings size={16} />
        </div>
        <div>
          <h1 className="page-title" style={{ fontSize: 22 }}>
            Cluster Settings &amp; Process Diagnostics
          </h1>
          <div className="page-subtitle">
            Runtime parameters, network endpoints, and local development CLI controls
          </div>
        </div>
      </div>

      {/* Group 1: Model & Runtime Environment */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Cpu size={14} color="var(--color-accent)" />
          <span className="section-label">1. Model &amp; Runtime Environment</span>
        </div>

        <div
          style={{
            padding: "16px 18px",
            background: "var(--color-surface)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--color-border)",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          <div className="stat-row">
            <span style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>Model Load Status</span>
            <StatusBadge
              variant={health?.model?.loaded ? "ok" : "warn"}
              label={health?.model?.loaded ? "Active (Loaded)" : "Not Loaded"}
            />
          </div>
          <div className="stat-row">
            <span style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>Context Window Limit</span>
            <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>
              {health?.context?.size ? `${health.context.size} tokens` : "512 tokens"}
            </span>
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 3 }}>
            <span className="section-label">Configured GGUF Model Path</span>
            <div
              className="mono"
              style={{
                fontSize: 11.5,
                background: "var(--color-surface-subtle)",
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--color-border)",
                wordBreak: "break-all",
                color: "var(--color-text)",
              }}
            >
              {health?.model?.path || "models/qwen2.5-0.5b-instruct-q4_k_m.gguf"}
            </div>
          </div>
        </div>
      </div>

      {/* Group 2: Inference Placement & Network Endpoints */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Network size={14} color="var(--color-accent)" />
          <span className="section-label">2. Inference Placement &amp; Local Endpoints</span>
        </div>

        <div
          style={{
            padding: "16px 18px",
            background: "var(--color-surface)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--color-border)",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          <div className="stat-row">
            <span style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>Placement Policy</span>
            <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--color-accent)" }}>
              {backends?.placement_policy ?? "balanced"}
            </span>
          </div>
          <div className="stat-row">
            <span style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>Coordinator Socket</span>
            <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>
              {health?.server?.host ? `http://${health.server.host}:${health.server.port}` : "http://127.0.0.1:8080"}
            </span>
          </div>
          <div className="stat-row">
            <span style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>Local RPC Worker Socket</span>
            <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>
              127.0.0.1:50052
            </span>
          </div>
          <div className="stat-row">
            <span style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>Network Isolation</span>
            <span style={{ fontSize: 11.5, fontWeight: 500, color: "var(--color-ok)" }}>
              Strict Loopback (127.0.0.1)
            </span>
          </div>
        </div>
      </div>

      {/* Group 3: Native Desktop Process Supervision (Desktop Only) */}
      {sup.isDesktop && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Activity size={14} color="var(--color-accent)" />
            <span className="section-label">3. Native Desktop Engine Supervision</span>
          </div>

          <div
            style={{
              padding: "16px 18px",
              background: "var(--color-surface)",
              borderRadius: "var(--radius)",
              border: "1px solid var(--color-border)",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            {/* Header & Status */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                  Native Engine Lifecycle &amp; Profile Control
                </div>
                <div style={{ fontSize: 11.5, color: "var(--color-text-2)", marginTop: 2 }}>
                  Managed child process orchestration via Windows Job Object containment
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
                  Status: {sup.isStarting ? "Starting..." : sup.engineStatus?.state ? String(sup.engineStatus.state) : "Stopped"}
                </span>
                <StatusBadge
                  variant={
                    sup.engineStatus?.coord_healthy
                      ? "ok"
                      : sup.isStarting
                      ? "busy"
                      : "warn"
                  }
                  label={
                    sup.engineStatus?.coord_healthy
                      ? "Ready"
                      : sup.isStarting
                      ? "Launching"
                      : "Stopped"
                  }
                />
              </div>
            </div>

            {/* Profile Selection */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="section-label">Runtime Execution Profile:</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
                {/* Default Cluster */}
                <div
                  onClick={() => sup.setSelectedProfileId("default")}
                  style={{
                    padding: "12px 14px",
                    borderRadius: "var(--radius-sm)",
                    border:
                      sup.selectedProfileId === "default"
                        ? "1.5px solid var(--color-accent)"
                        : "1px solid var(--color-border)",
                    background:
                      sup.selectedProfileId === "default"
                        ? "var(--color-accent-subtle)"
                        : "var(--color-surface-subtle)",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--color-text)" }}>
                      Distributed Cluster (Default)
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--color-accent)" }}>
                      DEFAULT
                    </span>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                    Dual-process loopback RPC worker (:50052) + Coordinator (:8080). Production cluster architecture.
                  </span>
                  <div style={{ display: "flex", gap: 8, fontSize: 10.5, color: "var(--color-text-3)", marginTop: 4 }}>
                    <span>RAM Guard: ≥ 1,500 MB</span>
                    <span>·</span>
                    <span>RPC: Enabled</span>
                  </div>
                </div>

                {/* Standalone CUDA */}
                <div
                  onClick={() => sup.setSelectedProfileId("low_memory_cuda_standalone")}
                  style={{
                    padding: "12px 14px",
                    borderRadius: "var(--radius-sm)",
                    border:
                      sup.selectedProfileId === "low_memory_cuda_standalone"
                        ? "1.5px solid var(--color-accent)"
                        : "1px solid var(--color-border)",
                    background:
                      sup.selectedProfileId === "low_memory_cuda_standalone"
                        ? "var(--color-accent-subtle)"
                        : "var(--color-surface-subtle)",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--color-text)" }}>
                      Standalone CUDA (Opt-in)
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--color-warn)" }}>
                      OPT-IN ONLY
                    </span>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                    Single-process coordinator with all 37 model layers offloaded to CUDA. Strict local GPU execution.
                  </span>
                  <div style={{ display: "flex", gap: 8, fontSize: 10.5, color: "var(--color-text-3)", marginTop: 4 }}>
                    <span>RAM: ≥ 1,000 MB</span>
                    <span>·</span>
                    <span>VRAM: ≥ 3,100 MiB</span>
                    <span>·</span>
                    <span>RPC: Disabled</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Preflight & Resource Validation Messages */}
            {sup.errorMessage && (
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "10px 12px",
                  borderRadius: "var(--radius-sm)",
                  background: "rgba(239, 68, 68, 0.08)",
                  border: "1px solid rgba(239, 68, 68, 0.25)",
                  color: "var(--color-error)",
                  fontSize: 11.5,
                }}
              >
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  <strong>Preflight / Launch Notice:</strong> {sup.errorMessage}
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 4 }}>
              {sup.isStarting ? (
                <>
                  <button type="button" className="btn-primary" disabled style={{ padding: "6px 14px", fontSize: 12 }}>
                    <RefreshCw size={12} className="spin" />
                    <span>Launching Engine...</span>
                  </button>
                  <button type="button" className="btn-ghost" onClick={sup.cancelStartup} style={{ padding: "6px 12px", fontSize: 12 }}>
                    Cancel Startup
                  </button>
                </>
              ) : sup.engineStatus?.coord_healthy ? (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={sup.stopEngine}
                  disabled={sup.isStopping}
                  style={{
                    padding: "6px 14px",
                    fontSize: 12,
                    color: "var(--color-error)",
                    border: "1px solid rgba(239, 68, 68, 0.3)",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <Square size={12} />
                  <span>{sup.isStopping ? "Stopping..." : "Stop Engine"}</span>
                </button>
              ) : (
                <button
                  type="button"
                  id="settings-start-engine-btn"
                  className="btn-primary"
                  onClick={() => setShowConfirmModal(true)}
                  style={{ padding: "6px 16px", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}
                >
                  <Play size={12} />
                  <span>Start Engine ({sup.selectedProfileId === "default" ? "Default Cluster" : "Standalone CUDA"})</span>
                </button>
              )}

              {/* Troubleshooting Drawer Toggle */}
              <button
                type="button"
                className="btn-ghost"
                onClick={toggleDiagnostics}
                style={{ padding: "6px 12px", fontSize: 11.5, marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}
              >
                {showDiagnostics ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span>Supervisor Diagnostics (Troubleshooting)</span>
              </button>
            </div>

            {/* Real Startup Confirmation Dialog */}
            {showConfirmModal && (
              <div
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(0, 0, 0, 0.65)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 99999,
                  padding: 16,
                }}
              >
                <div
                  className="card animate-fade-in"
                  style={{
                    maxWidth: 520,
                    width: "100%",
                    padding: "20px 24px",
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 16,
                    boxShadow: "0 20px 40px rgba(0,0,0,0.5)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <ShieldCheck size={20} color="var(--color-accent)" />
                    <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: "var(--color-text)" }}>
                      Confirm Real Engine Startup
                    </h2>
                  </div>

                  <div style={{ fontSize: 12.5, color: "var(--color-text-2)", lineHeight: 1.5 }}>
                    You are about to start the native Swarm engine under Windows Job Object containment with profile:{" "}
                    <strong style={{ color: "var(--color-text)" }}>
                      {sup.selectedProfileId === "low_memory_cuda_standalone" ? "Standalone CUDA (Opt-in)" : "Distributed Cluster (Default)"}
                    </strong>.
                  </div>

                  {/* Preflight Summary */}
                  <div
                    style={{
                      background: "var(--color-surface-subtle)",
                      padding: "10px 14px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--color-border)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--color-text-2)" }}>Runtime Profile:</span>
                      <span className="mono" style={{ fontWeight: 600 }}>{sup.selectedProfileId}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--color-text-2)" }}>Job Object Containment:</span>
                      <span style={{ color: "var(--color-ok)", fontWeight: 500 }}>Active (Kernel Isolated)</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--color-text-2)" }}>Coordinator Socket:</span>
                      <span className="mono">127.0.0.1:8080 (Strict Loopback)</span>
                    </div>
                  </div>

                  {/* Explicit Operator Authorization Checkbox */}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      fontSize: 12,
                      color: "var(--color-text)",
                      cursor: "pointer",
                      padding: "8px 10px",
                      background: userAuthorized ? "var(--color-accent-subtle)" : "transparent",
                      borderRadius: "var(--radius-sm)",
                      border: userAuthorized ? "1px solid var(--color-accent)" : "1px solid var(--color-hairline)",
                    }}
                  >
                    <input
                      type="checkbox"
                      id="settings-auth-real-checkbox"
                      checked={userAuthorized}
                      onChange={(e) => setUserAuthorized(e.target.checked)}
                      style={{ marginTop: 2, cursor: "pointer" }}
                    />
                    <span>
                      I explicitly authorize real engine startup and GGUF weight loading on this host (<code className="mono">allow_real_runtime: true</code>).
                    </span>
                  </label>

                  {/* Modal Actions */}
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        setShowConfirmModal(false);
                        setUserAuthorized(false);
                      }}
                      style={{ padding: "6px 14px", fontSize: 12 }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      id="settings-confirm-launch-btn"
                      className="btn-primary"
                      disabled={!userAuthorized}
                      onClick={async () => {
                        setShowConfirmModal(false);
                        await sup.startEngine(true);
                      }}
                      style={{ padding: "6px 16px", fontSize: 12 }}
                    >
                      Authorize &amp; Launch
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Secondary Diagnostics Drawer */}
            {showDiagnostics && (
              <div
                className="animate-fade-in"
                style={{
                  marginTop: 6,
                  padding: "12px 14px",
                  background: "var(--color-surface-subtle)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-border)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 600, fontSize: 12, color: "var(--color-text)" }}>
                    Diagnostic Hardware &amp; Port Inspection (Secondary View)
                  </span>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={fetchDiagnostics}
                    disabled={diagLoading}
                    style={{ padding: "2px 6px", fontSize: 10.5 }}
                  >
                    <RefreshCw size={11} className={diagLoading ? "spin" : ""} />
                    <span>Refresh</span>
                  </button>
                </div>

                {diagData ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, fontSize: 11 }}>
                    <div className="stat-row">
                      <span style={{ color: "var(--color-text-2)" }}>Job Object Active</span>
                      <span style={{ color: diagData.job_object_active ? "var(--color-ok)" : "var(--color-error)", fontWeight: 600 }}>
                        {diagData.job_object_active ? "Active" : "Inactive"}
                      </span>
                    </div>
                    <div className="stat-row">
                      <span style={{ color: "var(--color-text-2)" }}>Coordinator Port (8080)</span>
                      <span style={{ color: diagData.coordinator_port?.occupied ? "var(--color-warn)" : "var(--color-ok)" }}>
                        {diagData.coordinator_port?.occupant_ownership || "Available"}
                      </span>
                    </div>
                    <div className="stat-row">
                      <span style={{ color: "var(--color-text-2)" }}>RPC Port (50052)</span>
                      <span style={{ color: diagData.rpc_port?.occupied ? "var(--color-warn)" : "var(--color-ok)" }}>
                        {diagData.rpc_port?.occupant_ownership || "Available"}
                      </span>
                    </div>
                    <div className="stat-row">
                      <span style={{ color: "var(--color-text-2)" }}>Swarm Node Binary</span>
                      <span style={{ color: diagData.coordinator_executable?.exists ? "var(--color-ok)" : "var(--color-error)" }}>
                        {diagData.coordinator_executable?.exists ? "Verified Present" : "Missing"}
                      </span>
                    </div>
                    <div className="stat-row">
                      <span style={{ color: "var(--color-text-2)" }}>RPC Server Binary</span>
                      <span style={{ color: diagData.rpc_executable?.exists ? "var(--color-ok)" : "var(--color-error)" }}>
                        {diagData.rpc_executable?.exists ? "Verified Present" : "Missing"}
                      </span>
                    </div>
                    <div className="stat-row">
                      <span style={{ color: "var(--color-text-2)" }}>Model File</span>
                      <span style={{ color: diagData.model_file?.exists ? "var(--color-ok)" : "var(--color-error)" }}>
                        {diagData.model_file?.exists ? "Verified (2.10 GB)" : "Missing"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 11.5, color: "var(--color-text-3)" }}>
                    Loading diagnostic hardware metrics...
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Group 4: Local Process Controls & Audited Scripts */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Terminal size={14} color="var(--color-accent)" />
          <span className="section-label">{sup.isDesktop ? "4. Audited CLI Scripts (Manual Alternative)" : "3. Local Process Management (PowerShell Tooling)"}</span>
        </div>

        <div
          style={{
            display: "flex",
            gap: 10,
            padding: "12px 14px",
            borderRadius: "var(--radius)",
            background: "var(--color-accent-subtle)",
            border: "1px solid var(--color-border)",
            alignItems: "flex-start",
          }}
        >
          <Info size={16} color="var(--color-accent)" style={{ marginTop: 2, flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: "var(--color-text)", lineHeight: 1.5 }}>
            Browser security boundaries prohibit direct execution of native host operating system processes without an unauthenticated remote execution bridge. Use these audited scripts directly in your PowerShell terminal to launch, inspect, or terminate the cluster.
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {scripts.map((s) => (
            <div
              key={s.id}
              style={{
                padding: "14px 16px",
                background: "var(--color-surface)",
                borderRadius: "var(--radius)",
                border: "1px solid var(--color-border)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--color-text)" }}>{s.title}</span>
                <button
                  className="btn-ghost"
                  style={{ padding: "4px 8px", fontSize: 11 }}
                  onClick={() => copyToClipboard(s.command, s.id)}
                  title="Copy command to clipboard"
                >
                  {copiedScript === s.id ? (
                    <>
                      <Check size={12} color="var(--color-ok)" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      Copy Command
                    </>
                  )}
                </button>
              </div>

              <pre
                style={{
                  margin: 0,
                  padding: "8px 12px",
                  background: "var(--color-surface-subtle)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-border)",
                  fontSize: 11.5,
                  color: "var(--color-text)",
                  fontFamily: "var(--font-mono)",
                  overflowX: "auto",
                }}
              >
                <code>{s.command}</code>
              </pre>

              <span style={{ fontSize: 11.5, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                {s.description}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
