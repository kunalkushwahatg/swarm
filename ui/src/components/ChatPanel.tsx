import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { useChat, type ChatEntry } from "../hooks/useSwarm";
import { useSwarmSession } from "../hooks/useSwarmSession";
import { PlacementRibbon } from "./PlacementRibbon";
import { CoordinatorRecoveryCard } from "./CoordinatorRecoveryCard";
import { fmtMs, fmtTps, cn } from "../lib/utils";
import {
  Send,
  Square,
  Trash2,
  AlertCircle,
  Sparkles,
  SlidersHorizontal,
} from "lucide-react";

function MessageRow({ entry }: { entry: ChatEntry }) {
  const isUser = entry.role === "user";

  return (
    <div
      className="animate-fade-in"
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        padding: isUser ? "10px 14px" : "12px 14px",
        borderRadius: "var(--radius)",
        background: isUser ? "var(--color-surface-sunken)" : "transparent",
        border: isUser ? "1px solid var(--color-hairline)" : "none",
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
          fontFamily: isUser ? "var(--font-sans)" : "var(--font-sans)",
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

        {/* B.1 Interrupted Stream Notice */}
        {entry.interrupted && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 8px",
              borderRadius: "var(--radius-sm)",
              background: "rgba(239, 68, 68, 0.08)",
              border: "1px solid rgba(239, 68, 68, 0.2)",
              color: "var(--color-error)",
              fontSize: 11.5,
              marginTop: 6,
            }}
          >
            <AlertCircle size={13} style={{ flexShrink: 0 }} />
            <span>Generation interrupted: connection to coordinator lost. Response may be incomplete.</span>
          </div>
        )}
      </div>

      {/* Beneath assistant response: Authoritative timing telemetry (B.4) */}
      {!isUser && !entry.streaming && (
        <div
          style={{
            marginTop: 4,
            paddingTop: 6,
            borderTop: "1px dashed var(--color-hairline)",
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
                  fontSize: 12,
                  color: "var(--color-text-2)",
                }}
              >
                <span className="mono" style={{ fontWeight: 600, color: "var(--color-text)" }}>
                  {entry.timings.tokens_generated} tokens
                </span>
                <span>·</span>
                <span className="mono" style={{ fontWeight: 600, color: "var(--color-accent)" }}>
                  {entry.timings.tokens_per_sec != null ? fmtTps(entry.timings.tokens_per_sec) : "N/A tok/s"}
                </span>
                <span>·</span>
                <span className="mono" style={{ color: "var(--color-text-2)" }}>
                  {entry.timings.prompt_eval_ms != null
                    ? `${(entry.timings.prompt_eval_ms / 1000).toFixed(1)} s prompt evaluation`
                    : "prompt eval unmeasured"}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 10,
                  fontSize: 11,
                  color: "var(--color-text-3)",
                }}
              >
                {entry.timings.ttfc_ms != null && (
                  <span>
                    Time to first content: <strong className="mono" style={{ fontWeight: 500, color: "var(--color-text-2)" }}>{fmtMs(entry.timings.ttfc_ms)}</strong> (client)
                  </span>
                )}
                {entry.timings.gen_ms != null && (
                  <span>
                    Generation: <strong className="mono" style={{ fontWeight: 500, color: "var(--color-text-2)" }}>{fmtMs(entry.timings.gen_ms)}</strong> (backend)
                  </span>
                )}
                {entry.timings.total_ms != null && (
                  <span>
                    Total: <strong className="mono" style={{ fontWeight: 500, color: "var(--color-text-2)" }}>{fmtMs(entry.timings.total_ms)}</strong> (backend)
                  </span>
                )}
              </div>
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
  disabled: boolean;
  text: string;
  setText: (t: string) => void;
  contextWindow: number;
}

