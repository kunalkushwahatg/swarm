import React, { useState, useEffect, useRef } from "react";
import {
  Loader2,
  CheckCircle2,
  Wifi,
  Layers,
  Terminal,
  ChevronDown,
  ChevronUp,
  X,
  Server,
  AlertCircle,
} from "lucide-react";
import { useSupervisor } from "../hooks/useSupervisor";
import { useSwarmSession } from "../hooks/useSwarmSession";
import { supervisor } from "../lib/supervisor";
import { isAndroid } from "../lib/platform";

export const ClusterStartupModal: React.FC = () => {
  const sup = useSupervisor();
  const session = useSwarmSession(2000);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showLogs, setShowLogs] = useState(true);
  const [logs, setLogs] = useState<string[]>([]);
  const [isEventStarting, setIsEventStarting] = useState(false);
  const [justFinished, setJustFinished] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const logTerminalRef = useRef<HTMLDivElement>(null);
  const wasStartingRef = useRef(false);

  // Listen for custom engine start events (e.g. from ComputeAllocationModal)
  useEffect(() => {
    const handleStartEvent = () => setIsEventStarting(true);
    const handleStopEvent = () => setIsEventStarting(false);

    window.addEventListener("swarm-engine-starting", handleStartEvent);
    window.addEventListener("swarm-engine-started", handleStopEvent);

    return () => {
      window.removeEventListener("swarm-engine-starting", handleStartEvent);
      window.removeEventListener("swarm-engine-started", handleStopEvent);
    };
  }, []);

  const stateStr = typeof sup.engineStatus?.state === "string" ? sup.engineStatus.state : "";
  const isLifecycleStarting =
    stateStr === "StartingCoordinator" ||
    stateStr === "WaitingForCoordinator" ||
    stateStr === "StartingRpc" ||
    stateStr === "WaitingForRpc";

  const isHealthy = sup.engineStatus?.coord_healthy === true || stateStr === "Ready" || stateStr === "Healthy";

  const isStarting = (sup.isStarting || isLifecycleStarting || isEventStarting) && !justFinished && !startupError;
  const coordinatorPid = sup.engineStatus?.coordinator_pid;

  // Track completion transition: when starting finishes and reaches healthy, show 100% for 1.4s
  useEffect(() => {
    if (isStarting) {
      wasStartingRef.current = true;
      setStartupError(null);
    } else if (wasStartingRef.current) {
      if (isHealthy) {
        wasStartingRef.current = false;
        setJustFinished(true);
        const timer = setTimeout(() => {
          setJustFinished(false);
          setIsEventStarting(false);
        }, 1400);
        return () => clearTimeout(timer);
      } else if (sup.errorMessage) {
        wasStartingRef.current = false;
        setStartupError(sup.errorMessage);
        setIsEventStarting(false);
      }
    }
  }, [isStarting, isHealthy, sup.errorMessage]);

  // Determine if this is a distributed cluster with remote RPC or standalone
  const hasRpcWorker =
    sup.selectedProfileId !== "low_memory_cuda_standalone" &&
    session.devices.some((d) => !d.isLocalHost && !d.isLoopback);

  const remoteDevice = session.devices.find((d) => !d.isLocalHost && !d.isLoopback);
  const localDevice = session.devices.find((d) => d.isLocalHost);

  // Track elapsed time during startup
  useEffect(() => {
    if (!isStarting && !justFinished) {
      setElapsedSeconds(0);
      setLogs([]);
      return;
    }

    const timer = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [isStarting, justFinished]);

  // Poll live coordinator stdout logs when PID is known
  useEffect(() => {
    if (!isStarting || !coordinatorPid) return;

    let active = true;
    const fetchLogs = async () => {
      try {
        const lines = await supervisor.getProcessLogs(coordinatorPid, 25);
        if (active && lines && lines.length > 0) {
          setLogs(lines);
        }
      } catch (e) {
        // Ignore pipe errors while process is initializing
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 700);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [isStarting, coordinatorPid]);

  // Auto-scroll terminal log to bottom
  useEffect(() => {
    if (logTerminalRef.current) {
      logTerminalRef.current.scrollTop = logTerminalRef.current.scrollHeight;
    }
  }, [logs]);

  if (!isStarting && !justFinished && !startupError) {
    return null;
  }

  // Authoritative log-driven stage determination (Real physical state!)
  const allLogs = logs.join("\n");
  const rpcMatch = allLogs.match(/RPC0.*?model buffer size\s*=\s*([\d\.]+\s*[M|G]iB)/i);
  const transferSizeStr = rpcMatch ? rpcMatch[1] : undefined;

  let activeStage = 1;
  let stageDescription = "Verifying node reachability & network preflight…";
  let progressPercent = 10;

  if (justFinished || isHealthy) {
    activeStage = 6;
    stageDescription = isAndroid
      ? "On-Device Engine Ready for Inference!"
      : "Cluster Ready & Verified for Inference!";
    progressPercent = 100;
  } else if (allLogs.includes("Swarm API Gateway running on") || allLogs.includes("server listening")) {
    activeStage = 5;
    stageDescription = "Finalizing coordinator HTTP health probe…";
    progressPercent = 95;
  } else if (
    allLogs.includes("Backend Placement & Resource Observability") ||
    allLogs.includes("Placement Policy Verification") ||
    allLogs.includes("Outcome: All backend placements MATCHED")
  ) {
    activeStage = 4;
    stageDescription = `Allocating ${localDevice?.name || "GPU"} VRAM & KV context cache…`;
    progressPercent = 88;
  } else if (
    allLogs.includes("load_tensors:") ||
    allLogs.includes("llama_model_loader") ||
    allLogs.includes("Passing verified native tensor_split")
  ) {
    // Stage 3: THE REAL WI-FI WEIGHT STREAMING PHASE
    activeStage = 3;
    stageDescription = hasRpcWorker
      ? transferSizeStr
        ? `Streaming ${transferSizeStr} tensor weights to ${remoteDevice?.name || "remote worker"} RAM…`
        : `Streaming tensor weights over network link to ${remoteDevice?.name || "remote worker"} RAM…`
      : "Reading model weights from NVMe SSD into memory…";
    progressPercent = Math.min(84, 35 + Math.round(elapsedSeconds * 1.6));
  } else if (
    allLogs.includes("Starting Swarm API Gateway") ||
    allLogs.includes("Connecting to RPC worker") ||
    allLogs.includes("Registered device for worker") ||
    logs.length > 0
  ) {
    activeStage = 2;
    stageDescription = "Starting coordinator engine runtime & negotiating split…";
    progressPercent = Math.min(30, 15 + Math.round(elapsedSeconds * 5));
  } else {
    activeStage = 1;
    stageDescription = "Verifying node reachability & socket preflight…";
    progressPercent = Math.min(20, Math.round(elapsedSeconds * 8));
  }

  const formatTimer = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remaining = secs % 60;
    return `${mins.toString().padStart(2, "0")}:${remaining.toString().padStart(2, "0")}`;
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(32, 40, 33, 0.45)",
        backdropFilter: "blur(3px)",
        padding: 16,
      }}
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: 580,
          background: "var(--color-surface)",
          border: "1px solid var(--color-border-strong)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "0 12px 36px rgba(0, 0, 0, 0.18)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            background: "var(--color-surface)",
            borderBottom: "1px solid var(--color-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "var(--radius-sm)",
                background: startupError
                  ? "var(--color-error-bg)"
                  : justFinished
                  ? "var(--color-ok-bg)"
                  : "var(--color-accent-subtle)",
                color: startupError
                  ? "var(--color-error)"
                  : justFinished
                  ? "var(--color-ok)"
                  : "var(--color-accent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {startupError ? <AlertCircle size={18} /> : <Server size={18} />}
            </div>
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text)", margin: 0 }}>
                {startupError
                  ? isAndroid
                    ? "Engine Launch Stopped"
                    : "Cluster Launch Stopped"
                  : justFinished
                  ? isAndroid
                    ? "On-Device Engine Ready!"
                    : "Cluster Ready & Verified!"
                  : isAndroid
                  ? "Starting On-Device Engine"
                  : "Deploying Model to Cluster"}
              </h3>
              <span style={{ fontSize: 11.5, color: "var(--color-text-3)" }}>
                {startupError
                  ? "Action required to proceed"
                  : hasRpcWorker
                  ? "Distributed Wi-Fi Cluster"
                  : "Standalone Local Acceleration"}
              </span>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {!startupError && (
              <span
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--color-accent)",
                  background: "var(--color-surface-subtle)",
                  padding: "3px 8px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {formatTimer(elapsedSeconds)}
              </span>
            )}
            <button
              onClick={() => {
                if (startupError) {
                  setStartupError(null);
                } else {
                  sup.cancelStartup();
                }
              }}
              className="btn-ghost"
              style={{ padding: "4px 8px", fontSize: 11.5 }}
              title={startupError ? "Dismiss alert" : "Cancel startup"}
            >
              <X size={13} />
              <span>{startupError ? "Dismiss" : "Cancel"}</span>
            </button>
          </div>
        </div>

        {/* Body Content */}
        <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          {startupError ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "12px 14px",
                  background: "var(--color-error-bg)",
                  border: "1px solid rgba(185, 28, 28, 0.25)",
                  borderRadius: "var(--radius)",
                  color: "var(--color-error)",
                  fontSize: 12.5,
                  lineHeight: 1.5,
                }}
              >
                <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
                <div>
                  <strong style={{ display: "block", marginBottom: 2 }}>
                    {isAndroid ? "Engine Launch Failed" : "Launch Halted by Cluster Guard"}
                  </strong>
                  <span>{startupError}</span>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={async () => {
                    setStartupError(null);
                    await sup.startEngine(true, "low_memory_cuda_standalone");
                  }}
                  style={{ padding: "6px 14px", fontSize: 12 }}
                >
                  <span>
                    {isAndroid
                      ? "Run On-Device Engine (Local GPU)"
                      : "Run Standalone CUDA (Local GPU)"}
                  </span>
                </button>

                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setStartupError(null)}
                  style={{ padding: "6px 14px", fontSize: 12 }}
                >
                  <span>Dismiss</span>
                </button>
              </div>
            </div>
          ) : (
            <>
          {/* Target Cluster Split Card */}
          <div
            style={{
              padding: "10px 14px",
              background: "var(--color-surface-subtle)",
              borderRadius: "var(--radius)",
              border: "1px solid var(--color-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Layers size={14} style={{ color: "var(--color-text-3)" }} />
              <span style={{ color: "var(--color-text-2)" }}>Model Target:</span>
              <strong className="mono" style={{ color: "var(--color-text)", fontWeight: 600 }}>
                {session.modelName || "SmolLM2 360M"}
              </strong>
            </div>

            {hasRpcWorker && remoteDevice ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                <span className="mono" style={{ color: "var(--color-rpc)", fontWeight: 600 }}>
                  {remoteDevice.name || "Remote Worker"} ({remoteDevice.assignedLayersCount || 0}L)
                </span>
                <span style={{ color: "var(--color-text-3)" }}>+</span>
                <span className="mono" style={{ color: "var(--color-cuda)", fontWeight: 600 }}>
                  {localDevice?.name || "Local GPU"} ({localDevice?.assignedLayersCount || 0}L)
                </span>
              </div>
            ) : (
              <span className="mono" style={{ fontSize: 11.5, color: "var(--color-cuda)", fontWeight: 600 }}>
                100% Local GPU/CPU
              </span>
            )}
          </div>

          {/* Progress Bar Track */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}>
              <span style={{ color: activeStage === 6 ? "var(--color-ok)" : "var(--color-text-2)", fontWeight: 500 }}>
                {stageDescription}
              </span>
              <span className="mono" style={{ color: activeStage === 6 ? "var(--color-ok)" : "var(--color-accent)", fontWeight: 600 }}>
                {progressPercent}%
              </span>
            </div>

            <div
              style={{
                width: "100%",
                height: 8,
                background: "var(--color-surface-sunken)",
                borderRadius: 99,
                overflow: "hidden",
                border: "1px solid var(--color-border)",
              }}
            >
              <div
                style={{
                  height: "100%",
                  background: activeStage === 6 ? "var(--color-ok)" : "var(--color-accent)",
                  width: `${progressPercent}%`,
                  transition: "width 0.4s ease",
                }}
              />
            </div>
          </div>

          {/* Pipeline Stage Checklist */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: "12px",
              background: "var(--color-surface)",
              borderRadius: "var(--radius)",
              border: "1px solid var(--color-border)",
              fontSize: 12,
            }}
          >
            {/* Stage 1 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {activeStage > 1 ? (
                  <CheckCircle2 size={15} style={{ color: "var(--color-ok)" }} />
                ) : activeStage === 1 ? (
                  <Loader2 size={15} className="animate-spin" style={{ color: "var(--color-accent)" }} />
                ) : (
                  <div style={{ width: 15, height: 15, borderRadius: "50%", border: "1px solid var(--color-border)" }} />
                )}
                <span style={{ color: activeStage >= 1 ? "var(--color-text)" : "var(--color-text-3)", fontWeight: activeStage === 1 ? 600 : 400 }}>
                  1. Preflight Node Checks
                </span>
              </div>
              <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                {activeStage > 1 ? "Verified Reachable" : hasRpcWorker && remoteDevice ? `Probing ${remoteDevice.connectionAddress || "192.168.137.233:50052"}` : "Checking loopback ports"}
              </span>
            </div>

            {/* Stage 2 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {activeStage > 2 ? (
                  <CheckCircle2 size={15} style={{ color: "var(--color-ok)" }} />
                ) : activeStage === 2 ? (
                  <Loader2 size={15} className="animate-spin" style={{ color: "var(--color-accent)" }} />
                ) : (
                  <div style={{ width: 15, height: 15, borderRadius: "50%", border: "1px solid var(--color-border)" }} />
                )}
                <span style={{ color: activeStage >= 2 ? "var(--color-text)" : "var(--color-text-3)", fontWeight: activeStage === 2 ? 600 : 400 }}>
                  2. Launch Coordinator Engine
                </span>
              </div>
              <span className="mono" style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                {coordinatorPid ? `PID: ${coordinatorPid}` : "Spawning swarm_node"}
              </span>
            </div>

            {/* Stage 3 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {activeStage > 3 ? (
                  <CheckCircle2 size={15} style={{ color: "var(--color-ok)" }} />
                ) : activeStage === 3 ? (
                  <Loader2 size={15} className="animate-spin" style={{ color: "var(--color-accent)" }} />
                ) : (
                  <div style={{ width: 15, height: 15, borderRadius: "50%", border: "1px solid var(--color-border)" }} />
                )}
                <span style={{ color: activeStage >= 3 ? "var(--color-text)" : "var(--color-text-3)", fontWeight: activeStage === 3 ? 600 : 400 }}>
                  3. {hasRpcWorker ? "Wi-Fi Tensor Weight Streaming" : "Direct SSD Model Load"}
                </span>
              </div>
              <span style={{ fontSize: 11, color: activeStage === 3 ? "var(--color-accent)" : "var(--color-text-3)", fontWeight: activeStage === 3 ? 600 : 400 }}>
                {activeStage > 3
                  ? "Transferred & Mapped"
                  : hasRpcWorker
                  ? transferSizeStr
                    ? `${transferSizeStr} streaming to phone RAM`
                    : "Streaming layers to phone RAM"
                  : "Loading weights into memory"}
              </span>
            </div>

            {/* Stage 4 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {activeStage > 4 ? (
                  <CheckCircle2 size={15} style={{ color: "var(--color-ok)" }} />
                ) : activeStage === 4 ? (
                  <Loader2 size={15} className="animate-spin" style={{ color: "var(--color-accent)" }} />
                ) : (
                  <div style={{ width: 15, height: 15, borderRadius: "50%", border: "1px solid var(--color-border)" }} />
                )}
                <span style={{ color: activeStage >= 4 ? "var(--color-text)" : "var(--color-text-3)", fontWeight: activeStage === 4 ? 600 : 400 }}>
                  4. GPU VRAM &amp; Context Allocation
                </span>
              </div>
              <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                {activeStage > 4 ? `${localDevice?.name || "GPU"} Buffers Allocated` : `Allocating ${localDevice?.name || "GPU"} buffers`}
              </span>
            </div>

            {/* Stage 5 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {activeStage > 5 ? (
                  <CheckCircle2 size={15} style={{ color: "var(--color-ok)" }} />
                ) : activeStage === 5 ? (
                  <Loader2 size={15} className="animate-spin" style={{ color: "var(--color-accent)" }} />
                ) : (
                  <div style={{ width: 15, height: 15, borderRadius: "50%", border: "1px solid var(--color-border)" }} />
                )}
                <span style={{ color: activeStage >= 5 ? "var(--color-text)" : "var(--color-text-3)", fontWeight: activeStage === 5 ? 600 : 400 }}>
                  5. Finalize Health Probe
                </span>
              </div>
              <span className="mono" style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                {activeStage > 5 ? "GET /health (200 OK)" : "GET http://127.0.0.1:8080/health"}
              </span>
            </div>
          </div>

          {/* Educational Note */}
          {hasRpcWorker && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "8px 12px",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-surface-subtle)",
                border: "1px solid var(--color-border)",
                fontSize: 11.5,
                color: "var(--color-text-2)",
                lineHeight: 1.45,
              }}
            >
              <Wifi size={14} style={{ color: "var(--color-rpc)", marginTop: 2, flexShrink: 0 }} />
              <div>
                <strong>Why Wi-Fi streaming takes time:</strong> The model weights for your phone’s 29 layers are sent across the Wi-Fi network directly into your phone’s physical RAM on startup. Once transferred, token generation will be fast!
              </div>
            </div>
          )}

          {/* Live Coordinator Console Logs */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div
              onClick={() => setShowLogs(!showLogs)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                cursor: "pointer",
                userSelect: "none",
                fontSize: 11.5,
                color: "var(--color-text-2)",
                fontWeight: 500,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Terminal size={13} style={{ color: "var(--color-text-3)" }} />
                <span>Live Coordinator Engine Logs ({logs.length} lines)</span>
              </div>
              {showLogs ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </div>

            {showLogs && (
              <div
                ref={logTerminalRef}
                style={{
                  height: 100,
                  overflowY: "auto",
                  background: "#181D1A",
                  color: "#D8E2DC",
                  padding: "8px 12px",
                  borderRadius: "var(--radius-sm)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  lineHeight: 1.5,
                  border: "1px solid #2A332E",
                }}
              >
                {logs.length === 0 ? (
                  <span style={{ color: "#66716A" }}>Waiting for coordinator stdout stream…</span>
                ) : (
                  logs.map((line, idx) => (
                    <div key={idx} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {line}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
