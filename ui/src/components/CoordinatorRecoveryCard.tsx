import { useState, useEffect } from "react";
import type { SwarmSession } from "../hooks/useSwarmSession";
import { useSupervisor } from "../hooks/useSupervisor";
import { RefreshCw, Copy, Check, Play, AlertTriangle, Cpu, ShieldCheck } from "lucide-react";

interface CoordinatorRecoveryCardProps {
  session: SwarmSession;
}

export function CoordinatorRecoveryCard({ session }: CoordinatorRecoveryCardProps) {
  const sup = useSupervisor(3000);
  const [countdown, setCountdown] = useState(5);
  const [isRetrying, setIsRetrying] = useState(false);
  const [copiedMode, setCopiedMode] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"local" | "prod">("local");
  const [showManualCli, setShowManualCli] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [userAuthorized, setUserAuthorized] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Ticking timer for outage duration and countdown
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
      setCountdown((prev) => {
        if (prev <= 1) {
          // Trigger automatic retry
          session.retryNow();
          return 5;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [session]);

  const handleManualRetry = async () => {
    setIsRetrying(true);
    try {
      await session.retryNow();
    } finally {
      setIsRetrying(false);
      setCountdown(5);
    }
  };

  const handleCopy = (text: string, mode: string) => {
    navigator.clipboard.writeText(text);
    setCopiedMode(mode);
    setTimeout(() => setCopiedMode(null), 2000);
  };

  // Outage duration calculation
  const outageDurationSec = session.offlineSince
    ? Math.max(1, Math.round((nowMs - session.offlineSince) / 1000))
    : 0;

  const lastHealthyStr = session.lastHealthyTime
    ? new Date(session.lastHealthyTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  const localDevCmd = "powershell -ExecutionPolicy Bypass -File .\\scripts\\Start-LocalDev.ps1";
  const loopbackHelperCmd = "powershell -ExecutionPolicy Bypass -File .\\scripts\\Start-LoopbackRpc.ps1";
  const prodCmd = "powershell -ExecutionPolicy Bypass -File .\\scripts\\Start-ProductionCoordinator.ps1 -TokenFile \"$env:ProgramData\\Swarm\\secrets\\telemetry.token\" -RpcEndpoints \"<HELPER_VPN_IP>:50052\"";

  return (
    <div
      className="animate-fade-in card"
      style={{
        padding: "18px 20px",
        borderRadius: "var(--radius)",
        background: "var(--color-surface-sunken)",
        border: "1px solid var(--color-hairline)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        marginTop: 8,
      }}
    >
      {/* Calm Status Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="dot dot-error" style={{ width: 10, height: 10 }} />
          <div>
            <h2 className="panel-title" style={{ fontSize: 14, margin: 0 }}>
              Coordinator Offline — Reconnection in Progress
            </h2>
            <div style={{ fontSize: 12, color: "var(--color-text-2)", marginTop: 2 }}>
              The interface cannot reach the Swarm coordinator at <code className="mono">127.0.0.1:8080</code>.
            </div>
          </div>
        </div>

        {/* Retry & Countdown Widget */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--color-text-3)" }}>
            Next check in {countdown}s
          </span>
          <button
            type="button"
            className="btn-ghost"
            onClick={handleManualRetry}
            disabled={isRetrying}
            style={{
              padding: "4px 10px",
              fontSize: 12,
              height: 28,
              border: "1px solid var(--color-border)",
            }}
          >
            <RefreshCw size={12} className={isRetrying ? "spin" : ""} />
            <span>{isRetrying ? "Checking…" : "Retry Now"}</span>
          </button>
        </div>
      </div>

      {/* Outage Context & Draft Preservation Assurance */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 10,
          background: "var(--color-bg)",
          padding: "10px 14px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--color-hairline)",
          fontSize: 12,
        }}
      >
        <div>
          <span style={{ color: "var(--color-text-3)", display: "block", fontSize: 11 }}>Outage Status</span>
          <span style={{ color: "var(--color-text)", fontWeight: 500 }}>
            {outageDurationSec > 0 ? `${outageDurationSec}s elapsed` : "Offline"}
            {lastHealthyStr ? ` · Last healthy ${lastHealthyStr}` : ""}
          </span>
        </div>

        <div>
          <span style={{ color: "var(--color-text-3)", display: "block", fontSize: 11 }}>Consecutive Failures</span>
          <span className="mono" style={{ color: "var(--color-text)", fontWeight: 500 }}>
            {session.consecutiveFailures} checks failed
          </span>
        </div>

        <div>
          <span style={{ color: "var(--color-text-3)", display: "block", fontSize: 11 }}>Last Known Model</span>
          <span style={{ color: "var(--color-text)", fontWeight: 500 }} title={session.lastKnownModelPath}>
            {session.lastKnownModelName} ({session.lastKnownLayers} layers)
          </span>
        </div>

        <div>
          <span style={{ color: "var(--color-text-3)", display: "block", fontSize: 11 }}>Prompt Composer Draft</span>
          <span style={{ color: "var(--color-ok)", fontWeight: 500 }}>
            Draft safely preserved below
          </span>
        </div>
      </div>

      {/* Desktop Native Supervisor Engine Launcher */}
      {sup.isDesktop && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            padding: "14px 16px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Cpu size={15} color="var(--color-accent)" />
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text)" }}>
                Native Engine Launcher (Desktop)
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>Engine Status:</span>
              <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--color-accent)" }}>
                {sup.isStarting ? "Starting..." : sup.engineStatus?.state ? String(sup.engineStatus.state) : "Stopped"}
              </span>
            </div>
          </div>

          {/* Profile Selector */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>Runtime Profile:</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
              <button
                type="button"
                id="profile-default-cluster"
                className={sup.selectedProfileId === "default" ? "btn-primary" : "btn-ghost"}
                onClick={() => sup.setSelectedProfileId("default")}
                style={{
                  padding: "8px 12px",
                  fontSize: 12,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 2,
                  height: "auto",
                  border: sup.selectedProfileId === "default" ? "1px solid var(--color-accent)" : "1px solid var(--color-border)",
                  textAlign: "left",
                }}
              >
                <span style={{ fontWeight: 600 }}>Distributed Cluster (Default)</span>
                <span style={{ fontSize: 10.5, opacity: 0.85 }}>RPC worker :50052 + Coordinator :8080 (1.5 GB RAM)</span>
              </button>
              <button
                type="button"
                id="profile-standalone-cuda"
                className={sup.selectedProfileId === "low_memory_cuda_standalone" ? "btn-primary" : "btn-ghost"}
                onClick={() => sup.setSelectedProfileId("low_memory_cuda_standalone")}
                style={{
                  padding: "8px 12px",
                  fontSize: 12,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 2,
                  height: "auto",
                  border: sup.selectedProfileId === "low_memory_cuda_standalone" ? "1px solid var(--color-accent)" : "1px solid var(--color-border)",
                  textAlign: "left",
                }}
              >
                <span style={{ fontWeight: 600 }}>Standalone CUDA (Opt-in)</span>
                <span style={{ fontSize: 10.5, opacity: 0.85 }}>Single process CUDA offload (1.0 GB RAM / 3.1 GB VRAM)</span>
              </button>
            </div>
          </div>

          {/* Preflight & Resource Validation Errors / Warnings */}
          {sup.errorMessage && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.25)",
                color: "var(--color-error)",
                fontSize: 11.5,
              }}
            >
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <strong>Startup Blocked:</strong> {sup.errorMessage}
              </div>
            </div>
          )}

          {sup.preflight && (!sup.preflight.can_launch || sup.preflight.issues.length > 0) && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                background: "rgba(245, 158, 11, 0.08)",
                border: "1px solid rgba(245, 158, 11, 0.25)",
                color: "var(--color-warn)",
                fontSize: 11.5,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                <AlertTriangle size={13} />
                <span>Preflight Issues Detected:</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.4 }}>
                {sup.preflight.issues.map((iss, i) => (
                  <li key={i}>{iss}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
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
            ) : (
              <button
                type="button"
                id="start-engine-btn"
                className="btn-primary"
                onClick={() => setShowConfirmModal(true)}
                style={{ padding: "6px 16px", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}
              >
                <Play size={12} />
                <span>Start Engine</span>
              </button>
            )}
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setShowManualCli(!showManualCli)}
              style={{ padding: "6px 10px", fontSize: 11.5, marginLeft: "auto" }}
            >
              {showManualCli ? "Hide CLI Scripts" : "View CLI Scripts"}
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
                    id="auth-real-checkbox"
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
                    id="confirm-launch-btn"
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
        </div>
      )}

      {/* Launch Instructions (Mode Disambiguation) */}
      {(!sup.isDesktop || showManualCli) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text)" }}>
              Manual PowerShell Launch Workflow:
            </div>
            {/* Mode Selector Tabs */}
            <div style={{ display: "flex", gap: 4 }}>
              <button
                type="button"
                className={activeTab === "local" ? "btn-primary" : "btn-ghost"}
                onClick={() => setActiveTab("local")}
                style={{ padding: "2px 8px", fontSize: 11, height: 24 }}
              >
                Local Dev / Test
              </button>
              <button
                type="button"
                className={activeTab === "prod" ? "btn-primary" : "btn-ghost"}
                onClick={() => setActiveTab("prod")}
                style={{ padding: "2px 8px", fontSize: 11, height: 24 }}
              >
                Production (Mode C)
              </button>
            </div>
          </div>

          {activeTab === "local" ? (
            <div
              className="animate-fade-in"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                background: "var(--color-bg)",
                border: "1px solid var(--color-hairline)",
                borderRadius: "var(--radius-sm)",
                padding: "10px 12px",
              }}
            >
              <div style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>
                For single-machine development or loopback simulation, run this audited launch script in PowerShell:
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  background: "var(--color-surface-sunken)",
                  border: "1px solid var(--color-hairline)",
                  borderRadius: "var(--radius-sm)",
                  padding: "6px 10px",
                  gap: 8,
                }}
              >
                <code className="mono" style={{ fontSize: 11, color: "var(--color-text)", overflowX: "auto" }}>
                  {localDevCmd}
                </code>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => handleCopy(localDevCmd, "local")}
                  style={{ padding: "3px 8px", fontSize: 11, height: 24, flexShrink: 0 }}
                >
                  {copiedMode === "local" ? <Check size={12} color="var(--color-ok)" /> : <Copy size={12} />}
                  <span>{copiedMode === "local" ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <div style={{ fontSize: 11, color: "var(--color-text-3)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
                <span>Optional loopback RPC helper: <code className="mono" style={{ fontSize: 10.5 }}>{loopbackHelperCmd}</code></span>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => handleCopy(loopbackHelperCmd, "loopback")}
                  style={{ padding: "2px 6px", fontSize: 10.5, height: 22, flexShrink: 0 }}
                >
                  {copiedMode === "loopback" ? <Check size={11} color="var(--color-ok)" /> : <Copy size={11} />}
                  <span>{copiedMode === "loopback" ? "Copied" : "Copy"}</span>
                </button>
              </div>
            </div>
          ) : (
            <div
              className="animate-fade-in"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                background: "var(--color-bg)",
                border: "1px solid var(--color-hairline)",
                borderRadius: "var(--radius-sm)",
                padding: "10px 12px",
              }}
            >
              <div style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>
                For hardened multi-computer clusters, start the coordinator referencing the secured token file and helper endpoints:
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  background: "var(--color-surface-sunken)",
                  border: "1px solid var(--color-hairline)",
                  borderRadius: "var(--radius-sm)",
                  padding: "6px 10px",
                  gap: 8,
                }}
              >
                <code className="mono" style={{ fontSize: 10.5, color: "var(--color-text)", overflowX: "auto" }}>
                  {prodCmd}
                </code>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => handleCopy(prodCmd, "prod")}
                  style={{ padding: "3px 8px", fontSize: 11, height: 24, flexShrink: 0 }}
                >
                  {copiedMode === "prod" ? <Check size={12} color="var(--color-ok)" /> : <Copy size={12} />}
                  <span>{copiedMode === "prod" ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <div style={{ fontSize: 11, color: "var(--color-text-3)", lineHeight: 1.5 }}>
                <div>• <strong>-TokenFile:</strong> Points to the local file containing the telemetry secret (default: <code className="mono" style={{ fontSize: 10.5 }}>$env:ProgramData\Swarm\secrets\telemetry.token</code>). Tokens are never passed directly as plaintext CLI arguments.</div>
                <div>• <strong>-RpcEndpoints:</strong> Replace <code className="mono">&lt;HELPER_VPN_IP&gt;</code> with the helper's private VPN/WireGuard address. If running standalone or local CUDA without remote helpers, omit <code className="mono">-RpcEndpoints</code> entirely.</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Safety Notice: Browser cannot execute native shell processes */}
      {!sup.isDesktop && (
        <div style={{ fontSize: 11, color: "var(--color-text-3)", lineHeight: 1.45 }}>
          Note: The browser sandbox cannot directly spawn or terminate background operating system processes.
          The UI will automatically reconnect and resume normal operation as soon as the coordinator is reachable.
        </div>
      )}
    </div>
  );
}
