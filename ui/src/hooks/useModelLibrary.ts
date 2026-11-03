import { useState, useEffect, useCallback, useRef } from "react";
import { modelsApi } from "../lib/modelsApi";
import type {
  ModelLibraryState,
  CatalogModel,
  HuggingFaceRepoInfo,
  ModelSelectResult,
} from "../lib/modelsApi";

export function useModelLibrary() {
  const [libraryState, setLibraryState] = useState<ModelLibraryState | null>(null);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Hugging Face repo lookup state
  const [hfSearchRepo, setHfSearchRepo] = useState<string>("");
  const [hfRepoInfo, setHfRepoInfo] = useState<HuggingFaceRepoInfo | null>(null);
  const [hfSearching, setHfSearching] = useState<boolean>(false);

  // Modal state when engine is running and requires restart
  const [pendingModelSelect, setPendingModelSelect] = useState<{
    modelId: string;
    modelName: string;
  } | null>(null);

  const isMounted = useRef(true);

  const fetchLibrary = useCallback(async () => {
    try {
      const state = await modelsApi.getLibrary();
      if (isMounted.current) {
        setLibraryState(state);
      }
      return state;
    } catch (err: unknown) {
      if (isMounted.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return null;
    }
  }, []);

  const fetchCatalog = useCallback(async () => {
    try {
      const cat = await modelsApi.getCatalog();
      if (isMounted.current) {
        setCatalog(cat);
      }
    } catch (err: unknown) {
      console.warn("Failed to fetch catalog:", err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    isMounted.current = true;
    let timer: NodeJS.Timeout;

    const init = async () => {
      setIsLoading(true);
      await Promise.all([fetchLibrary(), fetchCatalog()]);
      if (isMounted.current) {
        setIsLoading(false);
      }
    };
    init();

    // Polling: fast (500ms) when downloading, standard (2500ms) otherwise
    const poll = async () => {
      const state = await fetchLibrary();
      const hasActive = state?.active_downloads.some(
        (t) => t.status === "downloading" || t.status === "verifying" || t.status === "queued"
      );
      const interval = hasActive ? 500 : 2500;
      if (isMounted.current) {
        timer = setTimeout(poll, interval);
      }
    };
    timer = setTimeout(poll, 1500);

    return () => {
      isMounted.current = false;
      clearTimeout(timer);
    };
  }, [fetchLibrary, fetchCatalog]);

  const startDownloadCatalog = async (item: CatalogModel) => {
    try {
      setError(null);
      await modelsApi.startDownload({
        modelId: item.id,
        filename: item.filename,
        sourceUrl: item.download_url,
        repoId: item.repo_id,
        expectedSha256: item.expected_sha256,
      });
      await fetchLibrary();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  };

  const startDownloadCustom = async (params: {
    modelId: string;
    filename: string;
    sourceUrl: string;
    repoId?: string;
    expectedSha256?: string;
  }) => {
    try {
      setError(null);
      await modelsApi.startDownload(params);
      await fetchLibrary();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  };

  const cancelDownload = async (taskId: string) => {
    try {
      await modelsApi.cancelDownload(taskId);
      await fetchLibrary();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const clearCompleted = async () => {
    try {
      await modelsApi.clearDownloads();
      await fetchLibrary();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const selectModel = async (modelId: string, forceRestart: boolean = false): Promise<ModelSelectResult> => {
    try {
      setError(null);
      // Optimistic update of local library state so UI reacts instantly
      const targetModel = libraryState?.installed_models.find((m) => m.id === modelId);
      if (targetModel) {
        setLibraryState((prev) => prev ? {
          ...prev,
          selected_model_id: modelId,
          selected_model_path: targetModel.path,
        } : prev);
      }

      const res = await modelsApi.selectModel(modelId, forceRestart);
      if (res.requires_restart && !forceRestart) {
        // Rollback optimistic update if restart confirmation is required
        await fetchLibrary();
        const found = libraryState?.installed_models.find((m) => m.id === modelId);
        setPendingModelSelect({
          modelId,
          modelName: found ? found.name : modelId,
        });
      } else {
        setPendingModelSelect(null);
        const updatedState = await fetchLibrary();
        const selected = updatedState?.installed_models.find((m) => m.id === modelId) || res.model || targetModel;
        if (selected) {
          localStorage.setItem("swarm_active_model_path", selected.path);
          localStorage.setItem("swarm_active_model_name", selected.name);
          if (selected.gguf?.context_length) {
            localStorage.setItem("swarm_active_model_ctx", String(selected.gguf.context_length));
          }
          window.dispatchEvent(new CustomEvent("swarm-model-changed", { detail: selected }));
        }
      }
      return res;
    } catch (err: unknown) {
      await fetchLibrary();
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  };

  // Handle cross-component model switch requests (e.g. from TopBar dropdown)
  useEffect(() => {
    const handleSwitchReq = (e: Event) => {
      const modelId = (e as CustomEvent).detail;
      if (modelId) {
        selectModel(modelId, false).catch(() => {});
      }
    };
    window.addEventListener("swarm-request-model-switch", handleSwitchReq);
    return () => {
      window.removeEventListener("swarm-request-model-switch", handleSwitchReq);
    };
  }, [selectModel]);

  const deleteModel = async (modelId: string) => {
    try {
      setError(null);
      await modelsApi.deleteModel(modelId);
      await fetchLibrary();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  };

  const rescan = async () => {
    try {
      setIsLoading(true);
      const state = await modelsApi.rescan();
      setLibraryState(state);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const searchHfRepo = async (repoId: string) => {
    if (!repoId.trim()) return;
    setHfSearching(true);
    setHfSearchRepo(repoId.trim());
    try {
      const info = await modelsApi.queryHfRepo(repoId.trim());
      setHfRepoInfo(info);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setHfSearching(false);
    }
  };

  const verifyChecksum = async (modelId: string) => {
    try {
      const res = await modelsApi.verifyModelChecksum(modelId);
      await fetchLibrary();
      return res;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  };

  return {
    libraryState,
    catalog,
    isLoading,
    error,
    clearError: () => setError(null),
    startDownloadCatalog,
    startDownloadCustom,
    cancelDownload,
    clearCompleted,
    selectModel,
    deleteModel,
    rescan,
    searchHfRepo,
    hfSearchRepo,
    hfRepoInfo,
    hfSearching,
    clearHfSearch: () => {
      setHfRepoInfo(null);
      setHfSearchRepo("");
    },
    verifyChecksum,
    pendingModelSelect,
    dismissPendingSelect: () => setPendingModelSelect(null),
    confirmPendingSelectRestart: async () => {
      if (pendingModelSelect) {
        await selectModel(pendingModelSelect.modelId, true);
      }
    },
  };
}
