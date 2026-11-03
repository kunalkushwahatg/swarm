import React, { useState } from "react";
import {
  Download,
  CheckCircle,
  ExternalLink,
  Search,
  Cpu,
  Layers,
  FileCode,
  ShieldCheck,
  AlertCircle,
  Loader2,
  ArrowRightLeft,
  Compass,
} from "lucide-react";
import type { CatalogModel, InstalledModel, DownloadTask, HuggingFaceRepoInfo } from "../../lib/modelsApi";

interface CatalogBrowserProps {
  catalog: CatalogModel[];
  installedModels: InstalledModel[];
  selectedModelId?: string;
  activeDownloads: DownloadTask[];
  onDownloadCatalog: (model: CatalogModel) => Promise<void>;
  onDownloadCustom: (params: {
    modelId: string;
    filename: string;
    sourceUrl: string;
    repoId?: string;
    expectedSha256?: string;
  }) => Promise<void>;
  onSelectModel?: (modelId: string) => Promise<void>;
  onSearchHfRepo: (repoId: string) => Promise<void>;
  hfRepoInfo: HuggingFaceRepoInfo | null;
  hfSearching: boolean;
  clearHfSearch: () => void;
}

export const CatalogBrowser: React.FC<CatalogBrowserProps> = ({
  catalog,
  installedModels,
  selectedModelId,
  activeDownloads,
  onDownloadCatalog,
  onDownloadCustom,
  onSelectModel,
  onSearchHfRepo,
  hfRepoInfo,
  hfSearching,
  clearHfSearch,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [quantFilter, setQuantFilter] = useState("all");
  const [hfInput, setHfInput] = useState("");
  const [downloadingIds, setDownloadingIds] = useState<Record<string, boolean>>({});

  const isModelInstalled = (filename: string) => {
    return installedModels.some(
      (m) => m.filename.toLowerCase() === filename.toLowerCase()
    );
  };

  const getInstalledModel = (filename: string) => {
    return installedModels.find(
      (m) => m.filename.toLowerCase() === filename.toLowerCase()
    );
  };

  const getActiveDownload = (filename: string) => {
    return activeDownloads.find(
      (d) =>
        d.filename.toLowerCase() === filename.toLowerCase() &&
        (d.status === "downloading" || d.status === "verifying" || d.status === "queued")
    );
  };

  const handleDownload = async (model: CatalogModel) => {
    try {
      setDownloadingIds((prev) => ({ ...prev, [model.id]: true }));
      await onDownloadCatalog(model);
    } finally {
      setDownloadingIds((prev) => ({ ...prev, [model.id]: false }));
    }
  };

  const handleDownloadHfFile = async (
    repoId: string,
    file: { filename: string; download_url: string; size_bytes: number; sha256?: string }
  ) => {
    const id = `hf_${repoId.replace(/[^a-zA-Z0-9]/g, "_")}_${file.filename.replace(/[^a-zA-Z0-9]/g, "_")}`;
    try {
      setDownloadingIds((prev) => ({ ...prev, [id]: true }));
      await onDownloadCustom({
        modelId: id,
        filename: file.filename,
        sourceUrl: file.download_url,
        repoId,
        expectedSha256: file.sha256,
      });
    } finally {
      setDownloadingIds((prev) => ({ ...prev, [id]: false }));
    }
  };

  const filteredCatalog = catalog.filter((item) => {
    const matchesSearch =
      item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.publisher.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.architecture.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesQuant =
      quantFilter === "all" ||
      item.quantization.toLowerCase() === quantFilter.toLowerCase();

    return matchesSearch && matchesQuant;
  });

  const formatSize = (bytes: number) => {
    if (!bytes || bytes === 0) return "Unknown size";
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Search & Quantization Filter Bar */}
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
        <div style={{ position: "relative", flex: 1, minWidth: 260, display: "flex", alignItems: "center" }}>
          <Search size={15} style={{ position: "absolute", left: 10, color: "var(--color-text-3)" }} />
          <input
            id="model-catalog-search"
            type="text"
            placeholder="Search verified models by name, architecture, publisher..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%",
              padding: "7px 12px 7px 34px",
              fontSize: 13,
              background: "var(--color-surface-subtle)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--color-text)",
              outline: "none",
              fontFamily: "var(--font-sans)",
            }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11.5, color: "var(--color-text-3)", fontWeight: 500 }}>Quantization:</span>
          <select
            id="model-quant-filter"
            value={quantFilter}
            onChange={(e) => setQuantFilter(e.target.value)}
            style={{
              padding: "6px 12px",
              fontSize: 12,
              background: "var(--color-surface-subtle)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--color-text)",
              outline: "none",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            <option value="all">All Quantizations</option>
            <option value="q4_k_m">Q4_K_M (Recommended)</option>
            <option value="q8_0">Q8_0 (High Precision)</option>
          </select>
        </div>
      </div>

      {/* Curated Models Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 14 }}>
        {filteredCatalog.map((model) => {
          const installed = isModelInstalled(model.filename);
          const installedModel = getInstalledModel(model.filename);
          const isCurrentlyActive = installedModel && installedModel.id === selectedModelId;
          const activeDl = getActiveDownload(model.filename);
          const isBusy = downloadingIds[model.id] || !!activeDl;

          return (
            <div
              key={model.id}
              className="card"
              style={{
                padding: "16px",
                background: "var(--color-surface)",
                border: isCurrentlyActive
                  ? "1px solid var(--color-accent)"
                  : "1px solid var(--color-border)",
                borderRadius: "var(--radius)",
                boxShadow: isCurrentlyActive
                  ? "0 2px 8px rgba(27, 94, 73, 0.08)"
                  : "0 1px 3px rgba(32, 40, 33, 0.04)",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: 12,
                transition: "border-color var(--dur-fast), box-shadow var(--dur-fast)",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text)", margin: 0 }}>
                        {model.name}
                      </h3>
                      {model.expected_sha256 && (
                        <span
                          title="Verified publisher checksum"
                          className="badge badge-ok"
                          style={{ fontSize: 10.5 }}
                        >
                          <ShieldCheck size={11} />
                          <span>Official</span>
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--color-text-3)", display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                      <span>{model.publisher}</span>
                      <span>·</span>
                      <a
                        href={`https://huggingface.co/${model.repo_id}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: "var(--color-accent)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3 }}
                        title="View Hugging Face Repository"
                      >
                        HF Repo <ExternalLink size={10} />
                      </a>
                    </div>
                  </div>

                  <span
                    className="mono"
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "2px 7px",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--color-surface-subtle)",
                      border: "1px solid var(--color-border)",
                      color: "var(--color-text-2)",
                      flexShrink: 0,
                    }}
                  >
                    {model.quantization}
                  </span>
                </div>

                <p style={{ fontSize: 12.5, color: "var(--color-text-2)", lineHeight: 1.5, margin: "6px 0 10px" }}>
                  {model.description}
                </p>

                {/* Technical Specs Tags */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: 8,
                    padding: "8px 12px",
                    background: "var(--color-surface-subtle)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 11.5,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--color-text-2)" }} title="File Size">
                    <FileCode size={13} style={{ color: "var(--color-text-3)", flexShrink: 0 }} />
                    <span className="mono" style={{ fontWeight: 600, color: "var(--color-text)" }}>{formatSize(model.file_size_bytes)}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--color-text-2)" }} title="Architecture">
                    <Cpu size={13} style={{ color: "var(--color-text-3)", flexShrink: 0 }} />
                    <span className="mono" style={{ fontWeight: 500, color: "var(--color-text)", textTransform: "capitalize" }}>{model.architecture}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--color-text-2)" }} title="Context Length">
                    <Layers size={13} style={{ color: "var(--color-text-3)", flexShrink: 0 }} />
                    <span className="mono" style={{ fontWeight: 500, color: "var(--color-text)" }}>{(model.context_length / 1024).toFixed(0)}k ctx</span>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, color: "var(--color-text-3)", marginTop: 8 }}>
                  <span>License: {model.license}</span>
                  <span>Min RAM: {model.min_ram_gb} GB</span>
                </div>
              </div>

              {/* Action Button Footer */}
              <div style={{ paddingTop: 10, borderTop: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                {installed ? (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                    {isCurrentlyActive ? (
                      <span className="badge badge-ok" style={{ fontSize: 11.5, padding: "4px 8px" }}>
                        <CheckCircle size={13} />
                        <span>Active for Inference</span>
                      </span>
                    ) : (
                      <>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--color-ok)", fontWeight: 500 }}>
                          <CheckCircle size={14} />
                          <span>Installed &amp; Ready</span>
                        </span>
                        {installedModel && onSelectModel && (
                          <button
                            id={`select-catalog-${model.id}`}
                            onClick={() => onSelectModel(installedModel.id)}
                            className="btn-primary"
                            style={{ padding: "6px 14px", fontSize: 12, marginLeft: "auto" }}
                            title={`Switch to ${model.name} for inference`}
                          >
                            <ArrowRightLeft size={13} />
                            <span>Switch to this Model</span>
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ) : activeDl ? (
                  <div style={{ width: "100%" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--color-accent)", marginBottom: 4 }}>
                      <span>{activeDl.status === "verifying" ? "Verifying digest…" : "Downloading…"}</span>
                      {activeDl.total_bytes > 0 && (
                        <span>
                          {((activeDl.downloaded_bytes / activeDl.total_bytes) * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                    <div style={{ width: "100%", height: 6, background: "var(--color-surface-sunken)", borderRadius: 99, overflow: "hidden" }}>
                      <div
                        style={{
                          height: "100%",
                          background: "var(--color-accent)",
                          width: `${activeDl.total_bytes > 0 ? (activeDl.downloaded_bytes / activeDl.total_bytes) * 100 : 20}%`,
                          transition: "width 0.3s ease",
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", width: "100%" }}>
                    <button
                      id={`download-model-${model.id}`}
                      onClick={() => handleDownload(model)}
                      disabled={isBusy}
                      className="btn-primary"
                      style={{ padding: "6px 14px", fontSize: 12, marginLeft: "auto" }}
                    >
                      {isBusy ? (
                        <>
                          <Loader2 size={13} className="animate-spin" />
                          <span>Starting…</span>
                        </>
                      ) : (
                        <>
                          <Download size={13} />
                          <span>Download ({formatSize(model.file_size_bytes)})</span>
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Hugging Face Custom Repository Discovery */}
      <div
        className="card"
        style={{
          padding: "20px",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius)",
          marginTop: 16,
        }}
      >
        <div style={{ marginBottom: 14 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text)", display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
            <Compass size={17} style={{ color: "var(--color-accent)" }} />
            <span>Explore Any Hugging Face GGUF Repository</span>
          </h3>
          <p style={{ fontSize: 12.5, color: "var(--color-text-2)", marginTop: 4 }}>
            Enter a repository ID to inspect compatible GGUF files directly from Hugging Face without leaving Swarm.
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <input
            id="hf-repo-input"
            type="text"
            placeholder="e.g. Qwen/Qwen2.5-0.5B-Instruct-GGUF or bartowski/Llama-3.2-1B-Instruct-GGUF"
            value={hfInput}
            onChange={(e) => setHfInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hfInput.trim()) {
                onSearchHfRepo(hfInput.trim());
              }
            }}
            style={{
              flex: 1,
              minWidth: 280,
              padding: "7px 12px",
              fontSize: 12.5,
              background: "var(--color-surface-subtle)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--color-text)",
              fontFamily: "var(--font-mono)",
              outline: "none",
            }}
          />
          <button
            id="hf-repo-search-btn"
            onClick={() => onSearchHfRepo(hfInput.trim())}
            disabled={hfSearching || !hfInput.trim()}
            className="btn-ghost"
            style={{ padding: "7px 14px", fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            {hfSearching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            <span>Inspect Repo</span>
          </button>
          {hfRepoInfo && (
            <button
              onClick={clearHfSearch}
              className="btn-ghost"
              style={{ padding: "7px 12px", fontSize: 12.5 }}
            >
              Clear
            </button>
          )}
        </div>

        {/* HF Repo Query Results */}
        {hfRepoInfo && (
          <div
            style={{
              marginTop: 12,
              padding: 14,
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface-subtle)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid var(--color-border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text)" }}>{hfRepoInfo.repo_id}</span>
                {hfRepoInfo.license && (
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 7px",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--color-surface)",
                      border: "1px solid var(--color-border)",
                      color: "var(--color-text-3)",
                    }}
                  >
                    License: {hfRepoInfo.license}
                  </span>
                )}
              </div>
              <a
                href={`https://huggingface.co/${hfRepoInfo.repo_id}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, color: "var(--color-accent)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <span>Open on Hugging Face</span>
                <ExternalLink size={12} />
              </a>
            </div>

            {hfRepoInfo.error ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "10px 12px",
                  background: "var(--color-warn-bg)",
                  border: "1px solid rgba(154, 103, 0, 0.25)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--color-warn)",
                  fontSize: 12,
                }}
              >
                <AlertCircle size={15} style={{ marginTop: 2, flexShrink: 0 }} />
                <div>
                  <strong style={{ display: "block", marginBottom: 2 }}>Repository Notice</strong>
                  <span>{hfRepoInfo.error}</span>
                  {hfRepoInfo.is_gated && (
                    <div style={{ marginTop: 6, fontSize: 11.5 }}>
                      Gated or access-controlled models require publisher terms acceptance. Please visit the authentic repository page to review rights and access agreements.
                    </div>
                  )}
                </div>
              </div>
            ) : hfRepoInfo.files.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--color-text-3)", padding: "8px 0" }}>
                No GGUF model files found in this repository. Ensure the repository contains quantized .gguf weights.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontSize: 11.5, color: "var(--color-text-3)", fontWeight: 500 }}>
                  Discovered {hfRepoInfo.files.length} GGUF Quantization Files:
                </span>
                <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, paddingRight: 4 }}>
                  {hfRepoInfo.files.map((file) => {
                    const installed = isModelInstalled(file.filename);
                    const activeDl = getActiveDownload(file.filename);
                    const fileId = `hf_${hfRepoInfo.repo_id.replace(/[^a-zA-Z0-9]/g, "_")}_${file.filename.replace(/[^a-zA-Z0-9]/g, "_")}`;
                    const isBusy = downloadingIds[fileId] || !!activeDl;

                    return (
                      <div
                        key={file.filename}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "8px 12px",
                          background: "var(--color-surface)",
                          borderRadius: "var(--radius-sm)",
                          border: "1px solid var(--color-border)",
                          fontSize: 12.5,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden", marginRight: 8 }}>
                          <span className="mono" style={{ fontWeight: 500, color: "var(--color-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {file.filename}
                          </span>
                          {file.quantization && (
                            <span
                              className="mono"
                              style={{
                                fontSize: 10.5,
                                padding: "1px 6px",
                                borderRadius: "var(--radius-sm)",
                                background: "var(--color-surface-sunken)",
                                color: "var(--color-text-2)",
                                flexShrink: 0,
                              }}
                            >
                              {file.quantization}
                            </span>
                          )}
                          <span style={{ fontSize: 11.5, color: "var(--color-text-3)", flexShrink: 0 }}>
                            {formatSize(file.size_bytes)}
                          </span>
                        </div>

                        {installed ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "var(--color-ok)", fontWeight: 500, flexShrink: 0 }}>
                            <CheckCircle size={13} />
                            <span>Installed</span>
                          </span>
                        ) : activeDl ? (
                          <span className="mono" style={{ fontSize: 11.5, color: "var(--color-accent)", flexShrink: 0 }}>
                            Downloading…
                          </span>
                        ) : (
                          <button
                            onClick={() => handleDownloadHfFile(hfRepoInfo.repo_id, file)}
                            disabled={isBusy}
                            className="btn-primary"
                            style={{ padding: "4px 10px", fontSize: 11.5, flexShrink: 0 }}
                          >
                            <Download size={12} />
                            <span>Download</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
