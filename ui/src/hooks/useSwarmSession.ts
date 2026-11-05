import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useHealth, useBackends, useNodes, useLatestInference, type ValidatedTimings } from "./useSwarm";
import type { BackendPlacement, WorkerInfo } from "../types/api";

export type SessionState =
  | "not_running"
  | "loading_model"
  | "ready"
  | "generating"
  | "paused"
  | "stopped"
  | "error";

export interface RibbonSegment {
  backendId: string;
  deviceName: string;
  backendType: string;
  isLoopback: boolean;
  processor: "cpu" | "gpu" | "rpc";
  deviceRole: "host" | "helper";
  layerCount: number;
  startLayer: number;
  endLayer: number;
  rangeLabel: string;
  modelBufferBytes: number;
  kvBufferBytes: number;
  computeBufferBytes: number;
  endpoint?: string;
  memoryScope?: string;
  measurementStatus?: string;
  logDerived?: boolean;
  workerState?: string;
  workerStatusLabel?: string;
  workerLastError?: string;
  workerDiagnostic?: DeviceDiagnostic;
}

export interface DeviceDiagnostic {
  severity: "none" | "info" | "warning" | "error";
  title: string;
  message: string;
  consequence?: string;
  recoveryAction?: string;
}

export interface SwarmDevice {
  id: string;
  name: string;
  role: "host" | "helper";
  isLocalHost: boolean;
  isLoopback: boolean;
  status: "ready" | "reachable" | "unreachable" | "stale" | "idle" | "offline" | "busy" | "error";
  statusLabel: string;
  assignedLayersCount: number;
  totalModelLayers: number;
  sharePercent: number;
  ramTotalBytes: number;
  ramFreeBytes: number;
  vramTotalBytes?: number;
  vramFreeBytes?: number;
  vramUsedBytes?: number;
  reserveBytes: number;
  isBelowReserve: boolean;
  processors: {
    name: string;
    type: "cpu" | "gpu" | "rpc";
    layerCount: number;
    rangeLabel: string;
    modelBufferBytes: number;
  }[];
  connectionAddress: string;
  lastSeenMs?: number;
  provenance: string;
  endpointUrl?: string;
  lastError?: string;
  diagnostic?: DeviceDiagnostic;
  isStaleTelemetry?: boolean;
}

