import { useState, useId, useEffect } from "react";
import QRCode from "qrcode";
import { useWorkerMode } from "../hooks/useWorkerMode";
import { isAndroid } from "../lib/platform";
import {
  Server,
  Cpu,
  HardDrive,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  CheckCircle2,
  AlertTriangle,
  Play,
  Square,
  Copy,
  Check,
  RefreshCw,
  Terminal,
  Activity,
  Layers,
  ArrowRight,
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
    logs,
    isLoading,
    isStarting,
    isStopping,
    errorMessage,
    startWorker,
    stopWorker,
    revokeRemoteAccess,
    applyFirewallRule,
    saveConfig,
    refreshStatus,
    refreshHardware,
    checkFirewall,
    clearError,
  } = useWorkerMode();

  const [copiedEndpoint, setCopiedEndpoint] = useState(false);
  const [copiedFirewallCmd, setCopiedFirewallCmd] = useState(false);
  const [copiedPairing, setCopiedPairing] = useState(false);
  const [pairingQr, setPairingQr] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [firewallApplying, setFirewallApplying] = useState(false);
  const [firewallFeedback, setFirewallFeedback] = useState<string | null>(null);

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
  const backendDeviceId = useId();
  const targetRamMbId = useId();
  const targetVramMbId = useId();
  const allowRemoteAccessId = useId();
  const authorizedControllerIpId = useId();
  const backgroundRunEnabledId = useId();

  // Sync the form when authoritative configuration changes (initial load,
  // explicit save, or remote-access revocation). Polling never replaces the
  // config object, so this does not overwrite unsaved edits.
  useEffect(() => {
    if (!config) return;
    setRole(config.role);
    // Android compute nodes cannot be useful behind loopback and have no host
    // firewall to scope, so they always bind all interfaces.
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
  const currentState = status?.state || (isLoading ? "Loading" : "Unavailable");
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
    QRCode.toDataURL(pairingLink, { margin: 1, width: 240 })
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

  const handleCopyEndpoint = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedEndpoint(true);
    setTimeout(() => setCopiedEndpoint(false), 2000);
  };

  const handleCopyPairing = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedPairing(true);
    setTimeout(() => setCopiedPairing(false), 2000);
  };

  const handleCopyFirewall = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedFirewallCmd(true);
    setTimeout(() => setCopiedFirewallCmd(false), 2000);
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

  const handleApplyFirewall = async () => {
    setFirewallApplying(true);
    setFirewallFeedback(null);
    clearError();
    try {
      const res = await applyFirewallRule(Number(rpcPort), authorizedControllerIp);
      setFirewallFeedback(res);
      setTimeout(() => setFirewallFeedback(null), 4000);
    } catch {
      // Error handled by hook errorMessage
    } finally {
      setFirewallApplying(false);
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
    <div className="flex-1 overflow-y-auto bg-[#F4F5F0] p-6 text-[#2D312E]">
      <div className="mx-auto max-w-5xl space-y-6">

        {/* Top Header Card */}
        <div className="sticky top-0 z-10 rounded-xl border border-[#E2E4DC] bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-[#1B5E49]">
                <Server className="h-6 w-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-bold tracking-tight text-[#2D312E]">Worker Compute Mode</h1>
                  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${
                    isListening
                      ? "border border-emerald-200 bg-emerald-50 text-[#1B5E49]"
                      : isBusyOrStarting
                      ? "border border-amber-200 bg-amber-50 text-amber-800"
                      : "border border-stone-200 bg-stone-100 text-stone-600"
                  }`}>
                    {currentState}
                  </span>
                </div>
                <p className="text-xs text-[#6B7280]">
                  Share this device's GPU and CPU compute with other computers on your network.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              {!isAndroid && (isListening || status?.firewall_rule_installed || allowRemoteAccess) && (allowRemoteAccess || listenHost !== "127.0.0.1") && (
                <button
                  id="worker-revoke-remote-btn"
                  type="button"
                  onClick={handleRevokeRemoteAccess}
                  disabled={isBusyOrStarting || isLoading}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                  title="Immediately reset binding to 127.0.0.1, stop any active remote worker, and remove Swarm firewall rules"
                >
                  <ShieldX className="h-3.5 w-3.5 text-rose-600" />
                  <span>Revoke Remote Access</span>
                </button>
              )}

              <button
                id="worker-toggle-sharing-btn"
                type="button"
                onClick={handleToggleSharing}
                disabled={isBusyOrStarting || isLoading}
                className={`inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                  isListening
                    ? "bg-rose-700 hover:bg-rose-800 focus:ring-rose-600"
                    : "bg-[#1B5E49] hover:bg-[#154a3a] focus:ring-[#1B5E49]"
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {isListening ? (
                  <>
                    <Square className="h-4 w-4 fill-current" />
                    <span>Stop Sharing</span>
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 fill-current" />
                    <span>Start Sharing</span>
                  </>
                )}
              </button>

              {onSwitchToInference && (
                <button
                  id="worker-switch-inference-btn"
                  type="button"
                  onClick={onSwitchToInference}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#E2E4DC] bg-white px-3.5 py-2 text-xs font-medium text-[#2D312E] hover:bg-stone-50"
                >
                  <span>Open Chat Workspace</span>
                  <ArrowRight className="h-3.5 w-3.5 text-[#6B7280]" />
                </button>
              )}
            </div>
          </div>

          {/* Error Banner */}
          {errorMessage && (
            <div id="worker-error-banner" className="mt-4 flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
              <div className="flex-1">
                <span className="font-semibold">Worker Error: </span>
                {errorMessage}
              </div>
              <button
                type="button"
                onClick={clearError}
                className="font-medium text-rose-600 hover:text-rose-800"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Success Banner */}
          {saveSuccessMsg && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <span>{saveSuccessMsg}</span>
            </div>
          )}
        </div>

        {/* Operating Role Selection Card */}
        <div className="rounded-xl border border-[#E2E4DC] bg-white p-6 shadow-sm">
          <h2 className="mb-1 text-sm font-bold text-[#2D312E]">Operating Role</h2>
          <p className="mb-4 text-xs text-[#6B7280]">
            Select how this computer interacts with the Swarm distributed network.
          </p>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* Run Inference */}
            <div
              onClick={() => {
                setRole("inference");
                if (onSwitchToInference) onSwitchToInference();
              }}
              className={`cursor-pointer rounded-xl border p-4 transition-all ${
                role === "inference"
                  ? "border-[#1B5E49] bg-emerald-50/40 shadow-sm"
                  : "border-[#E2E4DC] bg-white hover:border-stone-300"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-[#1B5E49]">
                  <Activity className="h-4 w-4" />
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
                  className="text-[#1B5E49] focus:ring-[#1B5E49]"
                />
              </div>
              <h3 className="mt-3 text-xs font-bold text-[#2D312E]">Run Inference</h3>
              <p className="mt-1 text-[11px] leading-relaxed text-[#6B7280]">
                Controller mode. Coordinates local and remote devices to execute prompts.
              </p>
            </div>

            {/* Provide Compute */}
            <div
              onClick={() => setRole("worker")}
              className={`cursor-pointer rounded-xl border p-4 transition-all ${
                role === "worker"
                  ? "border-[#1B5E49] bg-emerald-50/40 shadow-sm"
                  : "border-[#E2E4DC] bg-white hover:border-stone-300"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-[#1B5E49]">
                  <Server className="h-4 w-4" />
                </div>
                <input
                  id={roleWorkerId}
                  type="radio"
                  name="operatingRole"
                  checked={role === "worker"}
                  onChange={() => setRole("worker")}
                  className="text-[#1B5E49] focus:ring-[#1B5E49]"
                />
              </div>
              <h3 className="mt-3 text-xs font-bold text-[#2D312E]">Provide Compute</h3>
              <p className="mt-1 text-[11px] leading-relaxed text-[#6B7280]">
                Worker mode. Shares local GPU and CPU compute with other computers on your network.
              </p>
            </div>

            {/* Combined Mode */}
            <div
              onClick={() => setRole("combined")}
              className={`cursor-pointer rounded-xl border p-4 transition-all ${
                role === "combined"
                  ? "border-[#1B5E49] bg-emerald-50/40 shadow-sm"
                  : "border-[#E2E4DC] bg-white hover:border-stone-300"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-[#1B5E49]">
                  <Layers className="h-4 w-4" />
                </div>
                <input
                  id={roleCombinedId}
                  type="radio"
                  name="operatingRole"
                  checked={role === "combined"}
                  onChange={() => setRole("combined")}
                  className="text-[#1B5E49] focus:ring-[#1B5E49]"
                />
              </div>
              <h3 className="mt-3 text-xs font-bold text-[#2D312E]">Combined Mode</h3>
              <p className="mt-1 text-[11px] leading-relaxed text-[#6B7280]">
                Run local models while sharing spare compute with other devices.
              </p>
            </div>
          </div>
        </div>

        {/* Hardware & Measured Telemetry Card */}
        <div className="rounded-xl border border-[#E2E4DC] bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="h-5 w-5 text-[#1B5E49]" />
              <h2 className="text-sm font-bold text-[#2D312E]">Hardware & Measured Telemetry</h2>
            </div>
            <button
              id="worker-probe-hardware-btn"
              type="button"
              onClick={refreshHardware}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[#6B7280] hover:bg-stone-50 hover:text-[#2D312E]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Probe Again</span>
            </button>
          </div>
          <p className="mt-1 text-xs text-[#6B7280]">
            Observed hardware capacity and available headroom.
          </p>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* CPU Box */}
            <div className="rounded-lg border border-[#E2E4DC] bg-stone-50/50 p-4">
              <div className="text-[11px] font-medium uppercase tracking-wider text-[#6B7280]">Processor</div>
              <div className="mt-1 truncate text-xs font-bold text-[#2D312E]" title={hardware?.cpu_name || "Unavailable"}>
                {hardware?.cpu_name ? cleanCpuName(hardware.cpu_name) : "Unavailable"}
              </div>
              <div className="mt-1 text-[11px] text-[#6B7280]">
                {hardware ? `${hardware.logical_cores} logical cores available` : "Telemetry unavailable"}
              </div>
            </div>

            {/* Host RAM Box */}
            <div className="rounded-lg border border-[#E2E4DC] bg-stone-50/50 p-4">
              <div className="text-[11px] font-medium uppercase tracking-wider text-[#6B7280]">Physical RAM</div>
              <div className="mt-1 text-xs font-bold text-[#2D312E]">
                {hardware ? `${hardware.available_ram_mb.toLocaleString()} MB free` : "Unavailable"}
              </div>
              <div className="mt-1 text-[11px] text-[#6B7280]">
                {hardware ? `${hardware.total_ram_mb.toLocaleString()} MB total` : "Telemetry unavailable"}
              </div>
            </div>

            {/* GPU VRAM Box */}
            <div className="rounded-lg border border-[#E2E4DC] bg-stone-50/50 p-4">
              <div className="text-[11px] font-medium uppercase tracking-wider text-[#6B7280]">Graphics / VRAM</div>
              <div className="mt-1 truncate text-xs font-bold text-[#2D312E]" title={hardware?.gpu_name || "Unavailable"}>
                {hardware ? (hardware.gpu_name || "CPU-only") : "Unavailable"}
              </div>
              <div className="mt-1 text-[11px] text-[#6B7280]">
                {!hardware
                  ? "Telemetry unavailable"
                  : hardware.available_vram_mb
                    ? `${hardware.available_vram_mb.toLocaleString()} MB VRAM free`
                    : hardware.gpu_name
                      ? "VRAM reading unavailable"
                      : "No discrete VRAM reading"}
              </div>
            </div>

            {/* Supported Backends Box */}
            <div className="rounded-lg border border-[#E2E4DC] bg-stone-50/50 p-4">
              <div className="text-[11px] font-medium uppercase tracking-wider text-[#6B7280]">RPC Backends</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {hardware && hardware.supported_backends.length > 0 ? (
                  hardware.supported_backends.map((b) => (
                    <span
                      key={b}
                      className="inline-flex items-center rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-[#1B5E49]"
                    >
                      {b}
                    </span>
                  ))
                ) : (
                  <span className="text-[11px] text-[#6B7280]">Unavailable</span>
                )}
              </div>
              <div className="mt-1 text-[11px] text-[#6B7280]">
                {hardware ? "Native RPC Server binary installed" : "Telemetry unavailable"}
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-end text-[11px] text-[#6B7280]">
            <span>Last observed: {hardware?.timestamp_ms ? new Date(hardware.timestamp_ms).toLocaleTimeString() : "—"}</span>
          </div>
        </div>

        {/* Network & Controller Security Card */}
        <div className="rounded-xl border border-[#E2E4DC] bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Wifi className="h-5 w-5 text-[#1B5E49]" />
              <h2 className="text-sm font-bold text-[#2D312E]">Network Exposure & Security Controls</h2>
            </div>
            {isListening && (
              <span className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-medium text-amber-800">
                Stop compute sharing to modify network settings
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-[#6B7280]">
            Configure listening interface and verify access scope before starting compute sharing.
          </p>

          {/* Plaintext Transport Security Warning */}
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/80 p-4 text-xs text-amber-900">
            <div className="flex items-start gap-2.5">
              <ShieldAlert className="h-4 w-4 shrink-0 text-amber-700" />
              <div className="space-y-1">
                <span className="font-bold">RPC Security Notice (Unauthenticated Plaintext Transport): </span>
                <p className="leading-relaxed text-amber-800">
                  GGML RPC inference transport is unencrypted and lacks cryptographic node authentication. For remote compute sharing, use a trusted Local Area Network (LAN) or a private WireGuard / Tailscale VPN. Do not expose port {rpcPort} directly to the public internet.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
            {/* Listening Interface Selection */}
            <div className="space-y-2">
              <label htmlFor={listenHostId} className="block text-xs font-semibold text-[#2D312E]">
                Listening Network Interface
              </label>
              <select
                id={listenHostId}
                value={listenHost}
                onChange={(e) => setListenHost(e.target.value)}
                disabled={isListening}
                className="w-full rounded-lg border border-[#E2E4DC] bg-white px-3 py-2 text-xs text-[#2D312E] focus:border-[#1B5E49] focus:outline-none focus:ring-1 focus:ring-[#1B5E49] disabled:bg-stone-100"
              >
                <option value="127.0.0.1">Loopback Only (127.0.0.1) — Safe Local RPC</option>
                <option value="0.0.0.0">All Network Interfaces (0.0.0.0) — LAN / VPN Sharing</option>
                {(status?.network_interfaces || [])
                  .filter((ip) => ip !== "127.0.0.1")
                  .map((ip) => (
                    <option key={ip} value={ip}>
                      {ip} (Local Network Adapter)
                    </option>
                  ))}
              </select>
              <p className="text-[11px] text-[#6B7280]">
                {listenHost === "127.0.0.1"
                  ? "Accessible only from this computer. Recommended for local testing."
                  : "Accessible from other computers on your LAN or VPN."}
              </p>
            </div>

            {/* Port & Threads */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label htmlFor={rpcPortId} className="block text-xs font-semibold text-[#2D312E]">RPC Port</label>
                <input
                  id={rpcPortId}
                  type="number"
                  value={rpcPort}
                  onChange={(e) => setRpcPort(parseInt(e.target.value) || 50052)}
                  disabled={isListening}
                  className="w-full rounded-lg border border-[#E2E4DC] px-3 py-2 text-xs text-[#2D312E] focus:border-[#1B5E49] focus:outline-none focus:ring-1 focus:ring-[#1B5E49] disabled:bg-stone-100"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor={threadsId} className="block text-xs font-semibold text-[#2D312E]">Compute Threads</label>
                <input
                  id={threadsId}
                  type="number"
                  min="1"
                  max={hardware?.logical_cores || 16}
                  value={threads}
                  onChange={(e) => setThreads(parseInt(e.target.value) || 2)}
                  disabled={isListening}
                  className="w-full rounded-lg border border-[#E2E4DC] px-3 py-2 text-xs text-[#2D312E] focus:border-[#1B5E49] focus:outline-none focus:ring-1 focus:ring-[#1B5E49] disabled:bg-stone-100"
                />
              </div>
            </div>

            {/* Remote Access Authorization (desktop) / Android policy note */}
            {isAndroid ? (
              <div className="col-span-full rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 text-emerald-600" />
                  <div className="space-y-1">
                    <span className="text-xs font-bold text-[#2D312E]">
                      Android Compute Nodes Always Share on the Local Network
                    </span>
                    <p className="text-[11px] leading-relaxed text-[#6B7280]">
                      A loopback-only worker cannot serve a Swarm controller, so this device binds to
                      all interfaces. Android exposes no inbound host firewall to scope by controller
                      address; the encrypted Swarm relay tunnel is the access boundary.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* Remote Access Authorization Checkbox */}
                <div className="col-span-full rounded-lg border border-[#E2E4DC] bg-stone-50/50 p-4">
                  <div className="flex items-start gap-3">
                    <input
                      id={allowRemoteAccessId}
                      type="checkbox"
                      checked={allowRemoteAccess}
                      onChange={(e) => setAllowRemoteAccess(e.target.checked)}
                      disabled={isListening}
                      className="mt-0.5 rounded border-stone-300 text-[#1B5E49] focus:ring-[#1B5E49]"
                    />
                    <div className="space-y-1">
                      <label htmlFor={allowRemoteAccessId} className="text-xs font-bold text-[#2D312E]">
                        Authorize Remote Compute Sharing
                      </label>
                      <p className="text-[11px] leading-relaxed text-[#6B7280]">
                        Required before binding to non-loopback addresses (0.0.0.0 or LAN IP). Confirms you understand this exposes the GGML RPC worker on your network.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Authorized Controller IP Field */}
                <div className="space-y-2">
                  <label htmlFor={authorizedControllerIpId} className="block text-xs font-semibold text-[#2D312E]">
                    Authorized Controller IP Address (Optional)
                  </label>
                  <input
                    id={authorizedControllerIpId}
                    type="text"
                    placeholder="e.g. 192.168.1.50"
                    value={authorizedControllerIp}
                    onChange={(e) => setAuthorizedControllerIp(e.target.value)}
                    disabled={isListening}
                    className="w-full rounded-lg border border-[#E2E4DC] px-3 py-2 text-xs text-[#2D312E] focus:border-[#1B5E49] focus:outline-none focus:ring-1 focus:ring-[#1B5E49] disabled:bg-stone-100"
                  />
                  <p className="text-[11px] text-[#6B7280]">
                    Restricts or documents the intended Swarm Controller address on Computer A.
                  </p>
                </div>
              </>
            )}

            {/* Copyable Connection Details */}
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-[#2D312E]">
                Worker Connection Endpoint for Controller
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={status?.advertised_endpoint || `127.0.0.1:${rpcPort}`}
                  className="w-full rounded-lg border border-[#E2E4DC] bg-stone-50 px-3 py-2 font-mono text-xs text-[#2D312E] select-all"
                />
                <button
                  type="button"
                  onClick={() => handleCopyEndpoint(status?.advertised_endpoint || `127.0.0.1:${rpcPort}`)}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#E2E4DC] bg-white px-3 py-2 text-xs font-medium text-[#2D312E] hover:bg-stone-50"
                  title="Copy endpoint to clipboard"
                >
                  {copiedEndpoint ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4 text-[#6B7280]" />}
                  <span>{copiedEndpoint ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <p className="text-[11px] text-[#6B7280]">
                Paste this endpoint in Computer A's <strong>Add Worker Computer</strong> dialog.
              </p>
            </div>

            {isAndroid && isListening && pairingCode && (
              <div className="col-span-full rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Wifi className="h-4 w-4 text-emerald-700" />
                      <span className="text-sm font-bold text-[#2D312E]">Pair with your computer</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-[#6B7280]">
                      On your computer, open <strong>Devices</strong> → <strong>Add device</strong> and
                      enter this code. It works anywhere, including mobile data.
                    </p>
                    <div className="mt-3 font-mono text-3xl font-bold tracking-[0.25em] text-[#1B5E49]">
                      {pairingCode.replace(/^(\d{3})(\d{3})$/, "$1 $2")}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => handleCopyPairing(pairingCode)}
                        className="inline-flex items-center gap-1 rounded-lg bg-[#1B5E49] px-3 py-2 text-xs font-semibold text-white hover:bg-[#164C3C]"
                      >
                        {copiedPairing ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        <span>{copiedPairing ? "Copied" : "Copy code"}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCopyPairing(pairingLink)}
                        className="inline-flex items-center gap-1 rounded-lg border border-[#E2E4DC] bg-white px-3 py-2 text-xs font-medium text-[#2D312E] hover:bg-stone-50"
                      >
                        <Copy className="h-4 w-4 text-[#6B7280]" />
                        <span>Copy pairing link</span>
                      </button>
                    </div>
                    <p className="mt-2 text-[10px] text-[#6B7280]">
                      This code is private and changes every time you start sharing.
                    </p>
                  </div>
                  {pairingQr && (
                    <div className="shrink-0 rounded-lg border border-emerald-200 bg-white p-2">
                      <img src={pairingQr} alt="Pairing QR code" className="h-28 w-28" />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Host Firewall / Network Policy Status */}
          {isAndroid ? (
            <div className="mt-4 rounded-lg border border-[#E2E4DC] bg-stone-50/70 p-4">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 text-emerald-600" />
                <div>
                  <span className="text-xs font-semibold text-[#2D312E]">
                    Network Policy: Android (No Host Firewall)
                  </span>
                  <p className="text-[11px] text-[#6B7280]">
                    Android exposes no inbound host firewall to applications. The worker listens on all
                    interfaces at port {rpcPort} and is reachable by the Swarm controller on your local network.
                  </p>
                </div>
              </div>
            </div>
          ) : (
          <div className="mt-4 rounded-lg border border-[#E2E4DC] bg-stone-50/70 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                {listenHost === "127.0.0.1" || !allowRemoteAccess ? (
                  <ShieldCheck className="h-4 w-4 text-stone-500" />
                ) : status?.firewall_status === "RestrictedAndVerified" ? (
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                ) : status?.firewall_status === "UnrestrictedWarning" ? (
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                ) : (
                  <ShieldAlert className="h-4 w-4 text-rose-600" />
                )}
                <div>
                  <span className="text-xs font-semibold text-[#2D312E]">
                    Firewall Policy:{" "}
                    {listenHost === "127.0.0.1" || !allowRemoteAccess
                      ? "Loopback Only (No Rule Required)"
                      : status?.firewall_status === "RestrictedAndVerified"
                      ? `Scoped & Restricted (Controller: ${status.firewall_remote_address})`
                      : status?.firewall_status === "UnrestrictedWarning"
                      ? "Warning: Unrestricted Rule Detected (Open to All IPs)"
                      : status?.firewall_status === "ControllerMismatch"
                      ? `Rule Scope Mismatch (Rule: ${status.firewall_remote_address})`
                      : "Firewall Rule Missing"}
                  </span>
                  <p className="text-[11px] text-[#6B7280]">
                    {listenHost === "127.0.0.1" || !allowRemoteAccess
                      ? "Worker listens on 127.0.0.1 only. External incoming connections are blocked by the OS network stack."
                      : status?.firewall_status === "RestrictedAndVerified"
                      ? `Windows Firewall restricts port ${rpcPort} solely to controller ${status.firewall_remote_address} on Private/Domain networks.`
                      : status?.firewall_status === "UnrestrictedWarning"
                      ? `An unrestricted rule for port ${rpcPort} was detected. For security, apply a scoped rule restricting access to the controller IP.`
                      : `Remote access requires an inbound rule on TCP port ${rpcPort} restricted to the authorized controller.`}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {allowRemoteAccess && status?.firewall_status !== "RestrictedAndVerified" && (
                  <button
                    type="button"
                    onClick={handleApplyFirewall}
                    disabled={firewallApplying || !authorizedControllerIp.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#1B5E49] px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-[#154a3a] disabled:cursor-not-allowed disabled:opacity-50"
                    title={!authorizedControllerIp.trim() ? "Enter an Authorized Controller IP first" : "Configure scoped Windows Firewall rule"}
                  >
                    {firewallApplying ? <RefreshCw className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                    <span>Apply Scoped Rule</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={checkFirewall}
                  className="text-[11px] font-medium text-[#1B5E49] hover:underline"
                >
                  Recheck
                </button>
              </div>
            </div>

            {firewallFeedback && (
              <div className="mt-3 flex items-center gap-2 rounded bg-emerald-50 p-2.5 text-xs text-emerald-800">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                <span>{firewallFeedback}</span>
              </div>
            )}

            {allowRemoteAccess && status?.firewall_status !== "RestrictedAndVerified" && (
              <div className="mt-3 space-y-1.5 border-t border-[#E2E4DC] pt-3">
                <p className="text-[11px] text-[#6B7280]">
                  If automatic configuration requires elevation, open an elevated (Administrator) PowerShell terminal and run:
                </p>
                <div className="flex items-center gap-2 rounded bg-stone-100 p-2 font-mono text-[11px] text-[#2D312E]">
                  <span className="flex-1 truncate select-all">
                    {status?.firewall_command ||
                      `New-NetFirewallRule -Name 'Swarm_RPC_Worker_${rpcPort}' -DisplayName 'Swarm GGML RPC (Port ${rpcPort})' -Group 'Swarm Compute' -Direction Inbound -LocalPort ${rpcPort} -Protocol TCP${authorizedControllerIp ? ` -RemoteAddress '${authorizedControllerIp}'` : ""} -Profile Private,Domain -Action Allow`}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      handleCopyFirewall(
                        status?.firewall_command ||
                          `New-NetFirewallRule -Name 'Swarm_RPC_Worker_${rpcPort}' -DisplayName 'Swarm GGML RPC (Port ${rpcPort})' -Group 'Swarm Compute' -Direction Inbound -LocalPort ${rpcPort} -Protocol TCP${authorizedControllerIp ? ` -RemoteAddress '${authorizedControllerIp}'` : ""} -Profile Private,Domain -Action Allow`
                      )
                    }
                    className="text-[#6B7280] hover:text-[#2D312E]"
                    title="Copy PowerShell command"
                  >
                    {copiedFirewallCmd ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            )}
          </div>
          )}

          {/* Active Connection & Config Path Status */}
          <div className="mt-4 rounded-lg border border-[#E2E4DC] bg-stone-50/50 p-4 space-y-2 text-xs">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <span className="font-semibold text-[#2D312E]">Active TCP Transport Connections:</span>
              <span className="font-mono text-[11px] text-[#2D312E]">
                {status?.active_client_connections && status.active_client_connections.length > 0
                  ? status.active_client_connections.join(", ")
                  : isListening
                  ? "No remote controller currently connected"
                  : "Worker stopped"}
              </span>
            </div>
            {status?.active_client_connections && status.active_client_connections.length > 0 && (
              <p className="text-[11px] text-amber-800">
                * Note: Established TCP socket observed on port {rpcPort}. GGML RPC does not perform cryptographic client authentication; verify your controller network IP.
              </p>
            )}
            <div className="flex flex-col gap-1 border-t border-[#E2E4DC] pt-2 sm:flex-row sm:items-center sm:justify-between text-[11px] text-[#6B7280]">
              <span>Canonical Configuration Path:</span>
              <span className="font-mono text-[10px] text-[#2D312E] select-all">
                {status?.canonical_config_path || "%APPDATA%\\Swarm\\config\\worker_mode_config.json"}
              </span>
            </div>
          </div>
        </div>

        {/* Resource Participation & Target Headroom Card */}
        <div className="rounded-xl border border-[#E2E4DC] bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <HardDrive className="h-5 w-5 text-[#1B5E49]" />
            <h2 className="text-sm font-bold text-[#2D312E]">Resource Participation & Target Headroom</h2>
          </div>
          <p className="mt-1 text-xs text-[#6B7280]">
            Set advisory sharing targets. Tensor splitting distributes layers across nodes; actual consumption is bounded by model size.
          </p>

          <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2">
            {/* Target RAM Contribution */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor={targetRamMbId} className="text-xs font-semibold text-[#2D312E]">
                  Host RAM Sharing Target
                </label>
                <span className="font-mono text-xs font-bold text-[#1B5E49]">{targetRamMb} MB</span>
              </div>
              <input
                id={targetRamMbId}
                type="range"
                min="512"
                max={Math.max(hardware?.total_ram_mb ? hardware.total_ram_mb - 1024 : 8192, 1024)}
                step="256"
                value={targetRamMb}
                onChange={(e) => setTargetRamMb(parseInt(e.target.value) || 2048)}
                disabled={isListening}
                className="w-full accent-[#1B5E49] disabled:opacity-50"
              />
              <div className="flex justify-between text-[10px] text-[#6B7280]">
                <span>512 MB</span>
                <span>Safety Headroom: 1,024 MB reserved for OS</span>
              </div>
            </div>

            {/* Target VRAM Contribution */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor={targetVramMbId} className="text-xs font-semibold text-[#2D312E]">
                  GPU VRAM Sharing Target
                </label>
                <span className="font-mono text-xs font-bold text-[#1B5E49]">{targetVramMb} MB</span>
              </div>
              <input
                id={targetVramMbId}
                type="range"
                min="256"
                max={hardware?.total_vram_mb || 4096}
                step="256"
                value={targetVramMb}
                onChange={(e) => setTargetVramMb(parseInt(e.target.value) || 2048)}
                disabled={isListening}
                className="w-full accent-[#1B5E49] disabled:opacity-50"
              />
              <div className="flex justify-between text-[10px] text-[#6B7280]">
                <span>256 MB</span>
                <span>Display Headroom: 256 MB reserved for GUI</span>
              </div>
            </div>

            {/* Backend Selector */}
            <div className="space-y-2">
              <label htmlFor={backendDeviceId} className="block text-xs font-semibold text-[#2D312E]">Backend Acceleration</label>
              <select
                id={backendDeviceId}
                value={backendDevice}
                onChange={(e) => setBackendDevice(e.target.value)}
                disabled={isListening}
                className="w-full rounded-lg border border-[#E2E4DC] bg-white px-3 py-2 text-xs text-[#2D312E] focus:border-[#1B5E49] focus:outline-none focus:ring-1 focus:ring-[#1B5E49] disabled:bg-stone-100"
              >
                {isAndroid ? (
                  <>
                    <option value="all">Automatic (ARM NEON CPU)</option>
                    <option value="cpu">CPU Only (ARM NEON)</option>
                    <option value="vulkan">Vulkan GPU (Experimental)</option>
                  </>
                ) : (
                  <>
                    <option value="all">Automatic (GPU CUDA + CPU Fallback)</option>
                    <option value="cuda">CUDA GPU Only</option>
                    <option value="cpu">CPU Only (No GPU offloading)</option>
                  </>
                )}
              </select>
            </div>

            {/* Background Operation Setting */}
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-[#2D312E]">Background Operation</label>
              <div className="flex items-center gap-3 pt-1">
                <input
                  id={backgroundRunEnabledId}
                  type="checkbox"
                  checked={backgroundRunEnabled}
                  onChange={(e) => setBackgroundRunEnabled(e.target.checked)}
                  disabled={isListening}
                  className="rounded border-stone-300 text-[#1B5E49] focus:ring-[#1B5E49]"
                />
                <label htmlFor={backgroundRunEnabledId} className="text-xs text-[#2D312E]">
                  Keep worker active when desktop app is minimized
                </label>
              </div>
            </div>
          </div>

          {/* Action Row */}
          <div className="mt-5 flex items-center justify-end gap-3 border-t border-[#E2E4DC] pt-4">
            {isListening && (
              <span className="text-[11px] text-stone-500 italic">
                (Worker active · Stop sharing above to edit and save changes)
              </span>
            )}
            <button
              id="worker-save-settings-btn"
              type="button"
              onClick={handleSaveSettings}
              disabled={isListening || isBusyOrStarting}
              title={isListening ? "Stop compute sharing to save configuration changes" : "Save configuration changes"}
              className="rounded-lg border border-[#E2E4DC] bg-white px-4 py-2 text-xs font-semibold text-[#2D312E] shadow-sm hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save Configuration
            </button>
          </div>
        </div>

        {/* Live Diagnostics & Process Log Card */}
        <div className="rounded-xl border border-[#E2E4DC] bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="h-5 w-5 text-[#1B5E49]" />
              <h2 className="text-sm font-bold text-[#2D312E]">Live Diagnostics & Native Logs</h2>
            </div>
            <button
              id="worker-toggle-logs-btn"
              type="button"
              onClick={() => setShowLogs(!showLogs)}
              className="text-xs font-medium text-[#1B5E49] hover:underline"
            >
              {showLogs ? "Hide Logs" : "Show Logs"}
            </button>
          </div>

          <div className="mt-3 flex items-center gap-4 text-xs text-[#6B7280]">
            <div>
              <span className="font-semibold text-[#2D312E]">Native Process PID: </span>
              {status ? (status.pid || "None") : "Unavailable"}
            </div>
            <div>
              <span className="font-semibold text-[#2D312E]">Listening Socket: </span>
              {status ? (status.listen_endpoint || "None") : "Unavailable"}
            </div>
            <div>
              <span className="font-semibold text-[#2D312E]">Uptime: </span>
              {status ? `${status.uptime_secs}s` : "Unavailable"}
            </div>
          </div>

          {showLogs && (
            <div className="mt-4 rounded-lg bg-stone-900 p-4 font-mono text-[11px] text-stone-200">
              <div className="mb-2 flex items-center justify-between border-b border-stone-700 pb-1 text-[10px] text-stone-400 uppercase">
                <span>Recent Output ({logs.length} lines)</span>
                <button
                  type="button"
                  onClick={refreshStatus}
                  className="hover:text-stone-200"
                >
                  Refresh
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {logs.length > 0 ? (
                  logs.map((line, idx) => (
                    <div key={idx} className="leading-tight">
                      {line}
                    </div>
                  ))
                ) : (
                  <div className="text-stone-500 italic">No logs available (worker stopped or idle).</div>
                )}
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
