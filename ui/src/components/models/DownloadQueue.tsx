import React from "react";
import {
  Download,
  XCircle,
  CheckCircle,
  AlertCircle,
  Trash2,
  Loader2,
  FileCode,
} from "lucide-react";
import type { DownloadTask } from "../../lib/modelsApi";

interface DownloadQueueProps {
  tasks: DownloadTask[];
  onCancelDownload: (taskId: string) => Promise<void>;
  onClearCompleted: () => Promise<void>;
}

export const DownloadQueue: React.FC<DownloadQueueProps> = ({
  tasks,
  onCancelDownload,
  onClearCompleted,
}) => {
  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return "0 B";
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    const kb = bytes / 1024;
    return `${kb.toFixed(0)} KB`;
  };

  const formatSpeed = (bytesPerSec: number) => {
    if (!bytesPerSec || bytesPerSec === 0) return "-- MB/s";
    const mb = bytesPerSec / (1024 * 1024);
    return `${mb.toFixed(1)} MB/s`;
  };

  const formatEta = (seconds?: number) => {
    if (seconds === undefined || seconds === null) return "--";
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const remainingSecs = seconds % 60;
    return `${mins}m ${remainingSecs}s`;
  };

  const hasFinishedTasks = tasks.some(
    (t) => t.status === "completed" || t.status === "cancelled" || t.status === "failed"
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        className="card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius)",
        }}
      >
        <span style={{ fontSize: 12, color: "var(--color-text-2)", fontWeight: 500 }}>
          {tasks.filter((t) => t.status === "downloading" || t.status === "queued" || t.status === "verifying").length} active
          download task(s)
        </span>

        {hasFinishedTasks && (
          <button
            onClick={onClearCompleted}
            className="btn-ghost"
            style={{ padding: "4px 10px", fontSize: 11.5 }}
          >
            <Trash2 size={13} />
            <span>Clear Finished</span>
          </button>
        )}
      </div>

      {tasks.length === 0 ? (
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
          <Download size={36} style={{ margin: "0 auto 12px", color: "var(--color-text-3)", opacity: 0.6 }} />
          <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text)", marginBottom: 4 }}>No Active Downloads</h3>
          <p style={{ fontSize: 12.5, color: "var(--color-text-2)", maxWidth: 420, margin: "0 auto" }}>
            Your download queue is empty. Browse models to start downloading GGUF model files directly into Swarm.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {tasks.map((task) => {
            const percent =
              task.total_bytes > 0
                ? Math.min(100, (task.downloaded_bytes / task.total_bytes) * 100)
                : 0;

            const isRunning = task.status === "downloading" || task.status === "verifying";

            return (
              <div
                key={task.id}
                className="card"
                style={{
                  padding: "16px",
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius)",
                  boxShadow: "0 1px 3px rgba(32, 40, 33, 0.04)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <h4 style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text)", display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
                      <FileCode size={15} style={{ color: "var(--color-text-3)" }} />
                      <span>{task.filename}</span>
                    </h4>
                    <p className="mono" style={{ fontSize: 11, color: "var(--color-text-3)", maxWidth: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", margin: 0 }} title={task.source_url}>
                      Source: {task.source_url}
                    </p>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {task.status === "downloading" && (
                      <span className="badge badge-busy" style={{ fontSize: 11 }}>
                        <Loader2 size={12} className="animate-spin" />
                        <span>Downloading</span>
                      </span>
                    )}

                    {task.status === "verifying" && (
                      <span className="badge badge-warn" style={{ fontSize: 11 }}>
                        <Loader2 size={12} className="animate-spin" />
                        <span>Verifying Checksum</span>
                      </span>
                    )}

                    {task.status === "completed" && (
                      <span className="badge badge-ok" style={{ fontSize: 11 }}>
                        <CheckCircle size={12} />
                        <span>Completed &amp; Finalized</span>
                      </span>
                    )}

                    {task.status === "failed" && (
                      <span className="badge badge-error" style={{ fontSize: 11 }}>
                        <AlertCircle size={12} />
                        <span>Failed</span>
                      </span>
                    )}

                    {task.status === "cancelled" && (
                      <span className="badge badge-idle" style={{ fontSize: 11 }}>
                        <XCircle size={12} />
                        <span>Cancelled</span>
                      </span>
                    )}

                    {isRunning && (
                      <button
                        onClick={() => onCancelDownload(task.id)}
                        className="btn-ghost"
                        style={{ padding: "4px 10px", fontSize: 11.5, color: "var(--color-error)" }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>

                {/* Progress Bar */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--color-text-2)" }}>
                    <span>
                      {formatBytes(task.downloaded_bytes)} / {formatBytes(task.total_bytes)} ({percent.toFixed(1)}%)
                    </span>
                    {isRunning && (
                      <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span>Speed: {formatSpeed(task.speed_bytes_per_sec)}</span>
                        <span>ETA: {formatEta(task.eta_seconds)}</span>
                      </span>
                    )}
                  </div>

                  <div style={{ width: "100%", height: 7, background: "var(--color-surface-sunken)", borderRadius: 99, overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        transition: "width 0.3s ease",
                        width: `${percent}%`,
                        background:
                          task.status === "completed"
                            ? "var(--color-ok)"
                            : task.status === "failed"
                            ? "var(--color-error)"
                            : task.status === "cancelled"
                            ? "var(--color-text-3)"
                            : "var(--color-accent)",
                      }}
                    />
                  </div>
                </div>

                {/* Error Banner */}
                {task.error_message && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "8px 12px",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--color-error-bg)",
                      border: "1px solid rgba(185, 28, 28, 0.25)",
                      color: "var(--color-error)",
                      fontSize: 12,
                    }}
                  >
                    <AlertCircle size={14} style={{ marginTop: 2, flexShrink: 0 }} />
                    <span className="mono">{task.error_message}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
