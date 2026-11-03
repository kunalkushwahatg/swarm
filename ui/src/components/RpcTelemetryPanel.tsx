import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { cn, fmtBytes } from "../lib/utils";
import type {
  RpcTelemetryDetail,
  RpcTelemetryOperation,
  RpcTelemetrySummary,
  RpcTelemetryWorker,
} from "../types/api";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  Cpu,
  Loader2,
  Network,
  RefreshCw,
} from "lucide-react";

function fmtExactMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms > 0 && ms < 0.005) return "<0.01 ms";
  return `${ms.toFixed(2)} ms`;
}

const integerFormat = new Intl.NumberFormat("en-US");

function fmtInt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return integerFormat.format(Math.max(0, Math.round(value)));
}

function fmtExactBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  return `${fmtInt(bytes)} B`;
}

function fmtShare(part: number, total: number): string {
  if (!(total > 0)) return "0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function layerRangeLabel(layers?: number[]): string {
  if (!layers || layers.length === 0) return "—";
  const sorted = [...layers].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = i < sorted.length ? sorted[i] : null;
    if (cur !== null && cur === prev + 1) {
      prev = cur;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
    if (cur !== null) {
      start = cur;
      prev = cur;
    }
  }
  const shown = ranges.slice(0, 3).join(", ");
  return ranges.length > 3 ? `L${shown} +${ranges.length - 3}` : `L${shown}`;
}

/**
 * ggml prefixes every tensor with its RPC backend tag, e.g.
 * "RPC0[127.0.0.1:59133]#attn_inp_kq_mask#0". The prefix is identical for the
 * whole column and repeats the worker id, so show only the tensor identity and
 * keep the full wire name in the cell tooltip.
 */
function shortTensorName(name?: string): string {
  if (!name) return "—";
  const marker = name.indexOf("]#");
  return marker >= 0 ? name.slice(marker + 1) : name;
}

function tensorDirectionLabel(direction?: string): string {
  if (direction === "receive") return "↓ recv";
  if (direction === "copy") return "⇄ copy";
  return "↑ send";
}

function opKindLabel(kind: string): string {
  switch (kind) {
    case "tensor_send":
      return "Tensor ↑";
    case "tensor_recv":
      return "Tensor ↓";
    case "tensor_copy":
      return "Tensor copy";
    case "graph_compute":
      return "Graph";
    case "worker_busy":
      return "Busy";
    case "rtt_probe":
      return "RTT";
    default:
      return "RPC";
  }
}

function opKindClass(kind: string): string {
  switch (kind) {
    case "tensor_send":
      return "rpc-kind-send";
    case "tensor_recv":
      return "rpc-kind-recv";
    case "tensor_copy":
      return "rpc-kind-copy";
    case "graph_compute":
    case "worker_busy":
      return "rpc-kind-compute";
    default:
      return "rpc-kind-rpc";
  }
}

export function RpcTelemetryChip({
  summary,
  open,
  onToggle,
  controlsId,
}: {
  summary: RpcTelemetrySummary;
  open: boolean;
  onToggle: () => void;
  controlsId: string;
}) {
  const tensorBytes = summary.tensor_bytes_sent + summary.tensor_bytes_received;

  return (
    <button
      type="button"
      className={cn("rpc-chip", open && "rpc-chip-open")}
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controlsId}
      title="Exact per-message RPC network and compute telemetry"
    >
      <span className="rpc-chip-icon">
        <Network size={12} />
      </span>
      <span className="rpc-chip-label">Network &amp; RPC</span>
      <span className="rpc-chip-sep">·</span>
      <span
        className="rpc-chip-stat mono"
        title={`${tensorBytes.toLocaleString("en-US")} exact tensor bytes`}
      >
        {fmtBytes(tensorBytes)}
      </span>
      <span className="rpc-chip-muted">tensors</span>
      <span className="rpc-chip-sep">·</span>
      <span className="rpc-chip-stat mono" title="Round-trip probe latency">
        {summary.network_rtt_ms > 0 ? fmtExactMs(summary.network_rtt_ms) : "RTT —"}
      </span>
      <span className="rpc-chip-sep">·</span>
      <span className="rpc-chip-stat mono">
        {summary.workers.length} worker{summary.workers.length === 1 ? "" : "s"}
      </span>
      {summary.partial && (
        <span className="rpc-chip-warn" title="Some telemetry was unavailable">
          <AlertTriangle size={10} />
          partial
        </span>
      )}
      <ChevronDown
        size={12}
        className="rpc-chip-chevron"
        style={{ transform: open ? "rotate(180deg)" : undefined }}
      />
    </button>
  );
}

