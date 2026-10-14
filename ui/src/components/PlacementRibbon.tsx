import { useState } from "react";
import type { RibbonSegment } from "../hooks/useSwarmSession";
import { fmtBytes } from "../lib/utils";
import { X, AlertCircle, Cpu, HardDrive, Server } from "lucide-react";

interface PlacementRibbonProps {
  segments: RibbonSegment[];
  totalLayers: number;
  showCaption?: boolean;
  compact?: boolean;
  isOffline?: boolean;
}

export function PlacementRibbon({
  segments,
  totalLayers,
  showCaption = true,
  compact = false,
  isOffline = false,
}: PlacementRibbonProps) {
  const [selectedBackendId, setSelectedBackendId] = useState<string | null>(null);
  const [hoveredBackendId, setHoveredBackendId] = useState<string | null>(null);

  if (!segments || segments.length === 0) {
    return null;
  }

  const effectiveTotal = totalLayers > 0 ? totalLayers : 37;
  const sortedSegments = [...segments].sort((a, b) => a.startLayer - b.startLayer);
  const selectedSegment = sortedSegments.find((s) => s.backendId === selectedBackendId);

  const handleKeyDown = (e: React.KeyboardEvent, seg: RibbonSegment, idx: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelectedBackendId((prev) => (prev === seg.backendId ? null : seg.backendId));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = sortedSegments[(idx + 1) % sortedSegments.length];
      setSelectedBackendId(next.backendId);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = sortedSegments[(idx - 1 + sortedSegments.length) % sortedSegments.length];
      setSelectedBackendId(prev.backendId);
    } else if (e.key === "Escape") {
      setSelectedBackendId(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
      {/* Ribbon Track */}
      <div
        role="tablist"
        aria-label="Model layer placement across hardware processors"
        style={{
          display: "flex",
          gap: 2,
          height: compact ? 12 : 16,
          width: "100%",
          alignItems: "stretch",
          position: "relative",
          opacity: isOffline ? 0.85 : 1,
        }}
      >
        {sortedSegments.map((seg, idx) => {
          const widthPct = Math.max((seg.layerCount / effectiveTotal) * 100, 3);
          const isSelected = selectedBackendId === seg.backendId;
          const isHovered = hoveredBackendId === seg.backendId;

          // Hue = Physical Device. Fill = Processor
          // Host (Verdigris #1F6F66), Helper (Steel #46598F)
          let background = "var(--color-accent)";
          let border = "none";
          let borderStyle = "solid";

          if (seg.processor === "cpu") {
            background = "var(--color-accent-subtle)";
            border = "1.5px solid var(--color-accent)";
          } else if (seg.processor === "gpu") {
            background = "var(--color-accent)";
            border = "1.5px solid var(--color-accent)";
          } else if (seg.isLoopback) {
            background = "var(--color-surface-subtle)";
            border = "1.5px dashed var(--color-steel)";
            borderStyle = "dashed";
          } else {
            background = "var(--color-steel)";
            border = "1.5px solid var(--color-steel)";
          }

          return (
            <button
              key={`${seg.backendId}-${idx}`}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-expanded={isSelected}
              aria-label={`${seg.deviceName} (${seg.processor.toUpperCase()}): ${seg.layerCount} layers (${seg.rangeLabel}). Click or press Enter to inspect placement details.`}
              onClick={() => setSelectedBackendId((prev) => (prev === seg.backendId ? null : seg.backendId))}
              onKeyDown={(e) => handleKeyDown(e, seg, idx)}
              onMouseEnter={() => setHoveredBackendId(seg.backendId)}
              onMouseLeave={() => setHoveredBackendId(null)}
              style={{
                flex: `${widthPct}`,
                background,
                border,
                borderStyle,
                borderRadius: 3,
                cursor: "pointer",
                position: "relative",
                padding: 0,
                outline: isSelected ? "2px solid var(--color-accent)" : "none",
                outlineOffset: 2,
                transform: isSelected ? "scaleY(1.2)" : isHovered ? "scaleY(1.12)" : "none",
                transition: "transform 120ms ease, opacity 120ms ease",
                zIndex: isSelected ? 10 : 1,
              }}
            >
              {/* Desktop quick hover tooltip */}
              {isHovered && !selectedSegment && (
                <div
                  style={{
                    position: "absolute",
                    bottom: "calc(100% + 6px)",
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: "var(--color-ink)",
                    color: "#FFFFFF",
                    padding: "5px 9px",
                    borderRadius: 6,
                    fontSize: 11,
                    fontFamily: "var(--font-sans)",
                    whiteSpace: "nowrap",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                    zIndex: 100,
                    pointerEvents: "none",
                  }}
                >
                  <div style={{ fontWeight: 600, display: "flex", gap: 5, alignItems: "center" }}>
                    <span>{seg.deviceName}</span>
                    <span className="mono" style={{ color: "#CDD3CA" }}>({seg.rangeLabel})</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#A0A8B0", marginTop: 2 }}>
                    {seg.layerCount} layers · Click to inspect drill-down
                  </div>
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Direct Labels & Honest Explanation */}
      {showCaption && (
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "4px 12px",
            fontSize: 11.5,
            color: "var(--color-text-2)",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
            {sortedSegments.map((seg, idx) => {
              const isSelected = selectedBackendId === seg.backendId;
              return (
                <button
                  key={seg.backendId}
                  type="button"
                  onClick={() => setSelectedBackendId((prev) => (prev === seg.backendId ? null : seg.backendId))}
                  style={{
                    display: "inline-flex",
                    alignItems: "baseline",
                    gap: 4,
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: isSelected ? "var(--color-accent)" : "inherit",
                    textDecoration: isSelected ? "underline" : "none",
                    fontSize: "inherit",
                  }}
                  title="Click to view processor buffer allocations"
                >
                  <span style={{ fontWeight: isSelected ? 700 : 500, color: isSelected ? "var(--color-accent)" : "var(--color-text)" }}>
                    {seg.rangeLabel}
                  </span>
                  <span>{seg.processor.toUpperCase()}</span>
                  {seg.isLoopback && <span className="k">(test helper)</span>}
                  {idx < segments.length - 1 && <span style={{ color: "var(--color-rule-strong)", textDecoration: "none" }}>·</span>}
                </button>
              );
            })}
          </div>

          <span
            style={{
              fontSize: 11,
              color: isOffline ? "var(--color-warn)" : "var(--color-text-3)",
              fontWeight: isOffline ? 500 : 400,
              whiteSpace: "nowrap",
            }}
          >
            {isOffline
              ? "Last known placement — status unverified while offline"
              : selectedSegment
              ? "Click segment again or ✕ to close drill-down"
              : "Placement is fixed when the session loads. Click segment to inspect."}
          </span>
        </div>
      )}

      {/* B.3 Interactive Placement Drill-Down Box */}
      {selectedSegment && (
        <div
          className="animate-fade-in card"
          style={{
            marginTop: 4,
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-surface-sunken)",
            border: "1px solid var(--color-hairline)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            maxHeight: "min(38vh, 240px)",
            overflowY: "auto",
          }}
        >
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {selectedSegment.processor === "cpu" ? (
                  <Cpu size={15} color="var(--color-accent)" />
                ) : selectedSegment.processor === "gpu" ? (
                  <HardDrive size={15} color="var(--color-accent)" />
                ) : (
                  <Server size={15} color="var(--color-steel)" />
                )}
                <span style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                  {selectedSegment.deviceName}
                </span>
              </div>

              <span
                style={{
                  fontSize: 11,
                  padding: "1px 6px",
                  borderRadius: 4,
                  background: selectedSegment.deviceRole === "host" ? "var(--color-accent-subtle)" : "var(--color-surface-subtle)",
                  color: selectedSegment.deviceRole === "host" ? "var(--color-accent)" : "var(--color-text-2)",
                  fontWeight: 500,
                }}
              >
                {selectedSegment.deviceRole === "host" ? "Host Device" : selectedSegment.isLoopback ? "Local Test Helper" : "Remote Helper"}
              </span>

              {/* Status Pill */}
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5 }}>
                <span
                  className={`dot ${
                    selectedSegment.processor !== "rpc"
                      ? "dot-ok"
                      : selectedSegment.workerStatusLabel === "Unreachable" || selectedSegment.workerStatusLabel === "Failed"
                      ? "dot-error"
                      : selectedSegment.workerStatusLabel === "Busy"
                      ? "dot-busy"
                      : selectedSegment.workerStatusLabel === "Idle (0 layers)"
                      ? "dot-idle"
                      : "dot-ok"
                  }`}
                />
                <span style={{ color: "var(--color-text-2)" }}>
                  {selectedSegment.processor !== "rpc" ? "Connected (In-process)" : selectedSegment.workerStatusLabel || "Reported"}
                </span>
              </div>
            </div>

            <button
              type="button"
              className="btn-ghost"
              onClick={() => setSelectedBackendId(null)}
              style={{ padding: "2px 6px", height: 22, fontSize: 11 }}
              title="Close drill-down view"
            >
              <X size={13} />
              <span>Close</span>
            </button>
          </div>

          {/* Allocation Metrics Grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
              gap: 8,
              fontSize: 12,
              background: "var(--color-bg)",
              padding: "8px 12px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-hairline)",
            }}
          >
            <div>
              <span style={{ color: "var(--color-text-3)", fontSize: 11, display: "block" }}>Layer Assignment</span>
              <span className="mono" style={{ fontWeight: 600, color: "var(--color-text)" }}>
                {selectedSegment.rangeLabel}
              </span>
              <span style={{ fontSize: 11, color: "var(--color-text-2)", marginLeft: 4 }}>
                ({selectedSegment.layerCount} layers · {((selectedSegment.layerCount / effectiveTotal) * 100).toFixed(0)}%)
              </span>
            </div>

            <div>
              <span style={{ color: "var(--color-text-3)", fontSize: 11, display: "block" }}>Model Weights Buffer</span>
              <span className="mono" style={{ fontWeight: 600, color: "var(--color-text)" }}>
                {fmtBytes(selectedSegment.modelBufferBytes)}
              </span>
            </div>

            <div>
              <span style={{ color: "var(--color-text-3)", fontSize: 11, display: "block" }}>KV Cache Buffer</span>
              <span className="mono" style={{ color: "var(--color-text)" }}>
                {selectedSegment.kvBufferBytes > 0 ? fmtBytes(selectedSegment.kvBufferBytes) : "Host shared / system RAM"}
              </span>
            </div>

            <div>
              <span style={{ color: "var(--color-text-3)", fontSize: 11, display: "block" }}>Compute Buffer</span>
              <span className="mono" style={{ color: "var(--color-text)" }}>
                {selectedSegment.computeBufferBytes > 0 ? fmtBytes(selectedSegment.computeBufferBytes) : "Dynamic runtime scratch"}
              </span>
            </div>

            <div>
              <span style={{ color: "var(--color-text-3)", fontSize: 11, display: "block" }}>Memory Scope</span>
              <span className="mono" style={{ color: "var(--color-text-2)" }}>
                {selectedSegment.memoryScope || (selectedSegment.processor === "gpu" ? "device_vram" : "shared_host")}
              </span>
            </div>

            <div>
              <span style={{ color: "var(--color-text-3)", fontSize: 11, display: "block" }}>Transport &amp; Endpoint</span>
              <span className="mono" style={{ color: "var(--color-text)", wordBreak: "break-all" }}>
                {selectedSegment.processor === "rpc"
                  ? `${selectedSegment.endpoint || "127.0.0.1:50052"} (GGML RPC)`
                  : selectedSegment.processor === "gpu"
                  ? "PCI-e Bus (CUDA Runtime)"
                  : "Local CPU Threads"}
              </span>
            </div>
          </div>

          {/* Diagnostic Warning if RPC worker has issue */}
          {selectedSegment.workerDiagnostic && (
            <div
              style={{
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.25)",
                color: "var(--color-error)",
                fontSize: 11.5,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                <AlertCircle size={13} style={{ flexShrink: 0 }} />
                <span>{selectedSegment.workerDiagnostic.title}</span>
              </div>
              <div>{selectedSegment.workerDiagnostic.message}</div>
              {selectedSegment.workerDiagnostic.consequence && (
                <div><strong>Session impact:</strong> {selectedSegment.workerDiagnostic.consequence}</div>
              )}
            </div>
          )}

          {/* Offline warning banner if unverified */}
          {isOffline && (
            <div style={{ fontSize: 11, color: "var(--color-warn)", lineHeight: 1.4 }}>
              <strong>Offline state:</strong> Last known placement preserved for diagnostics. Actual node state unverified while coordinator is unreachable.
            </div>
          )}

          {/* Load-time explanation footnote */}
          <div style={{ fontSize: 11, color: "var(--color-text-3)", lineHeight: 1.4 }}>
            Informational drill-down: Model layer placement is established at load time and is not altered by selecting a segment.
          </div>
        </div>
      )}
    </div>
  );
}
