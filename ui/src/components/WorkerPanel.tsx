import { useState, useId, useEffect } from "react";
import QRCode from "qrcode";
import { useWorkerMode } from "../hooks/useWorkerMode";
import { isAndroid } from "../lib/platform";
import {
  Server,
  Cpu,
  ShieldX,
  CheckCircle2,
  AlertTriangle,
  Play,
  Square,
  Copy,
  Check,
  RefreshCw,
  Activity,
  Layers,
  Wifi,
} from "lucide-react";

interface WorkerPanelProps {
  onSwitchToInference?: () => void;
}

function cleanCpuName(name: string): string {
  if (name.includes("Intel64 Family") || name.includes("Family 6 Model")) {
    return "Intel x86_64 Processor";
  }
  return name.replace(/\(R\)|\(TM\)/gi, "").trim();
}

export function WorkerPanel({ onSwitchToInference }: WorkerPanelProps) {
  const {
    config,
    status,
    hardware,
    isLoading,
    isStarting,
    isStopping,
    errorMessage,
    startWorker,
    stopWorker,
    revokeRemoteAccess,
    saveConfig,
    refreshHardware,
    clearError,
  } = useWorkerMode();

  const [copiedPairing, setCopiedPairing] = useState(false);
  const [pairingQr, setPairingQr] = useState<string | null>(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);

  // Form state
  const [role, setRole] = useState<string>(config?.role || "worker");
  const [listenHost, setListenHost] = useState<string>(config?.listen_host || "127.0.0.1");
  const [rpcPort, setRpcPort] = useState<number>(config?.rpc_port || 50052);
  const [threads, setThreads] = useState<number>(config?.threads || 4);
  const [backendDevice, setBackendDevice] = useState<string>(config?.backend_device || "all");
  const [targetRamMb, setTargetRamMb] = useState<number>(config?.target_ram_mb || 2048);
  const [targetVramMb, setTargetVramMb] = useState<number>(config?.target_vram_mb || 2048);
  const [allowRemoteAccess, setAllowRemoteAccess] = useState<boolean>(config?.allow_remote_access || false);
  const [authorizedControllerIp, setAuthorizedControllerIp] = useState<string>(config?.authorized_controller_ip || "");
  const [backgroundRunEnabled, setBackgroundRunEnabled] = useState<boolean>(config?.background_run_enabled || false);

  const roleInferenceId = useId();
  const roleWorkerId = useId();
  const roleCombinedId = useId();
  const listenHostId = useId();
  const rpcPortId = useId();
  const threadsId = useId();
  const allowRemoteAccessId = useId();

  useEffect(() => {
    if (!config) return;
    setRole(config.role);
    setListenHost(isAndroid ? "0.0.0.0" : config.listen_host);
    setRpcPort(config.rpc_port);
    setThreads(config.threads);
    setBackendDevice(config.backend_device);
    setTargetRamMb(config.target_ram_mb);
    setTargetVramMb(config.target_vram_mb);
    setAllowRemoteAccess(isAndroid ? true : config.allow_remote_access);
    setAuthorizedControllerIp(config.authorized_controller_ip);
    setBackgroundRunEnabled(config.background_run_enabled);
  }, [config]);

  const isListening = status?.is_listening || false;
  const currentState = status?.state || (isLoading ? "Loading" : "Stopped");
  const isBusyOrStarting = isStarting || isStopping || currentState === "Starting" || currentState === "CheckingPrerequisites";

  const pairingCode = status?.pairing_code || "";
  const pairingLink = pairingCode
    ? `swarm://pair?v=1&code=${pairingCode}${status?.endpoint_id ? `&endpoint_id=${status.endpoint_id}` : ""}`
    : "";

  useEffect(() => {
    let cancelled = false;
    if (!pairingLink) {
      setPairingQr(null);
      return;
    }
    QRCode.toDataURL(pairingLink, { margin: 1, width: 200 })
      .then((url) => {
        if (!cancelled) setPairingQr(url);
      })
      .catch(() => {
        if (!cancelled) setPairingQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pairingLink]);

  const handleCopyPairing = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedPairing(true);
    setTimeout(() => setCopiedPairing(false), 2000);
  };

  const handleSaveSettings = async () => {
    clearError();
    setSaveSuccessMsg(null);
    try {
      await saveConfig({
        role,
        listen_host: listenHost,
        rpc_port: Number(rpcPort),
        threads: Number(threads),
        backend_device: backendDevice,
        authorized_controller_ip: authorizedControllerIp,
        allow_remote_access: allowRemoteAccess,
        enable_file_cache: true,
        target_ram_mb: Number(targetRamMb),
        target_vram_mb: Number(targetVramMb),
        reserved_headroom_ram_mb: 1024,
        reserved_headroom_vram_mb: 256,
        background_run_enabled: backgroundRunEnabled,
        updated_at_ms: Date.now(),
      });
      setSaveSuccessMsg("Worker configuration saved successfully.");
      setTimeout(() => setSaveSuccessMsg(null), 3000);
    } catch {
      // Error handled in hook
    }
  };

  const handleRevokeRemoteAccess = async () => {
    clearError();
    try {
      await revokeRemoteAccess();
      setListenHost("127.0.0.1");
      setAllowRemoteAccess(false);
      setAuthorizedControllerIp("");
      setSaveSuccessMsg("Remote compute sharing revoked. Reset binding to 127.0.0.1 and removed Swarm firewall rules.");
      setTimeout(() => setSaveSuccessMsg(null), 4000);
    } catch {
      // Error handled in hook
    }
  };

  const handleToggleSharing = async () => {
    clearError();
    if (isListening) {
      await stopWorker();
    } else {
      if (!isAndroid && allowRemoteAccess && listenHost !== "127.0.0.1" && !authorizedControllerIp.trim()) {
        saveConfig({
          role,
          listen_host: listenHost,
          rpc_port: Number(rpcPort),
          threads: Number(threads),
          backend_device: backendDevice,
          authorized_controller_ip: authorizedControllerIp,
          allow_remote_access: allowRemoteAccess,
          enable_file_cache: true,
          target_ram_mb: Number(targetRamMb),
          target_vram_mb: Number(targetVramMb),
          reserved_headroom_ram_mb: 1024,
          reserved_headroom_vram_mb: 256,
          background_run_enabled: backgroundRunEnabled,
          updated_at_ms: Date.now(),
        }).catch(() => {});
        return;
      }
      await startWorker({
        role,
        listen_host: listenHost,
        rpc_port: Number(rpcPort),
        threads: Number(threads),
        backend_device: backendDevice,
        authorized_controller_ip: authorizedControllerIp,
        allow_remote_access: allowRemoteAccess,
        enable_file_cache: true,
        target_ram_mb: Number(targetRamMb),
        target_vram_mb: Number(targetVramMb),
        reserved_headroom_ram_mb: 1024,
        reserved_headroom_vram_mb: 256,
        background_run_enabled: backgroundRunEnabled,
        updated_at_ms: Date.now(),
      });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, width: "100%", maxWidth: 1080, margin: "0 auto" }}>
      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 className="page-title" style={{ fontSize: 22, fontWeight: 700, margin: 0, color: "var(--color-text)" }}>
              Share Compute
            </h1>
            <span
              className={`badge ${
                isListening ? "badge-ok" : isBusyOrStarting ? "badge-warn" : "badge-idle"
              }`}
              style={{ fontSize: 11 }}
            >
              {currentState}
            </span>
          </div>
          <div className="page-subtitle" style={{ marginTop: 4, fontSize: 13, color: "var(--color-text-2)" }}>
            Share this machine's GPU and CPU compute with phones and other nodes in your swarm.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {!isAndroid && (isListening || status?.firewall_rule_installed || allowRemoteAccess) && (allowRemoteAccess || listenHost !== "127.0.0.1") && (
            <button
              type="button"
              onClick={handleRevokeRemoteAccess}
              disabled={isBusyOrStarting || isLoading}
              className="btn-ghost"
              style={{ color: "var(--color-error)", borderColor: "var(--color-error)", fontSize: 12 }}
            >
              <ShieldX size={13} />
              <span>Revoke Remote</span>
            </button>
          )}

          <button
            type="button"
            className="btn-primary"
            onClick={handleToggleSharing}
            disabled={isBusyOrStarting || isLoading}
            style={{
              padding: "7px 18px",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: isListening ? "var(--color-error)" : "var(--color-accent)",
            }}
          >
            {isListening ? (
              <>
                <Square size={13} fill="currentColor" />
                <span>Stop Sharing</span>
              </>
            ) : (
              <>
                <Play size={13} fill="currentColor" />
                <span>Start Sharing</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {errorMessage && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 16px",
            background: "#FEF2F2",
            border: "1px solid #FCA5A5",
            borderRadius: "var(--radius-sm)",
            color: "#991B1B",
            fontSize: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2, color: "#DC2626" }} />
            <div>
              <strong style={{ display: "block", color: "#7F1D1D", fontSize: 12.5, marginBottom: 2 }}>
                Worker Error
              </strong>
              <span>{errorMessage}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={clearError}
            style={{ background: "none", border: "none", color: "#991B1B", cursor: "pointer", fontSize: 14 }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Success Banner */}
      {saveSuccessMsg && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            background: "var(--color-ok-bg)",
            border: "1px solid rgba(22, 101, 52, 0.2)",
            borderRadius: "var(--radius-sm)",
            color: "var(--color-ok)",
            fontSize: 12,
          }}
        >
          <CheckCircle2 size={15} />
          <span>{saveSuccessMsg}</span>
        </div>
      )}

      {/* ── CARD 1: OPERATING ROLE ────────────────────────────────────── */}
      <div
        className="card"
        style={{
          padding: "18px 20px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: "var(--color-text)" }}>
            Operating Role
          </h2>
          <div style={{ fontSize: 11.5, color: "var(--color-text-3)", marginTop: 2 }}>
            Select how this computer interacts with the Swarm distributed network.
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          {/* Run Inference */}
          <div
            onClick={() => {
              setRole("inference");
              if (onSwitchToInference) onSwitchToInference();
            }}
            style={{
              padding: "14px 16px",
              borderRadius: "var(--radius-sm)",
              border: role === "inference" ? "1.5px solid var(--color-accent)" : "1px solid var(--color-border)",
              background: role === "inference" ? "var(--color-accent-subtle)" : "var(--color-surface)",
              cursor: "pointer",
              transition: "all var(--dur-fast)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 6,
                  background: "var(--color-surface)",
                  color: "var(--color-accent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Activity size={16} />
              </div>
              <input
                id={roleInferenceId}
                type="radio"
                name="operatingRole"
                checked={role === "inference"}
                onChange={() => {
                  setRole("inference");
                  if (onSwitchToInference) onSwitchToInference();
                }}
                style={{ accentColor: "var(--color-accent)" }}
              />
            </div>
            <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text)", margin: "10px 0 2px 0" }}>
              Run Inference
            </h3>
            <p style={{ fontSize: 11, color: "var(--color-text-2)", margin: 0, lineHeight: 1.4 }}>
              Controller mode. Coordinates local and remote devices to execute prompts.
            </p>
          </div>

          {/* Provide Compute */}
          <div
            onClick={() => setRole("worker")}
            style={{
              padding: "14px 16px",
              borderRadius: "var(--radius-sm)",
              border: role === "worker" ? "1.5px solid var(--color-accent)" : "1px solid var(--color-border)",
              background: role === "worker" ? "var(--color-accent-subtle)" : "var(--color-surface)",
              cursor: "pointer",
              transition: "all var(--dur-fast)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 6,
                  background: "var(--color-surface)",
                  color: "var(--color-accent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Server size={16} />
              </div>
              <input
                id={roleWorkerId}
                type="radio"
                name="operatingRole"
                checked={role === "worker"}
                onChange={() => setRole("worker")}
                style={{ accentColor: "var(--color-accent)" }}
              />
            </div>
            <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text)", margin: "10px 0 2px 0" }}>
              Provide Compute
            </h3>
            <p style={{ fontSize: 11, color: "var(--color-text-2)", margin: 0, lineHeight: 1.4 }}>
              Worker mode. Shares local GPU and CPU compute with other computers on your network.
            </p>
          </div>

          {/* Combined Mode */}
          <div
            onClick={() => setRole("combined")}
            style={{
              padding: "14px 16px",
              borderRadius: "var(--radius-sm)",
              border: role === "combined" ? "1.5px solid var(--color-accent)" : "1px solid var(--color-border)",
              background: role === "combined" ? "var(--color-accent-subtle)" : "var(--color-surface)",
              cursor: "pointer",
              transition: "all var(--dur-fast)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 6,
                  background: "var(--color-surface)",
                  color: "var(--color-accent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Layers size={16} />
              </div>
              <input
                id={roleCombinedId}
                type="radio"
                name="operatingRole"
                checked={role === "combined"}
                onChange={() => setRole("combined")}
                style={{ accentColor: "var(--color-accent)" }}
              />
            </div>
            <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text)", margin: "10px 0 2px 0" }}>
              Combined Mode
            </h3>
            <p style={{ fontSize: 11, color: "var(--color-text-2)", margin: 0, lineHeight: 1.4 }}>
              Run local models while sharing spare compute with other devices.
            </p>
          </div>
        </div>
      </div>

      {/* ── CARD 2: HARDWARE & MEASURED TELEMETRY ─────────────────────── */}
      <div
        className="card"
        style={{
          padding: "18px 20px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Cpu size={16} color="var(--color-accent)" />
            <div>
              <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: "var(--color-text)" }}>
                Hardware &amp; Measured Telemetry
              </h2>
              <div style={{ fontSize: 11.5, color: "var(--color-text-3)", marginTop: 2 }}>
                Observed hardware capacity and available headroom on this machine.
              </div>
            </div>
          </div>

          <button
            id="worker-probe-hardware-btn"
            type="button"
            className="btn-ghost"
            onClick={refreshHardware}
            style={{ padding: "4px 10px", fontSize: 11.5, display: "flex", alignItems: "center", gap: 5 }}
          >
            <RefreshCw size={12} />
            <span>Probe Again</span>
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          {/* CPU Box */}
          <div style={{ padding: "12px 14px", background: "var(--color-surface-subtle)", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)" }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--color-text-3)", textTransform: "uppercase" }}>Processor</div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-text)", marginTop: 2 }} title={hardware?.cpu_name || "Unavailable"}>
              {hardware?.cpu_name ? cleanCpuName(hardware.cpu_name) : "Unavailable"}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-2)", marginTop: 2 }}>
              {hardware ? `${hardware.logical_cores} logical cores available` : "Telemetry unavailable"}
            </div>
          </div>

          {/* Physical RAM Box */}
          <div style={{ padding: "12px 14px", background: "var(--color-surface-subtle)", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)" }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--color-text-3)", textTransform: "uppercase" }}>Physical RAM</div>
            <div className="mono" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-text)", marginTop: 2 }}>
              {hardware ? `${hardware.available_ram_mb.toLocaleString()} MB free` : "Unavailable"}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-2)", marginTop: 2 }}>
              {hardware ? `${hardware.total_ram_mb.toLocaleString()} MB total` : "Telemetry unavailable"}
            </div>
          </div>

          {/* GPU VRAM Box */}
          <div style={{ padding: "12px 14px", background: "var(--color-surface-subtle)", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)" }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--color-text-3)", textTransform: "uppercase" }}>Graphics / VRAM</div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-text)", marginTop: 2 }} title={hardware?.gpu_name || "Unavailable"}>
              {hardware ? (hardware.gpu_name || "CPU-only") : "Unavailable"}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-2)", marginTop: 2 }}>
              {hardware?.available_vram_mb ? `${hardware.available_vram_mb.toLocaleString()} MB free` : "Integrated / Shared memory"}
            </div>
          </div>

          {/* RPC Backends Box */}
          <div style={{ padding: "12px 14px", background: "var(--color-surface-subtle)", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)" }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--color-text-3)", textTransform: "uppercase" }}>RPC Backends</div>
            <div style={{ display: "flex", gap: 5, marginTop: 4 }}>
              {hardware && hardware.supported_backends.length > 0 ? (
                hardware.supported_backends.map((b) => (
                  <span
                    key={b}
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 6px",
                      borderRadius: 3,
                      background: "var(--color-accent-subtle)",
                      color: "var(--color-accent)",
                    }}
                  >
                    {b.toUpperCase()}
                  </span>
                ))
              ) : (
                <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>Unavailable</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-2)", marginTop: 3 }}>
              Native RPC server ready
            </div>
          </div>
        </div>
      </div>

      {/* ── CARD 3: MOBILE PAIRING CODE (IF SHARING ACTIVE) ───────────── */}
      {isListening && pairingCode && (
        <div
          className="card animate-fade-in"
          style={{
            padding: "20px",
            background: "var(--color-accent-subtle)",
            border: "1px solid rgba(27, 94, 73, 0.25)",
            borderRadius: "var(--radius)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 16,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Wifi size={16} color="var(--color-accent)" />
              <strong style={{ fontSize: 14, color: "var(--color-text)" }}>Pairing Code for This Machine</strong>
            </div>
            <p style={{ fontSize: 12, color: "var(--color-text-2)", margin: "4px 0 12px 0", maxWidth: 440 }}>
              On your computer, click <strong>+ Pair Device</strong> and enter this 6-digit PIN. Works across local Wi-Fi, 5G, or USB.
            </p>
            <div className="mono" style={{ fontSize: 32, fontWeight: 800, letterSpacing: "0.2em", color: "var(--color-accent)" }}>
              {pairingCode.replace(/^(\d{3})(\d{3})$/, "$1 $2")}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="btn-primary"
                onClick={() => handleCopyPairing(pairingCode)}
                style={{ padding: "5px 14px", fontSize: 12 }}
              >
                {copiedPairing ? <Check size={13} /> : <Copy size={13} />}
                <span>{copiedPairing ? "Copied" : "Copy Code"}</span>
              </button>
            </div>
          </div>

          {pairingQr && (
            <div style={{ background: "#FFFFFF", padding: 8, borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)" }}>
              <img src={pairingQr} alt="Pairing QR code" style={{ width: 120, height: 120, display: "block" }} />
            </div>
          )}
        </div>
      )}

      {/* ── CARD 4: NETWORK & SECURITY CONTROLS ───────────────────────── */}
      <div
        className="card"
        style={{
          padding: "18px 20px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div>
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: "var(--color-text)" }}>
              Network &amp; Security Controls
            </h2>
            <div style={{ fontSize: 11.5, color: "var(--color-text-3)", marginTop: 2 }}>
              Configure network binding, port, and firewall rules for compute sharing.
            </div>
          </div>

          {isListening && (
            <span className="badge badge-warn" style={{ fontSize: 11 }}>
              Stop compute sharing to modify network settings
            </span>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
          {/* Listening Interface Selection */}
          <div>
            <label htmlFor={listenHostId} style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--color-text)", marginBottom: 4 }}>
              Listening Interface
            </label>
            <select
              id={listenHostId}
              value={listenHost}
              onChange={(e) => setListenHost(e.target.value)}
              disabled={isListening}
              style={{
                width: "100%",
                padding: "7px 10px",
                fontSize: 12,
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--color-border)",
                background: "var(--color-surface-subtle)",
                color: "var(--color-text)",
                outline: "none",
              }}
            >
              <option value="127.0.0.1">Loopback Only (127.0.0.1) — Secure</option>
              {!isAndroid &&
                (status?.network_interfaces || [])
                  .filter((ip: string) => ip !== "127.0.0.1")
                  .map((ip: string) => (
                    <option key={ip} value={ip} disabled={!allowRemoteAccess}>
                      {ip} {!allowRemoteAccess ? "(Requires Remote Access)" : ""}
                    </option>
                  ))}
              {!isAndroid && (
                <option value="0.0.0.0" disabled={!allowRemoteAccess}>
                  All Interfaces (0.0.0.0) {!allowRemoteAccess ? "(Requires Remote Access)" : ""}
                </option>
              )}
            </select>
          </div>

          {/* Port */}
          <div>
            <label htmlFor={rpcPortId} style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--color-text)", marginBottom: 4 }}>
              RPC Port
            </label>
            <input
              id={rpcPortId}
              type="number"
              value={rpcPort}
              onChange={(e) => setRpcPort(parseInt(e.target.value) || 50052)}
              disabled={isListening}
              className="mono"
              style={{
                width: "100%",
                padding: "7px 10px",
                fontSize: 12,
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--color-border)",
                background: "var(--color-surface-subtle)",
                color: "var(--color-text)",
                outline: "none",
              }}
            />
          </div>

          {/* Threads */}
          <div>
            <label htmlFor={threadsId} style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--color-text)", marginBottom: 4 }}>
              Compute Threads
            </label>
            <input
              id={threadsId}
              type="number"
              value={threads}
              onChange={(e) => setThreads(parseInt(e.target.value) || 4)}
              disabled={isListening}
              className="mono"
              style={{
                width: "100%",
                padding: "7px 10px",
                fontSize: 12,
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--color-border)",
                background: "var(--color-surface-subtle)",
                color: "var(--color-text)",
                outline: "none",
              }}
            />
          </div>
        </div>

        {/* Remote Sharing Auth Toggle (Windows only) */}
        {!isAndroid && (
          <div style={{ paddingTop: 8, borderTop: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: isListening ? "not-allowed" : "pointer" }}>
              <input
                id={allowRemoteAccessId}
                type="checkbox"
                checked={allowRemoteAccess}
                onChange={(e) => {
                  setAllowRemoteAccess(e.target.checked);
                  if (!e.target.checked) setListenHost("127.0.0.1");
                }}
                disabled={isListening}
                style={{ accentColor: "var(--color-accent)", marginTop: 2 }}
              />
              <div>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-text)" }}>
                  Authorize Remote LAN / VPN Access (Direct IP Mode)
                </span>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--color-text-2)", marginTop: 2 }}>
                  Enables binding to external network adapters. Requires specifying your controller PC's IP to restrict firewall access.
                </span>
              </div>
            </label>

            {/* When checked, show the Authorized Controller IP input */}
            {allowRemoteAccess && (
              <div
                className="animate-fade-in"
                style={{
                  padding: "12px 14px",
                  background: "var(--color-surface-subtle)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-border)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <label htmlFor="authorized-controller-ip" style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text)" }}>
                  Authorized Controller IP Address:
                </label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    id="authorized-controller-ip"
                    type="text"
                    placeholder="e.g. 192.168.204.45 (IP of Computer A)"
                    value={authorizedControllerIp}
                    onChange={(e) => setAuthorizedControllerIp(e.target.value)}
                    disabled={isListening}
                    className="mono"
                    style={{
                      flex: 1,
                      padding: "7px 10px",
                      fontSize: 12,
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--color-border)",
                      background: "var(--color-surface)",
                      color: "var(--color-text)",
                      outline: "none",
                    }}
                  />
                </div>
                <span style={{ fontSize: 11, color: "var(--color-text-3)", lineHeight: 1.4 }}>
                  For security, the Windows Firewall rule will restrict incoming RPC access strictly to this IP address.
                </span>
              </div>
            )}
          </div>
        )}

        {/* Action Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 10, borderTop: "1px solid var(--color-border)" }}>
          <button
            type="button"
            className="btn-ghost"
            onClick={handleSaveSettings}
            disabled={isListening}
            style={{ padding: "6px 16px", fontSize: 12.5 }}
          >
            Save Configuration
          </button>
        </div>
      </div>
    </div>
  );
}
