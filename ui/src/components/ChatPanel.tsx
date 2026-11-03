import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { useChat, type ChatEntry } from "../hooks/useSwarm";
import { useSwarmSession } from "../hooks/useSwarmSession";
import { useSupervisor } from "../hooks/useSupervisor";
import { PlacementRibbon } from "./PlacementRibbon";
import { RpcTelemetryChip, RpcTelemetryPanel } from "./RpcTelemetryPanel";
import { fmtMs, fmtTps, cn, friendlyModelTitle } from "../lib/utils";
import { isAndroid } from "../lib/platform";
import {
  Send,
  Square,
  Trash2,
  AlertCircle,
  AlertTriangle,
  Sparkles,
  SlidersHorizontal,
  Power,
  Play,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

function MessageRow({
  entry,
  onRecoverInterrupted,
}: {
  entry: ChatEntry;
  onRecoverInterrupted?: () => void;
}) {
  const isUser = entry.role === "user";
  const [rpcOpen, setRpcOpen] = useState(false);
  const rpc = entry.timings?.rpc_telemetry;
  const telemetryId = `rpc-telemetry-${rpc?.request_id ?? entry.id}`;

  return (
    <div
      className="animate-fade-in"
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        padding: isUser ? "12px 16px" : "14px 16px",
        borderRadius: "var(--radius)",
        background: isUser ? "var(--color-surface-sunken)" : "transparent",
        border: isUser ? "1px solid var(--color-border)" : "none",
        gap: 6,
      }}
    >
      {/* Sender indicator */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 11.5,
          color: "var(--color-text-2)",
        }}
      >
        <span style={{ fontWeight: 600, color: isUser ? "var(--color-text)" : "var(--color-accent)" }}>
          {isUser ? "You" : "Swarm"}
        </span>
      </div>

      {/* Message content */}
      <div
        style={{
          color: "var(--color-text)",
          fontSize: 13.5,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "var(--font-sans)",
        }}
      >
        {entry.error ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--color-error)" }}>
            <AlertCircle size={14} style={{ flexShrink: 0 }} />
            <span>{entry.error}</span>
          </div>
        ) : (
          <div className={cn(entry.streaming && !entry.content ? "cursor-blink" : entry.streaming ? "cursor-blink" : "")}>
            {entry.content || (entry.streaming ? "..." : "—")}
          </div>
        )}

        {/* Interrupted Stream Notice */}
        {entry.interrupted && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 8,
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              background: "rgba(239, 68, 68, 0.08)",
              border: "1px solid rgba(239, 68, 68, 0.2)",
              color: "var(--color-error)",
              fontSize: 11.5,
              marginTop: 6,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <AlertCircle size={13} style={{ flexShrink: 0 }} />
              <span>Generation interrupted: connection to coordinator lost. Response may be incomplete.</span>
            </div>
            {onRecoverInterrupted && (
              <>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={onRecoverInterrupted}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "4px 10px",
                    minHeight: 32,
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: "var(--color-error)",
                    borderColor: "var(--color-error)",
                  }}
                >
                  <RefreshCw size={12} />
                  <span>{isAndroid ? "Restart on-device engine" : "Restart standalone engine"}</span>
                </button>
                <span style={{ fontSize: 10.5, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                  {isAndroid
                    ? "Restarts local inference without the remote worker. Your last prompt is restored to the composer."
                    : "Unloads the distributed layers and restarts on local CUDA. Your last prompt is restored to the composer."}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Beneath assistant response: Authoritative timing telemetry */}
      {!isUser && !entry.streaming && (
        <div
          style={{
            marginTop: 4,
            paddingTop: 8,
            borderTop: "1px dashed var(--color-border)",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {entry.timings ? (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 6,
                  fontSize: 11.5,
                  color: "var(--color-text-3)",
                }}
              >
                <span className="mono" style={{ fontWeight: 600, color: "var(--color-text)" }}>
                  {entry.timings.tokens_generated} tokens
                </span>
                <span>·</span>
                <span className="mono" style={{ fontWeight: 600, color: "var(--color-accent)" }}>
                  {entry.timings.tokens_per_sec != null ? fmtTps(entry.timings.tokens_per_sec) : "N/A tok/s"}
                </span>
                {entry.timings.total_ms != null && (
                  <>
                    <span>·</span>
                    <span className="mono" style={{ color: "var(--color-text-2)" }}>
                      {fmtMs(entry.timings.total_ms)}
                    </span>
                  </>
                )}
                {entry.timings.ttfc_ms != null && (
                  <>
                    <span>·</span>
                    <span className="mono" style={{ color: "var(--color-text-3)" }} title="Time to first token">
                      TTFT: {fmtMs(entry.timings.ttfc_ms)}
                    </span>
                  </>
                )}
              </div>
              {rpc?.available && (
                <div style={{ display: "flex", flexDirection: "column", marginTop: 3 }}>
                  <RpcTelemetryChip
                    summary={rpc}
                    open={rpcOpen}
                    onToggle={() => setRpcOpen((v) => !v)}
                    controlsId={telemetryId}
                  />
                  {rpcOpen && (
                    <RpcTelemetryPanel
                      summary={rpc}
                      onClose={() => setRpcOpen(false)}
                      id={telemetryId}
                    />
                  )}
                </div>
              )}
            </>
          ) : entry.interrupted ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--color-warn)" }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} />
              <span>Generation stopped · authoritative timings unavailable</span>
            </div>
          ) : entry.error ? null : entry.timingsUnavailable ? (
            <div style={{ fontSize: 11, color: "var(--color-text-3)", fontStyle: "italic" }}>
              Authoritative timings unavailable
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface ChatInputProps {
  onSend: (text: string, maxTokens: number) => void;
  onStop: () => void;
  streaming: boolean;
  isEngineStopped: boolean;
  isStarting: boolean;
  text: string;
  setText: (t: string) => void;
  contextWindow: number;
}

function ChatInput({
  onSend,
  onStop,
  streaming,
  isEngineStopped,
  isStarting,
  text,
  setText,
  contextWindow,
}: ChatInputProps) {
  const [maxTokens, setMaxTokens] = useState(256);
  const [showOptions, setShowOptions] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Dynamic token estimation based on non-empty characters
  const trimmed = text.trim();
  const estimatedTokens = trimmed.length === 0 ? 0 : Math.max(1, Math.ceil(trimmed.length / 4));

  const handleSend = () => {
    if (!trimmed || streaming) return;
    onSend(trimmed, maxTokens);
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };

  return (
    <div
      style={{
        borderTop: "1px solid var(--color-border)",
        padding: "12px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        background: "var(--color-bg)",
      }}
    >
      {/* Controls Bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11 }}>
        <button
          type="button"
          onClick={() => setShowOptions(!showOptions)}
          className="btn-ghost"
          style={{ padding: "2px 7px", fontSize: 11, border: "none", color: "var(--color-text-2)" }}
        >
          <SlidersHorizontal size={12} />
          <span>Options ({maxTokens} max tokens)</span>
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            className="mono"
            style={{ fontSize: 11, color: "var(--color-text-3)" }}
            title="Estimated token count for current prompt input"
          >
            {estimatedTokens > 0 ? `~${estimatedTokens} est. tokens` : "0 tokens"} / {contextWindow.toLocaleString()} ctx
          </span>
          <span className="hide-on-mobile" style={{ color: "var(--color-text-3)", fontSize: 11 }}>
            · Shift+Enter for newline
          </span>
        </div>
      </div>

      {/* Collapsible Options Panel */}
      {showOptions && (
        <div
          className="animate-fade-in"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "12px 14px",
            background: "var(--color-surface)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--color-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--color-text)" }}>
              Generation Parameters
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {[
                { label: "Precise", tokens: 128 },
                { label: "Balanced", tokens: 256 },
                { label: "Extended", tokens: 512 },
              ].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setMaxTokens(preset.tokens)}
                  style={{
                    padding: "2px 8px",
                    fontSize: 10.5,
                    borderRadius: "var(--radius-sm)",
                    border: maxTokens === preset.tokens ? "1px solid var(--color-accent)" : "1px solid var(--color-border)",
                    background: maxTokens === preset.tokens ? "var(--color-accent-subtle)" : "var(--color-surface-subtle)",
                    color: maxTokens === preset.tokens ? "var(--color-accent)" : "var(--color-text-2)",
                    fontWeight: maxTokens === preset.tokens ? 600 : 400,
                    cursor: "pointer",
                  }}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setMaxTokens(256)}
                className="btn-ghost"
                style={{ padding: "2px 6px", fontSize: 10.5, display: "flex", alignItems: "center", gap: 3 }}
                title="Reset to 256 tokens"
              >
                <RotateCcw size={10} />
                <span>Reset</span>
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 12 }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                <span style={{ color: "var(--color-text-2)", fontWeight: 500 }}>Max Output Tokens</span>
                <span className="mono" style={{ color: "var(--color-text)", fontWeight: 600 }}>{maxTokens} tokens</span>
              </div>
              <input
                id="chat-max-tokens"
                type="range"
                min={32}
                max={Math.min(2048, contextWindow || 2048)}
                step={32}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
                style={{ width: "100%", accentColor: "var(--color-accent)" }}
              />
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-3)", maxWidth: 180, lineHeight: 1.3 }}>
              Caps generation to avoid runaway loops while keeping context fast.
            </div>
          </div>
        </div>
      )}

      {/* Input Textarea & Send Button */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          id="chat-input"
          ref={textareaRef}
          value={text}
          onChange={(e) => { setText(e.target.value); handleInput(); }}
          onKeyDown={handleKeyDown}
          disabled={streaming}
          placeholder={
            isStarting
              ? "Starting engine… prompt will send once ready"
              : isEngineStopped
              ? "Type a prompt to send once engine starts…"
              : "Send a prompt to Swarm…"
          }
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            padding: "10px 14px",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius)",
            fontSize: 13,
            fontFamily: "var(--font-sans)",
            background: "var(--color-surface-subtle)",
            color: "var(--color-text)",
            outline: "none",
            transition: "border-color var(--dur-fast)",
            lineHeight: 1.5,
          }}
          onFocus={(e) => { e.target.style.borderColor = "var(--color-accent)"; }}
          onBlur={(e) => { e.target.style.borderColor = "var(--color-border)"; }}
        />

        {streaming ? (
          <button
            id="chat-stop-btn"
            className="btn-ghost"
            onClick={onStop}
            title="Stop generation"
            style={{
              color: "var(--color-error)",
              borderColor: "var(--color-error)",
              height: 38,
              padding: "0 14px",
            }}
          >
            <Square size={13} fill="currentColor" />
            <span>Stop</span>
          </button>
        ) : (
          <button
            id="chat-send-btn"
            className="btn-primary"
            onClick={handleSend}
            disabled={!trimmed || isStarting}
            title={isEngineStopped ? "Start engine and dispatch prompt" : "Send message"}
            style={{ height: 38, padding: "0 16px" }}
          >
            {isStarting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Send size={13} />
            )}
            <span>{isEngineStopped ? "Send" : "Send"}</span>
          </button>
        )}
      </div>
    </div>
  );
}

