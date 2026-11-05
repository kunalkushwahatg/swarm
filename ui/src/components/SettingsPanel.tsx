import { useState, useEffect } from "react";
import { useSwarmSession } from "../hooks/useSwarmSession";
import { useSupervisor } from "../hooks/useSupervisor";
import { supervisor } from "../lib/supervisor";
import { StatusBadge } from "./ui/StatusBadge";
import { friendlyModelTitle } from "../lib/utils";
import { isAndroid } from "../lib/platform";
import {
  Settings,
  Terminal,
  Copy,
  Check,
  Info,
  Cpu,
  Network,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Activity,
  ShieldCheck,
} from "lucide-react";

export function SettingsPanel() {
  const session = useSwarmSession(3000);
  const sup = useSupervisor(3000);
  const [copiedModelPath, setCopiedModelPath] = useState(false);

  const [copiedScript, setCopiedScript] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showDevScripts, setShowDevScripts] = useState(false);
  const [diagData, setDiagData] = useState<any>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [selectedContext, setSelectedContext] = useState<number>(session.contextWindow || 2048);
  const [modelPathInput, setModelPathInput] = useState<string>(session.modelPath || "");
  const [stagedMessage, setStagedMessage] = useState<string | null>(null);

  useEffect(() => {
    if (session.modelPath) {
      setModelPathInput(session.modelPath);
    }
  }, [session.modelPath]);

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

  const handleContextChange = (newSize: number) => {
    setSelectedContext(newSize);
    setStagedMessage("Context size updated. Restart engine to load with the new context limit.");
  };

  const isHealthy =
    sup.engineStatus?.coord_healthy === true || session.raw.health?.model?.loaded === true;
  const friendlyName = friendlyModelTitle(session.modelPath || session.modelName);

  const scripts = [
    {
      id: "start",
      title: "Start Local Cluster",
      command: "powershell -ExecutionPolicy Bypass -File scripts\\Start-LocalDev.ps1",
      description: "Spawns a local GGML RPC worker on 127.0.0.1:50052 and coordinator on 127.0.0.1:8080.",
    },
    {
      id: "test",
      title: "Test Local Inference",
      command: "powershell -ExecutionPolicy Bypass -File scripts\\Test-LocalDevInference.ps1",
      description: "Dispatches verification prompt to the coordinator and validates end-to-end token generation over loopback RPC.",
    },
    {
      id: "stop",
      title: "Stop Local Cluster",
      command: "powershell -ExecutionPolicy Bypass -File scripts\\Stop-LocalDev.ps1",
      description: "Gracefully terminates coordinator and RPC worker processes and releases loopback ports 8080 and 50052.",
    },
  ];

  return (
    <div
      className="card animate-fade-in"
      style={{
        padding: "24px",
        display: "flex",
        flexDirection: "column",
        gap: 22,
        maxWidth: 1040,
        margin: "0 auto",
        width: "100%",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          paddingBottom: 14,
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: "var(--radius-sm)",
            background: "var(--color-accent-subtle)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-accent)",
          }}
        >
          <Settings size={18} />
        </div>
        <div>
          <h1 className="page-title" style={{ fontSize: 20 }}>
            Settings
          </h1>
          <div className="page-subtitle" style={{ marginTop: 2 }}>
            Model, network, and execution configuration
          </div>
        </div>
      </div>

      {stagedMessage && (
        <div
          style={{
            padding: "8px 12px",
            background: "var(--color-accent-subtle)",
            border: "1px solid rgba(14, 165, 233, 0.3)",
            borderRadius: "var(--radius-sm)",
            fontSize: 12,
            color: "var(--color-accent)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Info size={14} />
          <span>{stagedMessage}</span>
        </div>
      )}

      {/* Group 1: Model & Runtime Environment */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Cpu size={14} color="var(--color-accent)" />
          <span className="section-label" style={{ fontWeight: 600 }}>Model &amp; Context</span>
        </div>

        <div
          style={{
            padding: "16px 18px",
            background: "var(--color-surface-subtle)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--color-border)",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 14,
          }}
        >
          <div className="stat-row">
            <span style={{ fontSize: 12, color: "var(--color-text-2)" }}>Model Load Status</span>
            <StatusBadge
              variant={isHealthy ? "ok" : "idle"}
              label={isHealthy ? "Loaded & Active" : "Standby (Ready to load)"}
            />
          </div>

          <div className="stat-row">
            <span style={{ fontSize: 12, color: "var(--color-text-2)" }}>Context Window Size</span>
            <select
              value={selectedContext}
              onChange={(e) => handleContextChange(Number(e.target.value))}
              style={{
                padding: "3px 8px",
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--color-text)",
                fontSize: 11.5,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
              }}
            >
              <option value={512}>512 tokens (Low memory)</option>
              <option value={1024}>1,024 tokens</option>
              <option value={2048}>2,048 tokens (Standard)</option>
              <option value={4096}>4,096 tokens (Extended)</option>
              <option value={8192}>8,192 tokens (Large)</option>
            </select>
          </div>

          {/* Configured GGUF Model Path */}
          <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="section-label">Configured GGUF Model File</span>
              <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                {friendlyName}
              </span>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                value={modelPathInput}
                placeholder="Path to a GGUF model file"
                onChange={(e) => {
                  setModelPathInput(e.target.value);
                  setStagedMessage("Model path updated. Restart engine to load with this model.");
                }}
                className="mono"
                style={{
                  flex: 1,
                  fontSize: 11.5,
                  background: "var(--color-bg)",
                  padding: "7px 10px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                  outline: "none",
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (modelPathInput) {
                    navigator.clipboard?.writeText(modelPathInput);
                    setCopiedModelPath(true);
                    setTimeout(() => setCopiedModelPath(false), 2000);
                  }
                }}
                disabled={!modelPathInput}
                className="btn-ghost"
                style={{ padding: "7px 10px", fontSize: 11.5, display: "flex", alignItems: "center", gap: 5 }}
                title="Copy model file path to clipboard"
              >
                {copiedModelPath ? <Check size={13} style={{ color: "var(--color-ok)" }} /> : <Copy size={13} />}
                <span>{copiedModelPath ? "Copied" : "Copy"}</span>
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--color-text-3)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <span style={{ color: "var(--color-text-2)" }}>
                Active GGUF model for local inference.
              </span>
              <a
                href="#models"
                style={{ color: "var(--color-accent)", textDecoration: "none", cursor: "pointer", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <span>Browse Model Library</span>
                <span>→</span>
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Group 2: Runtime Execution Profiles */}
      {!isAndroid && sup.isDesktop && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Activity size={14} color="var(--color-accent)" />
            <span className="section-label" style={{ fontWeight: 600 }}>Execution Profiles</span>
          </div>

          <div
            style={{
              padding: "16px 18px",
              background: "var(--color-surface-subtle)",
              borderRadius: "var(--radius)",
              border: "1px solid var(--color-border)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
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
                      : "var(--color-surface)",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  transition: "all var(--dur-fast)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                    Distributed Cluster
                  </span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--color-accent)", fontWeight: 600 }}>
                    DEFAULT
                  </span>
                </div>
                <span style={{ fontSize: 11.5, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                  Splits model computation across local and network devices via RPC.
                </span>
                <div style={{ display: "flex", gap: 8, fontSize: 11, color: "var(--color-text-3)", marginTop: 4 }}>
                  <span>Multi-Device Pooling</span>
                  <span>·</span>
                  <span>Network Enabled</span>
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
                      : "var(--color-surface)",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  transition: "all var(--dur-fast)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                    Standalone GPU
                  </span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--color-warn)", fontWeight: 600 }}>
                    LOCAL ONLY
                  </span>
                </div>
                <span style={{ fontSize: 11.5, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                  Runs entirely on this machine's GPU for lowest latency and zero network overhead.
                </span>
                <div style={{ display: "flex", gap: 8, fontSize: 11, color: "var(--color-text-3)", marginTop: 4 }}>
                  <span>Direct GPU Acceleration</span>
                  <span>·</span>
                  <span>Zero Network Latency</span>
                </div>
              </div>
            </div>

            {sup.errorMessage && (
              <div
                style={{
                  padding: "8px 12px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--color-error-bg)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  color: "var(--color-error)",
                  fontSize: 11.5,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <AlertTriangle size={13} style={{ flexShrink: 0 }} />
                <span>{sup.errorMessage}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Group 3: Network Endpoints & Placement */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Network size={14} color="var(--color-accent)" />
          <span className="section-label" style={{ fontWeight: 600 }}>Network &amp; Endpoints</span>
        </div>

        <div
          style={{
            padding: "16px 18px",
            background: "var(--color-surface-subtle)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--color-border)",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 12,
          }}
        >
          <div className="stat-row">
            <span style={{ fontSize: 12, color: "var(--color-text-2)" }}>Placement Policy</span>
            <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--color-accent)" }}>
              {session.raw.backends?.placement_policy ?? "dynamic"}
            </span>
          </div>
          <div className="stat-row">
            <span style={{ fontSize: 12, color: "var(--color-text-2)" }}>Inference Gateway</span>
            <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
              http://127.0.0.1:8080
            </span>
          </div>
          <div className="stat-row">
            <span style={{ fontSize: 12, color: "var(--color-text-2)" }}>Worker RPC Socket</span>
            <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
              {isAndroid ? "0.0.0.0:50052 (LAN shared)" : "127.0.0.1:50052"}
            </span>
          </div>
          <div className="stat-row">
            <span style={{ fontSize: 12, color: "var(--color-text-2)" }}>Network Scope</span>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-ok)" }}>
              Private Local Network
            </span>
          </div>
        </div>
      </div>

      {/* Group 4: Local Development CLI Commands (Collapsible Accordion) */}
      {!isAndroid && sup.isDesktop && (
      <div
        style={{
          background: "var(--color-surface-subtle)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-sm)",
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          onClick={() => setShowDevScripts(!showDevScripts)}
          style={{
            width: "100%",
            padding: "12px 14px",
            background: "none",
            border: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Terminal size={14} color="var(--color-accent)" />
            <span style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
              Developer Tools &amp; Scripts
            </span>
          </div>
          <span style={{ fontSize: 11.5, color: "var(--color-text-3)", fontWeight: 500 }}>
            {showDevScripts ? "▲ Hide Scripts" : "▼ View Scripts"}
          </span>
        </button>

        {showDevScripts && (
          <div style={{ padding: "0 14px 14px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 11.5, color: "var(--color-text-3)", marginBottom: 4 }}>
              Standalone PowerShell automation scripts to supervise coordinator and worker processes directly from your terminal.
            </div>
            {scripts.map((script) => (
              <div
                key={script.id}
                style={{
                  padding: "12px 14px",
                  background: "var(--color-surface)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-border)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--color-text)" }}>
                    {script.title}
                  </span>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => copyToClipboard(script.command, script.id)}
                    style={{ padding: "2px 8px", fontSize: 11, height: 22, display: "flex", alignItems: "center", gap: 4 }}
                  >
                    {copiedScript === script.id ? <Check size={11} color="var(--color-ok)" /> : <Copy size={11} />}
                    <span>{copiedScript === script.id ? "Copied" : "Copy"}</span>
                  </button>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    background: "var(--color-bg)",
                    padding: "6px 8px",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--color-accent)",
                    overflowX: "auto",
                    whiteSpace: "nowrap",
                  }}
                >
                  {script.command}
                </div>
                <div style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                  {script.description}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {/* Diagnostics Accordion */}
      {!isAndroid && sup.isDesktop && (
        <div
          style={{
            background: "var(--color-surface-subtle)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            overflow: "hidden",
          }}
        >
          <button
            id="settings-diagnostics-btn"
            type="button"
            onClick={toggleDiagnostics}
            style={{
              width: "100%",
              padding: "12px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "transparent",
              border: "none",
              color: "var(--color-text)",
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ShieldCheck size={14} color="var(--color-accent)" />
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>System Diagnostics &amp; Win32 Fixture Inspection</span>
            </div>
            {showDiagnostics ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {showDiagnostics && (
            <div
              className="animate-fade-in"
              style={{
                padding: "12px 16px 16px",
                borderTop: "1px solid var(--color-border)",
                fontSize: 11.5,
              }}
            >
              {diagLoading ? (
                <div style={{ color: "var(--color-text-3)" }}>Fetching system diagnostics…</div>
              ) : diagData ? (
                <pre
                  className="mono"
                  style={{
                    background: "var(--color-bg)",
                    padding: "12px",
                    borderRadius: "var(--radius-sm)",
                    overflowX: "auto",
                    color: "var(--color-text-2)",
                    fontSize: 11,
                    maxHeight: 280,
                  }}
                >
                  {JSON.stringify(diagData, null, 2)}
                </pre>
              ) : (
                <div style={{ color: "var(--color-text-3)" }}>No diagnostics data returned.</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
