import { useState } from "react";
import { useSwarmSession } from "../hooks/useSwarmSession";
import { PlacementRibbon } from "./PlacementRibbon";
import { fmtBytes } from "../lib/utils";
import { calculateBufferComposition } from "../lib/tensorBuffer";
import { Cpu, Info, Sliders } from "lucide-react";
import { ComputeAllocationModal } from "./ComputeAllocationModal";

export function SessionPanel() {
  const session = useSwarmSession(3000);
  const [showAllocationModal, setShowAllocationModal] = useState(false);

  const backends = session.ribbonSegments;
  const memory = session.memoryAccounting;
  const hostGpu = session.hostDevice?.vramTotalBytes ? session.hostDevice : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, width: "100%", maxWidth: 960 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div>
          <h1 className="page-title">
            Session
          </h1>
          <div className="page-subtitle">
            Active model, layer placement, memory accounting, and runtime performance
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span
            className={`dot ${
              session.state === "ready"
                ? "dot-ok"
                : session.state === "generating"
                ? "dot-busy"
                : session.state === "paused"
                ? "dot-warn"
                : "dot-error"
            }`}
          />
          <span style={{ fontSize: 13, fontWeight: 500 }}>{session.stateLabel}</span>
        </div>
      </div>

      {/* 1. Model Identity Row */}
      <div
        className="card-flat"
        style={{
          padding: "16px 20px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Cpu size={18} color="var(--color-accent)" />
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{session.modelName}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--color-text-2)", marginTop: 2, wordBreak: "break-all" }}>
              {session.modelPath}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 20, fontSize: 12.5 }}>
          <div>
            <span style={{ color: "var(--color-text-2)" }}>Layers: </span>
            <strong className="mono">{session.totalLayers} total</strong>
          </div>
          <div>
            <span style={{ color: "var(--color-text-2)" }}>Context: </span>
            <strong className="mono">{session.contextWindow.toLocaleString()} tokens</strong>
          </div>
        </div>
      </div>

      {/* 2. Model Layer Placement Ribbon */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="section-label">
            Model Placement Across Devices
          </div>
          <button
            onClick={() => setShowAllocationModal(true)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 12,
              padding: "4px 10px",
              background: "rgba(14, 165, 233, 0.08)",
              border: "1px solid rgba(14, 165, 233, 0.3)",
              color: "#0ea5e9",
              borderRadius: "var(--radius, 6px)",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            <Sliders size={13} />
            <span>Adjust Allocation Plan</span>
          </button>
        </div>

        <PlacementRibbon
          segments={session.ribbonSegments}
          totalLayers={session.totalLayers}
          showCaption={true}
          isOffline={session.isCoordinatorOffline}
        />
      </div>

      {/* 3. Tensor Buffer Allocation Table & Composition Bars (B.6) */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, flexWrap: "wrap", gap: 6 }}>
          <div className="section-label">
            Tensor Buffer Allocations by Processor
          </div>
          {session.isCoordinatorOffline && (
            <span className="badge badge-offline" style={{ fontSize: 10.5 }}>
              Cached buffer allocations — status unverified while offline
            </span>
          )}
        </div>
        <div className="caption-text" style={{ fontSize: 11.5, color: "var(--color-text-3)", marginBottom: 10 }}>
          Inference engine tensor buffers (model weights, KV-cache, compute scratch). Distinct from OS physical RAM and driver VRAM.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {backends.map((b, idx) => {
            const composition = calculateBufferComposition(
              b.modelBufferBytes,
              b.kvBufferBytes,
              b.computeBufferBytes
            );

            return (
              <div
                key={idx}
                className="card-flat"
                style={{
                  padding: "14px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {/* Processor Info Header */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    flexWrap: "wrap",
                    gap: 8,
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 600, fontSize: 13.5, color: "var(--color-text)" }}>
                      {b.deviceName}
                    </span>
                    <span className="k" style={{ marginLeft: 6, fontSize: 12 }}>
                      ({b.backendType})
                    </span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 12px", fontSize: 12 }}>
                    <div>
                      <span style={{ color: "var(--color-text-2)" }}>Layers: </span>
                      <strong className="mono">{b.layerCount}</strong>
                      <span className="k" style={{ marginLeft: 4 }}>({b.rangeLabel})</span>
                    </div>
                    <div>
                      <span style={{ color: "var(--color-text-2)" }}>Measured Total: </span>
                      <strong className="mono">{fmtBytes(composition.totalBytes)}</strong>
                    </div>
                  </div>
                </div>

                {/* Tensor Buffer Composition Bar */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
                    <span style={{ fontWeight: 600, color: "var(--color-text-2)", letterSpacing: "0.01em" }}>
                      Tensor Buffer Composition (Observed)
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--color-text-3)" }}>
                      {session.isCoordinatorOffline
                        ? "Cached offline (unverified)"
                        : b.logDerived
                        ? "Log-derived (GGML engine)"
                        : b.measurementStatus === "observed"
                        ? "API-reported buffer allocation"
                        : b.measurementStatus || "Reported allocation"}
                    </span>
                  </div>

                  {composition.isZeroTotal ? (
                    <div className="buffer-bar-track buffer-bar-empty">
                      <span style={{ fontSize: 11, color: "var(--color-text-3)", padding: "0 8px" }}>
                        {composition.statusText || "No tensor buffers allocated"}
                      </span>
                    </div>
                  ) : (
                    <div
                      className="buffer-bar-track"
                      role="img"
                      aria-label={`Tensor buffer composition for ${b.deviceName}: Model weights ${composition.modelPct.toFixed(1)}%, KV Cache ${composition.kvPct.toFixed(1)}%, Compute scratch ${composition.computePct.toFixed(1)}%`}
                    >
                      {composition.modelPct > 0 && (
                        <div
                          className="buffer-slice slice-model"
                          style={{ width: `${composition.modelPct}%` }}
                          title={`Model weights buffer: ${fmtBytes(composition.modelBytes ?? 0)} (${composition.modelPct.toFixed(1)}%)`}
                        />
                      )}
                      {composition.kvPct > 0 && (
                        <div
                          className="buffer-slice slice-kv"
                          style={{ width: `${composition.kvPct}%` }}
                          title={`KV-cache buffer: ${fmtBytes(composition.kvBytes ?? 0)} (${composition.kvPct.toFixed(1)}%)`}
                        />
                      )}
                      {composition.computePct > 0 && (
                        <div
                          className="buffer-slice slice-compute"
                          style={{ width: `${composition.computePct}%` }}
                          title={`Compute buffer: ${fmtBytes(composition.computeBytes ?? 0)} (${composition.computePct.toFixed(1)}%)`}
                        />
                      )}
                    </div>
                  )}

                  {/* Accessible Legend & Measured Byte Values */}
                  <div className="buffer-legend-grid">
                    <div className="buffer-legend-item">
                      <span className="buffer-legend-dot slice-model" />
                      <span className="buffer-legend-label">Model weights buffer:</span>
                      <span className="mono buffer-legend-val">
                        {composition.modelBytes != null
                          ? `${fmtBytes(composition.modelBytes)} (${composition.modelPct.toFixed(1)}%)`
                          : "Unmeasured"}
                      </span>
                    </div>
                    <div className="buffer-legend-item">
                      <span className="buffer-legend-dot slice-kv" />
                      <span className="buffer-legend-label">KV-cache buffer:</span>
                      <span className="mono buffer-legend-val">
                        {composition.kvBytes != null
                          ? `${fmtBytes(composition.kvBytes)} (${composition.kvPct.toFixed(1)}%)`
                          : "Unmeasured"}
                      </span>
                    </div>
                    <div className="buffer-legend-item">
                      <span className="buffer-legend-dot slice-compute" />
                      <span className="buffer-legend-label">Compute buffer:</span>
                      <span className="mono buffer-legend-val">
                        {composition.computeBytes != null
                          ? `${fmtBytes(composition.computeBytes)} (${composition.computePct.toFixed(1)}%)`
                          : "Unmeasured"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Why this split explanation */}
        <div
          className="well-sunken"
          style={{
            marginTop: 14,
            fontSize: 12,
            lineHeight: 1.55,
            color: "var(--color-text-2)",
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
          }}
        >
          <Info size={15} color="var(--color-accent)" style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong>Why this split?</strong> Swarm offloads the last 3 layers to host GPU (CUDA0 VRAM)
            and 1 layer to the RPC test helper, leaving 33 base layers on Host CPU.
            Placement is calculated at model load and remains fixed throughout the entire session.
          </div>
        </div>
      </div>

      {/* 4. Physical Memory Accounting */}
      <div>
        <div className="section-label" style={{ marginBottom: 8 }}>
          Host Physical Memory &amp; Headroom
        </div>

        <div className="card-flat" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
              <span>
                <strong>Host Physical RAM</strong> <span className="k">(OS-reported via system telemetry)</span>
              </span>
              <span className="mono" style={{ color: memory.isBelowReserve ? "var(--color-warn)" : "var(--color-text)" }}>
                {fmtBytes(memory.hostRamAvailableBytes)} free now / {fmtBytes(memory.hostRamTotalBytes)} total
              </span>
            </div>

            <div className="memory-reserve-track">
              <div
                className="memory-reserve-fill"
                style={{
                  width: `${Math.min(
                    ((memory.hostRamTotalBytes - memory.hostRamAvailableBytes) / memory.hostRamTotalBytes) * 100,
                    100
                  )}%`,
                }}
              />
              <div
                className="memory-reserve-tick"
                style={{
                  left: `${Math.max(
                    ((memory.hostRamTotalBytes - memory.reserveBytes) / memory.hostRamTotalBytes) * 100,
                    10
                  )}%`,
                }}
              />
            </div>

            <div style={{ fontSize: 12, color: memory.isBelowReserve ? "var(--color-warn)" : "var(--color-text-2)", marginTop: 8 }}>
              {memory.reserveWarningText} Loopback helper memory is deduplicated with host RAM.
            </div>
          </div>

          {hostGpu?.vramTotalBytes != null && (
            <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span><strong>Dedicated GPU VRAM</strong> <span className="k">(OS/Driver-reported hardware usage)</span></span>
                <span className="mono" style={{ color: "var(--color-accent)" }}>
                  {fmtBytes(hostGpu.vramUsedBytes || 0)} used / {fmtBytes(hostGpu.vramTotalBytes)} total
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 5. Most Recent Inference Performance (B.4 item 5) */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
          <div className="section-label">
            Most Recent Inference Performance (Observed)
          </div>
          {session.latestInference && (
            <span className="caption-text" style={{ fontSize: 11 }}>
              Single request measurement · Completed {new Date(session.latestInference.completed_at).toLocaleTimeString()}
            </span>
          )}
        </div>

        {session.latestInference ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            {/* Generated Tokens */}
            <div className="card-flat" style={{ padding: "14px" }}>
              <span className="section-label">Generated Tokens</span>
              <div className="mono-stat" style={{ marginTop: 4 }}>
                {session.latestInference.tokens_generated}{" "}
                <span style={{ fontSize: 12, fontWeight: 400, color: "var(--color-text-2)" }}>tokens</span>
              </div>
              <span className="caption-text" style={{ marginTop: 2, display: "block" }}>
                Latest response token count
              </span>
            </div>

            {/* Generation Rate */}
            <div className="card-flat" style={{ padding: "14px" }}>
              <span className="section-label">Generation Rate</span>
              <div className="mono-stat" style={{ marginTop: 4 }}>
                {session.latestInference.tokens_per_sec != null ? (
                  <>
                    {session.latestInference.tokens_per_sec.toFixed(1)}{" "}
                    <span style={{ fontSize: 12, fontWeight: 400, color: "var(--color-text-2)" }}>tok/s</span>
                  </>
                ) : (
                  <span style={{ fontSize: 16, color: "var(--color-text-3)" }}>N/A tok/s</span>
                )}
              </div>
              <span className="caption-text" style={{ marginTop: 2, display: "block" }}>
                Active token generation speed
              </span>
            </div>

            {/* Prompt Evaluation */}
            <div className="card-flat" style={{ padding: "14px" }}>
              <span className="section-label">Prompt Evaluation</span>
              <div className="mono-stat" style={{ marginTop: 4 }}>
                {session.latestInference.prompt_eval_ms != null ? (
                  <>
                    {session.latestInference.prompt_eval_ms >= 1000
                      ? (session.latestInference.prompt_eval_ms / 1000).toFixed(2)
                      : Math.round(session.latestInference.prompt_eval_ms)}{" "}
                    <span style={{ fontSize: 12, fontWeight: 400, color: "var(--color-text-2)" }}>
                      {session.latestInference.prompt_eval_ms >= 1000 ? "s" : "ms"}
                    </span>
                  </>
                ) : (
                  <span style={{ fontSize: 16, color: "var(--color-text-3)" }}>Unmeasured</span>
                )}
              </div>
              <span className="caption-text" style={{ marginTop: 2, display: "block" }}>
                Backend prompt ingestion duration
              </span>
            </div>

            {/* Time to First Content (Client Latency) */}
            <div className="card-flat" style={{ padding: "14px" }}>
              <span className="section-label">Time to First Content</span>
              <div className="mono-stat" style={{ marginTop: 4 }}>
                {session.latestInference.ttfc_ms != null ? (
                  <>
                    {session.latestInference.ttfc_ms >= 1000
                      ? (session.latestInference.ttfc_ms / 1000).toFixed(2)
                      : Math.round(session.latestInference.ttfc_ms)}{" "}
                    <span style={{ fontSize: 12, fontWeight: 400, color: "var(--color-text-2)" }}>
                      {session.latestInference.ttfc_ms >= 1000 ? "s" : "ms"}
                    </span>
                  </>
                ) : (
                  <span style={{ fontSize: 16, color: "var(--color-text-3)" }}>Unmeasured</span>
                )}
              </div>
              <span className="caption-text" style={{ marginTop: 2, display: "block" }}>
                Client-observed initial stream latency
              </span>
            </div>

            {/* Generation Duration (Backend) */}
            <div className="card-flat" style={{ padding: "14px" }}>
              <span className="section-label">Generation Duration</span>
              <div className="mono-stat" style={{ marginTop: 4 }}>
                {session.latestInference.gen_ms != null ? (
                  <>
                    {(session.latestInference.gen_ms / 1000).toFixed(2)}{" "}
                    <span style={{ fontSize: 12, fontWeight: 400, color: "var(--color-text-2)" }}>s</span>
                  </>
                ) : (
                  <span style={{ fontSize: 16, color: "var(--color-text-3)" }}>Unmeasured</span>
                )}
              </div>
              <span className="caption-text" style={{ marginTop: 2, display: "block" }}>
                Backend token generation phase
              </span>
            </div>

            {/* Total Request Duration */}
            <div className="card-flat" style={{ padding: "14px" }}>
              <span className="section-label">Total Duration</span>
              <div className="mono-stat" style={{ marginTop: 4 }}>
                {session.latestInference.total_ms != null ? (
                  <>
                    {(session.latestInference.total_ms / 1000).toFixed(2)}{" "}
                    <span style={{ fontSize: 12, fontWeight: 400, color: "var(--color-text-2)" }}>s</span>
                  </>
                ) : (
                  <span style={{ fontSize: 16, color: "var(--color-text-3)" }}>Unmeasured</span>
                )}
              </div>
              <span className="caption-text" style={{ marginTop: 2, display: "block" }}>
                Whole-request backend latency
              </span>
            </div>
          </div>
        ) : (
          <div
            className="card-flat"
            style={{
              padding: "16px 20px",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              color: "var(--color-text-2)",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
              Awaiting first inference run
            </div>
            <div style={{ fontSize: 12 }}>
              Authoritative generation speed, prompt evaluation duration, and token counts will appear here after a prompt is completed in Chat.
            </div>
          </div>
        )}
      </div>

      <ComputeAllocationModal
        isOpen={showAllocationModal}
        onClose={() => setShowAllocationModal(false)}
        onPlanApplied={() => session.refetch()}
      />
    </div>
  );
}

