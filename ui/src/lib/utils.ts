import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/** Format bytes to a human-readable string like "1.6 GB" */
export function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Format milliseconds to a readable string like "1.23 s" or "321 ms" */
export function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

/** Format a token/s rate */
export function fmtTps(tps: number): string {
  if (typeof tps !== "number" || !Number.isFinite(tps) || tps <= 0) {
    return "N/A tok/s";
  }
  return `${tps.toFixed(1)} tok/s`;
}

/** Convert a WorkerState to a visual status */
export function workerStateVariant(state: string): "ok" | "busy" | "error" | "idle" {
  if (state === "READY") return "ok";
  if (state === "BUSY") return "busy";
  if (state === "FAILED" || state === "UNAVAILABLE") return "error";
  return "idle";
}

/** Convert a backend type to a display label */
export function backendTypeLabel(type: string): string {
  switch (type) {
    case "cpu": return "CPU";
    case "local_cuda": return "CUDA";
    case "loopback_rpc": return "RPC (loopback)";
    case "remote_rpc": return "RPC (remote)";
    default: return type.toUpperCase();
  }
}

/** Shorten a model path for display */
export function shortModelPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}

/** Format a friendly short model name like "Qwen 2.5 3B" from model path or filename */
export function shortModelName(path: string): string {
  if (!path) return "—";
  const filename = shortModelPath(path).toLowerCase();

  if (filename.includes("qwen2.5-3b") || filename.includes("qwen 2.5 3b")) return "Qwen 2.5 3B";
  if (filename.includes("qwen2.5-0.5b") || filename.includes("qwen 2.5 0.5b")) return "Qwen 2.5 0.5B";
  if (filename.includes("qwen2.5-1.5b") || filename.includes("qwen 2.5 1.5b")) return "Qwen 2.5 1.5B";
  if (filename.includes("qwen2.5-7b") || filename.includes("qwen 2.5 7b")) return "Qwen 2.5 7B";
  if (filename.includes("qwen2.5-14b") || filename.includes("qwen 2.5 14b")) return "Qwen 2.5 14B";
  if (filename.includes("smollm2-135m") || filename.includes("smollm2 135m")) return "SmolLM2 135M";
  if (filename.includes("smollm2-360m") || filename.includes("smollm2 360m")) return "SmolLM2 360M";
  if (filename.includes("smollm2-1.7b") || filename.includes("smollm2 1.7b")) return "SmolLM2 1.7B";
  if (filename.includes("llama-3.2-1b") || filename.includes("llama 3.2 1b")) return "Llama 3.2 1B";
  if (filename.includes("llama-3.2-3b") || filename.includes("llama 3.2 3b")) return "Llama 3.2 3B";
  if (filename.includes("llama-3-8b") || filename.includes("llama-3.1-8b")) return "Llama 3.1 8B";
  if (filename.includes("phi-3.5-mini") || filename.includes("phi 3.5 mini")) return "Phi-3.5 Mini";
  if (filename.includes("mistral-7b")) return "Mistral 7B";

  // Generic extraction: model-name-sizeb
  const match = filename.match(/^([a-z0-9]+)(?:[-_ ]([0-9]+(?:\.[0-9]+)?[mb]))?/i);
  if (match && match[1]) {
    const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    const size = match[2] ? ` ${match[2].toUpperCase()}` : "";
    return `${name}${size}`;
  }

  const raw = shortModelPath(path).replace(/\.gguf$/i, "").replace(/[-_]/g, " ");
  return raw.length > 20 ? `${raw.slice(0, 18)}…` : raw;
}

/** Formats a clean, professional model title with instruction/quantization details */
export function friendlyModelTitle(path: string): string {
  if (!path) return "No Model Selected";
  const filename = shortModelPath(path);
  const lower = filename.toLowerCase();

  const name = shortModelName(path);
  const tags: string[] = [];

  if (lower.includes("instruct")) tags.push("Instruct");
  if (lower.includes("q4_k_m")) tags.push("Q4_K_M");
  else if (lower.includes("q4_0")) tags.push("Q4_0");
  else if (lower.includes("q8_0")) tags.push("Q8_0");
  else if (lower.includes("f16")) tags.push("F16");

  if (tags.length > 0) {
    return `${name} (${tags.join(" · ")})`;
  }
  return name;
}

