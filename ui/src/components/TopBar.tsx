import { useSwarmSession } from "../hooks/useSwarmSession";
import { useSupervisor } from "../hooks/useSupervisor";

interface TopBarProps {
  onSelectView?: (view: "chat" | "devices" | "session" | "settings") => void;
}

export function TopBar({ onSelectView }: TopBarProps) {
  const session = useSwarmSession(3000);
  const sup = useSupervisor(3000);

  return (
    <header className="session-bar-header">
      {/* Brand Mark: Three dots on a thread */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontWeight: 600,
          fontSize: 14,
          letterSpacing: "-0.01em",
          color: "var(--color-text)",
          marginRight: 6,
        }}
      >
        <span style={{ color: "var(--color-accent)", fontSize: 13, letterSpacing: "-1px" }}>●—●—●</span>
        <span>Swarm</span>
      </div>

      <div style={{ width: 1, height: 16, background: "var(--color-border)" }} />

      {/* Model Name & Context Window */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, overflow: "hidden" }}>
        <span
          style={{
            fontWeight: 600,
            fontSize: 13.5,
            color: "var(--color-text)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={session.modelPath}
        >
          {session.modelName}
        </span>
        <span
          className="mono hide-on-mobile"
          style={{ fontSize: 11.5, color: "var(--color-text-2)", whiteSpace: "nowrap" }}
        >
          {session.contextWindow.toLocaleString()}-token window
        </span>
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Session State (Honest single word + status dot) */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
        {sup.isDesktop && sup.selectedProfile && (
          <span
            className="mono hide-on-mobile"
            style={{
              fontSize: 11,
              padding: "2px 7px",
              borderRadius: 4,
              background: "var(--color-surface-subtle)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-2)",
            }}
            title={`Active Runtime Profile: ${sup.selectedProfile.name}`}
          >
            {sup.selectedProfile.id === "default" ? "Cluster (Default)" : "Standalone CUDA"}
          </span>
        )}
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
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text)" }}>
          {session.stateLabel}
        </span>
        {session.isCoordinatorOffline && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => session.retryNow()}
            style={{
              padding: "2px 7px",
              fontSize: 11,
              height: 22,
              borderRadius: 4,
              border: "1px solid var(--color-border)",
            }}
            title="Retry coordinator health check"
          >
            Retry
          </button>
        )}
        {sup.isDesktop && (sup.engineStatus?.coord_healthy || session.state === "ready") && (
          <button
            id="topbar-stop-engine-btn"
            type="button"
            className="btn-ghost hide-on-mobile"
            onClick={sup.stopEngine}
            disabled={sup.isStopping}
            style={{
              padding: "2px 8px",
              fontSize: 11,
              height: 22,
              borderRadius: 4,
              color: "var(--color-error)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
            }}
            title="Stop native engine processes"
          >
            {sup.isStopping ? "Stopping..." : "Stop Engine"}
          </button>
        )}
      </div>

      {/* Devices Summary Button */}
      {session.state !== "not_running" && (
        <button
          className="btn-ghost topbar-device-chip hide-on-mobile"
          onClick={() => onSelectView?.("devices")}
          style={{
            padding: "3px 9px",
            fontSize: 12,
            minHeight: "unset",
            height: 26,
            borderRadius: 5,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
          title="Click to view device hardware, memory and processors"
        >
          <span>{session.topBarDeviceLabel}</span>
        </button>
      )}
    </header>
  );
}