function ChatInput({ onSend, onStop, streaming, disabled, text, setText, contextWindow }: ChatInputProps) {
  const [maxTokens, setMaxTokens] = useState(256);
  const [showOptions, setShowOptions] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const estimatedTokens = Math.max(0, Math.ceil(text.trim().length / 4));

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || streaming || disabled) return;
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
        borderTop: "1px solid var(--color-hairline)",
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
          style={{ padding: "2px 6px", fontSize: 11, border: "none", color: "var(--color-text-2)" }}
        >
          <SlidersHorizontal size={12} />
          <span>Options ({maxTokens} max tokens)</span>
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--color-text-3)" }}>
            {estimatedTokens} / {contextWindow} tokens
          </span>
          <span className="hide-on-mobile" style={{ color: "var(--color-text-3)", fontSize: 11 }}>
            · Shift+Enter for newline
          </span>
        </div>
      </div>

      {/* Collapsible Options */}
      {showOptions && (
        <div
          className="animate-fade-in"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 10px",
            background: "var(--color-surface-sunken)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--color-hairline)",
          }}
        >
          <label htmlFor="chat-max-tokens" style={{ fontSize: 11, color: "var(--color-text-2)", fontWeight: 500 }}>
            max_tokens limit:
          </label>
          <input
            id="chat-max-tokens"
            type="number"
            min={16}
            max={1024}
            step={32}
            value={maxTokens}
            onChange={(e) => setMaxTokens(Math.max(1, Number(e.target.value)))}
            style={{
              width: 72,
              padding: "3px 6px",
              border: "1px solid var(--color-hairline)",
              borderRadius: "var(--radius-sm)",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              background: "var(--color-bg)",
              color: "var(--color-text)",
            }}
          />
          <span style={{ fontSize: 11, color: "var(--color-text-3)" }}>Limits generation length per request</span>
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
          placeholder={disabled ? "Coordinator unreachable — prompt draft safely preserved here" : "Send a prompt to Swarm…"}
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            padding: "10px 14px",
            border: "1px solid var(--color-hairline)",
            borderRadius: "var(--radius)",
            fontSize: 13,
            fontFamily: "var(--font-sans)",
            background: "var(--color-surface-sunken)",
            color: "var(--color-text)",
            outline: "none",
            transition: "border-color var(--dur-fast)",
            lineHeight: 1.5,
          }}
          onFocus={(e) => { e.target.style.borderColor = "var(--color-accent)"; }}
          onBlur={(e) => { e.target.style.borderColor = "var(--color-hairline)"; }}
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
            disabled={!text.trim() || streaming || disabled}
            title={disabled ? "Coordinator offline — prompt draft preserved" : "Send message"}
            style={{ height: 38 }}
          >
            <Send size={13} />
            <span>Send</span>
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
  const [inputText, setInputTextState] = useState(() => {
    try {
      return sessionStorage.getItem(COMPOSER_DRAFT_KEY) || "";
    } catch {
      return "";
    }
  });

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

  const handleSendPrompt = (prompt: string, maxTokens: number) => {
    try {
      sessionStorage.removeItem(COMPOSER_DRAFT_KEY);
    } catch {
      // ignore
    }
    sendMessage(prompt, maxTokens);
  };

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  const examplePrompts = [
    "What is 3 + 3?",
    "Explain KV cache offloading in one sentence.",
    "Summarize how distributed tensor layers operate over RPC.",
  ];

  const isStopped = session.state === "not_running";

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
          border: "1px solid var(--color-hairline)",
          background: "var(--color-bg)",
        }}
      >
        {/* Placement Ribbon Header Strip */}
        {session.ribbonSegments.length > 0 && (
          <div
            style={{
              padding: "10px 18px 8px 18px",
              borderBottom: "1px solid var(--color-hairline)",
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
            borderBottom: "1px solid var(--color-hairline)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--color-surface-sunken)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="panel-title" style={{ fontSize: 13 }}>Session Chat</span>
            {streaming && (
              <span id="chat-generation-status" className="badge badge-busy" style={{ fontSize: 10 }}>
                {generationPhase === "evaluating" ? "Evaluating prompt…" : "Streaming…"}
              </span>
            )}
          </div>
          {messages.length > 0 && (
            <button
              id="chat-clear-btn"
              className="btn-ghost"
              style={{ padding: "2px 7px", fontSize: 11, height: 24 }}
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
            padding: "12px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            background: "var(--color-bg)",
          }}
        >
          {/* B.1 Coordinator Recovery State */}
          {isStopped && (
            <CoordinatorRecoveryCard session={session} />
          )}

          {/* Empty Conversation Welcome State */}
          {!isStopped && messages.length === 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                margin: "auto 0",
                width: "100%",
                gap: 8,
                color: "var(--color-text-2)",
                padding: "8px 10px",
                textAlign: "center",
              }}
            >
              {session.isReady ? (
                <>
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: "50%",
                      background: "var(--color-accent-subtle)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--color-accent)",
                    }}
                  >
                    <Sparkles size={20} strokeWidth={1.8} />
                  </div>
                  <div>
                    <h2 className="section-title">
                      Session Ready
                    </h2>
                    <p className="page-subtitle" style={{ maxWidth: 440, marginTop: 4 }}>
                      Model <strong>{session.modelName}</strong> allocated across {session.devices.length}{" "}
                      {session.devices.length === 1 ? "device" : "devices"}.
                    </p>
                  </div>

                  {/* Restrained Example Prompts */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12, width: "100%", maxWidth: 420 }}>
                    {examplePrompts.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        className="chip-suggestion"
                        onClick={() => setInputText(prompt)}
                        style={{
                          textAlign: "left",
                          background: "var(--color-surface-sunken)",
                          border: "1px solid var(--color-hairline)",
                          padding: "8px 12px",
                          borderRadius: "var(--radius)",
                          fontSize: 12,
                          color: "var(--color-text)",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          cursor: "pointer",
                        }}
                      >
                        <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>›</span>
                        <span>{prompt}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <AlertCircle size={32} strokeWidth={1.8} color="var(--color-warn)" />
                  <div>
                    <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text)", margin: 0 }}>
                      Session Not Ready
                    </h2>
                    <p style={{ fontSize: 12, color: "var(--color-warn)", marginTop: 4, maxWidth: 440 }}>
                      {session.stateLabel} · Waiting for coordinator model load to complete.
                    </p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Messages */}
          {messages.map((entry: ChatEntry) => (
            <MessageRow key={entry.id} entry={entry} />
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Anchored Composer within the column */}
        <ChatInput
          onSend={handleSendPrompt}
          onStop={stopStreaming}
          streaming={streaming}
          disabled={session.isCoordinatorOffline || (!session.isReady && messages.length === 0)}
          text={inputText}
          setText={setInputText}
          contextWindow={session.contextWindow}
        />
      </div>
    </div>
  );
}