export interface SwarmSession {
  state: SessionState;
  stateLabel: string;
  isReady: boolean;
  isGenerating: boolean;
  isStopped: boolean;
  modelName: string;
  modelPath: string;
  contextWindow: number;
  totalLayers: number;
  ribbonSegments: RibbonSegment[];
  devices: SwarmDevice[];
  hostDevice: SwarmDevice | null;
  helperDevices: SwarmDevice[];
  physicalHostCount: number;
  remoteHelperCount: number;
  localRpcHelperCount: number;
  totalPhysicalMachines: number;
  clusterSummary: string;
  topBarDeviceLabel: string;
  isCoordinatorOffline: boolean;
  consecutiveFailures: number;
  lastHealthyTime: number | null;
  offlineSince: number | null;
  lastKnownModelName: string;
  lastKnownModelPath: string;
  lastKnownLayers: number;
  retryNow: () => Promise<boolean>;
  memoryAccounting: {
    hostRamTotalBytes: number;
    hostRamAvailableBytes: number;
    totalModelBufferBytes: number;
    totalKvBufferBytes: number;
    totalComputeBufferBytes: number;
    totalAllocatedBufferBytes: number;
    reserveBytes: number;
    isBelowReserve: boolean;
    reserveWarningText: string;
  };
  performance: {
    tokensPerSec: number;
    lastPromptEvalMs: number;
    lastGenMs: number;
    lastTotalMs: number;
    avgGenTimePerRequestMs: number;
    totalTokensGenerated: number;
    totalRequestsEvaluated: number;
  };
  latestInference: ValidatedTimings | null;
  raw: {
    health: ReturnType<typeof useHealth>["data"];
    backends: ReturnType<typeof useBackends>["data"];
    nodes: ReturnType<typeof useNodes>["data"];
  };
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const DEFAULT_RESERVE_RAM = 1024 * 1024 * 1024; // 1.0 GB default reserve

const SwarmSessionContext = createContext<SwarmSession | null>(null);

function useSwarmSessionState(pollIntervalMs: number): SwarmSession {
  const {
    data: health,
    lastKnownData: lastKnownHealth,
    error: healthErr,
    loading: healthLoading,
    consecutiveFailures,
    isOffline: isCoordinatorOffline,
    lastHealthyTime,
    offlineSince,
    refetch: refetchHealth,
  } = useHealth(pollIntervalMs);
  const { data: backendsData, error: backendsErr } = useBackends(pollIntervalMs);
  const { data: nodesData, error: nodesErr } = useNodes(Math.max(pollIntervalMs, 5000));
  const latestInference = useLatestInference();

  const session = useMemo<SwarmSession>(() => {
    const error = healthErr || backendsErr || nodesErr || null;
    const loading = healthLoading && !health && !lastKnownHealth;

    // Transient failure tolerance: on a single transient failure, preserve lastKnownHealth
    const effectiveHealth = isCoordinatorOffline ? null : (health || lastKnownHealth);

    // 1. Determine Session Lifecycle State
    let state: SessionState = "ready";
    let stateLabel = "Ready";

    if (isCoordinatorOffline) {
      state = "not_running";
      stateLabel = "Coordinator offline";
    } else if (!effectiveHealth) {
      state = "not_running";
      stateLabel = "Not running";
    } else if (!effectiveHealth.model?.loaded) {
      state = "loading_model";
      stateLabel = "Loading model";
    } else if (effectiveHealth.workers?.some((w) => w.is_inference_active)) {
      state = "generating";
      stateLabel = "Generating";
    } else if (!effectiveHealth.inference?.ready) {
      if (effectiveHealth.inference?.unready_reason) {
        state = "paused";
        stateLabel = "Paused";
      } else {
        state = "paused";
        stateLabel = "Not ready";
      }
    }

    const isReady = state === "ready" || state === "generating";
    const isGenerating = state === "generating";
    const isStopped = state === "not_running";

    // 2. Model & Context Properties
    const effectiveHealthOrLast = effectiveHealth || lastKnownHealth;
    const storedModelPath = typeof window !== "undefined" ? localStorage.getItem("swarm_active_model_path") : null;
    const storedModelName = typeof window !== "undefined" ? localStorage.getItem("swarm_active_model_name") : null;
    const storedModelCtx = typeof window !== "undefined" ? localStorage.getItem("swarm_active_model_ctx") : null;

    const modelPath = isReady
      ? (effectiveHealth?.model?.path || storedModelPath || "")
      : (storedModelPath || effectiveHealthOrLast?.model?.path || "");
    const modelParts = modelPath.split(/[\\/]/);
    const modelName = isReady
      ? (effectiveHealth?.model?.path ? (modelParts[modelParts.length - 1] || "Unknown model") : (storedModelName || "Unknown model"))
      : (storedModelName || modelParts[modelParts.length - 1] || "No model loaded");
    const storedCtxNumber = storedModelCtx ? Number(storedModelCtx) : undefined;
    const contextWindow = isReady
      ? (effectiveHealth?.context?.size || storedCtxNumber || 0)
      : (storedCtxNumber || effectiveHealthOrLast?.context?.size || 0);

    // 3. Authoritative Placement Ribbon Segments
    const backends: BackendPlacement[] = backendsData?.backends ?? [];
    const calculatedTotal = backends.reduce((sum, b) => sum + (b.assigned_layers ? b.assigned_layers.length : 0), 0);
    const totalLayers = calculatedTotal;
    const allWorkers: WorkerInfo[] = (effectiveHealth?.workers ?? lastKnownHealth?.workers) || [];

    const ribbonSegments: RibbonSegment[] = backends.map((b) => {
      const count = b.assigned_layers ? b.assigned_layers.length : 0;

      let start = 0;
      let end = 0;
      let rangeLabel = "";
      if (b.assigned_layer_ranges && b.assigned_layer_ranges.length > 0) {
        const first = b.assigned_layer_ranges[0];
        const last = b.assigned_layer_ranges[b.assigned_layer_ranges.length - 1];
        start = first[0];
        end = last[1];
        rangeLabel = b.assigned_layer_ranges.map(([s, e]) => (s === e ? `L${s}` : `L${s}–L${e}`)).join(", ");
      } else if (count > 0) {
        start = b.assigned_layers[0];
        end = b.assigned_layers[count - 1];
        rangeLabel = start === end ? `L${start}` : `L${start}–L${end}`;
      }

      const isCuda = b.backend_type === "local_cuda" || b.backend_id.toUpperCase().includes("CUDA");
      const isCpu = b.backend_type === "cpu" || b.backend_id.toUpperCase().includes("CPU");
      const processor: "cpu" | "gpu" | "rpc" = isCuda ? "gpu" : isCpu ? "cpu" : "rpc";
      const isLoopback = b.is_loopback || b.backend_type === "loopback_rpc";
      const deviceRole: "host" | "helper" = isLoopback || processor !== "rpc" ? "host" : "helper";

      const matchWorker = allWorkers.find(
        (w) => (w.port && b.endpoint?.includes(String(w.port))) || b.backend_id === w.id || b.backend_id === w.device_name
      );

      let workerStatusLabel: string | undefined = undefined;
      let workerDiagnostic: DeviceDiagnostic | undefined = undefined;

      if (processor === "rpc") {
        const workerStateUpper = (matchWorker?.state || "").toUpperCase();
        const isFailedOrUnavailable = workerStateUpper === "FAILED" || workerStateUpper === "UNAVAILABLE";
        if (isFailedOrUnavailable) {
          workerStatusLabel = workerStateUpper === "FAILED" ? "Failed" : "Unreachable";
          workerDiagnostic = {
            severity: "error",
            title: `RPC Worker ${workerStatusLabel}`,
            message: `Coordinator cannot reach worker socket ${b.endpoint || `${matchWorker?.host}:${matchWorker?.port}`}.${matchWorker?.last_error ? ` Error: ${matchWorker.last_error}` : ""}`,
            consequence: count > 0
              ? `Critical: ${count} model layers (${rangeLabel}) are mapped to this worker. GGML RPC requires all participating nodes; inference will abort without this worker.`
              : `Non-critical: 0 layers assigned. Local host inference is unaffected.`,
            recoveryAction: `Verify RPC worker process is active at ${b.endpoint || `${matchWorker?.host}:${matchWorker?.port}`}.`,
          };
        } else if (workerStateUpper === "READY") {
          workerStatusLabel = count > 0 ? "Ready" : "Idle (0 layers)";
        } else if (workerStateUpper === "BUSY") {
          workerStatusLabel = "Busy";
        } else if (workerStateUpper) {
          workerStatusLabel = workerStateUpper.toLowerCase();
        }
      }

      return {
        backendId: b.backend_id,
        deviceName: b.description || b.device_name || b.backend_id,
        backendType: b.backend_type,
        isLoopback,
        processor,
        deviceRole,
        layerCount: count,
        startLayer: start,
        endLayer: end,
        rangeLabel,
        modelBufferBytes: b.model_buffer_bytes ?? 0,
        kvBufferBytes: b.kv_buffer_bytes ?? 0,
        computeBufferBytes: b.compute_buffer_bytes ?? 0,
        endpoint: b.endpoint || (matchWorker ? `${matchWorker.host}:${matchWorker.port}` : undefined),
        memoryScope: b.memory_scope || (processor === "gpu" ? "device_vram" : "shared_host"),
        measurementStatus: b.measurement_status || (b.log_derived ? "Measured" : "Reported"),
        logDerived: b.log_derived ?? false,
        workerState: matchWorker?.state,
        workerStatusLabel,
        workerLastError: matchWorker?.last_error,
        workerDiagnostic,
      };
    });

    // Ensure ribbon segments are strictly sorted by startLayer ascending
    // so they reflect actual contiguous model layer order: CPU (0–32), RPC (33), CUDA (34–36)
    ribbonSegments.sort((a, b) => a.startLayer - b.startLayer);

    // 4. Memory Accounting (Deduplicated Host RAM)
    const hostRamTotal = backendsData?.memory_accounting?.host_ram_total_bytes ?? 0;
    const hostRamAvail = backendsData?.memory_accounting?.host_ram_available_bytes ?? 0;
    const hasHostRamTelemetry = hostRamAvail > 0;
    const effectiveReserveRam = hostRamTotal > 0
      ? Math.min(DEFAULT_RESERVE_RAM, Math.max(300 * 1024 * 1024, Math.round(hostRamTotal * 0.05)))
      : DEFAULT_RESERVE_RAM;
    const isBelowReserve = hasHostRamTelemetry && hostRamAvail < effectiveReserveRam;
    const availGb = (hostRamAvail / 1024 / 1024 / 1024).toFixed(2);
    const reserveGb = (effectiveReserveRam / 1024 / 1024 / 1024).toFixed(1);
    const reserveWarningText = !hasHostRamTelemetry
      ? "RAM headroom unavailable: the coordinator has not reported host memory telemetry."
      : isBelowReserve
        ? `RAM Headroom: ${availGb} GB free now (reserve: ${reserveGb} GB). Inference remains active; memory is constrained.`
        : `RAM Headroom: ${availGb} GB free now (${reserveGb} GB kept in reserve).`;

    // 5. Structure Physical Devices
    // Primary Physical Host (This computer)
    const hostCpuSegment = ribbonSegments.find((r) => r.processor === "cpu");
    const hostGpuSegment = ribbonSegments.find((r) => r.processor === "gpu");

    const hostLayers = (hostCpuSegment?.layerCount || 0) + (hostGpuSegment?.layerCount || 0);
    const hostProcessors: SwarmDevice["processors"] = [];
    if (hostCpuSegment) {
      hostProcessors.push({
        name: "CPU",
        type: "cpu",
        layerCount: hostCpuSegment.layerCount,
        rangeLabel: hostCpuSegment.rangeLabel,
        modelBufferBytes: hostCpuSegment.modelBufferBytes,
      });
    }
    if (hostGpuSegment) {
      hostProcessors.push({
        name: hostGpuSegment.deviceName || "GPU (CUDA0)",
        type: "gpu",
        layerCount: hostGpuSegment.layerCount,
        rangeLabel: hostGpuSegment.rangeLabel,
        modelBufferBytes: hostGpuSegment.modelBufferBytes,
      });
    }

    const hostGpuPlacement = backends.find((b) => b.backend_type === "local_cuda");
    const hostVramTotal = hostGpuPlacement?.memory_total_bytes;
    const hostVramFreeRaw = hostGpuPlacement?.memory_free_bytes;
    const allocatedGpuBuffers =
      (hostGpuPlacement?.model_buffer_bytes || 0) +
      (hostGpuPlacement?.kv_buffer_bytes || 0) +
      (hostGpuPlacement?.compute_buffer_bytes || 0);

    const baseHostVramUsed =
      hostVramTotal != null && hostVramFreeRaw != null
        ? Math.max(0, hostVramTotal - hostVramFreeRaw)
        : 0;

    const hostVramUsed =
      hostVramTotal != null
        ? Math.min(hostVramTotal, baseHostVramUsed + allocatedGpuBuffers)
        : undefined;

    const hostVramFree =
      hostVramTotal != null && hostVramUsed != null
        ? Math.max(0, hostVramTotal - hostVramUsed)
        : hostVramFreeRaw;

    const hostConnection = effectiveHealth?.server?.host
      ? `${effectiveHealth.server.host}:${effectiveHealth.server.port} (Local Coordinator)`
      : "Coordinator unavailable";
    const hostDevice: SwarmDevice = {
      id: "device-host-local",
      name: "This computer",
      role: "host",
      isLocalHost: true,
      isLoopback: false,
      status: isReady ? "ready" : effectiveHealth ? "reachable" : "offline",
      statusLabel: isReady ? "Ready" : effectiveHealth ? "Connected" : "Offline",
      assignedLayersCount: hostLayers,
      totalModelLayers: totalLayers,
      sharePercent: totalLayers > 0 ? Math.round((hostLayers / totalLayers) * 100) : 0,
      ramTotalBytes: hostRamTotal,
      ramFreeBytes: hostRamAvail,
      vramTotalBytes: hostVramTotal,
      vramFreeBytes: hostVramFree,
      vramUsedBytes: hostVramUsed,
      reserveBytes: effectiveReserveRam,
      isBelowReserve,
      processors: hostProcessors,
      connectionAddress: hostConnection,
      provenance: hostRamTotal > 0 ? "Measured" : "Unavailable",
    };

    // Helper Devices (Loopback Test Helper and Remote Network Helpers)
    const helperDevices: SwarmDevice[] = [];

    allWorkers.forEach((w) => {
      if (w.type === "LOCAL_CUDA" || w.type === "LOCAL_CPU" || w.port === 0) {
        return; // Already part of host
      }

      const matchPlacement = backends.find((b) => (w.port && b.endpoint?.includes(String(w.port))) || b.backend_id === w.id || b.backend_id === w.device_name);
      const layersCount = matchPlacement?.assigned_layers?.length ?? w.assigned_layers?.length ?? 0;
      const rangeLabel = matchPlacement?.assigned_layer_ranges?.map(([s, e]) => (s === e ? `L${s}` : `L${s}–L${e}`)).join(", ") || (w.assigned_layers?.length > 0 ? `L${w.assigned_layers[0]}–L${w.assigned_layers[w.assigned_layers.length - 1]}` : "0 layers");

      const isLoopback = w.is_loopback || w.host === "127.0.0.1" || w.host === "localhost";
      const isParticipating = layersCount > 0;

      // Find matching node telemetry if available
      const nodeMatch = nodesData?.nodes?.find((n) =>
        (w.port && n.endpoint?.includes(String(w.port))) ||
        (w.host && n.endpoint?.includes(w.host)) ||
        n.node_id === w.id
      );
      const isStaleTelemetry = nodeMatch?.is_stale === true;

      // Determine state according to backend semantics
      let helperStatus: SwarmDevice["status"] = "reachable";
      let helperStatusLabel = "Reachable";
      let diagnostic: DeviceDiagnostic | undefined = undefined;

      const workerStateUpper = (w.state || "").toUpperCase();
      const hasError = !!w.last_error && w.last_error.trim().length > 0;
      const isFailedOrUnavailable = workerStateUpper === "FAILED" || workerStateUpper === "UNAVAILABLE";

      if (isFailedOrUnavailable) {
        helperStatus = workerStateUpper === "FAILED" ? "error" : "offline";
        helperStatusLabel = workerStateUpper === "FAILED" ? "Failed" : "Offline";
        const errorDetail = w.last_error ? ` Reported error: ${w.last_error}` : "";
        diagnostic = {
          severity: "error",
          title: `RPC Worker ${helperStatusLabel} (${w.host}:${w.port})`,
          message: `The coordinator cannot communicate with the RPC worker at ${w.host}:${w.port}.${errorDetail}`,
          consequence: isParticipating
            ? `Critical: ${layersCount} model layers (${rangeLabel}) are allocated to this worker. Due to GGML RPC protocol constraints, inference will abort or fail without this worker.`
            : `Non-critical: 0 model layers are mapped to this worker. Local host inference is operational, but distributed execution cannot use this node.`,
          recoveryAction: isParticipating
            ? `Restart the RPC worker process on ${w.host}:${w.port}. Then reload the model or restart the coordinator to re-establish the GGML tensor pipeline.`
            : `Check the worker process on ${w.host}:${w.port} before assigning model layers to it.`,
        };
      } else if (hasError && workerStateUpper !== "READY") {
        helperStatus = "error";
        helperStatusLabel = "Error";
        diagnostic = {
          severity: "warning",
          title: `RPC Worker Warning (${w.host}:${w.port})`,
          message: `Worker reported an issue: ${w.last_error}`,
          consequence: isParticipating
            ? `Inference using this worker may fail. Active layers: ${rangeLabel}.`
            : `Worker holds 0 layers; local host inference continues.`,
          recoveryAction: `Verify worker logs at ${w.host}:${w.port}.`,
        };
      } else if (workerStateUpper === "STOPPED") {
        helperStatus = "offline";
        helperStatusLabel = "Stopped";
      } else if (workerStateUpper === "BUSY" || (isParticipating && isGenerating)) {
        helperStatus = "busy";
        helperStatusLabel = "Busy";
        if (isStaleTelemetry) {
          diagnostic = {
            severity: "info",
            title: "Telemetry Stale",
            message: "Node telemetry has not updated in >30s, but RPC connection is active.",
          };
        }
      } else if (workerStateUpper === "READY") {
        if (isParticipating) {
          helperStatus = "ready";
          helperStatusLabel = "Ready";
        } else {
          helperStatus = "idle";
          helperStatusLabel = "Idle (0 layers)";
        }
        if (isStaleTelemetry) {
          diagnostic = {
            severity: "info",
            title: "Telemetry Stale",
            message: "Optional node telemetry has not updated in >30s, but RPC connection is active and healthy.",
          };
        }
      } else if (workerStateUpper === "STARTING") {
        helperStatus = "reachable";
        helperStatusLabel = "Starting";
      } else {
        helperStatus = isParticipating ? "ready" : "idle";
        helperStatusLabel = isParticipating ? "Ready" : "Idle (0 layers)";
      }

      helperDevices.push({
        id: w.id,
        name: isLoopback ? "Test helper" : (w.device_name || `Helper (${w.host})`),
        role: "helper",
        isLocalHost: false,
        isLoopback,
        status: helperStatus,
        statusLabel: helperStatusLabel,
        assignedLayersCount: layersCount,
        totalModelLayers: totalLayers,
        sharePercent: totalLayers > 0 ? Math.round((layersCount / totalLayers) * 100) : 0,
        ramTotalBytes: isLoopback
          ? hostRamTotal
          : (nodeMatch?.ram_total_bytes?.value ?? nodeMatch?.ram_total?.value ?? w.memory_total_bytes ?? 0),
        ramFreeBytes: isLoopback
          ? hostRamAvail
          : (nodeMatch?.ram_free_bytes?.value ?? nodeMatch?.ram_available?.value ?? w.memory_free_bytes ?? 0),
        vramTotalBytes: (nodeMatch?.vram_total_bytes?.value != null ? nodeMatch.vram_total_bytes.value : nodeMatch?.gpu_vram?.value) ?? undefined,
        vramFreeBytes: (nodeMatch?.vram_free_bytes?.value != null ? nodeMatch.vram_free_bytes.value : undefined),
        reserveBytes: effectiveReserveRam,
        isBelowReserve: isLoopback ? isBelowReserve : false,
        processors: [
          {
            name: isLoopback ? "RPC (Local Process)" : "Remote RPC Worker",
            type: "rpc",
            layerCount: layersCount,
            rangeLabel,
            modelBufferBytes: matchPlacement?.model_buffer_bytes ?? w.model_buffer_bytes ?? 0,
          },
        ],
        connectionAddress: `${w.host}:${w.port}`,
        provenance: matchPlacement?.log_derived ? "Measured" : (nodeMatch ? "Telemetry" : "Reported"),
        endpointUrl: `http://${w.host}:${w.port}`,
        lastError: w.last_error,
        diagnostic,
        isStaleTelemetry,
        lastSeenMs: nodeMatch?.ram_total_bytes?.observed_at_ms || nodeMatch?.ram_total?.observed_at_ms,
      });
    });

    const devices = [hostDevice, ...helperDevices];

    // Accurate physical hardware vs process classification
    const physicalHostCount = 1;
    const remoteHelperCount = helperDevices.filter((d) => !d.isLoopback).length;
    const localRpcHelperCount = helperDevices.filter((d) => d.isLoopback).length;
    const totalPhysicalMachines = physicalHostCount + remoteHelperCount;

    let clusterSummary = "";
    if (remoteHelperCount > 0) {
      clusterSummary = `${physicalHostCount} physical host · ${remoteHelperCount} remote helper${remoteHelperCount > 1 ? "s" : ""}`;
      if (localRpcHelperCount > 0) {
        clusterSummary += ` · ${localRpcHelperCount} local helper`;
      }
    } else if (localRpcHelperCount > 0) {
      clusterSummary = `1 physical host · ${localRpcHelperCount} local RPC helper`;
    } else {
      clusterSummary = `1 physical host (standalone)`;
    }

    let topBarDeviceLabel = "";
    if (remoteHelperCount > 0) {
      topBarDeviceLabel = `${totalPhysicalMachines} devices (${remoteHelperCount} remote)`;
    } else if (localRpcHelperCount > 0) {
      topBarDeviceLabel = `1 host + 1 local helper`;
    } else {
      topBarDeviceLabel = `1 host`;
    }

    // 6. Performance Telemetry & Corrected Metrics
    return {
      state,
      stateLabel,
      isReady,
      isGenerating,
      isStopped,
      modelName,
      modelPath,
      contextWindow,
      totalLayers,
      ribbonSegments,
      devices,
      hostDevice,
      helperDevices,
      physicalHostCount,
      remoteHelperCount,
      localRpcHelperCount,
      totalPhysicalMachines,
      clusterSummary,
      topBarDeviceLabel,
      isCoordinatorOffline,
      consecutiveFailures,
      lastHealthyTime,
      offlineSince,
      lastKnownModelName: effectiveHealthOrLast?.model?.path
        ? effectiveHealthOrLast.model.path.replace(/\\/g, "/").split("/").pop() || "Unknown model"
        : "No model loaded",
      lastKnownModelPath: effectiveHealthOrLast?.model?.path || "",
      lastKnownLayers: totalLayers,
      retryNow: refetchHealth,
      memoryAccounting: {
        hostRamTotalBytes: hostRamTotal,
        hostRamAvailableBytes: hostRamAvail,
        totalModelBufferBytes: backendsData?.memory_accounting?.total_model_buffer_bytes || 0,
        totalKvBufferBytes: backendsData?.memory_accounting?.total_kv_buffer_bytes || 0,
        totalComputeBufferBytes: backendsData?.memory_accounting?.total_compute_buffer_bytes || 0,
        totalAllocatedBufferBytes: backendsData?.memory_accounting?.total_allocated_buffers_bytes || 0,
        reserveBytes: effectiveReserveRam,
        isBelowReserve,
        reserveWarningText,
      },
      performance: {
        tokensPerSec: latestInference?.tokens_per_sec ?? 0,
        lastPromptEvalMs: latestInference?.prompt_eval_ms ?? 0,
        lastGenMs: latestInference?.gen_ms ?? 0,
        lastTotalMs: latestInference?.total_ms ?? 0,
        avgGenTimePerRequestMs: latestInference?.total_ms ?? 0,
        totalTokensGenerated: latestInference?.tokens_generated ?? 0,
        totalRequestsEvaluated: latestInference ? 1 : 0,
      },
      latestInference,
      raw: {
        health,
        backends: backendsData,
        nodes: nodesData,
      },
      loading,
      error,
      refetch: refetchHealth,
    };
  }, [
    health,
    lastKnownHealth,
    backendsData,
    nodesData,
    healthErr,
    backendsErr,
    nodesErr,
    healthLoading,
    isCoordinatorOffline,
    consecutiveFailures,
    lastHealthyTime,
    offlineSince,
    refetchHealth,
    latestInference,
  ]);

  return session;
}

export function SwarmSessionProvider({
  children,
  pollIntervalMs = 3000,
}: {
  children: ReactNode;
  pollIntervalMs?: number;
}) {
  const session = useSwarmSessionState(pollIntervalMs);
  return createElement(SwarmSessionContext.Provider, { value: session }, children);
}

export function useSwarmSession(_pollIntervalMs = 3000): SwarmSession {
  const session = useContext(SwarmSessionContext);
  if (!session) {
    throw new Error("useSwarmSession must be used inside a SwarmSessionProvider.");
  }
  return session;
}
