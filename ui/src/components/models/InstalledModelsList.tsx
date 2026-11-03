import { useState } from "react";
import {
  Check,
  Copy,
  Trash2,
  ShieldCheck,
  ShieldAlert,
  Cpu,
  Layers,
  FileCode,
  HardDrive,
  Loader2,
  ArrowRightLeft,
} from "lucide-react";
import type { InstalledModel } from "../../lib/modelsApi";

interface InstalledModelsListProps {
  models: InstalledModel[];
  selectedModelId?: string;
  onSelectModel: (modelId: string) => Promise<void>;
  onDeleteModel: (modelId: string) => Promise<void>;
  onVerifyChecksum: (modelId: string) => Promise<{
    success: boolean;
    computed_sha256: string;
    matches_expected?: boolean;
    message: string;
  }>;
  modelsDirectory: string;
  onOpenDirectory?: () => void;
  isLoading?: boolean;
}

export const InstalledModelsList: React.FC<InstalledModelsListProps> = ({
  models,
  selectedModelId,
  onSelectModel,
  onDeleteModel,
  onVerifyChecksum,
  modelsDirectory,
  isLoading,
}) => {
  const [modelToDelete, setModelToDelete] = useState<InstalledModel | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [verifyMessage, setVerifyMessage] = useState<{ id: string; msg: string; ok: boolean } | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selectNotice, setSelectNotice] = useState<string | null>(null);
  const [copiedDir, setCopiedDir] = useState(false);
  const [copiedPathId, setCopiedPathId] = useState<string | null>(null);

  const formatSize = (bytes: number) => {
    if (!bytes || bytes === 0) return "0 B";
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
  };

  const handleSelect = async (modelId: string) => {
    try {
      setSelectingId(modelId);
      setSelectNotice(null);
      await onSelectModel(modelId);
      const target = models.find((m) => m.id === modelId);
      setSelectNotice(`Active inference model switched to ${target?.name || modelId}`);
      setTimeout(() => setSelectNotice(null), 4000);
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setSelectingId(null);
    }
  };

  const handleVerify = async (modelId: string) => {
    try {
      setVerifyingId(modelId);
      setVerifyMessage(null);
      const res = await onVerifyChecksum(modelId);
      setVerifyMessage({
        id: modelId,
        msg: res.message,
        ok: res.success,
      });
    } catch (err: unknown) {
      setVerifyMessage({
        id: modelId,
        msg: err instanceof Error ? err.message : String(err),
        ok: false,
      });
    } finally {
      setVerifyingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!modelToDelete) return;
    try {
      setDeleteError(null);
      await onDeleteModel(modelToDelete.id);
      setModelToDelete(null);
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Path Header */}
      <div
        className="card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          padding: "10px 14px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <HardDrive size={15} style={{ color: "var(--color-text-3)", flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: "var(--color-text-2)", fontWeight: 500 }}>Storage directory:</span>
          <span
            className="mono"
            style={{
              fontSize: 12,
              color: modelsDirectory ? "var(--color-text)" : "var(--color-text-3)",
              background: "var(--color-surface-subtle)",
              padding: "2px 8px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-border)",
              maxWidth: 420,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={modelsDirectory || "Scanning storage directory…"}
          >
            {modelsDirectory || "Scanning storage directory…"}
          </span>
          <button
            onClick={() => {
              if (modelsDirectory) {
                navigator.clipboard?.writeText(modelsDirectory);
                setCopiedDir(true);
                setTimeout(() => setCopiedDir(false), 2000);
              }
            }}
            disabled={!modelsDirectory}
            className="btn-ghost"
            style={{ padding: "3px 6px", fontSize: 11 }}
            title="Copy models directory path"
          >
            {copiedDir ? <Check size={12} style={{ color: "var(--color-ok)" }} /> : <Copy size={12} />}
          </button>
        </div>
        <span style={{ fontSize: 12, color: "var(--color-text-3)", fontWeight: 500 }}>
          {isLoading && models.length === 0 ? "Scanning…" : `${models.length} model${models.length === 1 ? "" : "s"} installed`}
        </span>
      </div>

      {selectNotice && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 14px",
            background: "var(--color-ok-bg)",
            border: "1px solid rgba(30, 126, 89, 0.25)",
            borderRadius: "var(--radius)",
            color: "var(--color-ok)",
            fontSize: 12.5,
            fontWeight: 500,
          }}
        >
          <Check size={16} style={{ flexShrink: 0 }} />
          <span>{selectNotice}</span>
        </div>
      )}

      {isLoading && models.length === 0 ? (
        <div
          className="card"
          style={{
            padding: "48px 20px",
            textAlign: "center",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
          }}
        >
          <Loader2 size={24} className="animate-spin" style={{ color: "var(--color-accent)" }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text)" }}>
              Scanning Model Library
            </div>
            <div style={{ fontSize: 12, color: "var(--color-text-3)", marginTop: 3 }}>
              Reading verified GGUF model files from disk…
            </div>
          </div>
        </div>
      ) : models.length === 0 ? (
        <div
          className="card"
          style={{
            padding: "40px 20px",
            textAlign: "center",
            background: "var(--color-surface)",
            border: "1px dashed var(--color-border-strong)",
            borderRadius: "var(--radius)",
          }}
        >
          <FileCode size={36} style={{ margin: "0 auto 12px", color: "var(--color-text-3)", opacity: 0.6 }} />
          <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text)", marginBottom: 4 }}>No Models Installed</h3>
          <p style={{ fontSize: 12.5, color: "var(--color-text-2)", maxWidth: 420, margin: "0 auto" }}>
            You don't have any GGUF models in your library yet. Browse the catalog to download verified models or import existing ones.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {models.map((model) => {
            const isSelected = model.id === selectedModelId;
            const isVerifying = verifyingId === model.id;
            const isSelecting = selectingId === model.id;
            const verifyStatus = verifyMessage?.id === model.id ? verifyMessage : null;

            return (
              <div
                key={model.id}
                className="card"
                style={{
                  padding: "16px",
                  background: "var(--color-surface)",
                  border: isSelected
                    ? "1px solid var(--color-accent)"
                    : "1px solid var(--color-border)",
                  borderRadius: "var(--radius)",
                  boxShadow: isSelected
                    ? "0 2px 8px rgba(27, 94, 73, 0.08)"
                    : "0 1px 3px rgba(32, 40, 33, 0.04)",
                  transition: "all var(--dur-fast)",
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 8 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <h4 style={{ fontSize: 14.5, fontWeight: 600, color: "var(--color-text)", margin: 0 }}>{model.name}</h4>
                      {isSelected && (
                        <span className="badge badge-ok" style={{ fontSize: 11 }}>
                          <Check size={11} />
                          <span>Active for Inference</span>
                        </span>
                      )}
                      {model.is_official_verified && (
                        <span className="badge badge-ok" style={{ fontSize: 11 }}>
                          <ShieldCheck size={11} />
                          <span>Official Swarm Verified</span>
                        </span>
                      )}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <p className="mono" style={{ fontSize: 11.5, color: "var(--color-text-3)", margin: 0, maxWidth: 520, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={model.path}>
                        {model.path}
                      </p>
                      <button
                        onClick={() => {
                          navigator.clipboard?.writeText(model.path);
                          setCopiedPathId(model.id);
                          setTimeout(() => setCopiedPathId(null), 2000);
                        }}
                        className="btn-ghost"
                        style={{ padding: "2px 5px", fontSize: 11 }}
                        title="Copy file path"
                      >
                        {copiedPathId === model.id ? <Check size={11} style={{ color: "var(--color-ok)" }} /> : <Copy size={11} />}
                      </button>
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    {!isSelected ? (
                      <button
                        id={`select-model-${model.id}`}
                        onClick={() => handleSelect(model.id)}
                        disabled={isSelecting}
                        className="btn-primary"
                        style={{ padding: "6px 14px", fontSize: 12 }}
                      >
                        {isSelecting ? <Loader2 size={13} className="animate-spin" /> : <ArrowRightLeft size={13} />}
                        <span>Switch to this Model</span>
                      </button>
                    ) : (
                      <span className="badge badge-ok" style={{ padding: "5px 10px", fontSize: 12 }}>
                        <Check size={13} />
                        <span>Active Model</span>
                      </span>
                    )}

                    <button
                      id={`verify-model-${model.id}`}
                      onClick={() => handleVerify(model.id)}
                      disabled={isVerifying}
                      title="Verify SHA-256 integrity digest"
                      className="btn-ghost"
                      style={{ padding: "6px 10px", fontSize: 12 }}
                    >
                      {isVerifying ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                      <span>Verify Digest</span>
                    </button>

                    <button
                      id={`delete-model-${model.id}`}
                      onClick={() => setModelToDelete(model)}
                      title="Remove model from library and disk"
                      className="btn-ghost"
                      style={{ padding: "6px 8px", color: "var(--color-error)" }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Technical Metadata Row */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                    gap: 8,
                    padding: "8px 12px",
                    background: "var(--color-surface-subtle)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 11.5,
                    marginTop: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--color-text-2)" }} title="Disk file size">
                    <FileCode size={13} style={{ color: "var(--color-text-3)", flexShrink: 0 }} />
                    <span className="mono" style={{ fontWeight: 600, color: "var(--color-text)" }}>Size: {formatSize(model.size_bytes)}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--color-text-2)" }} title="Model Architecture">
                    <Cpu size={13} style={{ color: "var(--color-text-3)", flexShrink: 0 }} />
                    <span className="mono" style={{ fontWeight: 500, color: "var(--color-text)", textTransform: "capitalize" }}>{model.gguf?.architecture || "GGUF"}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--color-text-2)" }} title="Context Length">
                    <Layers size={13} style={{ color: "var(--color-text-3)", flexShrink: 0 }} />
                    <span className="mono" style={{ fontWeight: 500, color: "var(--color-text)" }}>
                      {model.gguf?.context_length
                        ? `${(model.gguf.context_length / 1024).toFixed(0)}k Ctx`
                        : "Std Ctx"}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--color-text-2)" }} title="Transformer Layers">
                    <Layers size={13} style={{ color: "var(--color-accent)", flexShrink: 0 }} />
                    <span className="mono" style={{ fontWeight: 500, color: "var(--color-text)" }}>{model.gguf?.block_count ? `${model.gguf.block_count} layers` : "— layers"}</span>
                  </div>
                  <div>
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "2px 7px",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--color-surface)",
                        border: "1px solid var(--color-border)",
                        color: "var(--color-text-2)",
                      }}
                    >
                      {model.gguf?.quantization || "Quantized"}
                    </span>
                  </div>
                </div>

                {/* SHA-256 Digest Verification Notice */}
                {verifyStatus && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginTop: 8,
                      padding: "8px 12px",
                      borderRadius: "var(--radius-sm)",
                      background: verifyStatus.ok ? "var(--color-ok-bg)" : "var(--color-error-bg)",
                      border: `1px solid ${verifyStatus.ok ? "rgba(30, 126, 89, 0.25)" : "rgba(185, 28, 28, 0.25)"}`,
                      color: verifyStatus.ok ? "var(--color-ok)" : "var(--color-error)",
                      fontSize: 12,
                    }}
                  >
                    {verifyStatus.ok ? <ShieldCheck size={14} style={{ flexShrink: 0 }} /> : <ShieldAlert size={14} style={{ flexShrink: 0 }} />}
                    <span className="mono">{verifyStatus.msg}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {modelToDelete && (
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
            }}
          >
            <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--color-text)", display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Trash2 size={18} style={{ color: "var(--color-error)" }} />
              <span>Remove Model from Library?</span>
            </h3>
            <p style={{ fontSize: 13, color: "var(--color-text-2)", lineHeight: 1.5, marginBottom: 12 }}>
              Are you sure you want to delete <strong style={{ color: "var(--color-text)" }}>{modelToDelete.name}</strong> ({formatSize(modelToDelete.size_bytes)})?
            </p>
            <div
              style={{
                background: "var(--color-surface-subtle)",
                padding: "8px 12px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--color-border)",
                marginBottom: 16,
              }}
            >
              <span style={{ fontSize: 11, color: "var(--color-text-3)", display: "block", marginBottom: 2, fontWeight: 500 }}>Disk Location:</span>
              <p className="mono" style={{ fontSize: 11.5, color: "var(--color-text-2)", wordBreak: "break-all", userSelect: "all", margin: 0, lineHeight: 1.4 }}>
                {modelToDelete.path}
              </p>
            </div>

            {deleteError && (
              <div
                style={{
                  padding: "8px 12px",
                  marginBottom: 16,
                  background: "var(--color-error-bg)",
                  color: "var(--color-error)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 12,
                  border: "1px solid rgba(185, 28, 28, 0.25)",
                }}
              >
                {deleteError}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setModelToDelete(null);
                  setDeleteError(null);
                }}
                className="btn-ghost"
                style={{ padding: "6px 14px", fontSize: 12.5 }}
              >
                Cancel
              </button>
              <button
                id="confirm-delete-model-btn"
                type="button"
                onClick={confirmDelete}
                style={{
                  padding: "6px 14px",
                  fontSize: 12.5,
                  borderRadius: "var(--radius)",
                  border: "none",
                  cursor: "pointer",
                  background: "var(--color-error)",
                  color: "#FFFFFF",
                  fontWeight: 500,
                  transition: "opacity var(--dur-fast)",
                }}
              >
                Delete File
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
