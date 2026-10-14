import { useHealth, useBackends } from "../hooks/useSwarm";
import { workerStateVariant, fmtBytes } from "../lib/utils";
import { StatusBadge } from "./ui/StatusBadge";
import { MemoryBar } from "./ui/Bars";
import type { WorkerInfo } from "../types/api";
import { Server, Activity, Monitor, HardDrive, Wifi, AlertCircle } from "lucide-react";

export function WorkersPanel() {
  const { data, error, loading } = useHealth(3000);
  const { data: backendsData } = useBackends(3000);

  if (loading) {
    return (
      <div className="card" style={{ padding: "24px" }}>
        <span style={{ color: "var(--color-text-3)", fontSize: 13 }}>Loading cluster devices and workers…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" style={{ padding: "24px" }}>
        <StatusBadge variant="error" label={`Error: ${error}`} />
      </div>
    );
  }

  const allWorkers = data?.workers ?? [];
  const server = data?.server;
  const model = data?.model;
  const context = data?.context;
  const inference = data?.inference;

  // Correlate with placement tracker (/backends) for authoritative layer assignments
  const getBackendPlacement = (dev: WorkerInfo) => {
    return backendsData?.backends?.find(
      (b) =>
        b.backend_id === dev.device_name ||
        b.backend_id === dev.backend_id ||
        b.device_name === dev.device_name ||
        (b.backend_type === "local_cuda" && (dev.type === "LOCAL_CUDA" || dev.id === "local-cuda-0"))
    );
  };

  const getBackendLayers = (dev: WorkerInfo) => {
    if (dev.assigned_layers && dev.assigned_layers.length > 0) {
      return {
        layers: dev.assigned_layers,
        ranges: dev.assigned_layer_ranges || [],
      };
    }
    const match = getBackendPlacement(dev);
    if (match && match.assigned_layers.length > 0) {
      return {
        layers: match.assigned_layers,
        ranges: match.assigned_layer_ranges || [],
      };
    }
    return {
      layers: dev.assigned_layers || [],
      ranges: dev.assigned_layer_ranges || [],
    };
  };

  // Architectural separation:
  // 1. Genuine Network RPC workers (have network port > 0 and protocol is RPC)
  const rpcWorkers = allWorkers.filter(
    (w) => w.type !== "LOCAL_CUDA" && w.type !== "LOCAL_CPU" && (w.port > 0 || w.type.includes("RPC"))
  );

  // 2. Local Hardware Execution Backends (in-process host CUDA / CPU acceleration)
  const localHardwareDevices = allWorkers.filter(
    (w) => w.type === "LOCAL_CUDA" || w.type === "LOCAL_CPU" || w.port === 0
  );

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
      {/* Panel Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          paddingBottom: 14,
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
            <Server size={16} />
          </div>
          <div>
            <h2 style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text)" }}>
              Cluster Compute &amp; Workers
            </h2>
            <div style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>
              Separation of local in-process acceleration and remote network RPC workers
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--color-text-2)" }}>
          <span>1 Coordinator</span>
          <span>&bull;</span>
          <span>{localHardwareDevices.length} Local Hardware</span>
          <span>&bull;</span>
          <span>{rpcWorkers.length} Network RPC</span>
        </div>
      </div>

      {/* 1. Local Coordinator Gateway */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Monitor size={14} color="var(--color-accent)" />
          <span className="section-label">1. Local Coordinator Gateway (Host Machine)</span>
        </div>

        <div
          style={{
            padding: "16px 18px",
            background: "var(--color-surface)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--color-border)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                Swarm Coordinator
              </span>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>
                http://{server?.host || "127.0.0.1"}:{server?.port || 8080}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <StatusBadge
                variant={server?.state === "running" ? "ok" : "warn"}
                label={server?.state ? `Server: ${server.state}` : "Running"}
              />
              <StatusBadge
                variant={inference?.ready ? "ok" : "error"}
                label={inference?.ready ? "Inference Ready" : "Inference Unready"}
              />
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 10,
              background: "var(--color-surface-subtle)",
              padding: "12px 14px",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <div className="stat-row">
              <span style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>Model Loaded</span>
              <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: model?.loaded ? "var(--color-ok)" : "var(--color-warn)" }}>
                {model?.loaded ? "Active (in RAM)" : "Not loaded"}
              </span>
            </div>
            <div className="stat-row">
              <span style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>Context Window</span>
              <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--color-text)" }}>
                {context?.size ? `${context.size} tokens` : "512 tokens"}
              </span>
            </div>
            <div className="stat-row">
              <span style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>Required RPC Workers</span>
              <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--color-text)" }}>
                {inference?.ready_required_rpc_workers ?? 0} of {inference?.required_rpc_workers ?? 0} ready
              </span>
            </div>
          </div>

          {inference?.unready_reason && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 10px",
                background: "var(--color-error-bg)",
                borderRadius: "var(--radius-sm)",
                border: "1px solid #F8D2D2",
                color: "var(--color-error)",
                fontSize: 11.5,
              }}
            >
              <AlertCircle size={14} style={{ flexShrink: 0 }} />
              <span>{inference.unready_reason}</span>
            </div>
          )}
        </div>
      </div>

      {/* 2. Local Acceleration Backends */}
      {localHardwareDevices.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Activity size={14} color="var(--color-accent)" />
            <span className="section-label">2. Local Acceleration Backends (Host Hardware)</span>
          </div>

          {localHardwareDevices.map((dev: WorkerInfo) => {
            const hasVram = dev.memory_total_bytes != null && dev.memory_total_bytes > 0 && dev.memory_free_bytes != null;
            const { layers, ranges } = getBackendLayers(dev);
            const placement = getBackendPlacement(dev);
            const displayName = placement?.description || dev.device_name || "CUDA GPU";
            return (
              <div
                key={dev.id}
                style={{
                  padding: "16px 18px",
                  background: "var(--color-surface)",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--color-border)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <HardDrive size={14} color="var(--color-accent)" />
                    <span style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                      {displayName}
                    </span>
                    <span className="mono" style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>
                      ({placement?.backend_id || dev.device_name || dev.id})
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 600,
                        background: "var(--color-accent-subtle)",
                        color: "var(--color-accent)",
                        padding: "2px 7px",
                        borderRadius: 4,
                        border: "1px solid #D2DDD7",
                      }}
                    >
                      In-Process Hardware
                    </span>
                    {layers.length > 0 && (
                      <StatusBadge variant="ok" label={`${layers.length} layers`} dot={false} />
                    )}
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: 8,
                    fontSize: 11.5,
                    color: "var(--color-text-2)",
                  }}
                >
                  <div>
                    Backend: <strong className="mono" style={{ color: "var(--color-text)" }}>local_cuda (in-process)</strong>
                  </div>
                  <div>
                    Assigned Layers: <strong className="mono" style={{ color: "var(--color-text)" }}>{layers.length}</strong>
                    {ranges.length > 0 && (
                      <span className="mono" style={{ marginLeft: 4, color: "var(--color-text-2)" }}>
                        [{ranges.map((r) => `${r[0]}-${r[1]}`).join(", ")}]
                      </span>
                    )}
                  </div>
                </div>

                {/* Buffer allocations */}
                {placement && (placement.model_buffer_bytes > 0 || placement.compute_buffer_bytes > 0) && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                      gap: 8,
                      background: "var(--color-surface-subtle)",
                      padding: "8px 12px",
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    <div className="stat-row">
                      <span className="section-label">Model Buffer</span>
                      <span className="mono" style={{ fontSize: 11.5 }}>{fmtBytes(placement.model_buffer_bytes ?? 0)}</span>
                    </div>
                    <div className="stat-row">
                      <span className="section-label">KV Cache</span>
                      <span className="mono" style={{ fontSize: 11.5 }}>{fmtBytes(placement.kv_buffer_bytes ?? 0)}</span>
                    </div>
                    <div className="stat-row">
                      <span className="section-label">Compute</span>
                      <span className="mono" style={{ fontSize: 11.5 }}>{fmtBytes(placement.compute_buffer_bytes ?? 0)}</span>
                    </div>
                  </div>
                )}

                {hasVram && (
                  <MemoryBar
                    totalBytes={dev.memory_total_bytes!}
                    freeBytes={dev.memory_free_bytes!}
                    label="VRAM Dedicated"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 3. Distributed RPC Workers */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Wifi size={14} color="var(--color-accent)" />
          <span className="section-label">3. Distributed RPC Workers (Network Compute)</span>
        </div>

        {rpcWorkers.length === 0 ? (
          <div
            style={{
              padding: "16px",
              background: "var(--color-surface-subtle)",
              borderRadius: "var(--radius)",
              border: "1px dashed var(--color-border)",
              color: "var(--color-text-2)",
              fontSize: 12,
              textAlign: "center",
            }}
          >
            No external RPC workers registered. Cluster operating on local compute only.
          </div>
        ) : (
          rpcWorkers.map((w: WorkerInfo) => {
            const variant = workerStateVariant(w.state);
            const { layers: rpcLayers, ranges: rpcRanges } = getBackendLayers(w);
            const rpcPlacement = getBackendPlacement(w);
            return (
              <div
                key={w.id}
                style={{
                  padding: "16px 18px",
                  background: "var(--color-surface)",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--color-border)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Server size={14} color="var(--color-text-2)" />
                    <span style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>{w.id}</span>
                    <span className="mono" style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>
                      {w.host}:{w.port}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <StatusBadge variant={variant} label={w.state} />
                    {rpcLayers.length > 0 && (
                      <StatusBadge variant="ok" label={`${rpcLayers.length} ${rpcLayers.length === 1 ? "layer" : "layers"}`} dot={false} />
                    )}
                    {w.is_loopback ? (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 500,
                          background: "var(--color-surface-subtle)",
                          color: "var(--color-text-2)",
                          padding: "2px 6px",
                          borderRadius: 4,
                          border: "1px solid var(--color-border)",
                        }}
                      >
                        Loopback (127.0.0.1)
                      </span>
                    ) : (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 500,
                          background: "#E8F0FE",
                          color: "#1967D2",
                          padding: "2px 6px",
                          borderRadius: 4,
                        }}
                      >
                        Remote Host
                      </span>
                    )}
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: 8,
                    fontSize: 11.5,
                    color: "var(--color-text-2)",
                  }}
                >
                  <div>
                    Assigned Layers: <strong className="mono" style={{ color: "var(--color-text)" }}>{rpcLayers.length}</strong>
                    {rpcRanges.length > 0 && (
                      <span className="mono" style={{ marginLeft: 4, color: "var(--color-text-2)" }}>
                        [{rpcRanges.map((r) => `${r[0]}-${r[1]}`).join(", ")}]
                      </span>
                    )}
                  </div>
                  <div>
                    Inference Invocations: <strong className="mono" style={{ color: "var(--color-text)" }}>{w.inference_count}</strong>
                  </div>
                </div>

                {/* Buffer sizes */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                    gap: 8,
                    background: "var(--color-surface-subtle)",
                    padding: "8px 12px",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <div className="stat-row">
                    <span className="section-label">Model Buffer</span>
                    <span className="mono" style={{ fontSize: 11.5 }}>{fmtBytes(rpcPlacement?.model_buffer_bytes ?? w.model_buffer_bytes ?? 0)}</span>
                  </div>
                  <div className="stat-row">
                    <span className="section-label">KV Cache</span>
                    <span className="mono" style={{ fontSize: 11.5 }}>{fmtBytes(rpcPlacement?.kv_buffer_bytes ?? w.kv_buffer_bytes ?? 0)}</span>
                  </div>
                  <div className="stat-row">
                    <span className="section-label">Compute</span>
                    <span className="mono" style={{ fontSize: 11.5 }}>{fmtBytes(rpcPlacement?.compute_buffer_bytes ?? w.compute_buffer_bytes ?? 0)}</span>
                  </div>
                </div>

                {w.last_error && (
                  <div style={{ fontSize: 11, color: "var(--color-error)", fontFamily: "var(--font-mono)" }}>
                    ⚠ Error: {w.last_error}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
