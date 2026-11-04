import React, { useState } from "react";
import { AlertTriangle, RefreshCw, Loader2 } from "lucide-react";

interface ModelSwitchModalProps {
  pendingSelect: {
    modelId: string;
    modelName: string;
  } | null;
  onConfirm: () => Promise<void>;
  onDismiss: () => void;
}

export const ModelSwitchModal: React.FC<ModelSwitchModalProps> = ({
  pendingSelect,
  onConfirm,
  onDismiss,
}) => {
  const [isRestarting, setIsRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!pendingSelect) return null;

  const handleConfirm = async () => {
    try {
      setIsRestarting(true);
      setError(null);
      await onConfirm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setIsRestarting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.45)",
        backdropFilter: "blur(2px)",
        padding: 16,
      }}
    >
      <div
        className="card"
        style={{
          padding: "24px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border-strong)",
          borderRadius: "var(--radius-lg)",
          maxWidth: 440,
          width: "100%",
          boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--color-warn)" }}>
          <AlertTriangle size={22} style={{ flexShrink: 0 }} />
          <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--color-text)", margin: 0 }}>
            Switch Model &amp; Restart Inference?
          </h3>
        </div>

        <p style={{ fontSize: 13, color: "var(--color-text-2)", lineHeight: 1.5, margin: 0 }}>
          The inference engine is currently active and hosting a loaded model.
          Switching to <strong style={{ color: "var(--color-text)" }}>{pendingSelect.modelName}</strong> requires
          gracefully stopping the coordinator and restarting it with the new model.
        </p>

        <div
          style={{
            padding: "10px 14px",
            background: "var(--color-surface-subtle)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            fontSize: 12,
            color: "var(--color-text)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <span style={{ color: "var(--color-text-3)", fontFamily: "var(--font-sans)", marginRight: 6 }}>Target:</span>
          <strong>{pendingSelect.modelName}</strong>
        </div>

        {error && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-error-bg)",
              color: "var(--color-error)",
              fontSize: 12,
              border: "1px solid rgba(185, 28, 28, 0.25)",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 8, borderTop: "1px solid var(--color-border)" }}>
          <button
            type="button"
            onClick={onDismiss}
            className="btn-ghost"
            style={{ padding: "6px 14px", fontSize: 12.5 }}
          >
            Cancel
          </button>
          <button
            id="confirm-model-switch-btn"
            type="button"
            onClick={handleConfirm}
            disabled={isRestarting}
            className="btn-primary"
            style={{ padding: "6px 16px", fontSize: 12.5 }}
          >
            {isRestarting ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                <span>Reloading Model Weights…</span>
              </>
            ) : (
              <>
                <RefreshCw size={13} />
                <span>Stop &amp; Switch Model</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
