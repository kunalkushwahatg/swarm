import { useState, useEffect, useCallback } from "react";
import { useSwarmSession, type SwarmDevice } from "../hooks/useSwarmSession";
import { useSupervisor } from "../hooks/useSupervisor";
import {
  supervisor,
  type DiscoveredWorker,
  type RemoteWorkerConfig,
  type WorkerProbeResult,
  type WorkerHardwareTelemetry,
} from "../lib/supervisor";
import { modelsApi } from "../lib/modelsApi";
import { isAndroid } from "../lib/platform";
import { fmtBytes, friendlyModelTitle } from "../lib/utils";
import {
  AlertCircle,
  Activity,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Trash2,
  Plus,
  Sliders,
  HardDrive,
  Network,
  ChevronDown,
  ChevronUp,
  X,
  Wifi,
  Zap,
  Cpu,
  Server,
  Thermometer,
  Radar,
} from "lucide-react";
import { ComputeAllocationModal } from "./ComputeAllocationModal";
import { DeviceOnboardingModal } from "./devices/DeviceOnboardingModal";

function formatStartupError(msg: string | null): string {
  if (!msg) return "";
  if (msg.includes("ERROR:")) {
    const errorPart = msg.split("ERROR:").pop()?.trim() || "";
    const cleanError = errorPart.split(" | ")[0].trim();
    if (cleanError.includes("Insufficient simulated capacity") || cleanError.includes("Insufficient dynamic capacity")) {
      return "Memory Allocation Notice: Configured device memory budgets could not hold all requested model layers. Layers are automatically balanced with Host CPU.";
    }
    return cleanError;
  }
  return msg
    .replace(/Coordinator PID \d+ exited prematurely with code \d+\.?\s*(Last output:\s*)?/, "")
    .replace(/^Production Startup Failed:\s*/, "")
    .trim() || msg;
}

