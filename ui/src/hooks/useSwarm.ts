import { useState, useEffect, useRef, useCallback } from "react";
import type { HealthResponse, BackendsResponse, NodeInventory, SwarmMetrics } from "../types/api";
import { api } from "../lib/api";

// ── health polling ──────────────────────────────────────────────
export function useHealth(intervalMs = 3000) {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [lastKnownData, setLastKnownData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [isOffline, setIsOffline] = useState(false);
  const [lastHealthyTime, setLastHealthyTime] = useState<number | null>(null);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);

  const failureCountRef = useRef(0);
  const pollActiveRef = useRef(true);

  const poll = useCallback(async (signal?: AbortSignal) => {
    // Development/test-only controlled fixtures — strictly disabled in production builds (import.meta.env.DEV === false)
    const isDevEnv = typeof import.meta !== "undefined" && Boolean(import.meta.env?.DEV);
    const isMockOffline = isDevEnv && typeof window !== "undefined" && (window.location.search.includes("mockOffline=true") || window.location.hash.includes("mockOffline=true"));
    if (isMockOffline) {
      if (pollActiveRef.current) {
        failureCountRef.current = 2;
        setConsecutiveFailures(2);
        setIsOffline(true);
        setOfflineSince((prev) => prev ?? (Date.now() - 42000));
        setLastHealthyTime((prev) => prev ?? (Date.now() - 42000));
        setData(null);
        setError("[SIMULATED] NetworkError: Failed to reach coordinator at 127.0.0.1:8080");
        setLoading(false);
      }
      return false;
    }

    try {
      const result = await api.health(signal);
      const isMockWorkerError = isDevEnv && typeof window !== "undefined" && (window.location.search.includes("mockWorkerError=true") || window.location.hash.includes("mockWorkerError=true"));
      if (isMockWorkerError && result && result.workers) {
        result.workers = result.workers.map((w) => ({
          ...w,
          state: "UNAVAILABLE",
          last_error: `[SIMULATED] Connection timed out on TCP socket ${w.host}:${w.port} (WSAETIMEDOUT 10060)`,
        }));
      }

      if (pollActiveRef.current) {
        failureCountRef.current = 0;
        setConsecutiveFailures(0);
        setIsOffline(false);
        setOfflineSince(null);
        setData(result);
        setLastKnownData(result);
        setError(null);
        setLoading(false);
        setLastHealthyTime(Date.now());
      }
      return true;
    } catch (e) {
      if (pollActiveRef.current && (e as Error).name !== "AbortError") {
        failureCountRef.current += 1;
        const count = failureCountRef.current;
        setConsecutiveFailures(count);
        setError((e as Error).message);
        setLoading(false);

        // Only declare offline on at least 2 consecutive failed health checks
        if (count >= 2) {
          setIsOffline(true);
          setOfflineSince((prev) => prev ?? Date.now());
          setData(null);
        }
      }
      return false;
    }
  }, []);

  const refetch = useCallback(() => {
    return poll();
  }, [poll]);

  useEffect(() => {
    pollActiveRef.current = true;
    const controller = new AbortController();

    poll(controller.signal);
    const id = setInterval(() => {
      poll(controller.signal);
    }, intervalMs);

    return () => {
      pollActiveRef.current = false;
      clearInterval(id);
      controller.abort();
    };
  }, [intervalMs, poll]);

  return {
    data,
    lastKnownData,
    error,
    loading,
    consecutiveFailures,
    isOffline,
    lastHealthyTime,
    offlineSince,
    refetch,
  };
}

// ── backends polling ────────────────────────────────────────────
export function useBackends(intervalMs = 5000) {
  const [data, setData] = useState<BackendsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const result = await api.backends(controller.signal);

        // Development/test fixture overrides — strictly disabled in production builds
        const isDevEnv = typeof import.meta !== "undefined" && Boolean(import.meta.env?.DEV);
        if (isDevEnv && typeof window !== "undefined") {
          const hasZeroBuffers = window.location.search.includes("mockZeroBuffers=true") || window.location.hash.includes("mockZeroBuffers=true");
          const hasUnmeasuredBuffers = window.location.search.includes("mockUnmeasuredBuffers=true") || window.location.hash.includes("mockUnmeasuredBuffers=true");
          if (hasZeroBuffers && result && result.backends && result.backends.length > 0) {
            result.backends = result.backends.map((b, i) =>
              i === 0
                ? { ...b, model_buffer_bytes: 0, kv_buffer_bytes: 0, compute_buffer_bytes: 0 }
                : b
            );
          } else if (hasUnmeasuredBuffers && result && result.backends && result.backends.length > 0) {
            result.backends = result.backends.map((b, i) =>
              i === 0
                ? { ...b, compute_buffer_bytes: undefined as unknown as number }
                : b
            );
          }
        }

        if (active) { setData(result); setError(null); setLoading(false); }
      } catch (e) {
        if (active && (e as Error).name !== "AbortError") {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    };

    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      active = false;
      clearInterval(id);
      controller.abort();
    };
  }, [intervalMs]);

  return { data, error, loading };
}

