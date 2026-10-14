import { useState, useEffect, useCallback } from "react";
import QRCode from "qrcode";
import { useSwarmSession } from "../hooks/useSwarmSession";
import { useSupervisor } from "../hooks/useSupervisor";
import {
  supervisor,
  type RemoteWorkerConfig,
  type WorkerProbeResult,
  type HostNetworkInfo,
} from "../lib/supervisor";
import { fmtBytes } from "../lib/utils";
import {
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
  AlertCircle,
  Shield,
  Laptop,
  QrCode,
  Activity,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Trash2,
  ArrowRight,
  ArrowLeft,
  Terminal,
  Plus,
  Info,
  Sliders,
  Layers,
} from "lucide-react";
import { ComputeAllocationModal } from "./ComputeAllocationModal";

type OnboardingStep = 1 | 2 | 3 | 4 | 5;
type OnboardingMethod = "manual" | "qr";

export function DevicesPanel() {
  const session = useSwarmSession(3000);
  const {
    profiles,
    selectedProfileId,
    startEngine,
    stopEngine,
    engineStatus,
    isStarting,
    isStopping,
  } = useSupervisor(3000);

  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("device-host-local");
  const [showTechnical, setShowTechnical] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isRestartingCoordinator, setIsRestartingCoordinator] = useState(false);

  // Registered remote workers managed locally / via supervisor
  const [registeredWorkers, setRegisteredWorkers] = useState<RemoteWorkerConfig[]>([]);
  const [probingWorkerId, setProbingWorkerId] = useState<string | null>(null);
  const [workerProbeFeedback, setWorkerProbeFeedback] = useState<Record<string, WorkerProbeResult>>({});

  // Compute Allocation Modal State
  const [showAllocationModal, setShowAllocationModal] = useState(false);

  // ─────────────────────────────────────────────
  // 5-Step Guided Onboarding State
  // ─────────────────────────────────────────────
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [currentStep, setCurrentStep] = useState<OnboardingStep>(1);
  const [method, setMethod] = useState<OnboardingMethod>("manual");

  // Step 2 Configuration State
  const [workerHost, setWorkerHost] = useState("");
  const [workerPort, setWorkerPort] = useState("50052");
  const [workerName, setWorkerName] = useState("");
  const [addressTouched, setAddressTouched] = useState(false);
  const [portTouched, setPortTouched] = useState(false);

  // Host Network Information for QR pairing
  const [hostNetwork, setHostNetwork] = useState<HostNetworkInfo | null>(null);
  const [selectedHostIp, setSelectedHostIp] = useState<string>("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Step 3 Live Probe State
  const [isProbing, setIsProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<WorkerProbeResult | null>(null);

  // Step 4 Verification / Monitoring State
  const [isVerifyingDaemon, setIsVerifyingDaemon] = useState(false);
  const [daemonVerified, setDaemonVerified] = useState(false);

  // Load registered workers from supervisor or local storage
  const loadWorkers = useCallback(async () => {
    try {
      const workers = await supervisor.getRegisteredWorkers();
      setRegisteredWorkers(workers);
    } catch (err) {
      console.warn("Failed to load registered workers:", err);
    }
  }, []);

  useEffect(() => {
    loadWorkers();
  }, [loadWorkers]);

  // Load host network info when opening onboarding
  useEffect(() => {
    if (showOnboarding) {
      supervisor.getHostNetworkInfo().then((info) => {
        if (info) {
          setHostNetwork(info);
          setSelectedHostIp(info.preferred_ip || info.ip_addresses[0] || "127.0.0.1");
        }
      });
    }
  }, [showOnboarding]);

  // Copy helper
  const copyCmd = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Validation
  const cleanIp = workerHost.trim();
  const cleanPort = workerPort.trim();
  const ipv4Octets = cleanIp.split(".");
  const isIpv4 =
    ipv4Octets.length === 4 &&
    ipv4Octets.every((oct) => /^\d{1,3}$/.test(oct) && Number(oct) >= 0 && Number(oct) <= 255);
  const hostnamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  const isHostname = cleanIp.length > 2 && hostnamePattern.test(cleanIp) && !isIpv4;
  const isAddressValid = isIpv4 || isHostname;

  const portNum = Number(cleanPort);
  const isPortValid = !isNaN(portNum) && Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;

  let addressError: string | null = null;
  if (addressTouched && cleanIp.length > 0 && !isAddressValid) {
    addressError = "Please enter a valid private IPv4 address (e.g. 192.168.1.50) or mesh hostname.";
  }

  let portError: string | null = null;
  if (portTouched && !isPortValid) {
    portError = "Port must be an integer between 1 and 65535 (default: 50052).";
  }

  const isFormValid = isAddressValid && isPortValid;
  const effectiveWorkerIp = isAddressValid ? cleanIp : "192.168.x.x";
  const effectiveWorkerPort = isPortValid ? cleanPort : "50052";
  const effectiveHostIp = selectedHostIp || hostNetwork?.preferred_ip || "127.0.0.1";

  // Generate scoped QR pairing payload (omitting sensitive long-lived bearer tokens for security)
  const pairingPayload = JSON.stringify({
    coord: `http://${effectiveHostIp}:8080`,
    rpc_port: Number(effectiveWorkerPort),
    host: hostNetwork?.hostname || "Host-PC",
    mode: "lan_pairing",
    network: "private_lan",
  });

  // Render QR Code as PNG data URL
  useEffect(() => {
    if (showOnboarding && method === "qr") {
      QRCode.toDataURL(pairingPayload, {
        width: 176,
        margin: 1,
        color: {
          dark: "#1C2024",
          light: "#FFFFFF",
        },
      })
        .then((url) => setQrDataUrl(url))
        .catch((err) => console.error("QR Code generation error:", err));
    }
  }, [showOnboarding, method, pairingPayload]);

  // Step 3: Run Live Connection Probe
  const executeConnectionProbe = async (host = cleanIp, port = portNum) => {
    setIsProbing(true);
    setProbeResult(null);
    try {
      const res = await supervisor.probeWorkerEndpoint(host, port, 3500);
      setProbeResult(res);
    } catch (err) {
      setProbeResult({
        reachable: false,
        host,
        port,
        latency_ms: 0,
        status_state: "ERROR",
        message: err instanceof Error ? err.message : String(err),
        actionable_recovery: "Ensure Computer B is connected to the same LAN or VPN subnet.",
      });
    } finally {
      setIsProbing(false);
    }
  };

  // Step 4: Verify Worker Daemon
  const executeDaemonCheck = async () => {
    setIsVerifyingDaemon(true);
    try {
      const res = await supervisor.probeWorkerEndpoint(cleanIp, portNum, 3000);
      if (res.reachable) {
        setDaemonVerified(true);
      } else {
        setDaemonVerified(false);
      }
      setProbeResult(res);
    } catch {
      setDaemonVerified(false);
    } finally {
      setIsVerifyingDaemon(false);
    }
  };

  // Restart coordinator safely: stops existing cluster if running, then starts with updated endpoints
  const handleRestartCoordinator = async () => {
    setIsRestartingCoordinator(true);
    try {
      if (engineStatus?.coord_healthy || engineStatus?.state === "Ready") {
        await stopEngine();
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      await startEngine(true);
      await loadWorkers();
      session.refetch();
    } catch (err) {
      console.error("Failed to restart coordinator:", err);
    } finally {
      setIsRestartingCoordinator(false);
    }
  };

  // Step 5: Save & Register Worker
  const handleCompleteRegistration = async (restartEngine = false) => {
    const newWorker: RemoteWorkerConfig = {
      id: `worker-${cleanIp.replace(/\./g, "-")}-${cleanPort}`,
      name: workerName.trim() || `Helper (${cleanIp})`,
      host: cleanIp,
      port: portNum,
      added_at_ms: Date.now(),
      is_active: true,
    };

    try {
      const updated = await supervisor.registerWorker(newWorker);
      setRegisteredWorkers(updated);
      await loadWorkers();
      session.refetch();

      if (restartEngine) {
        await handleRestartCoordinator();
      }
    } catch (err) {
      console.error("Failed to register worker:", err);
    } finally {
      closeOnboarding();
    }
  };

  const closeOnboarding = () => {
    setShowOnboarding(false);
    setCurrentStep(1);
    setProbeResult(null);
    setDaemonVerified(false);
    setAddressTouched(false);
    setPortTouched(false);
  };

  // Quick probe on worker card in list
  const probeWorkerCard = async (wId: string, host: string, port: number) => {
    setProbingWorkerId(wId);
    try {
      const res = await supervisor.probeWorkerEndpoint(host, port, 2500);
      setWorkerProbeFeedback((prev) => ({ ...prev, [wId]: res }));
      setTimeout(() => {
        setWorkerProbeFeedback((prev) => {
          const next = { ...prev };
          delete next[wId];
          return next;
        });
      }, 5000);
    } catch (err) {
      console.warn("Probe failed:", err);
    } finally {
      setProbingWorkerId(null);
    }
  };

  // Remove worker
  const handleRemoveWorker = async (wId: string) => {
    try {
      const updated = await supervisor.removeWorker(wId);
      setRegisteredWorkers(updated);
      await loadWorkers();
      session.refetch();
    } catch (err) {
      console.error("Failed to remove worker:", err);
    }
  };

  const isCoordinatorActive = engineStatus?.coord_healthy === true || session.isReady;

  // Merge session helper devices with persistent registered workers
  const combinedDevices = [...session.devices];
  registeredWorkers.forEach((rw) => {
    const alreadyPresent = combinedDevices.some(
      (d) => d.id === rw.id || d.connectionAddress === `${rw.host}:${rw.port}`
    );
    if (!alreadyPresent) {
      // Add as registered device
      combinedDevices.push({
        id: rw.id,
        name: rw.name,
        role: "helper",
        isLocalHost: false,
        isLoopback: false,
        status: isCoordinatorActive ? "idle" : "offline",
        statusLabel: isCoordinatorActive ? "Awaiting Coordinator Restart" : "Saved in Registry",
        assignedLayersCount: 0,
        totalModelLayers: session.totalLayers || 37,
        sharePercent: 0,
        ramTotalBytes: 0,
        ramFreeBytes: 0,
        reserveBytes: 1024 * 1024 * 1024,
        isBelowReserve: false,
        processors: [
          {
            name: "Remote GGML RPC Daemon",
            type: "rpc",
            layerCount: 0,
            rangeLabel: "0 layers (Pending restart)",
            modelBufferBytes: 0,
          },
        ],
        connectionAddress: `${rw.host}:${rw.port}`,
        provenance: "Configured",
        endpointUrl: `http://${rw.host}:${rw.port}`,
      });
    }
  });

  const hasPendingWorkers = isCoordinatorActive && registeredWorkers.some((rw) => {
    const match = session.devices.find((d) => d.connectionAddress === `${rw.host}:${rw.port}`);
    return !match || match.assignedLayersCount === 0;
  });

  const selectedDevice =
    combinedDevices.find((d) => d.id === selectedDeviceId) || session.hostDevice || combinedDevices[0];

  // Commands for manual copying
  const generatedWorkerCmd = `.\\Start-RemoteWorker.ps1 -CoordinatorUrl "http://${effectiveHostIp}:8080" -WorkerIp "${effectiveWorkerIp}" -RpcPort ${effectiveWorkerPort}`;
  const directRpcCmd = `.\\ggml-rpc-server.exe --host 0.0.0.0 --port ${effectiveWorkerPort} --threads 4`;
  const firewallCmd = `New-NetFirewallRule -DisplayName "Swarm GGML RPC" -Direction Inbound -LocalPort ${effectiveWorkerPort} -Protocol TCP -Action Allow`;

  // Host specs
  const activeProfile = profiles.find((p) => p.id === selectedProfileId);
  const hostRamTotal = session.hostDevice?.ramTotalBytes || session.memoryAccounting?.hostRamTotalBytes || 0;
  const hostRamAvail = session.hostDevice?.ramFreeBytes || session.memoryAccounting?.hostRamAvailableBytes || 0;
  const hostRamUsed = Math.max(0, hostRamTotal - hostRamAvail);
  const hostVramTotal = session.hostDevice?.vramTotalBytes || 4294836224;
  const hostVramUsed = session.hostDevice?.vramUsedBytes || 768055705;

  return (
    <div className="devices-layout">
      {/* Primary Devices Column */}
      <div className="devices-list-col">
        {/* Header */}
        <div className="devices-header">
          <div>
            <h1 className="page-title">Devices &amp; Compute Nodes</h1>
            <div className="page-subtitle">
              {session.clusterSummary || "1 physical host · Manage cluster and remote workers"}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              className="btn-secondary"
              onClick={() => setShowAllocationModal(true)}
              style={{
                padding: "7px 14px",
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexShrink: 0,
                border: "1px solid var(--color-border-accent, #0ea5e9)",
              }}
            >
              <Sliders size={15} />
              <span>Compute Allocation</span>
            </button>

            <button
              className="btn-primary"
              onClick={() => {
                setShowOnboarding(true);
                setCurrentStep(1);
              }}
              style={{
                padding: "7px 14px",
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexShrink: 0,
              }}
            >
              <Plus size={15} />
              <span>Add Worker Computer</span>
            </button>
          </div>
        </div>

        {/* ═══════════════════════════════════════════
            COMPUTE ALLOCATION SUMMARY BANNER
           ═══════════════════════════════════════════ */}
        <div
          style={{
            marginBottom: 20,
            padding: "12px 16px",
            background: "rgba(14, 165, 233, 0.05)",
            border: "1px solid rgba(14, 165, 233, 0.2)",
            borderRadius: "var(--radius, 8px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "rgba(14, 165, 233, 0.12)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#0ea5e9",
              }}
            >
              <Layers size={18} />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-1)" }}>
                Distributed Compute &amp; Layer Distribution
              </div>
              <div style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>
                Model: Qwen 2.5 3B (37 Layers) · Dynamic tensor split with protected host RAM &amp; VRAM headroom
              </div>
            </div>
          </div>

          <button
            onClick={() => setShowAllocationModal(true)}
            style={{
              fontSize: 12,
              padding: "5px 12px",
              background: "transparent",
              border: "1px solid rgba(14, 165, 233, 0.3)",
              color: "#0ea5e9",
              borderRadius: "var(--radius, 6px)",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Adjust Plan →
          </button>
        </div>

        {/* ═══════════════════════════════════════════
            1. HOST COMPUTER SECTION (Instrumented)
           ═══════════════════════════════════════════ */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-2)" }}>
              Host Machine (This Computer)
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
              <span className={`dot ${session.isReady ? "dot-ok" : session.isStopped ? "dot-error" : "dot-warn"}`} />
              <span style={{ fontWeight: 500 }}>
                {session.isReady ? "Coordinator Ready" : session.isStopped ? "Coordinator Stopped" : "Initializing"}
              </span>
              <span style={{ color: "var(--color-text-3)" }}>· 127.0.0.1:8080</span>
            </div>
          </div>

          <div
            className="card"
            style={{
              padding: 16,
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
            }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16 }}>
              {/* Profile & Model Info */}
              <div>
                <div style={{ fontSize: 11, color: "var(--color-text-3)", marginBottom: 2 }}>
                  Active Inference Profile
                </div>
                <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--color-text)" }}>
                  {activeProfile?.name || "Standard Distributed Cluster"}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--color-text-2)", marginTop: 2, lineHeight: 1.35 }}>
                  {activeProfile?.description || "Dual-process distributed cluster with local RPC & remote workers"}
                </div>
              </div>

              {/* Model & Context */}
              <div>
                <div style={{ fontSize: 11, color: "var(--color-text-3)", marginBottom: 2 }}>
                  Selected Model &amp; Context
                </div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)", wordBreak: "break-all" }}>
                  {session.modelName || "Qwen 2.5 3B Instruct (Q4_K_M)"}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--color-text-2)", marginTop: 2 }}>
                  Context: <span className="mono">{session.contextWindow || 2048} tokens</span> · Layers: <span className="mono">{session.totalLayers || 37}</span>
                </div>
              </div>

              {/* Host Hardware RAM */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--color-text-3)", marginBottom: 4 }}>
                  <span>Host Physical RAM</span>
                  <span className="mono">{fmtBytes(hostRamUsed)} / {fmtBytes(hostRamTotal)}</span>
                </div>
                <div style={{ width: "100%", height: 6, background: "var(--color-surface-subtle)", borderRadius: 3, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${hostRamTotal > 0 ? Math.min(100, Math.round((hostRamUsed / hostRamTotal) * 100)) : 0}%`,
                      background: session.memoryAccounting?.isBelowReserve ? "var(--color-warn)" : "var(--color-accent)",
                    }}
                  />
                </div>
                <div style={{ fontSize: 11, color: "var(--color-text-2)", marginTop: 4 }}>
                  {fmtBytes(hostRamAvail)} available
                  {session.memoryAccounting?.isBelowReserve && (
                    <span style={{ color: "var(--color-warn)", fontWeight: 600 }}> · Below 1GB reserve</span>
                  )}
                </div>
              </div>

              {/* Dedicated GPU VRAM */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--color-text-3)", marginBottom: 4 }}>
                  <span>NVIDIA GPU VRAM</span>
                  <span className="mono">{fmtBytes(hostVramUsed)} / {fmtBytes(hostVramTotal)}</span>
                </div>
                <div style={{ width: "100%", height: 6, background: "var(--color-surface-subtle)", borderRadius: 3, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${hostVramTotal > 0 ? Math.min(100, Math.round((hostVramUsed / hostVramTotal) * 100)) : 0}%`,
                      background: "var(--color-steel)",
                    }}
                  />
                </div>
                <div style={{ fontSize: 11, color: "var(--color-text-2)", marginTop: 4 }}>
                  GeForce GTX 1050 · CUDA Backend
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ═══════════════════════════════════════════
            2. WORKER COMPUTERS SECTION
           ═══════════════════════════════════════════ */}
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-2)" }}>
              Worker Computers ({combinedDevices.filter((d) => !d.isLocalHost).length})
            </span>
            <span style={{ fontSize: 11.5, color: "var(--color-text-3)" }}>
              GGML RPC transport over private network
            </span>
          </div>

          {/* Pending Coordinator Restart Notification Banner */}
          {hasPendingWorkers && (
            <div
              className="banner-warn"
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "10px 14px",
                borderRadius: "var(--radius)",
                marginBottom: 12,
                gap: 12,
              }}
            >
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <AlertCircle size={18} color="var(--color-warn)" style={{ flexShrink: 0 }} />
                <span style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                  <strong>Cluster Configuration Changed:</strong> A registered worker is awaiting activation. The coordinator must be restarted to allocate model layers to this computer.
                </span>
              </div>
              <button
                className="btn-primary"
                onClick={handleRestartCoordinator}
                disabled={isRestartingCoordinator || isStarting || isStopping}
                style={{ padding: "5px 12px", fontSize: 12, display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}
              >
                <RefreshCw size={13} className={isRestartingCoordinator ? "animate-spin" : ""} />
                <span>{isRestartingCoordinator ? "Restarting..." : "Restart Coordinator"}</span>
              </button>
            </div>
          )}

          {combinedDevices.filter((d) => !d.isLocalHost).length === 0 ? (
            /* Empty State */
            <div
              className="well-sunken"
              style={{
                padding: "24px 20px",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
              }}
            >
              <Laptop size={28} color="var(--color-text-3)" />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: "var(--color-text)" }}>
                  No Remote Worker Computers Added Yet
                </div>
                <div style={{ fontSize: 12, color: "var(--color-text-2)", marginTop: 4, maxWidth: 440 }}>
                  Add a second Windows PC on your Wi-Fi or VPN to split layers, pool VRAM/RAM, and run larger models smoothly.
                </div>
              </div>
              <button
                className="btn-primary"
                onClick={() => {
                  setShowOnboarding(true);
                  setCurrentStep(1);
                }}
                style={{ marginTop: 4, padding: "6px 14px", fontSize: 12.5 }}
              >
                Add Worker Computer Now
              </button>
            </div>
          ) : (
            /* Worker Devices Cards */
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {combinedDevices
                .filter((d) => !d.isLocalHost)
                .map((dev) => {
                  const isSelected = selectedDevice?.id === dev.id;
                  const probeFeedback = workerProbeFeedback[dev.id];
                  const isProbingThis = probingWorkerId === dev.id;

                  // Parse host and port
                  const parts = dev.connectionAddress.split(":");
                  const hostPart = parts[0] || "127.0.0.1";
                  const portPart = Number(parts[1]) || 50052;
                  const isAwaitingRestart = isCoordinatorActive && !dev.isLoopback && dev.assignedLayersCount === 0;

                  return (
                    <div
                      key={dev.id}
                      className="card"
                      style={{
                        padding: "14px 16px",
                        border: isSelected ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
                        background: "var(--color-surface)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 12,
                        transition: "border-color 140ms ease, box-shadow 140ms ease",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                        {/* Device Info */}
                        <div
                          style={{ cursor: "pointer" }}
                          onClick={() => setSelectedDeviceId(dev.id)}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontWeight: 600, fontSize: 14.5, color: "var(--color-text)" }}>
                              {dev.name}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                color: dev.isLoopback ? "var(--color-steel)" : "var(--color-accent)",
                                background: dev.isLoopback ? "rgba(70,89,143,0.08)" : "var(--color-accent-subtle)",
                                padding: "2px 7px",
                                borderRadius: 4,
                                fontWeight: 500,
                              }}
                            >
                              {dev.isLoopback ? "Loopback Test Helper" : "Remote Worker"}
                            </span>
                          </div>

                          <div style={{ fontSize: 12, color: "var(--color-text-2)", marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>
                            <span className="mono">{dev.connectionAddress}</span>
                            <span>·</span>
                            <span>GGML RPC Port {portPart}</span>
                            {dev.lastSeenMs && (
                              <>
                                <span>·</span>
                                <span style={{ color: "var(--color-text-3)", fontSize: 11 }}>
                                  Active telemetry
                                </span>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Status Tag */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              fontSize: 12,
                              fontWeight: 500,
                              padding: "4px 9px",
                              borderRadius: 4,
                              background:
                                isAwaitingRestart
                                  ? "rgba(245, 158, 11, 0.12)"
                                  : dev.status === "ready"
                                  ? "var(--color-ok-bg)"
                                  : dev.status === "busy"
                                  ? "rgba(70,89,143,0.12)"
                                  : dev.status === "error"
                                  ? "var(--color-error-bg)"
                                  : "var(--color-surface-subtle)",
                              color:
                                isAwaitingRestart
                                  ? "var(--color-warn)"
                                  : dev.status === "ready"
                                  ? "var(--color-ok)"
                                  : dev.status === "busy"
                                  ? "var(--color-steel)"
                                  : dev.status === "error"
                                  ? "var(--color-error)"
                                  : "var(--color-text-2)",
                            }}
                          >
                            <span
                              className={`dot ${
                                isAwaitingRestart
                                  ? "dot-idle"
                                  : dev.status === "ready"
                                  ? "dot-ok"
                                  : dev.status === "busy"
                                  ? "dot-ok"
                                  : dev.status === "error"
                                  ? "dot-error"
                                  : "dot-idle"
                              }`}
                            />
                            <span>{isAwaitingRestart ? "Awaiting Coordinator Restart" : dev.statusLabel}</span>
                          </div>
                        </div>
                      </div>

                      {/* Hardware & Layer Allocation Specs */}
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                          gap: 12,
                          background: "var(--color-surface-subtle)",
                          padding: "10px 12px",
                          borderRadius: "var(--radius-sm)",
                          fontSize: 12,
                        }}
                      >
                        <div>
                          <div style={{ color: "var(--color-text-3)", fontSize: 11, marginBottom: 2 }}>Model Layers</div>
                          <div style={{ fontWeight: 600, color: "var(--color-text)" }}>
                            {dev.assignedLayersCount} of {dev.totalModelLayers} layers ({dev.sharePercent}%)
                          </div>
                          <div style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                            {dev.assignedLayersCount > 0 ? "Allocated in session" : "Awaiting cluster reload"}
                          </div>
                        </div>

                        <div>
                          <div style={{ color: "var(--color-text-3)", fontSize: 11, marginBottom: 2 }}>RAM &amp; Headroom</div>
                          <div style={{ fontWeight: 600, color: "var(--color-text)" }}>
                            {dev.ramTotalBytes > 0 ? fmtBytes(dev.ramFreeBytes) + " free" : "Shares host memory"}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                            {dev.ramTotalBytes > 0 ? `${fmtBytes(dev.ramTotalBytes)} total` : "Loopback IPC"}
                          </div>
                        </div>

                        <div>
                          <div style={{ color: "var(--color-text-3)", fontSize: 11, marginBottom: 2 }}>Transport &amp; Security</div>
                          <div style={{ fontWeight: 500, color: "var(--color-text)" }}>
                            Plaintext TCP Socket
                          </div>
                          <div style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                            Private LAN / VPN only
                          </div>
                        </div>
                      </div>

                      {/* Probe Feedback Banner if available */}
                      {probeFeedback && (
                        <div
                          style={{
                            padding: "8px 12px",
                            borderRadius: "var(--radius-sm)",
                            fontSize: 11.5,
                            background: probeFeedback.reachable ? "var(--color-ok-bg)" : "var(--color-error-bg)",
                            color: probeFeedback.reachable ? "var(--color-ok)" : "var(--color-error)",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          {probeFeedback.reachable ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                          <span>{probeFeedback.message}</span>
                        </div>
                      )}

                      {/* Device Action Controls */}
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: "1px solid var(--color-border)", paddingTop: 10 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => probeWorkerCard(dev.id, hostPart, portPart)}
                            disabled={isProbingThis}
                            style={{ padding: "4px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}
                          >
                            <RefreshCw size={13} className={isProbingThis ? "animate-spin" : ""} />
                            <span>{isProbingThis ? "Testing..." : "Test Connection"}</span>
                          </button>

                          {isAwaitingRestart && (
                            <button
                              type="button"
                              className="btn-primary"
                              onClick={handleRestartCoordinator}
                              disabled={isRestartingCoordinator || isStarting || isStopping}
                              style={{ padding: "4px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}
                            >
                              <RefreshCw size={12} className={isRestartingCoordinator ? "animate-spin" : ""} />
                              <span>{isRestartingCoordinator ? "Restarting..." : "Restart to Activate"}</span>
                            </button>
                          )}

                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => setSelectedDeviceId(dev.id)}
                            style={{ padding: "4px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}
                          >
                            <Activity size={13} />
                            <span>View Details</span>
                          </button>
                        </div>

                        {!dev.isLoopback && (
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => handleRemoveWorker(dev.id)}
                            style={{
                              padding: "4px 10px",
                              fontSize: 12,
                              color: "var(--color-error)",
                              display: "flex",
                              alignItems: "center",
                              gap: 5,
                            }}
                          >
                            <Trash2 size={13} />
                            <span>Remove</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════
          SELECTED DEVICE DETAIL DRAWER (Right column)
         ═══════════════════════════════════════════ */}
      {selectedDevice && (
        <aside className="device-drawer" style={{ minWidth: 310, maxWidth: 360 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-3)" }}>
              Device Inspection
            </span>
            <span
              style={{
                fontSize: 11,
                padding: "2px 6px",
                borderRadius: 4,
                fontWeight: 600,
                background: selectedDevice.role === "host" ? "var(--color-accent-subtle)" : "var(--color-surface-subtle)",
                color: selectedDevice.role === "host" ? "var(--color-accent)" : "var(--color-text-2)",
              }}
            >
              {selectedDevice.role === "host" ? "Host Machine" : "Worker Node"}
            </span>
          </div>

          <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--color-text)", marginBottom: 4 }}>
            {selectedDevice.name}
          </h3>
          <div style={{ fontSize: 12, color: "var(--color-text-2)", marginBottom: 16 }}>
            {selectedDevice.connectionAddress}
          </div>

          {/* Model Layer Allocation */}
          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 14, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: "var(--color-text-2)" }}>Model Layer Share</span>
              <span className="mono" style={{ fontWeight: 600 }}>{selectedDevice.assignedLayersCount} of {selectedDevice.totalModelLayers} layers</span>
            </div>
            <div style={{ width: "100%", height: 6, background: "var(--color-surface-subtle)", borderRadius: 3, overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${Math.min(100, selectedDevice.sharePercent)}%`,
                  background: selectedDevice.role === "host" ? "var(--color-accent)" : "var(--color-steel)",
                }}
              />
            </div>
          </div>

          {/* Processors breakdown */}
          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-2)", marginBottom: 8 }}>
              Processors &amp; Allocations
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {selectedDevice.processors.map((p, idx) => (
                <div key={idx} className="well-sunken" style={{ padding: "8px 10px", fontSize: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
                    <span>{p.name}</span>
                    <span className="mono">{p.layerCount} layers</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 2 }}>
                    Range: {p.rangeLabel} {p.modelBufferBytes > 0 && `· ${fmtBytes(p.modelBufferBytes)}`}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Memory breakdown */}
          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-2)", marginBottom: 8 }}>
              Memory &amp; Headroom
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--color-text-2)" }}>Total RAM:</span>
                <span className="mono">{selectedDevice.ramTotalBytes > 0 ? fmtBytes(selectedDevice.ramTotalBytes) : "Shared with host"}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--color-text-2)" }}>Available RAM:</span>
                <span className="mono">{selectedDevice.ramFreeBytes > 0 ? fmtBytes(selectedDevice.ramFreeBytes) : "N/A"}</span>
              </div>
              {selectedDevice.vramTotalBytes != null && selectedDevice.vramTotalBytes > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--color-text-2)" }}>GPU VRAM:</span>
                  <span className="mono">{fmtBytes(selectedDevice.vramUsedBytes || 0)} / {fmtBytes(selectedDevice.vramTotalBytes)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Technical Details */}
          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
            <button
              onClick={() => setShowTechnical(!showTechnical)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                background: "none",
                border: "none",
                padding: 0,
                fontSize: 12,
                color: "var(--color-text-2)",
                cursor: "pointer",
              }}
            >
              {showTechnical ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>Technical details</span>
            </button>

            {showTechnical && (
              <div
                className="well-sunken"
                style={{
                  marginTop: 8,
                  fontSize: 11,
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                }}
              >
                <div>ID: <span className="mono">{selectedDevice.id}</span></div>
                <div>Transport: <span className="mono">{selectedDevice.isLoopback ? "Loopback" : "TCP Socket (GGML RPC)"}</span></div>
                <div>Provenance: <span className="mono">{selectedDevice.provenance}</span></div>
                <div>Status: <span className="mono">{selectedDevice.status}</span></div>
                {selectedDevice.lastError && (
                  <div style={{ color: "var(--color-error)" }}>Last Error: {selectedDevice.lastError}</div>
                )}
              </div>
            )}
          </div>
        </aside>
      )}

      {/* ═══════════════════════════════════════════
          3. GUIDED 5-STEP ONBOARDING MODAL
         ═══════════════════════════════════════════ */}
      {showOnboarding && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(28, 32, 36, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 16,
            backdropFilter: "blur(3px)",
          }}
        >
          <div
            className="card"
            style={{
              width: "100%",
              maxWidth: 620,
              maxHeight: "92vh",
              overflowY: "auto",
              padding: 24,
              boxShadow: "0 20px 50px rgba(0,0,0,0.22)",
              display: "flex",
              flexDirection: "column",
              gap: 18,
              background: "var(--color-surface)",
            }}
          >
            {/* Modal Header & 5-Step Progress Indicator */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div>
                  <h2 className="section-title" style={{ fontSize: 18 }}>
                    Add Worker Computer
                  </h2>
                  <p className="page-subtitle" style={{ marginTop: 2, fontSize: 12.5 }}>
                    Connect a secondary Windows computer to distribute and offload LLM layers.
                  </p>
                </div>
                <button
                  className="btn-ghost"
                  onClick={closeOnboarding}
                  style={{ padding: "4px 8px", fontSize: 12 }}
                >
                  Cancel
                </button>
              </div>

              {/* 5-Step Progress Stepper Bar */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4, padding: "8px 0", borderBottom: "1px solid var(--color-border)" }}>
                {[
                  { step: 1, label: "Choose Method" },
                  { step: 2, label: "Enter Details" },
                  { step: 3, label: "Check Connection" },
                  { step: 4, label: "Start Worker" },
                  { step: 5, label: "Complete" },
                ].map((s) => {
                  const isActive = currentStep === s.step;
                  const isDone = currentStep > s.step;
                  return (
                    <div
                      key={s.step}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        opacity: isActive ? 1 : isDone ? 0.9 : 0.45,
                        fontSize: 12,
                        fontWeight: isActive ? 600 : 400,
                        color: isActive ? "var(--color-accent)" : isDone ? "var(--color-text)" : "var(--color-text-3)",
                      }}
                    >
                      <span
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          background: isDone ? "var(--color-accent)" : isActive ? "var(--color-accent-subtle)" : "var(--color-surface-subtle)",
                          color: isDone ? "#FFFFFF" : isActive ? "var(--color-accent)" : "var(--color-text-3)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 11,
                          fontWeight: 600,
                        }}
                      >
                        {isDone ? <Check size={12} /> : s.step}
                      </span>
                      <span style={{ display: "inline" }}>{s.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── STEP 1: CHOOSE METHOD ────────────────── */}
            {currentStep === 1 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ fontSize: 13, color: "var(--color-text-2)" }}>
                  Select how you want to configure and connect the remote Windows computer:
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {/* Option 1: Manual Address */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setMethod("manual")}
                    onKeyDown={(e) => e.key === "Enter" && setMethod("manual")}
                    style={{
                      padding: 16,
                      borderRadius: "var(--radius)",
                      border: method === "manual" ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
                      background: method === "manual" ? "rgba(31,111,102,0.04)" : "var(--color-surface)",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      position: "relative",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <Terminal size={24} color="var(--color-accent)" />
                      <span
                        style={{
                          fontSize: 10.5,
                          background: "var(--color-accent-subtle)",
                          color: "var(--color-accent)",
                          padding: "2px 6px",
                          borderRadius: 4,
                          fontWeight: 600,
                        }}
                      >
                        Recommended (PC-to-PC)
                      </span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: "var(--color-text)" }}>
                      Enter Address Manually
                    </div>
                    <div style={{ fontSize: 12, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                      Directly enter Computer B’s private IPv4 address (e.g. 192.168.x.x) and port. Generates the exact PowerShell launcher command for Computer B.
                    </div>
                  </div>

                  {/* Option 2: QR Code */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setMethod("qr")}
                    onKeyDown={(e) => e.key === "Enter" && setMethod("qr")}
                    style={{
                      padding: 16,
                      borderRadius: "var(--radius)",
                      border: method === "qr" ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
                      background: method === "qr" ? "rgba(31,111,102,0.04)" : "var(--color-surface)",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <QrCode size={24} color="var(--color-steel)" />
                      <span
                        style={{
                          fontSize: 10.5,
                          background: "var(--color-surface-subtle)",
                          color: "var(--color-text-3)",
                          padding: "2px 6px",
                          borderRadius: 4,
                          fontWeight: 500,
                        }}
                      >
                        Mobile / Camera
                      </span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: "var(--color-text)" }}>
                      Scan QR Code
                    </div>
                    <div style={{ fontSize: 12, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                      Displays a QR code for mobile devices, tablets, or barcode scanners on the same Wi-Fi network to inspect connection and authentication payload.
                    </div>
                  </div>
                </div>

                {/* Private Network Security Reminder */}
                <div className="banner-warn" style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 14px", borderRadius: "var(--radius)" }}>
                  <Shield size={18} color="var(--color-warn)" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ fontSize: 12, lineHeight: 1.45 }}>
                    <strong>Private Network Mandatory:</strong> GGML RPC uses unauthenticated, unencrypted TCP.
                    Keep RPC traffic restricted to a trusted home/office Wi-Fi network or private WireGuard/Tailscale VPN. Never expose worker port 50052 to the public internet.
                  </div>
                </div>

                {/* Footer Controls */}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
                  <button className="btn-ghost" onClick={closeOnboarding}>
                    Cancel
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => setCurrentStep(2)}
                    style={{ padding: "7px 16px", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <span>Continue to Details</span>
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            )}

            {/* ── STEP 2: ENTER DETAILS ────────────────── */}
            {currentStep === 2 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {method === "qr" ? (
                  /* QR Pairing Mode */
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ fontSize: 12.5, color: "var(--color-text-2)" }}>
                      Computer B will connect to this host computer. Verify this host’s private network address:
                    </div>

                    {/* Host LAN Interface Selector */}
                    <div style={{ background: "var(--color-surface-subtle)", padding: 12, borderRadius: "var(--radius)", display: "flex", flexDirection: "column", gap: 8 }}>
                      <label style={{ fontSize: 11.5, fontWeight: 500, color: "var(--color-text-2)" }}>
                        Host Coordinator Address (on your LAN):
                      </label>
                      {hostNetwork?.ip_addresses && hostNetwork.ip_addresses.length > 1 ? (
                        <select
                          value={selectedHostIp}
                          onChange={(e) => setSelectedHostIp(e.target.value)}
                          style={{
                            padding: "6px 10px",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                            background: "var(--color-surface)",
                            border: "1px solid var(--color-border)",
                            borderRadius: "var(--radius-sm)",
                          }}
                        >
                          {hostNetwork.ip_addresses.map((ip) => (
                            <option key={ip} value={ip}>
                              http://{ip}:8080 {ip === hostNetwork.preferred_ip ? "(Primary)" : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="mono" style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                          http://{effectiveHostIp}:8080
                        </div>
                      )}
                    </div>

                    {/* QR Code Card & Payload */}
                    <div style={{ display: "flex", gap: 16, alignItems: "center", background: "var(--color-surface)", padding: 14, border: "1px solid var(--color-border)", borderRadius: "var(--radius)" }}>
                      <div style={{ flexShrink: 0 }}>
                        {qrDataUrl ? (
                          <img src={qrDataUrl} alt="Swarm Pairing QR Code" style={{ width: 140, height: 140, display: "block", borderRadius: 4 }} />
                        ) : (
                          <div style={{ width: 140, height: 140, background: "var(--color-surface-subtle)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            Generating...
                          </div>
                        )}
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                          Pairing Connection String
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                          Scan with your device or copy the connection payload to Computer B:
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            background: "var(--color-surface-subtle)",
                            border: "1px solid var(--color-border)",
                            padding: "6px 10px",
                            borderRadius: 6,
                            gap: 8,
                          }}
                        >
                          <code className="mono" style={{ fontSize: 10.5, wordBreak: "break-all" }}>
                            coord: http://{effectiveHostIp}:8080 | rpc: 50052
                          </code>
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => copyCmd(pairingPayload, "cmd-qr-payload")}
                            style={{ padding: "3px 8px", fontSize: 11, flexShrink: 0 }}
                          >
                            {copiedId === "cmd-qr-payload" ? <Check size={12} color="var(--color-ok)" /> : <Copy size={12} />}
                            <span>{copiedId === "cmd-qr-payload" ? "Copied" : "Copy"}</span>
                          </button>
                        </div>
                        <div style={{ fontSize: 10.5, color: "var(--color-text-3)", lineHeight: 1.3 }}>
                          <strong>Security Design:</strong> Sensitive bearer tokens are excluded from QR payloads to prevent credential interception. Authentication is provisioned via local secret files on Computer B.
                        </div>
                      </div>
                    </div>

                    {/* Target Worker IP Input */}
                    <div>
                      <label htmlFor="qr-worker-ip" style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--color-text)", marginBottom: 4 }}>
                        Computer B’s LAN IPv4 Address:
                      </label>
                      <input
                        id="qr-worker-ip"
                        type="text"
                        value={workerHost}
                        onChange={(e) => {
                          setWorkerHost(e.target.value);
                          setAddressTouched(true);
                        }}
                        placeholder="e.g. 192.168.204.45"
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          fontSize: 12.5,
                          fontFamily: "var(--font-mono)",
                          background: "var(--color-surface-subtle)",
                          border: addressError ? "1px solid var(--color-error)" : "1px solid var(--color-hairline)",
                          borderRadius: "var(--radius-sm)",
                          outline: "none",
                        }}
                      />
                      {addressError ? (
                        <span style={{ fontSize: 11, color: "var(--color-error)", marginTop: 3, display: "block" }}>
                          {addressError}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 3, display: "block" }}>
                          Computer B’s IPv4 address on this same Wi-Fi / LAN network
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  /* Manual Configuration Mode */
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ fontSize: 12.5, color: "var(--color-text-2)" }}>
                      Enter the network details for Computer B (the remote worker):
                    </div>

                    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", background: "var(--color-surface-subtle)", padding: "8px 12px", borderRadius: "var(--radius-sm)", fontSize: 11.5, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                      <Info size={14} color="var(--color-steel)" style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>
                        <strong>Outbound RPC Architecture:</strong> Computer A (Coordinator) initiates an outbound TCP socket to Computer B on port 50052 to stream model tensor layers.
                      </span>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "2.5fr 1fr", gap: 12 }}>
                      <div>
                        <label htmlFor="manual-ip-input" style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--color-text)", marginBottom: 4 }}>
                          Worker IPv4 Address / Hostname:
                        </label>
                        <input
                          id="manual-ip-input"
                          type="text"
                          value={workerHost}
                          onChange={(e) => {
                            setWorkerHost(e.target.value);
                            setAddressTouched(true);
                          }}
                          placeholder="e.g. 192.168.204.45 or worker-b.local"
                          style={{
                            width: "100%",
                            padding: "8px 12px",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                            background: "var(--color-surface-subtle)",
                            border: addressError ? "1px solid var(--color-error)" : "1px solid var(--color-hairline)",
                            borderRadius: "var(--radius-sm)",
                            outline: "none",
                          }}
                        />
                        {addressError ? (
                          <span style={{ fontSize: 11, color: "var(--color-error)", marginTop: 3, display: "block" }}>
                            {addressError}
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 3, display: "block" }}>
                            Must be on the same subnet (e.g. 192.168.x.x) or private VPN
                          </span>
                        )}
                      </div>

                      <div>
                        <label htmlFor="manual-port-input" style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--color-text)", marginBottom: 4 }}>
                          RPC Port:
                        </label>
                        <input
                          id="manual-port-input"
                          type="number"
                          value={workerPort}
                          onChange={(e) => {
                            setWorkerPort(e.target.value);
                            setPortTouched(true);
                          }}
                          placeholder="50052"
                          style={{
                            width: "100%",
                            padding: "8px 12px",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                            background: "var(--color-surface-subtle)",
                            border: portError ? "1px solid var(--color-error)" : "1px solid var(--color-hairline)",
                            borderRadius: "var(--radius-sm)",
                            outline: "none",
                          }}
                        />
                        {portError && (
                          <span style={{ fontSize: 11, color: "var(--color-error)", marginTop: 3, display: "block" }}>
                            {portError}
                          </span>
                        )}
                      </div>
                    </div>

                    <div>
                      <label htmlFor="manual-name-input" style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--color-text)", marginBottom: 4 }}>
                        Display Name (Optional):
                      </label>
                      <input
                        id="manual-name-input"
                        type="text"
                        value={workerName}
                        onChange={(e) => setWorkerName(e.target.value)}
                        placeholder="e.g. Computer B (Office Laptop)"
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          fontSize: 12.5,
                          background: "var(--color-surface-subtle)",
                          border: "1px solid var(--color-hairline)",
                          borderRadius: "var(--radius-sm)",
                          outline: "none",
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Footer Controls */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                  <button className="btn-ghost" onClick={() => setCurrentStep(1)}>
                    <ArrowLeft size={14} style={{ marginRight: 4 }} />
                    Back
                  </button>
                  <button
                    className="btn-primary"
                    disabled={!isFormValid}
                    onClick={() => {
                      setCurrentStep(3);
                      executeConnectionProbe(cleanIp, portNum);
                    }}
                    style={{
                      padding: "7px 16px",
                      fontSize: 13,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      opacity: isFormValid ? 1 : 0.5,
                      cursor: isFormValid ? "pointer" : "not-allowed",
                    }}
                  >
                    <span>Check Connection</span>
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            )}

            {/* ── STEP 3: CHECK CONNECTION ────────────── */}
            {currentStep === 3 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ fontSize: 13, color: "var(--color-text-2)" }}>
                  Testing network reachability to <span className="mono" style={{ fontWeight: 600, color: "var(--color-text)" }}>{cleanIp}:{portNum}</span>:
                </div>

                {isProbing ? (
                  /* Probing Spinner */
                  <div className="well-sunken" style={{ padding: 24, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <RefreshCw size={24} className="animate-spin" color="var(--color-accent)" />
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>Connecting to {cleanIp}:{portNum}...</div>
                    <div style={{ fontSize: 11.5, color: "var(--color-text-3)" }}>
                      Sending TCP SYN handshake to verify open port and route
                    </div>
                  </div>
                ) : probeResult?.reachable ? (
                  /* Success State */
                  <div
                    style={{
                      padding: 16,
                      borderRadius: "var(--radius)",
                      background: "var(--color-ok-bg)",
                      border: "1px solid rgba(22, 101, 52, 0.25)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 14, color: "var(--color-ok)" }}>
                      <CheckCircle2 size={18} />
                      <span>Network Connection Verified!</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--color-text)", lineHeight: 1.45 }}>
                      Successfully reached <span className="mono">{cleanIp}:{portNum}</span> in <span className="mono">{probeResult.latency_ms} ms</span>.
                      Computer B is reachable and the RPC network port is listening.
                    </div>
                  </div>
                ) : (
                  /* Probe Failure State */
                  <div
                    style={{
                      padding: 16,
                      borderRadius: "var(--radius)",
                      background: "rgba(239, 68, 68, 0.05)",
                      border: "1px solid rgba(239, 68, 68, 0.25)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 14, color: "var(--color-error)" }}>
                      <XCircle size={18} />
                      <span>Unable to Connect ({probeResult?.status_state || "UNREACHABLE"})</span>
                    </div>

                    <div style={{ fontSize: 12.5, color: "var(--color-text-2)", lineHeight: 1.45 }}>
                      {probeResult?.message || `Could not establish a TCP connection to ${cleanIp}:${portNum}.`}
                    </div>

                    {probeResult?.actionable_recovery && (
                      <div
                        style={{
                          background: "var(--color-surface)",
                          padding: "10px 12px",
                          borderRadius: "var(--radius-sm)",
                          border: "1px solid var(--color-border)",
                          fontSize: 12,
                          color: "var(--color-text)",
                        }}
                      >
                        <strong>Troubleshooting &amp; Recovery:</strong>
                        <p style={{ marginTop: 4, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                          {probeResult.actionable_recovery}
                        </p>
                      </div>
                    )}

                    {/* Firewall Rule Copy Card */}
                    <div style={{ background: "var(--color-surface)", padding: 10, borderRadius: 6, border: "1px solid var(--color-border)" }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-2)", marginBottom: 4 }}>
                        If blocked by Windows Firewall, run in PowerShell on Computer B:
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                        <code className="mono" style={{ fontSize: 10.5, wordBreak: "break-all" }}>
                          {firewallCmd}
                        </code>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => copyCmd(firewallCmd, "cmd-firewall")}
                          style={{ padding: "3px 8px", fontSize: 11, flexShrink: 0 }}
                        >
                          {copiedId === "cmd-firewall" ? <Check size={12} color="var(--color-ok)" /> : <Copy size={12} />}
                          <span>{copiedId === "cmd-firewall" ? "Copied" : "Copy"}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Footer Controls */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                  <button className="btn-ghost" onClick={() => setCurrentStep(2)}>
                    <ArrowLeft size={14} style={{ marginRight: 4 }} />
                    Back
                  </button>

                  <div style={{ display: "flex", gap: 8 }}>
                    {!probeResult?.reachable && (
                      <button
                        className="btn-ghost"
                        onClick={() => executeConnectionProbe(cleanIp, portNum)}
                        style={{ padding: "7px 14px", fontSize: 12.5 }}
                      >
                        Retry Probe
                      </button>
                    )}

                    <button
                      className="btn-primary"
                      onClick={() => setCurrentStep(4)}
                      style={{ padding: "7px 16px", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
                    >
                      <span>Continue to Start Worker</span>
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── STEP 4: START WORKER ────────────────── */}
            {currentStep === 4 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ fontSize: 13, color: "var(--color-text-2)" }}>
                  Start the Swarm Worker process on Computer B using one of the options below:
                </div>

                {/* Important notice regarding manual execution on Computer B */}
                <div className="banner-warn" style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--radius)", fontSize: 12, lineHeight: 1.4 }}>
                  <Terminal size={16} color="var(--color-warn)" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <strong>Manual Execution on Computer B Required:</strong> Worker processes are executed manually on the remote computer. Open PowerShell in the extracted worker package folder (<code>dist\swarm-worker-windows-x64</code>) on Computer B and run the command below. Keep the window open while participating in the cluster.
                  </div>
                </div>

                {/* Option A: Automated PowerShell Launcher */}
                <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", padding: 14, borderRadius: "var(--radius)" }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--color-text)" }}>
                    Option A: Automated Launcher (Recommended)
                  </div>
                  <p style={{ fontSize: 12, color: "var(--color-text-2)", marginTop: 2, marginBottom: 8 }}>
                    Starts both the GGML RPC server and the hardware telemetry reporting agent:
                  </p>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      background: "var(--color-surface-subtle)",
                      border: "1px solid var(--color-border)",
                      padding: "6px 10px",
                      borderRadius: 6,
                      gap: 8,
                    }}
                  >
                    <code className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>
                      {generatedWorkerCmd}
                    </code>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => copyCmd(generatedWorkerCmd, "cmd-step4-worker")}
                      style={{ padding: "3px 8px", fontSize: 11, flexShrink: 0 }}
                    >
                      {copiedId === "cmd-step4-worker" ? <Check size={12} color="var(--color-ok)" /> : <Copy size={12} />}
                      <span>{copiedId === "cmd-step4-worker" ? "Copied" : "Copy"}</span>
                    </button>
                  </div>
                </div>

                {/* Option B: Direct GGML RPC Executable */}
                <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", padding: 14, borderRadius: "var(--radius)" }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                    Option B: Standalone RPC Binary
                  </div>
                  <p style={{ fontSize: 12, color: "var(--color-text-2)", marginTop: 2, marginBottom: 8 }}>
                    Launches only the core GGML tensor computation daemon:
                  </p>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      background: "var(--color-surface-subtle)",
                      border: "1px solid var(--color-border)",
                      padding: "6px 10px",
                      borderRadius: 6,
                      gap: 8,
                    }}
                  >
                    <code className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>
                      {directRpcCmd}
                    </code>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => copyCmd(directRpcCmd, "cmd-step4-direct")}
                      style={{ padding: "3px 8px", fontSize: 11, flexShrink: 0 }}
                    >
                      {copiedId === "cmd-step4-direct" ? <Check size={12} color="var(--color-ok)" /> : <Copy size={12} />}
                      <span>{copiedId === "cmd-step4-direct" ? "Copied" : "Copy"}</span>
                    </button>
                  </div>
                </div>

                {/* Live Process Verify Button */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--color-surface-subtle)", padding: "10px 14px", borderRadius: "var(--radius)" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12.5, color: "var(--color-text)" }}>
                      Live Process Detection
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>
                      {daemonVerified
                        ? "Worker daemon detected listening on port 50052!"
                        : "Verify that the process is actively listening on Computer B."}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={executeDaemonCheck}
                    disabled={isVerifyingDaemon}
                    style={{ padding: "5px 12px", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <RefreshCw size={13} className={isVerifyingDaemon ? "animate-spin" : ""} />
                    <span>{isVerifyingDaemon ? "Checking..." : daemonVerified ? "Verified (Listening)" : "Check Daemon Status"}</span>
                  </button>
                </div>

                {/* Graceful shutdown instructions */}
                <div style={{ fontSize: 11.5, color: "var(--color-text-3)", lineHeight: 1.4 }}>
                  <Shield size={13} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} />
                  <strong>Lifecycle:</strong> To stop the worker cleanly at any time, press <kbd>Ctrl+C</kbd> in Computer B’s terminal window. Processes will terminate gracefully without orphaned handles.
                </div>

                {/* Footer Controls */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                  <button className="btn-ghost" onClick={() => setCurrentStep(3)}>
                    <ArrowLeft size={14} style={{ marginRight: 4 }} />
                    Back
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => setCurrentStep(5)}
                    style={{ padding: "7px 16px", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <span>Next: Complete Setup</span>
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            )}

            {/* ── STEP 5: COMPLETE ────────────────────── */}
            {currentStep === 5 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* Celebration Card */}
                <div
                  style={{
                    padding: 20,
                    borderRadius: "var(--radius)",
                    background: "var(--color-ok-bg)",
                    border: "1px solid rgba(22, 101, 52, 0.2)",
                    textAlign: "center",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <CheckCircle2 size={36} color="var(--color-ok)" />
                  <div style={{ fontWeight: 600, fontSize: 16, color: "var(--color-ok)" }}>
                    Worker Node Configured Successfully
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--color-text)", maxWidth: 460 }}>
                    <span className="mono" style={{ fontWeight: 600 }}>{cleanIp}:{portNum}</span> has been added to your Swarm cluster device registry.
                  </div>
                </div>

                {/* Configuration Summary */}
                <div
                  style={{
                    padding: 14,
                    borderRadius: "var(--radius-sm)",
                    background: "var(--color-surface-subtle)",
                    fontSize: 12,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--color-text-2)" }}>Worker Name:</span>
                    <span style={{ fontWeight: 600 }}>{workerName || `Helper (${cleanIp})`}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--color-text-2)" }}>Endpoint:</span>
                    <span className="mono">{cleanIp}:{portNum}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--color-text-2)" }}>Inference Mode:</span>
                    <span>Distributed GGML RPC</span>
                  </div>
                </div>

                {/* Important Inference Notice */}
                <div className="banner-warn" style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 14px", borderRadius: "var(--radius)" }}>
                  <AlertCircle size={18} color="var(--color-warn)" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ fontSize: 12, lineHeight: 1.45 }}>
                    <strong>Coordinator Restart Required for Activation:</strong> GGML partitions model weights across all registered RPC endpoints during startup.
                    To allocate model layers across both computers and engage this node in inference, restart the coordinator.
                  </div>
                </div>

                {/* Actions */}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
                  <button
                    className="btn-ghost"
                    onClick={() => handleCompleteRegistration(false)}
                    style={{ padding: "7px 14px", fontSize: 13 }}
                  >
                    Save for Later
                  </button>

                  <button
                    className="btn-primary"
                    onClick={() => handleCompleteRegistration(true)}
                    disabled={isRestartingCoordinator || isStarting || isStopping}
                    style={{ padding: "7px 16px", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <RefreshCw size={14} className={isRestartingCoordinator ? "animate-spin" : ""} />
                    <span>{isRestartingCoordinator ? "Restarting..." : "Save & Restart Coordinator Now"}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Compute Allocation Modal */}
      <ComputeAllocationModal
        isOpen={showAllocationModal}
        onClose={() => setShowAllocationModal(false)}
        onPlanApplied={() => {
          session.refetch();
        }}
      />
    </div>
  );
}
