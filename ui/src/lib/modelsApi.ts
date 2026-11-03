import { invoke } from "@tauri-apps/api/core";

export interface DownloadTask {
  id: string;
  model_id: string;
  filename: string;
  source_url: string;
  repo_id?: string;
  destination_path: string;
  temp_path: string;
  total_bytes: number;
  downloaded_bytes: number;
  status: "queued" | "downloading" | "paused" | "verifying" | "completed" | "failed" | "cancelled";
  speed_bytes_per_sec: number;
  eta_seconds?: number;
  error_message?: string;
  expected_sha256?: string;
  computed_sha256?: string;
  started_at_ms: number;
  updated_at_ms: number;
  can_resume: boolean;
}

export interface GgufMetadata {
  architecture: string;
  name?: string;
  file_type_description?: string;
  quantization?: string;
  context_length?: number;
  block_count?: number;
  embedding_length?: number;
  tensor_count: number;
  kv_count: number;
}

export interface InstalledModel {
  id: string;
  name: string;
  filename: string;
  path: string;
  size_bytes: number;
  sha256?: string;
  is_official_verified: boolean;
  source_repo?: string;
  installed_at_ms: number;
  gguf?: GgufMetadata;
}

export interface CatalogModel {
  id: string;
  name: string;
  publisher: string;
  repo_id: string;
  filename: string;
  download_url: string;
  revision: string;
  file_size_bytes: number;
  quantization: string;
  architecture: string;
  context_length: number;
  license: string;
  description: string;
  expected_sha256?: string;
  is_curated: boolean;
  is_gated: boolean;
  min_ram_gb: number;
  min_vram_gb: number;
}

export interface ModelLibraryState {
  models_directory: string;
  selected_model_id?: string;
  selected_model_path?: string;
  installed_models: InstalledModel[];
  active_downloads: DownloadTask[];
}

export interface HuggingFaceFileEntry {
  filename: string;
  size_bytes: number;
  download_url: string;
  sha256?: string;
  quantization?: string;
}

export interface HuggingFaceRepoInfo {
  repo_id: string;
  files: HuggingFaceFileEntry[];
  is_gated: boolean;
  license?: string;
  error?: string;
}

export interface ModelSelectResult {
  success: boolean;
  requires_restart: boolean;
  message: string;
  model?: InstalledModel;
}

export interface ChecksumVerifyResult {
  success: boolean;
  model_id: string;
  computed_sha256: string;
  matches_expected?: boolean;
  message: string;
}

export const modelsApi = {
  getLibrary: async (): Promise<ModelLibraryState> => {
    return await invoke<ModelLibraryState>("models_get_library");
  },

  getCatalog: async (): Promise<CatalogModel[]> => {
    return await invoke<CatalogModel[]>("models_get_catalog");
  },

  startDownload: async (params: {
    modelId: string;
    filename: string;
    sourceUrl: string;
    repoId?: string;
    expectedSha256?: string;
  }): Promise<string> => {
    return await invoke<string>("models_start_download", {
      modelId: params.modelId,
      filename: params.filename,
      sourceUrl: params.sourceUrl,
      repoId: params.repoId || null,
      expectedSha256: params.expectedSha256 || null,
    });
  },

  cancelDownload: async (taskId: string): Promise<void> => {
    return await invoke<void>("models_cancel_download", { taskId });
  },

  clearDownloads: async (): Promise<void> => {
    return await invoke<void>("models_clear_downloads");
  },

  deleteModel: async (modelId: string): Promise<void> => {
    return await invoke<void>("models_delete_model", { modelId });
  },

  selectModel: async (modelId: string, restartEngineIfRunning?: boolean): Promise<ModelSelectResult> => {
    return await invoke<ModelSelectResult>("models_select_model", {
      modelId,
      restartEngineIfRunning: restartEngineIfRunning || false,
    });
  },

  rescan: async (): Promise<ModelLibraryState> => {
    return await invoke<ModelLibraryState>("models_rescan");
  },

  setDirectory: async (path: string): Promise<ModelLibraryState> => {
    return await invoke<ModelLibraryState>("models_set_directory", { path });
  },

  queryHfRepo: async (repoId: string): Promise<HuggingFaceRepoInfo> => {
    return await invoke<HuggingFaceRepoInfo>("models_query_hf_repo", { repoId });
  },

  verifyModelChecksum: async (modelId: string): Promise<ChecksumVerifyResult> => {
    return await invoke<ChecksumVerifyResult>("models_verify_model_checksum", { modelId });
  },
};