function RpcPhaseBar({ summary }: { summary: RpcTelemetrySummary }) {
  const upload = Math.max(0, summary.upload_ms);
  const remote = Math.max(0, summary.remote_ms);
  const compute = Math.max(0, summary.compute_ms);
  const download = Math.max(0, summary.download_ms);
  const total = upload + remote + compute + download;
  const computeMeasured = summary.compute_measured === true;

  const segments = [
    { key: "upload", label: "Upload", value: upload, display: fmtExactMs(upload), className: "rpc-phase-upload" },
    { key: "remote", label: "Remote / other", value: remote, display: fmtExactMs(remote), className: "rpc-phase-remote" },
    {
      key: "compute",
      label: "Compute",
      value: compute,
      display: computeMeasured ? fmtExactMs(compute) : "not measured",
      className: "rpc-phase-compute",
    },
    { key: "download", label: "Download", value: download, display: fmtExactMs(download), className: "rpc-phase-download" },
  ];

  if (total <= 0) {
    return <div className="rpc-empty-line">No timed RPC phases captured.</div>;
  }

  return (
    <div className="rpc-phase-block">
      <div className="rpc-phase-head">
        <span className="rpc-section-title" style={{ margin: 0 }}>
          Phase composition
        </span>
        <span className="rpc-muted">summed across messages · normalized</span>
      </div>
      <div
        className="rpc-phase-bar"
        role="img"
        aria-label={segments.map((s) => `${s.label} ${s.display}`).join(", ")}
      >
        {segments.map((s) =>
          s.value > 0 ? (
            <span
              key={s.key}
              className={`rpc-phase-seg ${s.className}`}
              style={{ flexGrow: s.value, flexBasis: 0 }}
              title={`${s.label}: ${fmtExactMs(s.value)} (${fmtShare(s.value, total)})`}
            />
          ) : null,
        )}
      </div>
      <div className="rpc-legend">
        {segments.map((s) => (
          <span
            key={s.key}
            className="rpc-legend-item"
            title={`${fmtExactMs(s.value)} · ${fmtShare(s.value, total)}`}
          >
            <span className={`rpc-legend-dot ${s.className}`} />
            <span>{s.label}</span>
            <strong className="mono">{s.display}</strong>
            <span className="rpc-muted">{fmtShare(s.value, total)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function RpcTraffic({ summary }: { summary: RpcTelemetrySummary }) {
  const controlSent = Math.max(0, summary.bytes_sent - summary.tensor_bytes_sent);
  const controlReceived = Math.max(0, summary.bytes_received - summary.tensor_bytes_received);
  const total = summary.bytes_sent + summary.bytes_received;

  const rows = [
    {
      key: "tensor-sent",
      icon: <ArrowUpFromLine size={12} />,
      label: "Tensor data sent",
      bytes: summary.tensor_bytes_sent,
      items: `${summary.tensor_count_sent.toLocaleString("en-US")} tensors`,
      tone: "tensor",
    },
    {
      key: "tensor-recv",
      icon: <ArrowDownToLine size={12} />,
      label: "Tensor data received",
      bytes: summary.tensor_bytes_received,
      items: `${summary.tensor_count_received.toLocaleString("en-US")} tensors`,
      tone: "tensor",
    },
    {
      key: "control-sent",
      icon: <ArrowUpFromLine size={12} />,
      label: "RPC overhead sent",
      bytes: controlSent,
      items: `${summary.rpc_messages_sent.toLocaleString("en-US")} messages`,
      tone: "control",
    },
    {
      key: "control-recv",
      icon: <ArrowDownToLine size={12} />,
      label: "RPC overhead received",
      bytes: controlReceived,
      items: `${summary.rpc_messages_received.toLocaleString("en-US")} messages`,
      tone: "control",
    },
  ];

  return (
    <div className="rpc-traffic-block">
      <div className="rpc-phase-head">
        <span className="rpc-section-title" style={{ margin: 0 }}>
          Traffic
        </span>
        <span className="rpc-muted">exact wire bytes</span>
      </div>
      <div className="rpc-traffic-grid">
        {rows.map((r) => (
          <div
            key={r.key}
            className={`rpc-traffic-card rpc-traffic-${r.tone}`}
            title={
              r.tone === "tensor"
                ? "Exact tensor data bytes. Excludes the 296-byte tensor descriptor and frame headers."
                : "Exact wire bytes excluding tensor data. Includes frame headers and 296-byte tensor descriptors."
            }
          >
            <div className="rpc-traffic-label">
              {r.icon}
              <span>{r.label}</span>
            </div>
            <div className="rpc-traffic-value">{fmtExactBytes(r.bytes)}</div>
            <div className="rpc-traffic-meta">
              {r.items} · {fmtBytes(r.bytes)}
            </div>
            <div className="rpc-traffic-track" aria-hidden="true">
              <span
                style={{
                  width: `${total > 0 ? Math.max(0.5, (r.bytes / total) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RpcWorkerTable({ workers }: { workers: RpcTelemetryWorker[] }) {
  if (workers.length === 0) {
    return <div className="rpc-empty-line">No workers reported.</div>;
  }

  return (
    <div className="rpc-table-wrap">
      <table className="rpc-table rpc-worker-table">
        <thead>
          <tr>
            <th>Worker</th>
            <th>Layers</th>
            <th className="rpc-num">Wall</th>
            <th className="rpc-num">Upload</th>
            <th className="rpc-num">Remote*</th>
            <th className="rpc-num">Compute</th>
            <th className="rpc-num">Download</th>
            <th className="rpc-num">RTT</th>
            <th className="rpc-num">Tensor ↑</th>
            <th className="rpc-num">Tensor ↓</th>
            <th className="rpc-num">RPC msgs</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => (
            <tr key={w.id} title={w.endpoint ? `Endpoint: ${w.endpoint}` : undefined}>
              <td>
                <div className="rpc-worker-id">
                  {w.id}
                  {w.partial && (
                    <span className="rpc-badge rpc-badge-warn" title="Some telemetry for this worker was unavailable">
                      <AlertTriangle size={9} />
                      partial
                    </span>
                  )}
                </div>
                <div className="rpc-worker-endpoint">
                  {w.endpoint || "—"}
                  {w.is_loopback ? " · loopback" : ""}
                </div>
              </td>
              <td className="mono">{layerRangeLabel(w.assigned_layers)}</td>
              <td className="mono rpc-num">{fmtExactMs(w.wall_ms)}</td>
              <td className="mono rpc-num">{fmtExactMs(w.upload_ms)}</td>
              <td className="mono rpc-num">{fmtExactMs(w.remote_ms)}</td>
              <td className="mono rpc-num">
                {w.compute_measured ? (
                  fmtExactMs(w.compute_ms)
                ) : (
                  <span className="rpc-muted" title="Worker busy window or RTT probe unavailable">
                    not measured
                  </span>
                )}
              </td>
              <td className="mono rpc-num">{fmtExactMs(w.download_ms)}</td>
              <td className="mono rpc-num">
                {w.network_rtt_ms > 0 ? fmtExactMs(w.network_rtt_ms) : "—"}
              </td>
              <td className="mono rpc-num">
                {fmtExactBytes(w.tensor_bytes_sent)}
                <div className="rpc-cell-sub">{w.tensor_count_sent.toLocaleString("en-US")} tx</div>
              </td>
              <td className="mono rpc-num">
                {fmtExactBytes(w.tensor_bytes_received)}
                <div className="rpc-cell-sub">{w.tensor_count_received.toLocaleString("en-US")} rx</div>
              </td>
              <td className="mono rpc-num">
                {w.rpc_messages_sent.toLocaleString("en-US")} / {w.rpc_messages_received.toLocaleString("en-US")}
                <div className="rpc-cell-sub">sent / recv</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RpcTimeline({
  detail,
  fallbackWallMs,
}: {
  detail: RpcTelemetryDetail;
  fallbackWallMs: number;
}) {
  const laneOrder: string[] = [];
  const byWorker = new Map<string, RpcTelemetryOperation[]>();
  let maxEnd = detail.summary?.wall_ms ?? fallbackWallMs;

  const addOp = (op: RpcTelemetryOperation) => {
    if (!byWorker.has(op.worker_id)) {
      byWorker.set(op.worker_id, []);
      laneOrder.push(op.worker_id);
    }
    byWorker.get(op.worker_id)!.push(op);
    maxEnd = Math.max(maxEnd, op.offset_ms + op.duration_ms);
  };

  // Render busy windows first; graph operations then paint on top of them.
  for (const op of detail.worker_busy) addOp(op);
  for (const op of detail.operations) addOp(op);
  for (const w of detail.workers) {
    if (!byWorker.has(w.id)) {
      byWorker.set(w.id, []);
      laneOrder.push(w.id);
    }
  }
  if (!Number.isFinite(maxEnd) || maxEnd <= 0) {
    maxEnd = Math.max(1, fallbackWallMs);
  }

  return (
    <div className="rpc-timeline-block">
      <div className="rpc-phase-head">
        <span className="rpc-section-title" style={{ margin: 0 }}>
          Activity timeline
        </span>
        <span className="rpc-muted">exact offsets from request start</span>
      </div>
      <div className="rpc-timeline-axis">
        <span>0 ms</span>
        <span>{fmtExactMs(maxEnd)}</span>
      </div>
      {laneOrder.map((id) => {
        const ops = (byWorker.get(id) ?? []).slice().sort((a, b) => a.offset_ms - b.offset_ms);
        return (
          <div className="rpc-lane" key={id}>
            <div className="rpc-lane-label" title={id}>
              {id}
            </div>
            <div className="rpc-lane-track">
              {ops.map((op, idx) => {
                const left = Math.max(0, Math.min(100, (op.offset_ms / maxEnd) * 100));
                const rawWidth = (op.duration_ms / maxEnd) * 100;
                const width = Math.max(0.6, Math.min(100 - left, rawWidth));
                const title = `${op.op} · t=${fmtExactMs(op.offset_ms)} · ${fmtExactMs(op.duration_ms)}${
                  op.tensor ? ` · ${op.tensor.name}` : ""
                }${op.kind === "worker_busy" ? ` · compute ${fmtExactMs(op.compute_ms)}` : ""}`;
                return (
                  <span
                    key={`${id}-${idx}`}
                    className={`rpc-lane-bar ${opKindClass(op.kind)}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={title}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
      {laneOrder.length === 0 && <div className="rpc-empty-line">No timeline events captured.</div>}
      <div className="rpc-legend rpc-legend-tight">
        <span className="rpc-legend-item">
          <span className="rpc-legend-dot rpc-kind-rpc" />
          RPC
        </span>
        <span className="rpc-legend-item">
          <span className="rpc-legend-dot rpc-kind-send" />
          Tensor ↑
        </span>
        <span className="rpc-legend-item">
          <span className="rpc-legend-dot rpc-kind-recv" />
          Tensor ↓
        </span>
        <span className="rpc-legend-item">
          <span className="rpc-legend-dot rpc-kind-compute" />
          Graph / busy
        </span>
      </div>
    </div>
  );
}

function RpcDetailSection({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rpc-detail-section">
      <button
        type="button"
        className="rpc-detail-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{title}</span>
        <span className="rpc-count">{count.toLocaleString("en-US")}</span>
      </button>
      {open && <div className="rpc-detail-body">{children}</div>}
    </div>
  );
}

function TensorTable({ tensors }: { tensors: RpcTelemetryOperation[] }) {
  if (tensors.length === 0) {
    return (
      <div className="rpc-empty-line">
        No tensor transfers in this request. Model weights stay resident on the worker;
        per-token traffic is graph metadata.
      </div>
    );
  }

  return (
    <div className="rpc-table-wrap rpc-table-tall">
      <table className="rpc-table rpc-table-detail">
        <thead>
          <tr>
            <th className="rpc-num">t</th>
            <th>Worker</th>
            <th>Dir</th>
            <th>Tensor</th>
            <th>Type</th>
            <th>Shape</th>
            <th className="rpc-num">Data bytes (B)</th>
            <th className="rpc-num">Upload</th>
            <th className="rpc-num">Net wait</th>
            <th className="rpc-num">Download</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {tensors.map((op, i) => (
            <tr key={`${op.worker_id}-${op.offset_ms}-${i}`}>
              <td className="mono rpc-num">{fmtExactMs(op.offset_ms)}</td>
              <td className="mono">{op.worker_id}</td>
              <td>
                <span className={`rpc-dir rpc-dir-${op.direction ?? "send"}`}>
                  {tensorDirectionLabel(op.direction)}
                </span>
              </td>
              <td className="mono rpc-tensor-name" title={op.tensor?.name}>
                {shortTensorName(op.tensor?.name)}
              </td>
              <td className="mono">{op.tensor?.type || "—"}</td>
              <td className="mono">
                {op.tensor?.shape?.length ? op.tensor.shape.join(" × ") : "—"}
              </td>
              <td className="mono rpc-num rpc-emphasis">
                {op.tensor_bytes.toLocaleString("en-US")}
              </td>
              <td className="mono rpc-num">{fmtExactMs(op.upload_ms)}</td>
              <td className="mono rpc-num">
                {op.direction === "send" ? "—" : fmtExactMs(op.remote_ms)}
              </td>
              <td className="mono rpc-num">{fmtExactMs(op.download_ms)}</td>
              <td className="rpc-note">{op.note || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ControlOpsTable({ ops }: { ops: RpcTelemetryOperation[] }) {
  if (ops.length === 0) {
    return <div className="rpc-empty-line">No RPC control operations captured.</div>;
  }

  return (
    <div className="rpc-table-wrap rpc-table-tall">
      <table className="rpc-table rpc-table-detail">
        <thead>
          <tr>
            <th className="rpc-num">t</th>
            <th>Worker</th>
            <th>Operation</th>
            <th>Kind</th>
            <th className="rpc-num">Duration</th>
            <th className="rpc-num">Request B</th>
            <th className="rpc-num">Response B</th>
            <th className="rpc-num">Upload</th>
            <th className="rpc-num">Net wait</th>
            <th className="rpc-num">Download</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {ops.map((op, i) => (
            <tr key={`${op.worker_id}-${op.offset_ms}-${i}`}>
              <td className="mono rpc-num">{fmtExactMs(op.offset_ms)}</td>
              <td className="mono">{op.worker_id}</td>
              <td className="mono">{op.op}</td>
              <td>
                <span className={`rpc-kind-pill ${opKindClass(op.kind)}`}>
                  {opKindLabel(op.kind)}
                </span>
              </td>
              <td className="mono rpc-num">{fmtExactMs(op.duration_ms)}</td>
              <td className="mono rpc-num">{op.request_bytes.toLocaleString("en-US")}</td>
              <td className="mono rpc-num">{op.response_bytes.toLocaleString("en-US")}</td>
              <td className="mono rpc-num">{fmtExactMs(op.upload_ms)}</td>
              <td className="mono rpc-num">
                {op.response_bytes > 0 ? fmtExactMs(op.remote_ms) : "—"}
              </td>
              <td className="mono rpc-num">{fmtExactMs(op.download_ms)}</td>
              <td className="rpc-note">
                {op.note || (op.kind === "graph_compute" ? "no response (fire-and-forget)" : "—")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BusyTable({ busy }: { busy: RpcTelemetryOperation[] }) {
  if (busy.length === 0) {
    return <div className="rpc-empty-line">No worker busy windows captured.</div>;
  }

  return (
    <div className="rpc-table-wrap">
      <table className="rpc-table rpc-table-detail">
        <thead>
          <tr>
            <th className="rpc-num">Start</th>
            <th>Worker</th>
            <th className="rpc-num">Busy window</th>
            <th className="rpc-num">Inferred compute</th>
            <th>Measurement</th>
          </tr>
        </thead>
        <tbody>
          {busy.map((op, i) => (
            <tr key={`${op.worker_id}-${op.offset_ms}-${i}`}>
              <td className="mono rpc-num">{fmtExactMs(op.offset_ms)}</td>
              <td className="mono">{op.worker_id}</td>
              <td className="mono rpc-num">{fmtExactMs(op.duration_ms)}</td>
              <td className="mono rpc-num">
                {op.has_compute ? (
                  fmtExactMs(op.compute_ms)
                ) : (
                  <span className="rpc-muted">not measured</span>
                )}
              </td>
              <td className="rpc-note">{op.note || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RpcTelemetryPanel({
  summary,
  onClose,
  id,
}: {
  summary: RpcTelemetrySummary;
  onClose: () => void;
  id: string;
}) {
  const requestId = summary.request_id;
  const [detail, setDetail] = useState<RpcTelemetryDetail | null>(null);
  const [detailState, setDetailState] = useState<"loading" | "ready" | "error">("loading");
  const [detailError, setDetailError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!requestId) {
      setDetailState("error");
      setDetailError("Detailed telemetry is unavailable because the request id was not reported.");
      return;
    }

    let cancelled = false;
    setDetailState("loading");
    setDetailError("");

    api
      .rpcTelemetry(requestId)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        if (data.available) {
          setDetailState("ready");
        } else {
          setDetailState("error");
          setDetailError(
            data.error || "Detailed telemetry is no longer available (it may have been pruned).",
          );
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDetailState("error");
        setDetailError(
          err instanceof Error ? err.message : "Failed to load detailed telemetry.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [requestId, reloadKey]);

  const controlOps =
    detail?.operations.filter((op) => !op.kind.startsWith("tensor_")) ?? [];
  const probeCount = summary.probe_count ?? 0;
  const graphCount = summary.graph_count ?? 0;
  const busyCount = summary.worker_busy_count ?? 0;
  const phaseWarning = !summary.compute_measured && graphCount > 0;

  return (
    <div className="rpc-panel" id={id}>
      <div className="rpc-panel-head">
        <div className="rpc-panel-title">
          <Network size={14} />
          <span>Network &amp; RPC</span>
          {summary.partial && (
            <span
              className="rpc-badge rpc-badge-warn"
              title="Some RPC operations or timings were not captured"
            >
              <AlertTriangle size={10} />
              partial
            </span>
          )}
        </div>
        <button
          type="button"
          className="rpc-icon-btn"
          onClick={onClose}
          title="Collapse network telemetry"
          aria-label="Collapse network telemetry"
        >
          <ChevronDown size={14} style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>

      {summary.partial && (
        <div className="rpc-warning">
          <AlertTriangle size={12} />
          <span>
            Partial capture. Some RPC operations or worker busy windows were unavailable;
            totals may be incomplete.
          </span>
        </div>
      )}
      {phaseWarning && (
        <div className="rpc-note-line">
          <Cpu size={12} />
          <span>
            Compute time could not be isolated. &ldquo;Remote / other&rdquo; includes worker
            processing time.
          </span>
        </div>
      )}

      <div className="rpc-kpis">
        <div className="rpc-kpi">
          <div className="rpc-kpi-label">RPC wall</div>
          <div className="rpc-kpi-value">{fmtExactMs(summary.wall_ms)}</div>
          <div className="rpc-kpi-hint">first → last RPC message</div>
        </div>
        <div className="rpc-kpi">
          <div className="rpc-kpi-label">Compute</div>
          <div className="rpc-kpi-value">
            {summary.compute_measured ? fmtExactMs(summary.compute_ms) : "—"}
          </div>
          <div className="rpc-kpi-hint">
            {summary.compute_measured
              ? `${busyCount} busy window${busyCount === 1 ? "" : "s"} · summed`
              : "not measured"}
          </div>
        </div>
        <div className="rpc-kpi">
          <div className="rpc-kpi-label">Network RTT</div>
          <div className="rpc-kpi-value">
            {summary.network_rtt_ms > 0 ? fmtExactMs(summary.network_rtt_ms) : "—"}
          </div>
          <div className="rpc-kpi-hint">
            {probeCount > 0 ? `${probeCount} probe${probeCount === 1 ? "" : "s"}` : "probe unavailable"}
          </div>
        </div>
        <div className="rpc-kpi">
          <div className="rpc-kpi-label">Tensor traffic</div>
          <div className="rpc-kpi-value">
            {fmtBytes(summary.tensor_bytes_sent + summary.tensor_bytes_received)}
          </div>
          <div
            className="rpc-kpi-hint"
            title={fmtExactBytes(
              summary.tensor_bytes_sent + summary.tensor_bytes_received,
            )}
          >
            {summary.tensor_count_sent + summary.tensor_count_received} tensors
          </div>
        </div>
      </div>

      <RpcPhaseBar summary={summary} />
      <RpcTraffic summary={summary} />

      <div className="rpc-worker-block">
        <div className="rpc-phase-head">
          <span className="rpc-section-title" style={{ margin: 0 }}>
            Per-worker breakdown
          </span>
          <span className="rpc-muted">
            {summary.workers.length} worker{summary.workers.length === 1 ? "" : "s"}
          </span>
        </div>
        <RpcWorkerTable workers={summary.workers} />
        <div className="rpc-footnote">
          Remote* is derived as wall − upload − compute − download. It includes
          coordinator work and any non-RPC backend time, so it can also contain GPU
          compute that did not run on this worker. Compute is the RTT-adjusted worker
          busy window; per-message timings are exact.
        </div>
      </div>

      <div className="rpc-detail-block">
        <div className="rpc-phase-head">
          <span className="rpc-section-title" style={{ margin: 0 }}>
            Exact per-message detail
          </span>
          <span className="rpc-muted">lazy-loaded</span>
        </div>

        {detailState === "loading" && (
          <div className="rpc-detail-state">
            <Loader2 size={13} className="animate-spin" />
            <span>Loading every tensor transfer and RPC operation…</span>
          </div>
        )}

        {detailState === "error" && (
          <div className="rpc-detail-state rpc-detail-error">
            <AlertTriangle size={13} />
            <span>{detailError}</span>
            {requestId && (
              <button
                type="button"
                className="rpc-link-btn"
                onClick={() => setReloadKey((v) => v + 1)}
              >
                <RefreshCw size={11} />
                Retry
              </button>
            )}
          </div>
        )}

        {detailState === "ready" && detail && (
          <>
            <RpcTimeline detail={detail} fallbackWallMs={summary.wall_ms} />
            <RpcDetailSection
              title="Tensor transfers"
              count={detail.tensors.length}
              defaultOpen
            >
              <TensorTable tensors={detail.tensors} />
            </RpcDetailSection>
            <RpcDetailSection
              title="RPC control operations"
              count={controlOps.length}
            >
              <ControlOpsTable ops={controlOps} />
            </RpcDetailSection>
            <RpcDetailSection
              title="Worker busy windows"
              count={detail.worker_busy.length}
            >
              <BusyTable busy={detail.worker_busy} />
            </RpcDetailSection>
            <div className="rpc-footnote">
              Measured at the coordinator&apos;s loopback RPC proxy. Bytes are exact wire
              bytes; tensor data bytes exclude the 296-byte tensor descriptor and frame
              headers. No values are estimated.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
