import { useState, useEffect } from "react";
import { useSwarmSession } from "../hooks/useSwarmSession";
import { PlacementRibbon } from "./PlacementRibbon";
import { fmtBytes, friendlyModelTitle } from "../lib/utils";
import { calculateBufferComposition } from "../lib/tensorBuffer";
import { Cpu, Info, Sliders } from "lucide-react";
import { ComputeAllocationModal } from "./ComputeAllocationModal";
import { modelsApi } from "../lib/modelsApi";
import { supervisor, type WorkerHardwareTelemetry } from "../lib/supervisor";

export function SessionPanel() {
  const session = useSwarmSession(3000);
  const [showAllocationModal, setShowAllocationModal] = useState(false);
  const [modelLayerCount, setModelLayerCount] = useState<number | null>(null);
  const [hardware, setHardware] = useState<WorkerHardwareTelemetry | null>(null);

  useEffect(() => {
    if (supervisor.isDesktop) {
      supervisor.getWorkerHardware().then((hw) => {
        if (hw) setHardware(hw);
      }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    modelsApi.getLibrary().then((state) => {
      const active = state.installed_models.find((m) => m.id === state.selected_model_id);
      if (active?.gguf?.block_count) {
        setModelLayerCount(active.gguf.block_count + 1);
      }
    }).catch(() => {});
  }, [session.modelPath]);

  const effectiveTotalLayers = session.totalLayers > 0
    ? session.totalLayers
    : (modelLayerCount || (session.modelPath?.toLowerCase().includes("360m") ? 33 : session.modelPath?.toLowerCase().includes("1b") ? 17 : 0));

  const backends = session.ribbonSegments;
  const memory = session.memoryAccounting;
  const hostGpu = session.hostDevice?.vramTotalBytes ? session.hostDevice : null;

  const isRunning = session.state === "ready" || session.state === "generating";
  const isStopped = session.state === "not_running";

  const friendlyName = friendlyModelTitle(session.modelPath || session.modelName);

  // Dynamic placement explanation
  const placementExplanation = (() => {
    if (isStopped) {
      return "Model layers will be assigned to available devices once the engine starts.";
    }
    if (!backends || backends.length === 0) {
      return "Awaiting active layer placement confirmation from coordinator…";
    }
    const parts = backends
      .filter((b) => b.layerCount > 0)
      .map((b) => `${b.layerCount} ${b.layerCount === 1 ? "layer" : "layers"} on ${b.deviceName} (${b.backendType.toUpperCase()})`);

    if (parts.length === 0) {
      return "All model layers are currently executing on Host CPU memory.";
    }
    return `Swarm distributes ${parts.join(" and ")}.`;
  })();

  const vramTotal = hostGpu?.vramTotalBytes || (hardware?.total_vram_mb ? hardware.total_vram_mb * 1024 * 1024 : 0);
  const vramUsed = hostGpu?.vramUsedBytes || (hardware && hardware.total_vram_mb != null && hardware.available_vram_mb != null ? Math.max(0, (hardware.total_vram_mb - hardware.available_vram_mb) * 1024 * 1024) : 0);
  const vramFree = Math.max(0, vramTotal - vramUsed);
  const vramPct = vramTotal > 0 ? Math.min(100, Math.round((vramUsed / vramTotal) * 100)) : 0;

  const ramTotal = (memory.hostRamTotalBytes > 0 ? memory.hostRamTotalBytes : (hardware?.total_ram_mb ? hardware.total_ram_mb * 1024 * 1024 : 0));
  const ramAvail = (memory.hostRamAvailableBytes > 0 ? memory.hostRamAvailableBytes : (hardware?.available_ram_mb ? hardware.available_ram_mb * 1024 * 1024 : 0));
  const ramUsed = Math.max(0, ramTotal - ramAvail);
  const ramPct = ramTotal > 0 ? Math.min(100, Math.round((ramUsed / ramTotal) * 100)) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, width: "100%", maxWidth: 1080, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="page-title">Session Telemetry</h1>
          <div className="page-subtitle" style={{ marginTop: 4 }}>
            Live memory allocation and model layer distribution
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface-subtle)",
              border: "1px solid var(--color-border)",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <span
              className={`dot ${
                isRunning
                  ? "dot-ok"
                  : session.state === "generating"
                  ? "dot-busy"
                  : session.state === "paused"
                  ? "dot-warn"
                  : "dot-idle"
              }`}
            />
            <span>{isStopped ? "Engine Standby" : session.stateLabel}</span>
          </div>

          <button
            id="session-adjust-allocation-btn"
            type="button"
            className="btn-primary"
            onClick={() => setShowAllocationModal(true)}
            style={{ padding: "6px 14px", fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}
          >
            <Sliders size={13} />
            <span>Adjust Allocation Plan</span>
          </button>
        </div>
      </div>

      {/* Model & Context Identity Card */}
      <div
        className="card animate-fade-in"
        style={{
          padding: "16px 20px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "var(--radius-sm)",
              background: "var(--color-accent-subtle)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--color-accent)",
            }}
          >
            <Cpu size={18} />
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: "var(--color-text)" }}>
              {friendlyName}
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 2, wordBreak: "break-all" }}>
              {session.modelPath}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 20, fontSize: 12 }}>
          <div>
            <span style={{ color: "var(--color-text-3)" }}>Model Layers: </span>
            <strong className="mono" style={{ color: "var(--color-text)" }}>
              {effectiveTotalLayers > 0 ? `${effectiveTotalLayers} total` : "Calculated on start"}
            </strong>
          </div>
          <div>
            <span style={{ color: "var(--color-text-3)" }}>Context Window: </span>
            <strong className="mono" style={{ color: "var(--color-accent)" }}>{session.contextWindow.toLocaleString()} tokens</strong>
          </div>
          <div>
            <span style={{ color: "var(--color-text-3)" }}>Engine State: </span>
            <strong style={{ color: isRunning ? "var(--color-ok)" : "var(--color-text-2)" }}>
              {isRunning ? "Active" : "Standby"}
            </strong>
          </div>
        </div>
      </div>

      {/* Model Layer Placement Ribbon */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="section-label" style={{ fontWeight: 600 }}>Model Placement Across Devices</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--color-text-3)" }}>
            {isStopped ? "Planned Split" : "Confirmed Runtime Split"}
          </span>
        </div>

        <PlacementRibbon
          segments={session.ribbonSegments}
          totalLayers={effectiveTotalLayers}
          showCaption={true}
          isOffline={session.isCoordinatorOffline}
        />

        {/* Dynamic placement rationale card */}
        <div
          style={{
            padding: "10px 14px",
            background: "var(--color-surface-subtle)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--color-text-2)",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <Info size={15} color="var(--color-accent)" style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong style={{ color: "var(--color-text)", marginRight: 4 }}>Placement Rationale:</strong>
            {placementExplanation}
          </div>
        </div>
      </div>

      {/* Tensor Buffer Allocation by Processor */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 6 }}>
          <span className="section-label" style={{ fontWeight: 600 }}>
            Tensor Buffer Allocations by Processor
          </span>
          {session.isCoordinatorOffline && (
            <span className="badge badge-idle" style={{ fontSize: 10.5 }}>
              Awaiting coordinator start
            </span>
          )}
        </div>

        {backends.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {backends.map((b, idx) => {
              const composition = calculateBufferComposition(
                b.modelBufferBytes,
                b.kvBufferBytes,
                b.computeBufferBytes
              );

              return (
                <div
                  key={idx}
                  className="card"
                  style={{
                    padding: "14px 16px",
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: 13.5, color: "var(--color-text)" }}>
                        {b.deviceName}
                      </span>
                      <span style={{ marginLeft: 6, fontSize: 12, color: "var(--color-text-3)" }}>
                        ({b.backendType.toUpperCase()})
                      </span>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 12 }}>
                      <div>
                        <span style={{ color: "var(--color-text-3)" }}>Layers: </span>
                        <strong className="mono" style={{ color: "var(--color-text)" }}>{b.layerCount}</strong>
                        <span style={{ marginLeft: 4, color: "var(--color-text-3)" }}>({b.rangeLabel})</span>
                      </div>
                      <div>
                        <span style={{ color: "var(--color-text-3)" }}>Buffer Total: </span>
                        <strong className="mono" style={{ color: "var(--color-accent)" }}>{fmtBytes(composition.totalBytes)}</strong>
                      </div>
                    </div>
                  </div>

                  {/* Composition Bar */}
                  <div style={{ display: "flex", height: 10, background: "var(--color-surface-subtle)", borderRadius: "var(--radius-sm)", overflow: "hidden", border: "1px solid var(--color-border)" }}>
                    {composition.isZeroTotal ? (
                      <div style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "var(--color-text-3)" }}>
                        No tensor buffer allocated
                      </div>
                    ) : (
                      <>
                        {composition.modelPct > 0 && (
                          <div
                            style={{ width: `${composition.modelPct}%`, background: "var(--color-accent)" }}
                            title={`Model weights: ${fmtBytes(composition.modelBytes ?? 0)} (${composition.modelPct.toFixed(1)}%)`}
                          />
                        )}
                        {composition.kvPct > 0 && (
                          <div
                            style={{ width: `${composition.kvPct}%`, background: "var(--color-warn)" }}
                            title={`KV cache: ${fmtBytes(composition.kvBytes ?? 0)} (${composition.kvPct.toFixed(1)}%)`}
                          />
                        )}
                        {composition.computePct > 0 && (
                          <div
                            style={{ width: `${composition.computePct}%`, background: "var(--color-steel)" }}
                            title={`Compute buffer: ${fmtBytes(composition.computeBytes ?? 0)} (${composition.computePct.toFixed(1)}%)`}
                          />
                        )}
                      </>
                    )}
                  </div>

                  {/* Legend */}
                  <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 11, color: "var(--color-text-2)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--color-accent)" }} />
                      <span>Weights: <strong className="mono">{fmtBytes(composition.modelBytes ?? 0)}</strong></span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--color-warn)" }} />
                      <span>KV-Cache: <strong className="mono">{fmtBytes(composition.kvBytes ?? 0)}</strong></span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--color-steel)" }} />
                      <span>Compute: <strong className="mono">{fmtBytes(composition.computeBytes ?? 0)}</strong></span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div
            className="card"
            style={{
              padding: "20px",
              textAlign: "center",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius)",
              color: "var(--color-text-3)",
              fontSize: 12,
            }}
          >
            Tensor buffer allocations will display here once the engine starts.
          </div>
        )}
      </div>

      {/* Symmetric Physical Hardware Memory Accounting */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="section-label" style={{ fontWeight: 600 }}>Physical Hardware Memory &amp; Headroom</span>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
          {/* Host RAM Meter */}
          <div
            className="card"
            style={{
              padding: "16px",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>Host Physical RAM</span>
              <span className="mono" style={{ fontSize: 12, color: memory.isBelowReserve ? "var(--color-warn)" : "var(--color-text)" }}>
                {ramTotal > 0 ? `${fmtBytes(ramUsed)} / ${fmtBytes(ramTotal)} (${ramPct}%)` : "Unavailable"}
              </span>
            </div>

            <div style={{ width: "100%", height: 8, background: "var(--color-surface-subtle)", borderRadius: 4, overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${ramPct}%`,
                  background: memory.isBelowReserve ? "var(--color-warn)" : "var(--color-accent)",
                }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--color-text-3)" }}>
              <span>{ramTotal > 0 ? `${fmtBytes(ramAvail)} available` : "RAM telemetry unavailable"}</span>
              <span>1,024 MB reserved headroom</span>
            </div>
          </div>

          {/* Dedicated GPU VRAM Meter */}
          <div
            className="card"
            style={{
              padding: "16px",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>Dedicated GPU VRAM</span>
              <span className="mono" style={{ fontSize: 12, color: "var(--color-cuda)" }}>
                {vramTotal > 0 ? `${fmtBytes(vramUsed)} / ${fmtBytes(vramTotal)} (${vramPct}%)` : "Unavailable"}
              </span>
            </div>

            <div style={{ width: "100%", height: 8, background: "var(--color-surface-subtle)", borderRadius: 4, overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${vramPct}%`,
                  background: "var(--color-cuda)",
                }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--color-text-3)" }}>
              <span>{vramTotal > 0 ? `${fmtBytes(vramFree)} free` : "VRAM telemetry unavailable"}</span>
              <span>NVIDIA CUDA Device 0</span>
            </div>
          </div>
        </div>
      </div>

      {/* Observed Inference Performance */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 6 }}>
          <span className="section-label" style={{ fontWeight: 600 }}>Observed Inference Performance</span>
          {session.latestInference && (
            <span className="mono" style={{ fontSize: 11, color: "var(--color-text-3)" }}>
              Completed at {new Date(session.latestInference.completed_at).toLocaleTimeString()}
            </span>
          )}
        </div>

        {session.latestInference ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <div className="card" style={{ padding: "14px", background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
              <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>Generated Tokens</span>
              <div className="mono-stat" style={{ marginTop: 4, color: "var(--color-text)" }}>
                {session.latestInference.tokens_generated}{" "}
                <span style={{ fontSize: 11, color: "var(--color-text-2)" }}>tokens</span>
              </div>
            </div>

            <div className="card" style={{ padding: "14px", background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
              <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>Generation Speed</span>
              <div className="mono-stat" style={{ marginTop: 4, color: "var(--color-accent)" }}>
                {session.latestInference.tokens_per_sec != null ? session.latestInference.tokens_per_sec.toFixed(1) : "N/A"}{" "}
                <span style={{ fontSize: 11, color: "var(--color-text-2)" }}>tok/s</span>
              </div>
            </div>

            <div className="card" style={{ padding: "14px", background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
              <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>Prompt Evaluation</span>
              <div className="mono-stat" style={{ marginTop: 4, color: "var(--color-text)" }}>
                {session.latestInference.prompt_eval_ms != null
                  ? `${(session.latestInference.prompt_eval_ms / 1000).toFixed(2)} s`
                  : "Unmeasured"}
              </div>
            </div>

            <div className="card" style={{ padding: "14px", background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
              <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>Time to First Content</span>
              <div className="mono-stat" style={{ marginTop: 4, color: "var(--color-text)" }}>
                {session.latestInference.ttfc_ms != null ? `${Math.round(session.latestInference.ttfc_ms)} ms` : "Unmeasured"}
              </div>
            </div>
          </div>
        ) : (
          <div
            className="card"
            style={{
              padding: "16px 20px",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius)",
              color: "var(--color-text-2)",
              fontSize: 12.5,
            }}
          >
            <div style={{ fontWeight: 600, color: "var(--color-text)", marginBottom: 2 }}>Awaiting First Message</div>
            <div>Send a message in Chat to view live speed and latency breakdown.</div>
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