const COMPOSER_DRAFT_KEY = "swarm_composer_draft";

export function ChatPanel() {
  const { messages, streaming, generationPhase, sendMessage, stopStreaming, clearMessages } = useChat();
  const session = useSwarmSession(3000);
  const sup = useSupervisor(3000);

  const [inputText, setInputTextState] = useState(() => {
    try {
      return sessionStorage.getItem(COMPOSER_DRAFT_KEY) || "";
    } catch {
      return "";
    }
  });

  const [queuedPrompt, setQueuedPrompt] = useState<{ text: string; maxTokens: number } | null>(null);

  const setInputText = (val: string) => {
    setInputTextState(val);
    try {
      if (val) {
        sessionStorage.setItem(COMPOSER_DRAFT_KEY, val);
      } else {
        sessionStorage.removeItem(COMPOSER_DRAFT_KEY);
      }
    } catch {
      // ignore storage quota / sandbox errors
    }
  };

  const isReady = sup.engineStatus?.coord_healthy === true || session.isReady;
  const isStopped = !isReady && !sup.isStarting && (session.state === "not_running" || !sup.engineStatus?.coord_healthy);

  // If a prompt was queued while starting engine, send it once engine becomes ready
  useEffect(() => {
    if (isReady && queuedPrompt) {
      const p = queuedPrompt;
      setQueuedPrompt(null);
      sendMessage(p.text, p.maxTokens);
    }
  }, [isReady, queuedPrompt, sendMessage]);

  const handleSendPrompt = async (prompt: string, maxTokens: number) => {
    try {
      sessionStorage.removeItem(COMPOSER_DRAFT_KEY);
    } catch {
      // ignore
    }

    if (!isReady) {
      // Auto-start engine and queue prompt
      setQueuedPrompt({ text: prompt, maxTokens });
      try {
        await sup.startEngine(true);
      } catch (err) {
        console.warn("Failed to auto-start engine on send:", err);
      }
    } else {
      sendMessage(prompt, maxTokens);
    }
  };

  const bottomRef = useRef<HTMLDivElement>(null);

  const handleRecoverInterrupted = async () => {
    // Preserve the operator's last prompt before the engine is torn down.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser?.content) setInputText(lastUser.content);
    try {
      await sup.stopEngine();
    } catch {
      // Engine may already be down; the restart below is still valid.
    }
    try {
      if (isAndroid) {
        await sup.startEngine(true);
      } else {
        sup.setSelectedProfileId("low_memory_cuda_standalone");
        await sup.startEngine(true, "low_memory_cuda_standalone");
      }
    } catch (err) {
      console.warn("Failed to restart engine after interrupted stream:", err);
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  const examplePrompts = [
    "What is 3 + 3?",
    "Explain KV cache offloading in one sentence.",
    "Summarize how distributed tensor layers operate over RPC.",
  ];

  const friendlyName = friendlyModelTitle(session.modelPath || session.modelName);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {/* Centered Conversation Column — constrained to comfortable reading width (~960px) */}
      <div
        className="card animate-fade-in"
        style={{
          maxWidth: 960,
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          border: "1px solid var(--color-border)",
          background: "var(--color-bg)",
        }}
      >
        {/* Placement Ribbon Header Strip (Only when engine is active and segments exist) */}
        {isReady && session.ribbonSegments.length > 0 && (
          <div
            style={{
              padding: "10px 18px 8px 18px",
              borderBottom: "1px solid var(--color-border)",
              background: "var(--color-bg)",
            }}
          >
            <PlacementRibbon
              segments={session.ribbonSegments}
              totalLayers={session.totalLayers}
              compact={true}
              showCaption={true}
              isOffline={session.isCoordinatorOffline}
            />
          </div>
        )}

        {/* Sub-header / Actions */}
        <div
          style={{
            padding: "8px 18px",
            borderBottom: "1px solid var(--color-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--color-surface-subtle)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="panel-title" style={{ fontSize: 13, fontWeight: 600 }}>Chat</span>
            <span style={{ fontSize: 11.5, color: "var(--color-text-3)" }}>·</span>
            <span className="mono" style={{ fontSize: 12, color: "var(--color-text-2)" }}>{friendlyName}</span>
            {streaming && (
              <span id="chat-generation-status" className="badge badge-busy" style={{ fontSize: 10 }}>
                {generationPhase === "evaluating" ? "Evaluating prompt…" : "Streaming…"}
              </span>
            )}
            {queuedPrompt && (
              <span className="badge badge-busy" style={{ fontSize: 10 }}>
                Starting engine to dispatch message…
              </span>
            )}
          </div>
          {messages.length > 0 && (
            <button
              id="chat-clear-btn"
              className="btn-ghost"
              style={{ padding: "2px 8px", fontSize: 11, height: 24 }}
              onClick={clearMessages}
              title="Clear conversation"
            >
              <Trash2 size={11} />
              <span>Clear</span>
            </button>
          )}
        </div>

        {/* Scrollable Message List */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "16px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            background: "var(--color-bg)",
          }}
        >
          {/* Calm Standby State when engine is intentionally stopped and no messages exist */}
          {isStopped && messages.length === 0 && (
            <div
              className="card animate-fade-in"
              style={{
                margin: "auto 0",
                padding: "36px 24px",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 16,
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius)",
                maxWidth: 480,
                alignSelf: "center",
                width: "100%",
              }}
            >
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: "50%",
                  background: "var(--color-surface-subtle)",
                  border: "1px solid var(--color-border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--color-text-3)",
                }}
              >
                <Power size={22} />
              </div>

              <div>
                <h2 className="section-title" style={{ fontSize: 17, color: "var(--color-text)" }}>
                  Inference Engine in Standby
                </h2>
                <p className="page-subtitle" style={{ maxWidth: 440, marginTop: 6, fontSize: 12.5, lineHeight: 1.45 }}>
                  {isAndroid
                    ? "The on-device engine is in standby. Start the engine to begin your session."
                    : "Engine is in standby. Start the engine or type a prompt below to begin your session."}
                </p>
              </div>

              {!isAndroid ? (
                /* Profile Selection Pills */
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", maxWidth: 500 }}>
                  <button
                    id="chat-profile-cluster-btn"
                    type="button"
                    onClick={() => sup.setSelectedProfileId("default")}
                    style={{
                      padding: "5px 12px",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 11.5,
                      cursor: "pointer",
                      border: sup.selectedProfileId === "default" ? "1.5px solid var(--color-accent)" : "1px solid var(--color-border)",
                      background: sup.selectedProfileId === "default" ? "var(--color-accent-subtle)" : "var(--color-surface)",
                      color: sup.selectedProfileId === "default" ? "var(--color-accent)" : "var(--color-text-2)",
                      fontWeight: sup.selectedProfileId === "default" ? 600 : 400,
                      transition: "all var(--dur-fast)",
                    }}
                  >
                    Distributed Cluster (Multi-Device RPC)
                  </button>

                  <button
                    id="chat-profile-standalone-btn"
                    type="button"
                    onClick={() => sup.setSelectedProfileId("low_memory_cuda_standalone")}
                    style={{
                      padding: "5px 12px",
                      borderRadius: "var(--radius-sm)",
                      fontSize: 11.5,
                      cursor: "pointer",
                      border: sup.selectedProfileId === "low_memory_cuda_standalone" ? "1.5px solid var(--color-accent)" : "1px solid var(--color-border)",
                      background: sup.selectedProfileId === "low_memory_cuda_standalone" ? "var(--color-accent-subtle)" : "var(--color-surface)",
                      color: sup.selectedProfileId === "low_memory_cuda_standalone" ? "var(--color-accent)" : "var(--color-text-2)",
                      fontWeight: sup.selectedProfileId === "low_memory_cuda_standalone" ? 600 : 400,
                      transition: "all var(--dur-fast)",
                    }}
                  >
                    ⚡ Standalone CUDA (Direct GPU)
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                  <a
                    href="#worker"
                    className="btn-ghost"
                    style={{ padding: "6px 14px", fontSize: 12, gap: 6, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
                  >
                    <span>Or Share This Device's Compute →</span>
                  </a>
                </div>
              )}

              {/* Startup Error Banner if any */}
              {sup.errorMessage && (() => {
                let main = sup.errorMessage;
                let details: string | null = null;
                if (sup.errorMessage.includes("Last output:")) {
                  const parts = sup.errorMessage.split("Last output:");
                  main = parts[0].trim();
                  details = parts.slice(1).join("Last output:").trim();
                } else if (sup.errorMessage.includes("Status:")) {
                  const parts = sup.errorMessage.split("Status:");
                  main = parts[0].trim();
                  details = parts.slice(1).join("Status:").trim();
                }

                if (details && details.includes(" | ")) {
                  details = details.split(" | ").join("\n");
                }

                const isWorkerUnreachable =
                  sup.errorMessage.toLowerCase().includes("unreachable") ||
                  sup.errorMessage.toLowerCase().includes("failed to register worker") ||
                  sup.errorMessage.toLowerCase().includes("worker connection timeout");

                return (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "12px 14px",
                      background: "#FEF2F2",
                      border: "1px solid #FCA5A5",
                      borderRadius: "var(--radius-sm)",
                      color: "#991B1B",
                      fontSize: 12,
                      maxWidth: 520,
                      textAlign: "left",
                      lineHeight: 1.45,
                      boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                    }}
                  >
                    <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2, color: "#DC2626" }} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                        <div>
                          <strong style={{ display: "block", color: "#7F1D1D", fontSize: 12.5, marginBottom: 2 }}>
                            {isWorkerUnreachable ? "Remote Worker Offline" : "Startup Guard"}
                          </strong>
                          <span style={{ wordBreak: "break-word" }}>{main}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => sup.setErrorMessage(null)}
                          style={{
                            background: "none",
                            border: "none",
                            color: "#991B1B",
                            cursor: "pointer",
                            padding: 2,
                            fontSize: 14,
                            lineHeight: 1,
                          }}
                          title="Dismiss error"
                        >
                          ✕
                        </button>
                      </div>

                      {details && (
                        <details style={{ fontSize: 11, color: "#7F1D1D" }}>
                          <summary style={{ cursor: "pointer", fontWeight: 600, userSelect: "none" }}>
                            View Technical Logs
                          </summary>
                          <pre
                            style={{
                              marginTop: 6,
                              padding: "8px 10px",
                              background: "#FFFFFF",
                              border: "1px solid #FECACA",
                              borderRadius: 4,
                              fontFamily: "var(--font-mono)",
                              fontSize: 10.5,
                              lineHeight: 1.4,
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-all",
                              maxHeight: 140,
                              overflowY: "auto",
                            }}
                          >
                            {details}
                          </pre>
                        </details>
                      )}

                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
                        {sup.selectedProfileId === "default" && (
                          <button
                            type="button"
                            onClick={() => {
                              sup.setSelectedProfileId("low_memory_cuda_standalone");
                              sup.startEngine(true, "low_memory_cuda_standalone");
                            }}
                            style={{
                              padding: "5px 12px",
                              fontSize: 11,
                              fontWeight: 600,
                              borderRadius: "var(--radius-sm)",
                              background: "#DC2626",
                              color: "#FFFFFF",
                              border: "none",
                              cursor: "pointer",
                              boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                            }}
                          >
                            ⚡ Switch to {isAndroid ? "On-Device" : "Standalone CUDA"} &amp; Start Engine
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Primary Start Engine Button */}
              {sup.isDesktop && (
                <button
                  id="chat-start-engine-btn"
                  type="button"
                  className="btn-primary"
                  onClick={() => sup.startEngine(true)}
                  disabled={sup.isStarting}
                  style={{ padding: "8px 24px", fontSize: 13, gap: 7, marginTop: 4 }}
                >
                  {sup.isStarting ? <Loader2 size={14} className="animate-spin" /> : <Play size={13} fill="currentColor" />}
                  <span>
                    {sup.isStarting
                      ? "Starting Native Engine…"
                      : isAndroid
                      ? "Start Engine (On-Device Local)"
                      : `Start Engine (${sup.selectedProfileId === "low_memory_cuda_standalone" ? "Standalone CUDA" : "Cluster"})`}
                  </span>
                </button>
              )}
            </div>
          )}

          {/* Subdued Inline Notice if stopped with previous messages */}
          {isStopped && messages.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 12px",
                background: "var(--color-surface-subtle)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                color: "var(--color-text-2)",
              }}
            >
              <span>
                {isAndroid
                  ? "Engine is in standby. Start the on-device engine to continue."
                  : "Engine is in standby. Start cluster or fallback to local GPU."}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    sup.setSelectedProfileId("low_memory_cuda_standalone");
                    sup.startEngine(true);
                  }}
                  disabled={sup.isStarting}
                  style={{
                    padding: "3px 10px",
                    fontSize: 11.5,
                    height: 26,
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--color-border)",
                    background: "var(--color-surface)",
                    color: "var(--color-text)",
                    cursor: "pointer",
                  }}
                  title="Run locally on PC GPU without remote worker"
                >
                  ⚡ Fallback to Local GPU
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => sup.startEngine(true)}
                  disabled={sup.isStarting}
                  style={{ padding: "3px 10px", fontSize: 11.5, height: 26 }}
                >
                  {sup.isStarting ? "Starting…" : "Start Cluster"}
                </button>
              </div>
            </div>
          )}

          {/* Empty Conversation Welcome State when ready */}
          {isReady && messages.length === 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                margin: "auto 0",
                width: "100%",
                gap: 12,
                color: "var(--color-text-2)",
                padding: "16px 12px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: "var(--color-accent-subtle)",
                  border: "1px solid rgba(27, 94, 73, 0.2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--color-accent)",
                }}
              >
                <Sparkles size={20} strokeWidth={1.8} />
              </div>
              <div>
                <h2 className="section-title" style={{ fontSize: 16 }}>
                  Session Ready
                </h2>
                <p className="page-subtitle" style={{ maxWidth: 440, marginTop: 4 }}>
                  <strong>{friendlyName}</strong> loaded across {session.devices.length}{" "}
                  {session.devices.length === 1 ? "device" : "devices"}.
                </p>
              </div>

              {/* Example Prompts */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8, width: "100%", maxWidth: 420 }}>
                {examplePrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => setInputText(prompt)}
                    style={{
                      textAlign: "left",
                      background: "var(--color-surface-subtle)",
                      border: "1px solid var(--color-border)",
                      padding: "8px 12px",
                      borderRadius: "var(--radius)",
                      fontSize: 12,
                      color: "var(--color-text)",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      cursor: "pointer",
                      transition: "border-color var(--dur-fast)",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-accent)")}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--color-border)")}
                  >
                    <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>›</span>
                    <span>{prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((entry: ChatEntry) => (
            <MessageRow
              key={entry.id}
              entry={entry}
              onRecoverInterrupted={entry.interrupted ? handleRecoverInterrupted : undefined}
            />
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Anchored Composer within the column */}
        <ChatInput
          onSend={handleSendPrompt}
          onStop={stopStreaming}
          streaming={streaming}
          isEngineStopped={isStopped}
          isStarting={sup.isStarting}
          text={inputText}
          setText={setInputText}
          contextWindow={session.contextWindow}
        />
      </div>
    </div>
  );
}
