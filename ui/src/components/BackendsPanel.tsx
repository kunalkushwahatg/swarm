import { useBackends, useMetrics } from "../hooks/useSwarm";
import { fmtBytes, fmtMs, fmtTps, backendTypeLabel } from "../lib/utils";
import { MemoryBar, LayerBar } from "./ui/Bars";
import { StatusBadge } from "./ui/StatusBadge";
import type { BackendPlacement } from "../types/api";
import { Database, HardDrive, Cpu, Activity, Gauge, Zap, CheckCircle2 } from "lucide-react";

const BACKEND_COLORS: Record<string, string> = {
  cpu: "#66716B",
  local_cuda: "#356B55",
  loopback_rpc: "#4F7D65",
  remote_rpc: "#8D6228",
};

function getColor(type: string) {
  return BACKEND_COLORS[type] ?? "#97A29C";
}

function BackendIcon({ type }: { type: string }) {
  const size = 14;
  if (type === "cpu") return <Cpu size={size} />;
  if (type === "local_cuda") return <Activity size={size} />;
  return <HardDrive size={size} />;
}

export function BackendsPanel() {
  const { data, error, loading } = useBackends(4000);
  const { data: metrics } = useMetrics(3000);

  if (loading) {
    return (
      <div className="card" style={{ padding: "24px" }}>
        <span style={{ color: "var(--color-text-3)", fontSize: 13 }}>Loading backends and telemetry…</span>
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

  if (!data) return null;

  const { backends, memory_accounting, placement_policy, policy_evaluated } = data;

  const totalLayers = backends.reduce((acc: number, b: BackendPlacement) => acc + b.assigned_layers.length, 0);
  const layerSegments = backends.map((b: BackendPlacement) => {
    const rangeStr = b.assigned_layer_ranges && b.assigned_layer_ranges.length > 0
      ? b.assigned_layer_ranges.map((r) => (r[0] === r[1] ? `L${r[0]}` : `L${r[0]}–L${r[1]}`)).join(", ")
      : "";
    return {
      id: b.backend_id,
      layers: b.assigned_layers.length,
      color: getColor(b.backend_type),
      rangeStr,
      label: `${b.backend_id} (${backendTypeLabel(b.backend_type)})`,
    };
  });

  const avgPromptEvalMs =
    metrics && metrics.promptEvalCount > 0
      ? (metrics.promptEvalSecondsSum / metrics.promptEvalCount) * 1000
      : 0;

  const avgTokenGenMs =
    metrics && metrics.tokenGenCount > 0
      ? (metrics.tokenGenSecondsSum / metrics.tokenGenCount) * 1000
      : 0;

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
      }}
    >
      {/* 1. Header: Current Inference State & Placement Policy */}
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
            <Database size={16} />
          </div>
          <div>
            <h2 style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text)" }}>
              Activity &amp; Backend Placement
            </h2>
            <div style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>
              Distributed layer mapping and live generation metrics
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--color-text-2)" }}>
            Policy: <strong className="mono" style={{ color: "var(--color-text)" }}>{placement_policy}</strong>
          </span>
          {policy_evaluated && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                color: "var(--color-ok)",
                fontWeight: 600,
                background: "var(--color-ok-bg)",
                padding: "2px 7px",
                borderRadius: 4,
                border: "1px solid #D1E7DC",
              }}
            >
              <CheckCircle2 size={12} />
              Evaluated
            </span>
          )}
        </div>
      </div>

      {/* 2. Concise Summary of Meaningful Generation Metrics */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Gauge size={13} color="var(--color-text-2)" />
          <span className="section-label">Live Inference Activity Telemetry</span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 10,
          }}
        >
          {/* Last Generation Rate */}
          <div
            style={{
              padding: "12px 14px",
              background: "var(--color-surface-subtle)",
              borderRadius: "var(--radius)",
              border: "1px solid var(--color-border)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <span className="section-label">Last Generation Rate</span>
            <span className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--color-accent)" }}>
              {metrics?.lastTokensPerSec ? fmtTps(metrics.lastTokensPerSec) : "Standby"}
            </span>
            <span style={{ fontSize: 10.5, color: "var(--color-text-2)" }}>Live throughput</span>
          </div>

          {/* Average Prompt Eval Duration */}
          <div
            style={{
              padding: "12px 14px",
              background: "var(--color-surface-subtle)",
              borderRadius: "var(--radius)",
              border: "1px solid var(--color-border)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <span className="section-label">Avg Prompt Eval</span>
            <span className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--color-text)" }}>
              {avgPromptEvalMs > 0 ? fmtMs(avgPromptEvalMs) : "—"}
            </span>
            <span style={{ fontSize: 10.5, color: "var(--color-text-2)" }}>
              {metrics?.promptEvalCount ? `${metrics.promptEvalCount} prompt samples` : "No requests evaluated"}
            </span>
          </div>

          {/* Average Token Generation */}
          <div
            style={{
              padding: "12px 14px",
              background: "var(--color-surface-subtle)",
              borderRadius: "var(--radius)",
              border: "1px solid var(--color-border)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <span className="section-label">Avg Token Latency</span>
            <span className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--color-text)" }}>
              {avgTokenGenMs > 0 ? fmtMs(avgTokenGenMs) : "—"}
            </span>
            <span style={{ fontSize: 10.5, color: "var(--color-text-2)" }}>
              {metrics?.tokenGenCount ? `${metrics.tokenGenCount} generation steps` : "Awaiting tokens"}
            </span>
          </div>

          {/* Lifetime Tokens Generated */}
          <div
            style={{
              padding: "12px 14px",
              background: "var(--color-surface-subtle)",
              borderRadius: "var(--radius)",
              border: "1px solid var(--color-border)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <span className="section-label">Tokens Generated</span>
            <span className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--color-text)" }}>
              {metrics?.tokensGeneratedTotal ?? 0}
            </span>
            <span style={{ fontSize: 10.5, color: "var(--color-text-2)" }}>Session total</span>
          </div>
        </div>
      </div>

      {/* 3. Distribution of Layers across Backends */}
      {totalLayers > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "14px 16px",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="section-label">Cluster Tensor Layer Distribution</span>
            <span style={{ fontSize: 11, color: "var(--color-text-2)" }}>
              <strong>{totalLayers}</strong> total model layers assigned
            </span>
          </div>

          <LayerBar segments={layerSegments} totalLayers={totalLayers} />

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 4 }}>
            {layerSegments.map((s) => (
              <span
                key={s.id}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--color-text)" }}
              >
                <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                <strong>{s.id}</strong>: <span className="mono">{s.layers}L</span>
                {s.rangeStr && (
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--color-text-2)" }}>
                    ({s.rangeStr})
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 4. Backend Details & Memory Scope */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span className="section-label">Configured Placement Backends</span>
        {backends.map((b: BackendPlacement) => (
          <div
            key={b.backend_id}
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
            {/* Backend Title Row */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: getColor(b.backend_type) }}>
                  <BackendIcon type={b.backend_type} />
                </span>
                <span style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>{b.backend_id}</span>
                <span style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>
                  {b.description || backendTypeLabel(b.backend_type)}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {b.assigned_layers.length > 0 && (
                  <StatusBadge variant="ok" label={`${b.assigned_layers.length} layers`} dot={false} />
                )}
                {b.is_loopback && (
                  <StatusBadge variant="warn" label="Loopback RPC" dot={false} />
                )}
              </div>
            </div>

            {/* Buffer Allocation Breakdown */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                gap: 8,
                background: "var(--color-surface-subtle)",
                padding: "10px 12px",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {[
                { label: "Model Weights", bytes: b.model_buffer_bytes },
                { label: "KV Cache", bytes: b.kv_buffer_bytes },
                { label: "Compute Buffer", bytes: b.compute_buffer_bytes },
              ].map(({ label, bytes }) => (
                <div key={label} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  <span className="section-label">{label}</span>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text)" }}>
                    {fmtBytes(bytes)}
                  </span>
                </div>
              ))}
            </div>

            {/* Hardware Memory Utilization Bar (if measured) */}
            {b.memory_total_bytes != null && b.memory_free_bytes != null && b.memory_total_bytes > 0 && (
              <MemoryBar
                totalBytes={b.memory_total_bytes}
                freeBytes={b.memory_free_bytes}
                label={b.memory_scope === "device_vram" ? "VRAM" : "Host RAM"}
              />
            )}

            {/* Endpoint */}
            {b.endpoint && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--color-text-2)" }}>
                <span className="section-label">Endpoint:</span>
                <span className="mono" style={{ color: "var(--color-text)" }}>{b.endpoint}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 5. Cluster Memory Accounting Summary */}
      <div
        style={{
          padding: "14px 16px",
          background: "var(--color-accent-subtle)",
          borderRadius: "var(--radius)",
          border: "1px solid var(--color-border)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Zap size={13} color="var(--color-accent)" />
          <span className="section-label" style={{ color: "var(--color-accent)" }}>
            Cluster Memory Deduplication &amp; Accounting
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
          {[
            ["Model Buffer Total", fmtBytes(memory_accounting.total_model_buffer_bytes)],
            ["KV Cache Total", fmtBytes(memory_accounting.total_kv_buffer_bytes)],
            ["Compute Buffer Total", fmtBytes(memory_accounting.total_compute_buffer_bytes)],
            ["Total Allocated", fmtBytes(memory_accounting.total_allocated_buffers_bytes)],
            ["Host RAM Total", fmtBytes(memory_accounting.host_ram_total_bytes)],
            ["Host RAM Available", fmtBytes(memory_accounting.host_ram_available_bytes)],
          ].map(([label, val]) => (
            <div key={label} className="stat-row" style={{ padding: "2px 0" }}>
              <span style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>{label}</span>
              <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--color-text)" }}>{val}</span>
            </div>
          ))}
        </div>

        {memory_accounting.shared_host_memory_deduplicated && (
          <div style={{ fontSize: 11, color: "var(--color-text-2)", marginTop: 4 }}>
            ↳ Loopback RPC host memory is verified deduplicated &mdash; preventing double counting with coordinator.
          </div>
        )}
      </div>
    </div>
  );
}