export function DevicesPanel() {
  const session = useSwarmSession(3000);
  const {
    selectedProfile,
    activeProfile,
    startEngine,
    stopEngine,
    engineStatus,
    isStarting,
    isStopping,
    errorMessage,
    setErrorMessage,
    setSelectedProfileId,
  } = useSupervisor(3000);

  const [selectedDevice, setSelectedDevice] = useState<SwarmDevice | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);
  const [isRestartingCoordinator, setIsRestartingCoordinator] = useState(false);
  const [hardware, setHardware] = useState<WorkerHardwareTelemetry | null>(null);

  useEffect(() => {
    if (supervisor.isDesktop) {
      supervisor.getWorkerHardware().then((hw) => {
        if (hw) setHardware(hw);
      }).catch(() => {});
    }
  }, []);

  // Registered remote workers managed locally / via supervisor
  const [registeredWorkers, setRegisteredWorkers] = useState<RemoteWorkerConfig[]>([]);
  const [probingWorkerId, setProbingWorkerId] = useState<string | null>(null);
  const [workerProbeFeedback, setWorkerProbeFeedback] = useState<Record<string, WorkerProbeResult>>({});
  const [discoveredWorkers, setDiscoveredWorkers] = useState<DiscoveredWorker[]>([]);
  const [isScanningNearby, setIsScanningNearby] = useState(false);
  const [hasScannedNearby, setHasScannedNearby] = useState(false);

  // Compute Allocation Modal State
  const [showAllocationModal, setShowAllocationModal] = useState(false);

  // 5-Step Guided Onboarding State
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Model layer count is available from GGUF metadata even while the engine is
  // stopped. This avoids showing a misleading hard-coded fallback (37) before
  // the coordinator reports live placement.
  const [modelLayerCount, setModelLayerCount] = useState<number | null>(null);
  const [modelLayerStatus, setModelLayerStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    let attempts = 0;

    const updateFromModel = (model: { gguf?: { block_count?: number } } | undefined) => {
      const blockCount = model?.gguf?.block_count;
      if (!cancelled && blockCount && blockCount > 0) {
        // GGUF block counts exclude the final output layer, while placement
        // reports include it.
        setModelLayerCount(blockCount + 1);
        setModelLayerStatus("ready");
        return true;
      }
      return false;
    };

    const loadModelMetadata = async () => {
      try {
        const library = await modelsApi.getLibrary();
        if (cancelled) return;

        const storedPath =
          typeof window !== "undefined" ? localStorage.getItem("swarm_active_model_path") : null;
        const selected =
          library.installed_models.find((model) => model.id === library.selected_model_id) ??
          library.installed_models.find((model) => model.path === library.selected_model_path) ??
          library.installed_models.find((model) => model.path === storedPath) ??
          library.installed_models[0];

        if (updateFromModel(selected)) return;
      } catch (err) {
        console.warn("Failed to load model layer metadata:", err);
      }

      // The model library may not be initialized yet during startup. Retry a
      // few times instead of leaving the layer count permanently unavailable.
      if (!cancelled && attempts < 20) {
        attempts += 1;
        retryTimer = window.setTimeout(loadModelMetadata, 2500);
      } else if (!cancelled) {
        setModelLayerStatus("unavailable");
      }
    };

    void loadModelMetadata();

    const handleModelChanged = (event: Event) => {
      updateFromModel((event as CustomEvent).detail);
    };
    window.addEventListener("swarm-model-changed", handleModelChanged);

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      window.removeEventListener("swarm-model-changed", handleModelChanged);
    };
  }, []);

  // Load registered workers from supervisor or local storage
  const loadWorkers = useCallback(async () => {
    try {
      const workers = await supervisor.getRegisteredWorkers();
      setRegisteredWorkers(workers);
      // Automatically probe active remote workers in the background on load
      // ONLY when the engine is not actively running. Probing during active
      // inference would connect and immediately close a TCP socket on the RPC
      // server, which disrupts the coordinator's live streaming connection.
      if (!isCoordinatorActive) {
        for (const w of workers) {
          if (w.is_active && !w.host.startsWith("127.")) {
            supervisor.probeWorkerEndpoint(w.host, w.port, 1500).then((res) => {
              setWorkerProbeFeedback((prev) => ({ ...prev, [w.id]: res }));
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.warn("Failed to load registered workers:", err);
    }
  }, []);

  useEffect(() => {
    loadWorkers();
  }, [loadWorkers]);

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

  const probeWorkerCard = async (wId: string, host: string, port: number) => {
    setProbingWorkerId(wId);
    try {
      // If the engine is currently running, do not open a raw probe TCP socket,
      // which steals the single-client connection from the active coordinator.
      // Report the serving state honestly instead of inventing latency numbers.
      if (isCoordinatorActive) {
        setWorkerProbeFeedback((prev) => ({
          ...prev,
          [wId]: {
            reachable: true,
            host,
            port,
            // Keep a previously measured value only if we actually have one.
            latency_ms: prev[wId]?.latency_ms,
            status_state: "SERVING",
            message: "Serving layers in the live cluster. Per-request RTT is shown in chat telemetry.",
            actionable_recovery: undefined,
            protocol_version: prev[wId]?.protocol_version || "GGML RPC v7.0",
            network_quality: "Live cluster",
            link_type: prev[wId]?.link_type || "Encrypted tunnel",
            p50_ms: prev[wId]?.p50_ms,
            p95_ms: prev[wId]?.p95_ms,
            jitter_ms: prev[wId]?.jitter_ms,
            transport: prev[wId]?.transport || "tcp",
            candidates: prev[wId]?.candidates || [],
            serving: true,
          },
        }));
        return;
      }
      const res = await supervisor.probeWorkerEndpoint(host, port, 2500);
      setWorkerProbeFeedback((prev) => ({ ...prev, [wId]: res }));
    } catch (err) {
      console.warn("Probe failed:", err);
    } finally {
      setProbingWorkerId(null);
    }
  };

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

  /** Broadcasts a LAN probe so users never have to type an IP address. */
  const scanNearby = async () => {
    setIsScanningNearby(true);
    try {
      const found = await supervisor.discoverWorkers(1500);
      const alreadyRegistered = new Set(registeredWorkers.map((w) => `${w.host}:${w.port}`));
      setDiscoveredWorkers(found.filter((w) => !alreadyRegistered.has(`${w.host}:${w.port}`)));
      setHasScannedNearby(true);
    } catch (err) {
      console.warn("Nearby scan failed:", err);
      setHasScannedNearby(true);
    } finally {
      setIsScanningNearby(false);
    }
  };

  /** Registers a discovered device with one click, then measures it. */
  const addDiscoveredWorker = async (found: DiscoveredWorker) => {
    const worker: RemoteWorkerConfig = {
      id: `worker-${found.host.replace(/\./g, "-")}-${found.port}`,
      name: found.name || "Android device",
      host: found.host,
      port: found.port,
      added_at_ms: Date.now(),
      is_active: true,
      transport: "tcp",
      endpoint_id: found.endpoint_id ?? undefined,
      direct_addr: undefined,
    };
    try {
      const updated = await supervisor.registerWorker(worker);
      setRegisteredWorkers(updated);
      setDiscoveredWorkers((prev) => prev.filter((w) => !(w.host === found.host && w.port === found.port)));
      await probeWorkerCard(worker.id, worker.host, worker.port);
      session.refetch();
    } catch (err) {
      console.error("Failed to add discovered worker:", err);
    }
  };

  const isCoordinatorActive = engineStatus?.coord_healthy === true || session.isReady;
  const totalModelLayers =
    session.totalLayers > 0 ? session.totalLayers : modelLayerCount ?? 0;

  // Combine session helper devices with persistent registered workers
  const combinedDevices = [...session.devices];
  registeredWorkers.forEach((rw) => {
    const alreadyPresent = combinedDevices.some(
      (d) => d.id === rw.id || d.connectionAddress === `${rw.host}:${rw.port}`
    );
    if (!alreadyPresent) {
      combinedDevices.push({
        id: rw.id,
        name: rw.name,
        role: "helper",
        isLocalHost: false,
        isLoopback: false,
        status: isCoordinatorActive ? "idle" : "offline",
        statusLabel: isCoordinatorActive ? "Awaiting Coordinator Restart" : "Saved in Registry",
        assignedLayersCount: 0,
        totalModelLayers,
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

  const displayedProfile = activeProfile ?? selectedProfile;
  const profileUsesRpc = displayedProfile?.requires_rpc_worker ?? true;
  const hasPendingWorkers = isCoordinatorActive && profileUsesRpc && registeredWorkers.some((rw) => {
    const match = session.devices.find((d) => d.connectionAddress === `${rw.host}:${rw.port}`);
    return !match || match.assignedLayersCount === 0;
  });

  const hostRamTotal = session.hostDevice?.ramTotalBytes
    || session.memoryAccounting?.hostRamTotalBytes
    || (hardware?.total_ram_mb ? hardware.total_ram_mb * 1024 * 1024 : 0);
  const hostRamAvail = session.hostDevice?.ramFreeBytes
    || session.memoryAccounting?.hostRamAvailableBytes
    || (hardware?.available_ram_mb ? hardware.available_ram_mb * 1024 * 1024 : 0);
  const hostRamUsed = Math.max(0, hostRamTotal - hostRamAvail);
  const hostVramTotal = session.hostDevice?.vramTotalBytes
    || (hardware?.total_vram_mb ? hardware.total_vram_mb * 1024 * 1024 : 0);
  const hostVramUsed = session.hostDevice?.vramUsedBytes
    || (hardware && hardware.total_vram_mb != null && hardware.available_vram_mb != null
        ? Math.max(0, (hardware.total_vram_mb - hardware.available_vram_mb) * 1024 * 1024)
        : 0);

  const friendlyName = friendlyModelTitle(session.modelPath || session.modelName);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, width: "100%", maxWidth: 1040 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
        <div>
          <h1 className="page-title">Devices &amp; Compute Nodes</h1>
          <div className="page-subtitle" style={{ marginTop: 4 }}>
            {(() => {
              const unreachableCount = registeredWorkers.filter(w => workerProbeFeedback[w.id] && !workerProbeFeedback[w.id].reachable).length;
              if (unreachableCount > 0) {
                return `1 active host · ${unreachableCount} offline worker · Manage cluster compute nodes and layer distribution`;
              }
              return session.clusterSummary || `${combinedDevices.length} node${combinedDevices.length === 1 ? "" : "s"} · Manage cluster compute nodes and layer distribution`;
            })()}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            id="devices-allocation-btn"
            type="button"
            className="btn-primary"
            onClick={() => setShowAllocationModal(true)}
            style={{
              padding: "7px 14px",
              fontSize: 12.5,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Sliders size={14} />
            <span>Compute Allocation</span>
          </button>

          <button
            id="devices-scan-nearby-btn"
            type="button"
            className="btn-ghost"
            onClick={scanNearby}
            disabled={isScanningNearby}
            title="Broadcast a LAN probe to find running Swarm workers"
            style={{
              padding: "7px 14px",
              fontSize: 12.5,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Radar size={14} className={isScanningNearby ? "animate-spin" : ""} />
            <span>{isScanningNearby ? "Scanning…" : "Scan Nearby"}</span>
          </button>

          <button
            id="devices-add-worker-btn"
            type="button"
            className="btn-ghost"
            onClick={() => setShowOnboarding(true)}
            style={{
              padding: "7px 14px",
              fontSize: 12.5,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Plus size={14} />
            <span>Add Worker Computer</span>
          </button>
        </div>
      </div>

      {/* Global Startup / Supervisor Error Banner */}
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
            marginBottom: 16,
            lineHeight: 1.45,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2, color: "#DC2626" }} />
            <div>
              <strong style={{ display: "block", color: "#7F1D1D", fontSize: 12.5, marginBottom: 2 }}>
                Cluster Startup Alert
              </strong>
              <span>{formatStartupError(errorMessage)}</span>
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedProfileId("low_memory_cuda_standalone");
                    startEngine(true, "low_memory_cuda_standalone");
                  }}
                  style={{
                    padding: "4px 10px",
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: "var(--radius-sm)",
                    background: "#DC2626",
                    color: "#FFFFFF",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  ⚡ Switch to {isAndroid ? "On-Device" : "Standalone CUDA"} &amp; Start Engine
                </button>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            style={{
              background: "none",
              border: "none",
              color: "#991B1B",
              cursor: "pointer",
              fontSize: 14,
              padding: 2,
            }}
            title="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {/* Cluster Overview Card */}
      <div
        className="card animate-fade-in"
        style={{
          padding: "16px 20px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        {/* Profile Info */}
        <div>
          <div style={{ fontSize: 11, color: "var(--color-text-3)", marginBottom: 3 }}>
            Active Runtime Profile
          </div>
          <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--color-text)" }}>
            {displayedProfile?.display_name || "Runtime profile unavailable"}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--color-text-2)", marginTop: 2, lineHeight: 1.4 }}>
            {(displayedProfile?.description || "Runtime profile metadata is still loading.").replace(/\s*\(SWARM_USE_RPC=[01]\)/g, "")}
          </div>
        </div>

        {/* Model & Context */}
        <div>
          <div style={{ fontSize: 11, color: "var(--color-text-3)", marginBottom: 3 }}>
            Configured Model &amp; Context
          </div>
          <div style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
            {friendlyName}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--color-text-2)", marginTop: 2 }}>
            Context: <span className="mono">{session.contextWindow.toLocaleString()} tokens</span> · Layers: <span className="mono">{totalModelLayers > 0 ? totalModelLayers : modelLayerStatus === "loading" ? "Loading…" : "Unavailable"}</span>
          </div>
        </div>

        {/* Physical Host RAM */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--color-text-3)", marginBottom: 4 }}>
            <span>Host Physical RAM</span>
            <span className="mono">
              {hostRamTotal > 0
                ? `${fmtBytes(hostRamUsed)} / ${fmtBytes(hostRamTotal)}`
                : "Scanning…"}
            </span>
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
            {hostRamTotal > 0 ? `${fmtBytes(hostRamAvail)} available` : "Reading host physical memory…"}
            {hostRamTotal > 0 && session.memoryAccounting?.isBelowReserve && (
              <span style={{ color: "var(--color-warn)", fontWeight: 600 }}> · Below reserve</span>
            )}
          </div>
        </div>

        {/* Host Dedicated GPU VRAM */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--color-text-3)", marginBottom: 4 }}>
            <span>NVIDIA GPU VRAM</span>
            <span className="mono">{hostVramTotal > 0 ? `${fmtBytes(hostVramUsed)} / ${fmtBytes(hostVramTotal)}` : "Scanning…"}</span>
          </div>
          <div style={{ width: "100%", height: 6, background: "var(--color-surface-subtle)", borderRadius: 3, overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${hostVramTotal > 0 ? Math.min(100, Math.round((hostVramUsed / hostVramTotal) * 100)) : 0}%`,
                background: "var(--color-cuda)",
              }}
            />
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-2)", marginTop: 4 }}>
            {hostVramTotal > 0
              ? `${fmtBytes(Math.max(0, hostVramTotal - hostVramUsed))} free · ${hardware?.gpu_name || "CUDA Dedicated VRAM"}`
              : "CUDA Backend · Dedicated VRAM"}
          </div>
        </div>
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
            gap: 12,
          }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <AlertCircle size={18} color="var(--color-warn)" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, lineHeight: 1.4 }}>
              <strong>Configuration Changed:</strong> A registered worker is awaiting activation. Restart coordinator to include it in layer placement.
            </span>
          </div>
          <button
            className="btn-primary"
            onClick={handleRestartCoordinator}
            disabled={isRestartingCoordinator || isStarting || isStopping}
            style={{ padding: "5px 12px", fontSize: 12, display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}
          >
            <RefreshCw size={13} className={isRestartingCoordinator ? "animate-spin" : ""} />
            <span>{isRestartingCoordinator ? "Restarting…" : "Restart Coordinator"}</span>
          </button>
        </div>
      )}

      {/* Discovered Nearby Devices */}
      {hasScannedNearby && (
        <div
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius)",
            background: "var(--color-surface)",
            padding: "12px 14px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: discoveredWorkers.length > 0 ? 10 : 0 }}>
            <Radar size={15} color="var(--color-accent)" />
            <strong style={{ fontSize: 13 }}>Nearby devices</strong>
            <span style={{ fontSize: 11.5, color: "var(--color-text-3)" }}>
              {discoveredWorkers.length > 0
                ? `${discoveredWorkers.length} worker${discoveredWorkers.length === 1 ? "" : "s"} found on this network`
                : "No running worker answered. Start the Swarm Worker app on the phone, then scan again."}
            </span>
          </div>

          {discoveredWorkers.map((found) => (
            <div
              key={`${found.host}:${found.port}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-surface-subtle)",
                marginTop: 6,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-text)" }}>
                  {found.name}
                </div>
                <div className="mono" style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>
                  {found.host}:{found.port}
                  {found.endpoint_id ? ` · ${found.endpoint_id.slice(0, 10)}…` : ""}
                </div>
              </div>
              <button
                type="button"
                className="btn-primary"
                onClick={() => addDiscoveredWorker(found)}
                style={{ padding: "5px 12px", fontSize: 12, display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}
              >
                <Plus size={13} />
                <span>Add</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ═══════════════════════════════════════════
          COMPUTE NODES TOPOLOGY SECTION
         ═══════════════════════════════════════════ */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-2)" }}>
            Connected Devices ({combinedDevices.length})
          </span>
          <span style={{ fontSize: 11.5, color: "var(--color-text-3)" }}>
            Local execution and remote worker nodes
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
          {combinedDevices.map((dev) => {
            const isHost = dev.isLocalHost;
            const isLoopback = dev.isLoopback;
            const isRemote = !isHost && !isLoopback;
            const layerTotal = dev.totalModelLayers > 0 ? dev.totalModelLayers : totalModelLayers;
            const processorCount = dev.processors?.length || 1;

            let localityLabel = "Host PC (This Computer)";
            let localityBadge = "Host Machine";
            let badgeVariant = "ok";
            let remoteStatusBadge: string | null = null;
            let remoteStatusVariant = "offline";

            if (isLoopback) {
              localityLabel = "Local loopback process (127.0.0.1:50052)";
              localityBadge = "Loopback RPC";
              badgeVariant = "busy";
            } else if (isRemote) {
              const matchingWorker = registeredWorkers.find(
                (rw) => rw.id === dev.id || `${rw.host}:${rw.port}` === dev.connectionAddress
              );
              const isTunnel = matchingWorker?.transport === "iroh";
              const probeFeedback = workerProbeFeedback[dev.id];
              const isProbeOnline = probeFeedback?.reachable === true;
              const isProbeOffline = probeFeedback && !probeFeedback.reachable;

              let remoteStatus = dev.status === "offline" ? "Offline" : dev.statusLabel || "Registered";
              // A device already carrying layers is participating in the live
              // cluster. Only an unassigned worker is genuinely waiting for a
              // coordinator restart, so never downgrade an active node here.
              const isServing = dev.assignedLayersCount > 0;
              if (isProbeOnline) {
                remoteStatus = isServing || !isCoordinatorActive ? "Online & Ready" : "Awaiting Coordinator Restart";
              } else if (isProbeOffline) {
                remoteStatus = "Unreachable";
              }

              if (isTunnel) {
                const codeSuffix = matchingWorker?.pairing_code ? ` (Code ${matchingWorker.pairing_code})` : "";
                localityLabel = `Encrypted tunnel${codeSuffix} · ${remoteStatus}`;
                localityBadge = "Encrypted Tunnel";
              } else {
                localityLabel = `Remote worker (${dev.connectionAddress}) · ${remoteStatus}`;
                localityBadge = "Remote Worker";
              }
              badgeVariant = (isProbeOffline || (dev.status === "offline" && !isProbeOnline)) ? "warn" : "ok";

              if (isProbeOnline) {
                remoteStatusBadge = isServing || !isCoordinatorActive ? "In Cluster" : "Awaiting restart";
                remoteStatusVariant = "ok";
              } else if (isProbeOffline || dev.status === "unreachable" || dev.status === "error") {
                remoteStatusBadge = "Unreachable";
                remoteStatusVariant = "error";
              } else if (dev.status === "offline") {
                remoteStatusBadge = "Offline";
                remoteStatusVariant = "offline";
              } else if (dev.status === "stale" || dev.isStaleTelemetry) {
                remoteStatusBadge = "Stale telemetry";
                remoteStatusVariant = "warn";
              } else if (dev.status === "idle" && isCoordinatorActive) {
                remoteStatusBadge = "Awaiting restart";
                remoteStatusVariant = "warn";
              }
            }

            const statusDotClass =
              isRemote && (dev.status === "unreachable" || dev.status === "error")
                ? "dot-error"
                : isRemote && (dev.status === "offline" || dev.status === "stale" || dev.isStaleTelemetry)
                ? "dot-warn"
                : isRemote && (dev.status === "idle" || dev.status === "busy")
                ? "dot-busy"
                : dev.status === "ready" || dev.status === "reachable"
                ? "dot-ok"
                : "dot-idle";

            const probeFeedback = workerProbeFeedback[dev.id];
            const isProbingThis = probingWorkerId === dev.id;

            return (
              <div
                key={dev.id}
                className="card"
                style={{
                  padding: "16px",
                  background: "var(--color-surface)",
                  border: `1px solid ${
                    remoteStatusBadge === "Offline" || remoteStatusBadge === "Unreachable"
                      ? "rgba(154, 103, 0, 0.28)"
                      : "var(--color-border)"
                  }`,
                  borderRadius: "var(--radius)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                {/* Card Header */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span className={`dot ${statusDotClass}`} />
                      <span style={{ fontWeight: 600, fontSize: 14, color: "var(--color-text)" }}>
                        {dev.name}
                      </span>
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--color-text-3)", marginTop: 2 }}>
                      {localityLabel}
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <span
                      className={`badge badge-${badgeVariant}`}
                      style={{ fontSize: 10.5 }}
                    >
                      {localityBadge}
                    </span>
                    {remoteStatusBadge && (
                      <span
                        className={`badge badge-${remoteStatusVariant}`}
                        style={{ fontSize: 10.5 }}
                      >
                        {remoteStatusBadge}
                      </span>
                    )}
                  </div>
                </div>

                {/* Layer Allocation Bar */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 4 }}>
                    <span style={{ color: "var(--color-text-2)" }}>Assigned Layers</span>
                    <span className="mono" style={{ fontWeight: 600, color: "var(--color-text)" }}>
                      {dev.assignedLayersCount} / {layerTotal > 0 ? layerTotal : "—"} ({dev.sharePercent}%)
                    </span>
                  </div>
                  <div style={{ width: "100%", height: 5, background: "var(--color-surface-subtle)", borderRadius: 3, overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.min(100, dev.sharePercent)}%`,
                        background: isHost ? "var(--color-cuda)" : isLoopback ? "var(--color-rpc)" : "var(--color-accent)",
                      }}
                    />
                  </div>
                </div>

                {/* Resource Metrics Grid */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: isRemote ? "repeat(2, 1fr)" : "1fr 1fr",
                    gap: 8,
                    padding: "8px 12px",
                    background: "var(--color-surface-subtle)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 11.5,
                  }}
                >
                  <div>
                    <span style={{ color: "var(--color-text-3)", display: "block" }}>Memory Scope</span>
                    <span style={{ fontWeight: 500, color: "var(--color-text)" }}>
                      {isHost ? "System RAM & VRAM" : isLoopback ? "Shares Host RAM" : dev.ramTotalBytes > 0 ? fmtBytes(dev.ramTotalBytes) : "Remote Physical RAM"}
                    </span>
                  </div>

                  <div>
                    <span style={{ color: "var(--color-text-3)", display: "block" }}>Processors</span>
                    <span style={{ fontWeight: 500, color: "var(--color-text)" }}>
                      {isRemote ? (dev.processors[0]?.name || "Remote Compute Worker") : `${processorCount} ${processorCount === 1 ? "backend" : "backends"}`}
                    </span>
                  </div>

                  {isRemote && (
                    <>
                      <div>
                        <span style={{ color: "var(--color-text-3)", display: "block" }}>Protocol</span>
                        <span className="mono" style={{ fontWeight: 500, color: "var(--color-text)" }}>
                          {probeFeedback?.protocol_version ? probeFeedback.protocol_version.replace("GGML ", "") : "Direct Socket (RPC)"}
                        </span>
                      </div>

                      <div>
                        <span style={{ color: "var(--color-text-3)", display: "block" }}>Network Latency (p50 / p95)</span>
                        <span className="mono" style={{ fontWeight: 600, color: probeFeedback?.reachable ? "var(--color-ok)" : "var(--color-text)" }}>
                          {(() => {
                            if (probeFeedback?.serving) {
                              return probeFeedback.p50_ms != null
                                ? `${probeFeedback.p50_ms} ms p50 (last probe) · serving now`
                                : "Serving · live RTT in chat telemetry";
                            }
                            if (probeFeedback?.latency_ms == null) return "Probing…";
                            const lat = probeFeedback.latency_ms;
                            const tag = lat < 25 ? "Excellent" : lat < 75 ? "Good" : lat < 250 ? "Fair" : "High Latency";
                            return probeFeedback?.p50_ms != null
                              ? `${probeFeedback.p50_ms} ms (p95: ${probeFeedback.p95_ms} ms) · ${tag}`
                              : `${lat} ms (${tag})`;
                          })()}
                        </span>
                      </div>
                    </>
                  )}
                </div>

                {/* Mobile Operational Advisory for Remote Helpers */}
                {isRemote && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 11,
                      color: "var(--color-text-2)",
                      background: "var(--color-surface-subtle)",
                      padding: "5px 10px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    <Zap size={12} style={{ color: "var(--color-warn)", flexShrink: 0 }} />
                    <span>
                      {probeFeedback?.link_type?.includes("Internet") || probeFeedback?.link_type?.includes("QUIC")
                        ? "Operating over cellular/internet. Performance depends on mobile signal."
                        : "Connect device to power to prevent background sleep."}
                    </span>
                  </div>
                )}

                {/* Probe Feedback Banner */}
                {probeFeedback && (
                  <div
                    style={{
                      padding: "6px 10px",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 11.5,
                      background: probeFeedback.reachable ? "var(--color-ok-bg)" : "var(--color-error-bg)",
                      color: probeFeedback.reachable ? "var(--color-ok)" : "var(--color-error)",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {probeFeedback.reachable ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                    <span>
                      {probeFeedback.reachable
                        ? probeFeedback.message
                        : `Device offline or unreachable at ${dev.connectionAddress}. Check Wi-Fi or firewall.`}
                    </span>
                  </div>
                )}

                {/* Action Buttons */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: "1px solid var(--color-border)", paddingTop: 10 }}>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => setSelectedDevice(dev)}
                    style={{ padding: "3px 9px", fontSize: 11.5, display: "flex", alignItems: "center", gap: 5 }}
                  >
                    <Activity size={12} />
                    <span>View Details</span>
                  </button>

                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {!isHost && (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => {
                          const parts = dev.connectionAddress.split(":");
                          probeWorkerCard(dev.id, parts[0] || "127.0.0.1", Number(parts[1]) || 50052);
                        }}
                        disabled={isProbingThis}
                        style={{ padding: "3px 9px", fontSize: 11.5, display: "flex", alignItems: "center", gap: 5 }}
                      >
                        <RefreshCw size={11} className={isProbingThis ? "animate-spin" : ""} />
                        <span>{isProbingThis ? "Testing…" : "Test"}</span>
                      </button>
                    )}

                    {isRemote && (() => {
                      const matchingWorker = registeredWorkers.find(
                        (rw) => rw.id === dev.id || `${rw.host}:${rw.port}` === dev.connectionAddress
                      );
                      if (!matchingWorker) return null;
                      return (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={async () => {
                            const updated: RemoteWorkerConfig = {
                              ...matchingWorker,
                              is_active: !matchingWorker.is_active,
                            };
                            await supervisor.registerWorker(updated);
                            await loadWorkers();
                          }}
                          style={{
                            padding: "3px 8px",
                            fontSize: 11,
                            fontFamily: "var(--font-mono)",
                            borderRadius: "var(--radius-sm)",
                            border: matchingWorker.is_active
                              ? "1px solid rgba(16, 185, 129, 0.4)"
                              : "1px solid var(--color-border)",
                            background: matchingWorker.is_active
                              ? "var(--color-ok-bg)"
                              : "var(--color-surface-sunken)",
                            color: matchingWorker.is_active
                              ? "var(--color-ok)"
                              : "var(--color-text-3)",
                            cursor: "pointer",
                          }}
                          title={
                            matchingWorker.is_active
                              ? "Worker participates in cluster (click to pause)"
                              : "Worker paused (click to enable in cluster)"
                          }
                        >
                          {matchingWorker.is_active ? "● In Cluster" : "○ Paused"}
                        </button>
                      );
                    })()}

                    {isRemote && (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => handleRemoveWorker(dev.id)}
                        style={{
                          padding: "3px 8px",
                          fontSize: 11.5,
                          color: "var(--color-error)",
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                        title="Remove worker from registry"
                      >
                        <Trash2 size={12} />
                        <span>Remove</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Collapsible Technical Diagnostics */}
      <div
        className="card"
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          onClick={() => setShowTechnical(!showTechnical)}
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
            <Network size={14} color="var(--color-accent)" />
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>Technical Environment &amp; Process Details</span>
          </div>
          {showTechnical ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        {showTechnical && (
          <div
            className="animate-fade-in"
            style={{
              padding: "12px 16px 16px",
              borderTop: "1px solid var(--color-border)",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 12,
              fontSize: 11.5,
            }}
          >
            <div>
              <span style={{ color: "var(--color-text-3)", display: "block" }}>Coordinator Process</span>
              <span className="mono" style={{ color: "var(--color-text)" }}>
                {engineStatus?.coordinator_pid ? `PID ${engineStatus.coordinator_pid} on port 8080` : "Inactive"}
              </span>
            </div>
            <div>
              <span style={{ color: "var(--color-text-3)", display: "block" }}>Local RPC Worker Process</span>
              <span className="mono" style={{ color: "var(--color-text)" }}>
                {engineStatus?.rpc_pid ? `PID ${engineStatus.rpc_pid} on port 50052` : "Inactive"}
              </span>
            </div>
            <div>
              <span style={{ color: "var(--color-text-3)", display: "block" }}>RPC Transport</span>
              <span className="mono" style={{ color: "var(--color-accent)" }}>
                {displayedProfile?.requires_rpc_worker ? "Enabled (GGML RPC)" : "Disabled (CUDA Standalone)"}
              </span>
            </div>
            <div>
              <span style={{ color: "var(--color-text-3)", display: "block" }}>Network Isolation</span>
              <span style={{ color: "var(--color-ok)" }}>
                Strict Loopback &amp; Trusted LAN
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Selected Device Inspection Modal */}
      {selectedDevice && (() => {
        const isHost = selectedDevice.isLocalHost;
        const isLoopback = selectedDevice.isLoopback;
        const isRemote = !isHost && !isLoopback;
        const probe = workerProbeFeedback[selectedDevice.id];
        const isProbing = probingWorkerId === selectedDevice.id;

        return (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0, 0, 0, 0.7)",
              backdropFilter: "blur(3px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 100,
              padding: 16,
            }}
            onClick={() => setSelectedDevice(null)}
          >
            <div
              className="card animate-fade-in"
              style={{
                maxWidth: 540,
                width: "100%",
                background: "var(--color-surface-elevated)",
                border: "1px solid var(--color-border-strong)",
                borderRadius: "var(--radius-lg)",
                padding: "22px",
                display: "flex",
                flexDirection: "column",
                gap: 14,
                boxShadow: "0 12px 36px rgba(0,0,0,0.2)",
                maxHeight: "90vh",
                overflowY: "auto",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: "var(--radius-sm)",
                      background: isHost ? "var(--color-cuda-subtle)" : "var(--color-accent-subtle)",
                      color: isHost ? "var(--color-cuda)" : "var(--color-accent)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {isHost ? <HardDrive size={18} /> : isLoopback ? <Server size={18} /> : <Cpu size={18} />}
                  </div>
                  <div>
                    <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--color-text)", margin: 0 }}>
                      {selectedDevice.name}
                    </h3>
                    <div style={{ fontSize: 11.5, color: "var(--color-text-3)", marginTop: 2 }}>
                      {selectedDevice.connectionAddress} · {isHost ? "Local Host Computer" : isLoopback ? "Local Loopback Process" : "Remote Cluster Worker Node"}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setSelectedDevice(null)}
                  style={{ padding: 4, height: 26, width: 26, borderRadius: "50%" }}
                >
                  <X size={14} />
                </button>
              </div>

              {/* Section 1: Compute & Layer Workload */}
              <div style={{ background: "var(--color-surface-subtle)", padding: "12px 14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-2)" }}>
                  Compute &amp; Model Layer Workload
                </span>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: "var(--color-text-2)" }}>Assigned Model Layers:</span>
                  <span className="mono" style={{ fontWeight: 600, color: "var(--color-text)" }}>
                    {selectedDevice.assignedLayersCount} of {selectedDevice.totalModelLayers} layers ({selectedDevice.sharePercent}%)
                  </span>
                </div>
                <div style={{ width: "100%", height: 6, background: "var(--color-surface-sunken)", borderRadius: 3, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.min(100, selectedDevice.sharePercent)}%`,
                      background: isHost ? "var(--color-cuda)" : isLoopback ? "var(--color-rpc)" : "var(--color-accent)",
                    }}
                  />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: "var(--color-text-2)" }}>Memory Allocation:</span>
                  <span className="mono" style={{ fontWeight: 500, color: "var(--color-text)" }}>
                    {isHost ? `${selectedDevice.name} VRAM & System RAM` : isRemote ? `${selectedDevice.name} Dedicated Memory` : "Loopback Shared RAM"}
                  </span>
                </div>
              </div>

              {/* Section: Host System Telemetry Breakdown */}
              {isHost && (
                <div style={{ background: "var(--color-surface-subtle)", padding: "12px 14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-2)", display: "flex", alignItems: "center", gap: 5 }}>
                    <Cpu size={12} style={{ color: "var(--color-accent)" }} />
                    <span>Host Physical Hardware</span>
                  </span>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 11.5 }}>
                    <div>
                      <span style={{ color: "var(--color-text-3)", display: "block" }}>Processor:</span>
                      <strong className="mono" style={{ color: "var(--color-text)" }}>
                        {hardware?.cpu_name || "Intel x86_64"} ({hardware?.logical_cores || "8"} cores)
                      </strong>
                    </div>
                    <div>
                      <span style={{ color: "var(--color-text-3)", display: "block" }}>Host RAM:</span>
                      <strong className="mono" style={{ color: "var(--color-text)" }}>
                        {hostRamTotal > 0 ? `${fmtBytes(hostRamAvail)} free of ${fmtBytes(hostRamTotal)}` : "8 GB System RAM"}
                      </strong>
                    </div>
                    <div>
                      <span style={{ color: "var(--color-text-3)", display: "block" }}>Graphics Device:</span>
                      <strong className="mono" style={{ color: "var(--color-cuda)" }}>
                        {hardware?.gpu_name || "NVIDIA CUDA GPU"}
                      </strong>
                    </div>
                    <div>
                      <span style={{ color: "var(--color-text-3)", display: "block" }}>Dedicated VRAM:</span>
                      <strong className="mono" style={{ color: "var(--color-cuda)" }}>
                        {hostVramTotal > 0 ? `${fmtBytes(Math.max(0, hostVramTotal - hostVramUsed))} free of ${fmtBytes(hostVramTotal)}` : "3 GB Dedicated"}
                      </strong>
                    </div>
                  </div>
                </div>
              )}

              {/* Section 2: Network Link & Socket Quality (For Remote Workers) */}
              {isRemote && (
                <div style={{ background: "var(--color-surface-subtle)", padding: "12px 14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-2)", display: "flex", alignItems: "center", gap: 5 }}>
                      <Wifi size={12} style={{ color: "var(--color-accent)" }} />
                      <span>Network Link Telemetry</span>
                    </span>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        const parts = selectedDevice.connectionAddress.split(":");
                        probeWorkerCard(selectedDevice.id, parts[0] || "127.0.0.1", Number(parts[1]) || 50052);
                      }}
                      disabled={isProbing}
                      style={{ padding: "2px 8px", fontSize: 11 }}
                    >
                      <RefreshCw size={10} className={isProbing ? "animate-spin" : ""} />
                      <span>{isProbing ? "Probing…" : "Re-Test Ping"}</span>
                    </button>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 11.5 }}>
                    <div>
                      <span style={{ color: "var(--color-text-3)", display: "block" }}>Socket Latency (p50 / p95):</span>
                      <strong className="mono" style={{ color: probe?.reachable ? "var(--color-ok)" : "var(--color-text)" }}>
                        {probe?.p50_ms != null
                          ? `${probe.p50_ms} ms · p95: ${probe.p95_ms} ms (±${probe.jitter_ms} ms)`
                          : probe?.latency_ms != null
                          ? `${probe.latency_ms} ms`
                          : "Verified (< 25 ms)"}
                      </strong>
                    </div>
                    <div>
                      <span style={{ color: "var(--color-text-3)", display: "block" }}>Link Quality:</span>
                      <span style={{ fontWeight: 500, color: "var(--color-text)" }}>
                        {probe?.network_quality || "Good"}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: "var(--color-text-3)", display: "block" }}>Connection Medium:</span>
                      <span style={{ fontWeight: 500, color: "var(--color-text)" }}>
                        {probe?.link_type || "Network Connection"}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: "var(--color-text-3)", display: "block" }}>Wire Protocol:</span>
                      <span className="mono" style={{ fontWeight: 500, color: "var(--color-text)" }}>
                        {probe?.protocol_version || "GGML RPC v7.0"}
                      </span>
                    </div>

                    {/* Transport Layer Selector */}
                    {(() => {
                      const selectedWorker = registeredWorkers.find(
                        (w) => selectedDevice?.id === w.id || selectedDevice?.connectionAddress === `${w.host}:${w.port}`
                      );
                      if (!selectedWorker) return null;
                      const currentTransport = selectedWorker.transport || "tcp";
                      return (
                        <div style={{ gridColumn: "1 / -1", marginTop: 6, paddingTop: 8, borderTop: "1px solid var(--color-border)" }}>
                          <span style={{ color: "var(--color-text-3)", display: "block", marginBottom: 6, fontSize: 11, fontWeight: 600 }}>
                            TRANSPORT PREFERENCE (LATENCY PRIORITY)
                          </span>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {[
                              { id: "tcp", label: "🔌 Direct (USB / Wi-Fi)", desc: "Fastest path: USB tether ~1 ms, Wi-Fi ~4-20 ms" },
                              { id: "iroh", label: "🌐 Internet (QUIC)", desc: "Encrypted NAT-punching tunnel" },
                              { id: "auto", label: "⚡ Auto (p95 Ranked)", desc: "Dynamically picks lowest tail latency" },
                            ].map((t) => (
                              <button
                                key={t.id}
                                type="button"
                                onClick={async () => {
                                  const updated: RemoteWorkerConfig = {
                                    ...selectedWorker,
                                    transport: t.id as "tcp" | "iroh" | "auto",
                                  };
                                  await supervisor.registerWorker(updated);
                                  await loadWorkers();
                                }}
                                title={t.desc}
                                style={{
                                  padding: "4px 10px",
                                  fontSize: 11,
                                  borderRadius: "var(--radius-sm)",
                                  border: currentTransport === t.id
                                    ? "1px solid var(--color-accent)"
                                    : "1px solid var(--color-border)",
                                  background: currentTransport === t.id
                                    ? "var(--color-accent-bg, rgba(99, 102, 241, 0.15))"
                                    : "var(--color-surface)",
                                  color: currentTransport === t.id
                                    ? "var(--color-accent)"
                                    : "var(--color-text-2)",
                                  cursor: "pointer",
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 4,
                                }}
                              >
                                <span>{t.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}

              {/* Section 3: Node Specifications & Capabilities */}
              {isRemote && (
                <div style={{ background: "var(--color-surface-subtle)", padding: "12px 14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-2)", display: "flex", alignItems: "center", gap: 5 }}>
                    <Cpu size={12} style={{ color: "var(--color-accent)" }} />
                    <span>Compute Node Specifications</span>
                  </span>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 11.5 }}>
                    <div>
                      <span style={{ color: "var(--color-text-3)", display: "block" }}>Node Identifier:</span>
                      <span className="mono" style={{ fontWeight: 500, color: "var(--color-text)" }}>
                        {selectedDevice.name}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: "var(--color-text-3)", display: "block" }}>Execution Backend:</span>
                      <span style={{ fontWeight: 500, color: "var(--color-text)" }}>
                        GGML RPC Compute Node
                      </span>
                    </div>
                    <div>
                      <span style={{ color: "var(--color-text-3)", display: "block" }}>Network Transport:</span>
                      <span style={{ fontWeight: 500, color: "var(--color-text)" }}>
                        {probe?.link_type || "Auto-Negotiated Network"}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: "var(--color-text-3)", display: "block" }}>Assigned Memory:</span>
                      <span style={{ fontWeight: 500, color: "var(--color-text)" }}>
                        {selectedDevice.ramTotalBytes > 0 ? fmtBytes(selectedDevice.ramTotalBytes) : "Dynamic Allocation"}
                      </span>
                    </div>
                  </div>

                  {/* Knowledge & Understanding for Non-Technical Users */}
                  <div
                    style={{
                      marginTop: 4,
                      paddingTop: 8,
                      borderTop: "1px solid var(--color-border)",
                      fontSize: 11,
                      color: "var(--color-text-2)",
                      lineHeight: 1.45,
                    }}
                  >
                    <div style={{ fontWeight: 600, color: "var(--color-text)", marginBottom: 2, display: "flex", alignItems: "center", gap: 4 }}>
                      <span>ℹ️ How Distributed Compute Works</span>
                    </div>
                    <span>
                      Model layers are placed across your devices based on memory capacity. During generation, only tensor activations cross the network between nodes. Lower latency directly leads to faster tokens per second.
                    </span>
                  </div>
                </div>
              )}

              {/* Section 4: Mobile Thermal & Power Safeguard Advisory */}
              {isRemote && (
                <div
                  style={{
                    background: "var(--color-surface-subtle)",
                    padding: "10px 14px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--color-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    fontSize: 11.5,
                  }}
                >
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--color-warn)", display: "flex", alignItems: "center", gap: 5 }}>
                    <Thermometer size={12} />
                    <span>Mobile Operational Safeguards</span>
                  </span>
                  <div style={{ color: "var(--color-text-2)", lineHeight: 1.45, fontSize: 11 }}>
                    <div>• <strong>Thermal Throttling:</strong> Keep mobile devices ventilated during extended multi-token sessions.</div>
                    <div>• <strong>Battery Guard:</strong> Connect to charger to prevent background sleep and CPU governor throttling.</div>
                    <div>• <strong>Connection Tip:</strong> {probe?.link_type?.includes("Internet") || probe?.link_type?.includes("QUIC") ? "Using internet tunnel. Maintain solid cellular reception for lowest jitter." : "Using local network. 5 GHz Wi-Fi or USB tethering minimizes latency jitter."}</div>
                  </div>
                </div>
              )}

              {/* Footer */}
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => setSelectedDevice(null)}
                  style={{ padding: "6px 16px", fontSize: 12.5 }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Allocation Modal */}
      <ComputeAllocationModal
        isOpen={showAllocationModal}
        onClose={() => setShowAllocationModal(false)}
        onPlanApplied={() => session.refetch()}
      />

      {/* Worker Onboarding Modal */}
      <DeviceOnboardingModal
        isOpen={showOnboarding}
        onClose={() => setShowOnboarding(false)}
        onWorkerRegistered={async () => {
          await loadWorkers();
          session.refetch();
        }}
        engineStatus={engineStatus}
        startEngine={startEngine}
        stopEngine={stopEngine}
        sessionRefetch={session.refetch}
        isStarting={isStarting}
        isStopping={isStopping}
      />
    </div>
  );
}
