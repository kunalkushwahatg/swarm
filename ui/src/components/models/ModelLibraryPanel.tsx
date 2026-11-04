import { useEffect, useState } from "react";
import {
  Compass,
  HardDrive,
  DownloadCloud,
  RotateCw,
  AlertCircle,
} from "lucide-react";
import { useModelLibrary } from "../../hooks/useModelLibrary";
import { CatalogBrowser } from "./CatalogBrowser";
import { InstalledModelsList } from "./InstalledModelsList";
import { DownloadQueue } from "./DownloadQueue";
import { ModelSwitchModal } from "./ModelSwitchModal";

type LibraryTab = "browse" | "installed" | "downloads";

export const ModelLibraryPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<LibraryTab>("browse");
  const {
    libraryState,
    catalog,
    isLoading,
    error,
    clearError,
    startDownloadCatalog,
    startDownloadCustom,
    cancelDownload,
    clearCompleted,
    selectModel,
    deleteModel,
    rescan,
    searchHfRepo,
    hfRepoInfo,
    hfSearching,
    clearHfSearch,
    verifyChecksum,
    refreshLibrary,
    pendingModelSelect,
    dismissPendingSelect,
    confirmPendingSelectRestart,
  } = useModelLibrary();

  useEffect(() => {
    const handleRefresh = () => {
      void refreshLibrary();
    };
    window.addEventListener("swarm-model-library-refresh", handleRefresh);
    return () => window.removeEventListener("swarm-model-library-refresh", handleRefresh);
  }, [refreshLibrary]);

  const installedCount = libraryState?.installed_models.length || 0;
  const activeDownloads = libraryState?.active_downloads || [];
  const activeDlCount = activeDownloads.filter(
    (d) => d.status === "downloading" || d.status === "verifying" || d.status === "queued"
  ).length;

  const selectedModel = libraryState?.installed_models.find(
    (m) => m.id === libraryState.selected_model_id
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, width: "100%", maxWidth: 1200, margin: "0 auto" }}>
      {/* Top Header & Overview */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 className="page-title">Model Library</h1>
          <p className="page-subtitle">
            Download and manage AI models for local inference.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {selectedModel && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 12px",
                borderRadius: "var(--radius)",
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
              }}
              title={`Active Model: ${selectedModel.name}\n${selectedModel.path}`}
            >
              <span className="dot dot-ok" />
              <span style={{ fontSize: 11.5, color: "var(--color-text-3)", fontWeight: 500 }}>Active:</span>
              <strong className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-accent)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selectedModel.name}
              </strong>
            </div>
          )}

          <button
            id="rescan-models-btn"
            type="button"
            onClick={rescan}
            disabled={isLoading}
            className="btn-ghost"
            style={{ padding: "6px 12px", fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}
            title="Rescan model directory on disk"
          >
            <RotateCw size={13} className={isLoading ? "animate-spin" : ""} />
            <span>Rescan</span>
          </button>
        </div>
      </div>

      {/* Global Error Banner */}
      {error && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 14px",
            background: "var(--color-error-bg)",
            border: "1px solid rgba(185, 28, 28, 0.25)",
            borderRadius: "var(--radius)",
            color: "var(--color-error)",
            fontSize: 12.5,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <AlertCircle size={16} style={{ marginTop: 2, flexShrink: 0 }} />
            <span>{error}</span>
          </div>
          <button
            onClick={clearError}
            style={{ background: "none", border: "none", color: "var(--color-error)", fontSize: 11.5, fontWeight: 600, cursor: "pointer", textDecoration: "underline" }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Tabs Navigation (Segmented Pill Bar) */}
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: "var(--color-surface-subtle)",
          padding: 3,
          borderRadius: "var(--radius)",
          border: "1px solid var(--color-border)",
          gap: 2,
          alignSelf: "flex-start",
        }}
      >
        <button
          id="tab-browse-models"
          type="button"
          onClick={() => setActiveTab("browse")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 14px",
            fontSize: 12.5,
            fontWeight: activeTab === "browse" ? 600 : 500,
            borderRadius: "var(--radius-sm)",
            border: "none",
            cursor: "pointer",
            background: activeTab === "browse" ? "var(--color-surface)" : "transparent",
            color: activeTab === "browse" ? "var(--color-text)" : "var(--color-text-2)",
            boxShadow: activeTab === "browse" ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
            transition: "all var(--dur-fast)",
          }}
        >
          <Compass size={14} style={{ color: activeTab === "browse" ? "var(--color-accent)" : "inherit" }} />
          <span>Browse Catalog</span>
        </button>

        <button
          id="tab-installed-models"
          type="button"
          onClick={() => setActiveTab("installed")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 14px",
            fontSize: 12.5,
            fontWeight: activeTab === "installed" ? 600 : 500,
            borderRadius: "var(--radius-sm)",
            border: "none",
            cursor: "pointer",
            background: activeTab === "installed" ? "var(--color-surface)" : "transparent",
            color: activeTab === "installed" ? "var(--color-text)" : "var(--color-text-2)",
            boxShadow: activeTab === "installed" ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
            transition: "all var(--dur-fast)",
          }}
        >
          <HardDrive size={14} style={{ color: activeTab === "installed" ? "var(--color-accent)" : "inherit" }} />
          <span>Installed Models</span>
          <span
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "1px 6px",
              borderRadius: 99,
              background: activeTab === "installed" ? "var(--color-surface-subtle)" : "var(--color-border)",
              color: "var(--color-text)",
            }}
          >
            {installedCount}
          </span>
        </button>

        <button
          id="tab-downloads"
          type="button"
          onClick={() => setActiveTab("downloads")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 14px",
            fontSize: 12.5,
            fontWeight: activeTab === "downloads" ? 600 : 500,
            borderRadius: "var(--radius-sm)",
            border: "none",
            cursor: "pointer",
            background: activeTab === "downloads" ? "var(--color-surface)" : "transparent",
            color: activeTab === "downloads" ? "var(--color-text)" : "var(--color-text-2)",
            boxShadow: activeTab === "downloads" ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
            transition: "all var(--dur-fast)",
          }}
        >
          <DownloadCloud size={14} style={{ color: activeTab === "downloads" ? "var(--color-accent)" : "inherit" }} />
          <span>Downloads</span>
          {activeDlCount > 0 && (
            <span
              className="mono"
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 99,
                background: "var(--color-accent)",
                color: "var(--color-accent-fg)",
              }}
            >
              {activeDlCount}
            </span>
          )}
        </button>
      </div>

      {/* Tab Panels */}
      <div style={{ width: "100%" }}>
        {activeTab === "browse" && (
          <CatalogBrowser
            catalog={catalog}
            installedModels={libraryState?.installed_models || []}
            selectedModelId={libraryState?.selected_model_id}
            activeDownloads={activeDownloads}
            onDownloadCatalog={startDownloadCatalog}
            onDownloadCustom={startDownloadCustom}
            onSelectModel={(id) => selectModel(id, false).then(() => {})}
            onSearchHfRepo={searchHfRepo}
            hfRepoInfo={hfRepoInfo}
            hfSearching={hfSearching}
            clearHfSearch={clearHfSearch}
          />
        )}

        {activeTab === "installed" && (
          <InstalledModelsList
            models={libraryState?.installed_models || []}
            selectedModelId={libraryState?.selected_model_id}
            onSelectModel={(id) => selectModel(id, false).then(() => {})}
            onDeleteModel={deleteModel}
            onVerifyChecksum={verifyChecksum}
            modelsDirectory={libraryState?.models_directory || ""}
            isLoading={isLoading}
          />
        )}

        {activeTab === "downloads" && (
          <DownloadQueue
            tasks={activeDownloads}
            onCancelDownload={cancelDownload}
            onClearCompleted={clearCompleted}
          />
        )}
      </div>

      {/* Model Switch Confirmation Modal */}
      <ModelSwitchModal
        pendingSelect={pendingModelSelect}
        onConfirm={confirmPendingSelectRestart}
        onDismiss={dismissPendingSelect}
      />
    </div>
  );
};
