import { useState, useId, useEffect, type CSSProperties } from "react";
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

function formatInterfaceLabel(ip: string, alias?: string): string {
  if (alias) {
    return `${ip} (${alias})`;
  }
  if (ip.startsWith("192.168.137.")) return `${ip} (Hotspot)`;
  if (ip.startsWith("172.16.") || ip.startsWith("172.17.") || ip.startsWith("172.18.")) return `${ip} (Cloudflare WARP / VPN)`;
  if (ip.startsWith("100.")) return `${ip} (Tailscale VPN)`;
  if (ip.startsWith("10.154.")) return `${ip} (USB Tethering)`;
  if (ip.startsWith("192.168.")) return `${ip} (Wi-Fi / LAN)`;
  if (ip.startsWith("10.")) return `${ip} (Local Network)`;
  return ip;
}

function parseDeviceSelection(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => {
      const lower = v.toLowerCase();
      return v.length > 0 && lower !== "all" && lower !== "auto" && lower !== "cuda";
    });
}

function isAutoSelection(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed === "" || trimmed === "all" || trimmed === "auto" || trimmed === "cuda";
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

  // Device sharing selection. "all" lets the RPC server export every
  // accelerator; a comma list exports exactly those devices.
  const availableGpus = hardware?.gpus?.length
    ? hardware.gpus
    : hardware?.gpu_name
      ? [{
          index: 0,
          name: hardware.gpu_name,
          total_vram_mb: hardware.total_vram_mb ?? 0,
          available_vram_mb: hardware.available_vram_mb ?? 0,
        }]
      : [];
  const deviceSelection = parseDeviceSelection(backendDevice);
  const autoSelection = isAutoSelection(backendDevice);
  const exportedDevices = autoSelection
    ? (availableGpus.length > 0 ? availableGpus.map((_, i) => `CUDA${i}`) : ["CPU"])
    : deviceSelection;
  const exportedDeviceArg = exportedDevices.join(",");
  const backendChips = isAndroid ? (hardware?.supported_backends ?? []) : exportedDevices;

  const savedSelection = status?.config?.backend_device || "all";
  const savedDevices = isAutoSelection(savedSelection)
    ? (availableGpus.length > 0 ? availableGpus.map((_, i) => `CUDA${i}`) : ["CPU"])
    : parseDeviceSelection(savedSelection);
  const selectionChanged = isListening && savedDevices.join(",") !== exportedDeviceArg;

  const shareChipStyle = (active: boolean): CSSProperties => ({
    fontSize: 11.5,
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: 999,
    border: active ? "1px solid var(--color-accent)" : "1px solid var(--color-border)",
    background: active ? "var(--color-accent-subtle)" : "var(--color-surface)",
    color: active ? "var(--color-accent)" : "var(--color-text-2)",
    cursor: "pointer",
  });

  const toggleDevice = (name: string) => {
    const current = parseDeviceSelection(backendDevice);
    const next = current.includes(name)
      ? current.filter((d) => d !== name)
      : [...current, name];
    setBackendDevice(next.length > 0 ? next.join(",") : "all");
  };

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
            Share this machine's compute with phones and other nodes in your swarm. Pick exactly which devices to export.
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
              Worker mode. Shares the compute you select with other computers on your network.
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

        {!isAndroid && (
          <div
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              padding: "12px 14px",
              background: "var(--color-surface-subtle)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Layers size={14} color="var(--color-accent)" />
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--color-text)" }}>
                  Compute to share
                </span>
              </div>
              <span
                className="mono"
                title={autoSelection ? "Devices the RPC server exports" : "Devices passed to ggml-rpc-server via -d"}
                style={{ fontSize: 11, color: "var(--color-text-3)" }}
              >
                {exportedDeviceArg ? (autoSelection ? exportedDeviceArg : `-d ${exportedDeviceArg}`) : "auto"}
              </span>
            </div>

            <div
              role="radiogroup"
              aria-label="Compute sharing mode"
              style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}
            >
              <button
                type="button"
                role="radio"
                aria-checked={autoSelection}
                onClick={() => setBackendDevice("all")}
                style={shareChipStyle(autoSelection)}
              >
                All accelerators
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={!autoSelection}
                onClick={() => {
                  if (isAutoSelection(backendDevice)) {
                    setBackendDevice(
                      availableGpus.length > 0
                        ? availableGpus.map((_, i) => `CUDA${i}`).join(",")
                        : "CPU",
                    );
                  }
                }}
                style={shareChipStyle(!autoSelection)}
              >
                Choose devices
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 6 }}>
              {autoSelection
                ? "Exports all non-CPU devices, or CPU when none is present."
                : "Exports only the devices checked below."}
            </div>

            {selectionChanged && (
              <div style={{ fontSize: 11, color: "var(--color-warn)", marginTop: 8 }}>
                Restart sharing to apply the new device selection.
              </div>
            )}

            {!autoSelection && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                {availableGpus.map((gpu, index) => {
                  const name = `CUDA${index}`;
                  return (
                    <label
                      key={name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 11.5,
                        color: "var(--color-text)",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={deviceSelection.includes(name)}
                        onChange={() => toggleDevice(name)}
                        style={{ accentColor: "var(--color-accent)" }}
                      />
                      <span style={{ fontWeight: 600 }}>{name}</span>
                      <span style={{ color: "var(--color-text-2)" }}>{gpu.name}</span>
                      <span className="mono" style={{ marginLeft: "auto", color: "var(--color-text-3)" }}>
                        {gpu.total_vram_mb > 0 ? `${(gpu.total_vram_mb / 1024).toFixed(1)} GB` : "VRAM unknown"}
                      </span>
                    </label>
                  );
                })}
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 11.5,
                    color: "var(--color-text)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={deviceSelection.includes("CPU")}
                    onChange={() => toggleDevice("CPU")}
                    style={{ accentColor: "var(--color-accent)" }}
                  />
                  <span style={{ fontWeight: 600 }}>CPU</span>
                  <span style={{ color: "var(--color-text-2)" }}>
                    {hardware ? `${hardware.logical_cores} cores` : "Host processor"}
                  </span>
                  <span className="mono" style={{ marginLeft: "auto", color: "var(--color-text-3)" }}>
                    {hardware ? `${hardware.total_ram_mb.toLocaleString()} MB` : "RAM unknown"}
                  </span>
                </label>
                {deviceSelection.length === 0 && (
                  <div style={{ fontSize: 11, color: "var(--color-warn)" }}>
                    Select at least one device, or switch back to All accelerators.
                  </div>
                )}
                {deviceSelection.length > 1 && (
                  <div style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                    Each selected device is exported as its own RPC backend.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

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
            <div
              style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-text)", marginTop: 2 }}
              title={hardware?.gpu_name || "Unavailable"}
            >
              {hardware
                ? availableGpus.length > 1
                  ? `${availableGpus.length} GPUs`
                  : hardware.gpu_name || "CPU-only"
                : "Unavailable"}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-2)", marginTop: 2, display: "flex", flexDirection: "column", gap: 2 }}>
              {availableGpus.length > 0
                ? availableGpus.map((gpu, index) => (
                    <span key={index}>
                      {availableGpus.length > 1 ? `CUDA${index}: ` : ""}
                      {gpu.available_vram_mb > 0 ? `${(gpu.available_vram_mb / 1024).toFixed(1)} GB free` : "free unknown"}
                      {gpu.total_vram_mb > 0 ? ` of ${(gpu.total_vram_mb / 1024).toFixed(1)} GB` : ""}
                    </span>
                  ))
                : hardware
                  ? "Integrated / Shared memory"
                  : "Telemetry unavailable"}
            </div>
          </div>

          {/* RPC Backends Box */}
          <div style={{ padding: "12px 14px", background: "var(--color-surface-subtle)", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)" }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--color-text-3)", textTransform: "uppercase" }}>RPC Backends</div>
            <div style={{ display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap" }}>
              {hardware && backendChips.length > 0 ? (
                backendChips.map((b) => (
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
              Exported over GGML RPC
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

      {/* ── CARD 4: CONNECTION MODE & ACCESS CONTROLS ───────────────── */}
      <div
        className="card"
        style={{
          padding: "18px 20px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div>
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: "var(--color-text)" }}>
              Connection Mode &amp; Access Controls
            </h2>
            <div style={{ fontSize: 11.5, color: "var(--color-text-3)", marginTop: 2 }}>
              Choose how other devices connect to this machine to share compute.
            </div>
          </div>

          {isListening && (
            <span className="badge badge-warn" style={{ fontSize: 11 }}>
              Stop sharing to modify connection settings
            </span>
          )}
        </div>

        {/* Two Connection Mode Option Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
          {/* Option 1: Encrypted Peer Tunnel (Default & Recommended) */}
          <div
            onClick={() => {
              if (isListening) return;
              setAllowRemoteAccess(false);
              setListenHost("127.0.0.1");
            }}
            style={{
              padding: "14px 16px",
              borderRadius: "var(--radius-sm)",
              border: !allowRemoteAccess
                ? "1.5px solid var(--color-accent)"
                : "1px solid var(--color-border)",
              background: !allowRemoteAccess
                ? "var(--color-accent-subtle)"
                : "var(--color-surface)",
              cursor: isListening ? "not-allowed" : "pointer",
              transition: "all var(--dur-fast)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: !allowRemoteAccess ? "var(--color-accent)" : "var(--color-border-strong)",
                  }}
                />
                <strong style={{ fontSize: 13, color: "var(--color-text)" }}>
                  Encrypted Peer Tunnel (Recommended)
                </strong>
              </div>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "1px 6px",
                  borderRadius: 3,
                  background: !allowRemoteAccess ? "var(--color-accent)" : "var(--color-surface-subtle)",
                  color: !allowRemoteAccess ? "#FFFFFF" : "var(--color-text-3)",
                }}
              >
                Safe &amp; Private
              </span>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--color-text-2)", margin: 0, lineHeight: 1.45 }}>
              Pairs securely via 6-digit PIN over Wi-Fi, 5G cellular, or USB. Operates on local loopback (127.0.0.1) with zero firewall configuration needed.
            </p>
          </div>

          {/* Option 2: Direct LAN Socket (Advanced) */}
          <div
            onClick={() => {
              if (isListening) return;
              setAllowRemoteAccess(true);
              const defaultLan = (status?.network_interfaces || []).find((ip: string) => ip !== "127.0.0.1") || "0.0.0.0";
              setListenHost(defaultLan);
            }}
            style={{
              padding: "14px 16px",
              borderRadius: "var(--radius-sm)",
              border: allowRemoteAccess
                ? "1.5px solid var(--color-accent)"
                : "1px solid var(--color-border)",
              background: allowRemoteAccess
                ? "var(--color-accent-subtle)"
                : "var(--color-surface)",
              cursor: isListening ? "not-allowed" : "pointer",
              transition: "all var(--dur-fast)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: allowRemoteAccess ? "var(--color-accent)" : "var(--color-border-strong)",
                  }}
                />
                <strong style={{ fontSize: 13, color: "var(--color-text)" }}>
                  Direct LAN Socket (Advanced)
                </strong>
              </div>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "1px 6px",
                  borderRadius: 3,
                  background: allowRemoteAccess ? "var(--color-accent)" : "var(--color-surface-subtle)",
                  color: allowRemoteAccess ? "#FFFFFF" : "var(--color-text-3)",
                }}
              >
                LAN / VPN
              </span>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--color-text-2)", margin: 0, lineHeight: 1.45 }}>
              Binds unencrypted RPC port directly to your home network or WireGuard subnet. Requires entering your controller PC's IP to restrict firewall access.
            </p>
          </div>
        </div>

        {/* Advanced Settings Drawer (Only visible when Direct LAN is active) */}
        {allowRemoteAccess && (
          <div
            className="animate-fade-in"
            style={{
              padding: "14px 16px",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface-subtle)",
              border: "1px solid var(--color-border)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--color-text)" }}>
              Direct LAN Configuration
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {/* Network Adapter */}
              <div>
                <label style={{ display: "block", fontSize: 11.5, fontWeight: 600, color: "var(--color-text)", marginBottom: 4 }}>
                  Network Interface
                </label>
                <select
                  value={listenHost}
                  onChange={(e) => setListenHost(e.target.value)}
                  disabled={isListening}
                  style={{
                    width: "100%",
                    padding: "7px 10px",
                    fontSize: 12,
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--color-border)",
                    background: "var(--color-surface)",
                    color: "var(--color-text)",
                    outline: "none",
                  }}
                >
                  {(status?.network_interfaces || [])
                    .filter((ip: string) => ip !== "127.0.0.1")
                    .map((ip: string) => {
                      const alias = status?.network_interface_names?.[ip];
                      return (
                        <option key={ip} value={ip}>
                          {formatInterfaceLabel(ip, alias)}
                        </option>
                      );
                    })}
                  <option value="0.0.0.0">All Interfaces (0.0.0.0) — Listen on all networks</option>
                </select>
              </div>

              {/* Port (Clean input without spinners) */}
              <div>
                <label style={{ display: "block", fontSize: 11.5, fontWeight: 600, color: "var(--color-text)", marginBottom: 4 }}>
                  RPC Port
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={rpcPort}
                  onChange={(e) => {
                    const clean = e.target.value.replace(/\D/g, "");
                    setRpcPort(parseInt(clean) || 50052);
                  }}
                  disabled={isListening}
                  className="mono"
                  style={{
                    width: "100%",
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

              {/* Controller IP */}
              <div>
                <label style={{ display: "block", fontSize: 11.5, fontWeight: 600, color: "var(--color-text)", marginBottom: 4 }}>
                  Authorized Controller IP
                </label>
                <input
                  type="text"
                  placeholder="e.g. 192.168.204.45 (Computer A)"
                  value={authorizedControllerIp}
                  onChange={(e) => setAuthorizedControllerIp(e.target.value)}
                  disabled={isListening}
                  className="mono"
                  style={{
                    width: "100%",
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
            </div>
          </div>
        )}

        {/* Compute Hardware Allocation (Threads) */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 10, borderTop: "1px solid var(--color-border)", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Cpu size={14} color="var(--color-accent)" />
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text)" }}>
              Dedicated Compute Threads:
            </span>
            <span style={{ fontSize: 11.5, color: "var(--color-text-3)" }}>
              (Leaves 2 cores free for system responsiveness)
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setThreads(Math.max(1, threads - 1))}
              disabled={isListening || threads <= 1}
              style={{ width: 28, height: 28, padding: 0 }}
            >
              -
            </button>
            <span className="mono" style={{ fontSize: 13, fontWeight: 700, minWidth: 32, textAlign: "center" }}>
              {threads}
            </span>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setThreads(Math.min(hardware?.logical_cores || 16, threads + 1))}
              disabled={isListening}
              style={{ width: 28, height: 28, padding: 0 }}
            >
              +
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
