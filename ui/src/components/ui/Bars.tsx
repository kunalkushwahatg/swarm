import { fmtBytes } from "../../lib/utils";

interface MemoryBarProps {
  totalBytes: number;
  freeBytes: number;
  label?: string;
}

export function MemoryBar({ totalBytes, freeBytes, label }: MemoryBarProps) {
  const used = totalBytes - freeBytes;
  const pct = totalBytes > 0 ? Math.min(100, (used / totalBytes) * 100) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {label && <span className="section-label">{label}</span>}
      <div style={{
        height: 5,
        borderRadius: 99,
        background: "var(--color-border)",
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          borderRadius: 99,
          background: pct > 85 ? "var(--color-error)" : pct > 60 ? "var(--color-warn)" : "var(--color-accent)",
          transition: "width 400ms ease",
        }} />
      </div>
      <div className="stat-row">
        <span style={{ fontSize: 11, color: "var(--color-text-2)" }}>
          {fmtBytes(used)} used
        </span>
        <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>
          {fmtBytes(totalBytes)}
        </span>
      </div>
    </div>
  );
}

interface LayerBarProps {
  /** Map of backend_id -> { layers: number, color: string } */
  segments: { id: string; layers: number; color: string; label: string }[];
  totalLayers: number;
}

export function LayerBar({ segments, totalLayers }: LayerBarProps) {
  if (totalLayers === 0) return null;
  return (
    <div className="layer-bar-track" style={{ height: 8 }}>
      {segments.map((s) => {
        const w = (s.layers / totalLayers) * 100;
        if (w === 0) return null;
        return (
          <div
            key={s.id}
            className="layer-bar-segment"
            title={`${s.label}: ${s.layers} layers`}
            style={{ width: `${w}%`, background: s.color, flexShrink: 0 }}
          />
        );
      })}
    </div>
  );
}