// ── nodes polling ───────────────────────────────────────────────
export function useNodes(intervalMs = 5000) {
  const [data, setData] = useState<NodeInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const result = await api.nodes(controller.signal);
        if (active) { setData(result); setError(null); setLoading(false); }
      } catch (e) {
        if (active && (e as Error).name !== "AbortError") {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    };

    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      active = false;
      clearInterval(id);
      controller.abort();
    };
  }, [intervalMs]);

  return { data, error, loading };
}

// ── metrics polling ─────────────────────────────────────────────
export function useMetrics(intervalMs = 4000) {
  const [data, setData] = useState<SwarmMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const result = await api.metrics(controller.signal);
        if (active) { setData(result); setError(null); setLoading(false); }
      } catch (e) {
        if (active && (e as Error).name !== "AbortError") {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    };

    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      active = false;
      clearInterval(id);
      controller.abort();
    };
  }, [intervalMs]);

  return { data, error, loading };
}

// ── timing telemetry & validation ───────────────────────────────
export interface ValidatedTimings {
  tokens_generated: number;
  tokens_per_sec?: number;
  prompt_eval_ms?: number;
  gen_ms?: number;
  total_ms?: number;
  ttfc_ms?: number;
  completed_at: number;
}

export function isValidTimingNumber(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val) && val >= 0;
}

export function validateTimings(raw: unknown, ttfcMs?: number): ValidatedTimings | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;

  if (!isValidTimingNumber(t.tokens_generated)) {
    return null;
  }

  const tokensGenerated = Math.floor(t.tokens_generated);
  const promptEvalMs = isValidTimingNumber(t.prompt_eval_ms) ? t.prompt_eval_ms : undefined;
  const genMs = isValidTimingNumber(t.gen_ms) ? t.gen_ms : undefined;
  const totalMs = isValidTimingNumber(t.total_ms) ? t.total_ms : undefined;

  let tokensPerSec: number | undefined = undefined;
  if (tokensGenerated === 0) {
    tokensPerSec = undefined;
  } else if (isValidTimingNumber(t.tokens_per_sec) && t.tokens_per_sec > 0) {
    tokensPerSec = t.tokens_per_sec;
  }

  const validTtfc = isValidTimingNumber(ttfcMs) ? ttfcMs : undefined;

  return {
    tokens_generated: tokensGenerated,
    tokens_per_sec: tokensPerSec,
    prompt_eval_ms: promptEvalMs,
    gen_ms: genMs,
    total_ms: totalMs,
    ttfc_ms: validTtfc,
    completed_at: Date.now(),
  };
}

const LATEST_INFERENCE_KEY = "swarm_latest_inference";

export function getLatestInference(): ValidatedTimings | null {
  if (typeof window === "undefined" || !window.sessionStorage) return null;
  try {
    const raw = window.sessionStorage.getItem(LATEST_INFERENCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return validateTimings(parsed, parsed.ttfc_ms);
  } catch {
    return null;
  }
}

export function setLatestInference(timings: ValidatedTimings): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(LATEST_INFERENCE_KEY, JSON.stringify(timings));
    window.dispatchEvent(new CustomEvent("swarm:latest-inference-updated", { detail: timings }));
  } catch {
    // sessionStorage quota or security restriction
  }
}

export function useLatestInference(): ValidatedTimings | null {
  const [inference, setInference] = useState<ValidatedTimings | null>(() => getLatestInference());

  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent<ValidatedTimings>;
      if (custom.detail) {
        setInference(custom.detail);
      } else {
        setInference(getLatestInference());
      }
    };
    window.addEventListener("swarm:latest-inference-updated", handler);
    return () => {
      window.removeEventListener("swarm:latest-inference-updated", handler);
    };
  }, []);

  return inference;
}

// ── chat streaming ──────────────────────────────────────────────
export type GenerationPhase = "idle" | "evaluating" | "streaming" | "completed" | "interrupted" | "error";

export type ChatEntry = {
  id: number;
  role: "user" | "assistant";
  content: string;
  timings?: ValidatedTimings;
  timingsUnavailable?: boolean;
  ttfcMs?: number;
  streaming?: boolean;
  phase?: GenerationPhase;
  error?: string;
  interrupted?: boolean;
};

export function useChat() {
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [generationPhase, setGenerationPhase] = useState<"idle" | "evaluating" | "streaming">("idle");
  const counterRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (content: string, maxTokens = 256) => {
    if (streaming) return;

    const userMsg: ChatEntry = { id: ++counterRef.current, role: "user", content };
    const assistantId = ++counterRef.current;
    const assistantMsg: ChatEntry = {
      id: assistantId,
      role: "assistant",
      content: "",
      streaming: true,
      phase: "evaluating",
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);
    setGenerationPhase("evaluating");

    const tDispatch = performance.now();
    let firstContentReceived = false;
    let recordedTtfc: number | undefined = undefined;
    let timingsReceived = false;

    // Build history for context (last 10 messages)
    const history = [...messages, userMsg].slice(-10).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    abortRef.current = new AbortController();

    // Check dev-only mock flags
    const isDevEnv = typeof import.meta !== "undefined" && Boolean(import.meta.env?.DEV);
    const mockParam = isDevEnv && typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("mockTimings") ||
        (window.location.hash.includes("mockTimings=zero") ? "zero" :
         window.location.hash.includes("mockTimings=captured") ? "captured" :
         window.location.hash.includes("mockTimings=missing") ? "missing" : null)
      : null;

    if (mockParam) {
      // Run controlled simulated streaming for testing without large-model inference
      try {
        await new Promise((r) => setTimeout(r, 120));
        if (abortRef.current.signal.aborted) throw new Error("AbortError");

        if (mockParam === "zero") {
          // Authoritative zero-token response
          timingsReceived = true;
          const zeroTimings = validateTimings({
            tokens_generated: 0,
            tokens_per_sec: 0,
            prompt_eval_ms: 312.4,
            gen_ms: 0,
            total_ms: 312.4,
          });
          if (zeroTimings) {
            setLatestInference(zeroTimings);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, timings: zeroTimings, streaming: false, phase: "completed" }
                  : m
              )
            );
          }
        } else {
          // Stream test words
          const pieces = ["Distributed ", "computing ", "divides ", "tasks ", "across ", "nodes."];
          for (const piece of pieces) {
            if (abortRef.current.signal.aborted) throw new Error("AbortError");
            await new Promise((r) => setTimeout(r, 60));
            if (!firstContentReceived) {
              firstContentReceived = true;
              recordedTtfc = Math.round(performance.now() - tDispatch);
              setGenerationPhase("streaming");
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content + piece, phase: "streaming", ttfcMs: recordedTtfc }
                  : m
              )
            );
          }

          if (mockParam === "captured") {
            timingsReceived = true;
            const captured = validateTimings(
              {
                tokens_generated: 26,
                tokens_per_sec: 3.220761524287329,
                prompt_eval_ms: 6712.5476,
                gen_ms: 8072.625,
                total_ms: 14815.8315,
              },
              recordedTtfc ?? 420
            );
            if (captured) {
              setLatestInference(captured);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, timings: captured, streaming: false, phase: "completed" }
                    : m
                )
              );
            }
          } else if (mockParam === "missing") {
            // Missing timings event
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, timingsUnavailable: true, streaming: false, phase: "completed" }
                  : m
              )
            );
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError" || (e as Error).message === "AbortError") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, streaming: false, interrupted: true, phase: "interrupted" }
                : m
            )
          );
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, streaming: false, error: (e as Error).message, phase: "error" }
                : m
            )
          );
        }
      } finally {
        setStreaming(false);
        setGenerationPhase("idle");
      }
      return;
    }

    try {
      await api.chat(
        { messages: history, max_tokens: maxTokens },
        (delta) => {
          if (!firstContentReceived && delta.length > 0) {
            firstContentReceived = true;
            recordedTtfc = Math.round(performance.now() - tDispatch);
            setGenerationPhase("streaming");
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: m.content + delta,
                    phase: "streaming",
                    ttfcMs: recordedTtfc ?? m.ttfcMs,
                  }
                : m,
            ),
          );
        },
        (rawTimings) => {
          timingsReceived = true;
          const validated = validateTimings(rawTimings, recordedTtfc);
          if (validated) {
            setLatestInference(validated);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      timings: validated,
                      streaming: false,
                      phase: "completed",
                    }
                  : m,
              ),
            );
          } else {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      timingsUnavailable: true,
                      streaming: false,
                      phase: "completed",
                    }
                  : m,
              ),
            );
          }
        },
        (err) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    error: err,
                    streaming: false,
                    phase: "error",
                    interrupted: m.content.trim().length > 0,
                  }
                : m,
            ),
          );
        },
        abortRef.current.signal,
      );

      // Stream completed without authoritative timings event received
      if (!timingsReceived) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId && m.streaming
              ? {
                  ...m,
                  streaming: false,
                  timingsUnavailable: true,
                  phase: "completed",
                }
              : m,
          ),
        );
      }
    } finally {
      setStreaming(false);
      setGenerationPhase("idle");
    }
  }, [messages, streaming]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    setMessages((prev) =>
      prev.map((m) =>
        m.streaming
          ? {
              ...m,
              streaming: false,
              interrupted: true,
              phase: "interrupted",
            }
          : m,
      ),
    );
    setStreaming(false);
    setGenerationPhase("idle");
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    messages,
    streaming,
    generationPhase,
    sendMessage,
    stopStreaming,
    clearMessages,
  };
}
