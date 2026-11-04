import { useState, useEffect, useRef } from "react";
import QRCode from "qrcode";
import {
  supervisor,
  type DiscoveredWorker,
  type RemoteWorkerConfig,
  type WorkerProbeResult,
  type HostNetworkInfo,
} from "../../lib/supervisor";
import {
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  QrCode,
  Smartphone,
  ChevronDown,
  ChevronUp,
  X,
  ShieldCheck,
} from "lucide-react";

export interface DeviceOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onWorkerRegistered: () => Promise<void> | void;
  engineStatus?: any;
  startEngine: (allowReal?: boolean) => Promise<any>;
  stopEngine: () => Promise<any>;
  sessionRefetch: () => void;
  isStarting?: boolean;
  isStopping?: boolean;
}

type ModalView = "pair" | "connecting" | "success" | "qr";

export function DeviceOnboardingModal({
  isOpen,
  onClose,
  onWorkerRegistered,
  engineStatus,
  startEngine,
  stopEngine,
  sessionRefetch,
  isStarting = false,
  isStopping = false,
}: DeviceOnboardingModalProps) {
  // Modal view states
  const [view, setView] = useState<ModalView>("pair");
  const [digits, setDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [workerName, setWorkerName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Success state payload
  const [connectedWorker, setConnectedWorker] = useState<RemoteWorkerConfig | null>(null);
  const [probeResult, setProbeResult] = useState<WorkerProbeResult | null>(null);
  const [isActivatingEngine, setIsActivatingEngine] = useState(false);

  // Discovered LAN worker (if phone broadcasts on local Wi-Fi)
  const [detectedWorker, setDetectedWorker] = useState<DiscoveredWorker | null>(null);

  // Advanced: Direct IP state
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [directHost, setDirectHost] = useState("");
  const [directPort, setDirectPort] = useState("50052");
  const [isDirectProbing, setIsDirectProbing] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);

  // QR state
  const [hostNetwork, setHostNetwork] = useState<HostNetworkInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const pinInputsRef = useRef<(HTMLInputElement | null)[]>([]);

  // Reset state on open & query network/LAN workers
  useEffect(() => {
    if (!isOpen) return;

    setView("pair");
    setDigits(["", "", "", "", "", ""]);
    setWorkerName("");
    setErrorMessage(null);
    setConnectedWorker(null);
    setProbeResult(null);
    setIsSubmitting(false);
    setShowAdvanced(false);
    setDirectHost("");
    setDirectPort("50052");
    setDirectError(null);

    // Auto-focus first PIN digit
    setTimeout(() => {
      pinInputsRef.current[0]?.focus();
    }, 120);

    // Scan for LAN workers (zero-config Wi-Fi path)
    supervisor
      .discoverWorkers(1500)
      .then((workers) => {
        if (workers && workers.length > 0) {
          setDetectedWorker(workers[0]);
        }
      })
      .catch(() => {});

    // Query host network for QR payload
    supervisor
      .getHostNetworkInfo()
      .then((info) => {
        if (info) setHostNetwork(info);
      })
      .catch(() => {});
  }, [isOpen]);

  // Generate QR payload when QR view is triggered
  useEffect(() => {
    if (view === "qr" && hostNetwork) {
      const payload = JSON.stringify({
        swarm_version: 1,
        host: hostNetwork.preferred_ip || hostNetwork.ip_addresses[0] || "127.0.0.1",
        coordinator_port: hostNetwork.coordinator_port || 8080,
        telemetry_token: hostNetwork.telemetry_token,
      });
      QRCode.toDataURL(payload, {
        width: 220,
        margin: 1,
        color: { dark: "#1B5E49", light: "#FFFFFF" },
      })
        .then(setQrDataUrl)
        .catch(() => {});
    }
  }, [view, hostNetwork]);

  if (!isOpen) return null;

  const isCoordinatorActive =
    engineStatus?.coord_healthy === true ||
    engineStatus?.state === "Ready" ||
    engineStatus?.state === "running";

  // PIN digit input handling with auto-advance and backspace navigation
  const handleDigitChange = (index: number, val: string) => {
    setErrorMessage(null);
    const clean = val.replace(/\D/g, "");
    if (!clean) {
      const next = [...digits];
      next[index] = "";
      setDigits(next);
      return;
    }

    const next = [...digits];
    next[index] = clean.slice(-1);
    setDigits(next);

    // Move to next digit
    if (index < 5) {
      pinInputsRef.current[index + 1]?.focus();
    }

    // Auto-submit if all 6 digits are filled
    const fullCode = next.join("");
    if (fullCode.length === 6) {
      void executePair(fullCode);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      pinInputsRef.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text").trim();
    // Support either clean digits or full link
    let extracted = text.replace(/\D/g, "").slice(0, 6);
    if (text.includes("code=")) {
      const match = text.match(/code=(\d{6})/);
      if (match) extracted = match[1];
    }
    if (extracted.length > 0) {
      const next = ["", "", "", "", "", ""];
      for (let i = 0; i < extracted.length; i++) {
        next[i] = extracted[i];
      }
      setDigits(next);
      if (extracted.length === 6) {
        pinInputsRef.current[5]?.focus();
        void executePair(extracted);
      } else {
        pinInputsRef.current[extracted.length]?.focus();
      }
    }
  };

  // Execute pairing with 6-digit code over encrypted QUIC tunnel
  const executePair = async (code: string) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    setView("connecting");

    try {
      const res = await supervisor.pairWorker(code, workerName.trim() || undefined);
      if (!res.success) {
        setErrorMessage(res.message || "Could not establish encrypted tunnel to this device.");
        setView("pair");
        return;
      }
      setConnectedWorker(res.worker || null);
      setProbeResult(res.probe || null);
      await onWorkerRegistered();
      sessionRefetch();
      setView("success");
    } catch (err: any) {
      setErrorMessage(err?.message || String(err));
      setView("pair");
    } finally {
      setIsSubmitting(false);
    }
  };

  // One-click pairing for auto-detected LAN worker
  const handlePairDiscovered = async (worker: DiscoveredWorker) => {
    if (worker.endpoint_id) {
      // Worker has Iroh tunnel identity, dial directly
      await executePair(worker.endpoint_id);
      return;
    }
    // Fall back to direct LAN registration
    const directWorker: RemoteWorkerConfig = {
      id: `worker-${worker.host.replace(/\./g, "-")}-${worker.port}`,
      name: worker.name || "Remote Worker",
      host: worker.host,
      port: worker.port,
      added_at_ms: Date.now(),
      is_active: true,
      transport: "tcp",
    };
    try {
      setIsSubmitting(true);
      setView("connecting");
      await supervisor.registerWorker(directWorker);
      const probe = await supervisor.probeWorkerEndpoint(worker.host, worker.port, 2500);
      setConnectedWorker(directWorker);
      setProbeResult(probe);
      await onWorkerRegistered();
      sessionRefetch();
      setView("success");
    } catch (err: any) {
      setErrorMessage(err?.message || "Failed to add discovered worker.");
      setView("pair");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Direct IP connect for custom subnets / WireGuard
  const handleDirectConnect = async () => {
    const cleanHost = directHost.trim();
    const portNum = Number(directPort.trim());
    if (!cleanHost || isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setDirectError("Enter a valid host IP and port (e.g. 192.168.1.50:50052).");
      return;
    }

    setIsDirectProbing(true);
    setDirectError(null);
    try {
      const probe = await supervisor.probeWorkerEndpoint(cleanHost, portNum, 3000);
      if (!probe.reachable) {
        setDirectError(`Unable to reach ${cleanHost}:${portNum} (${probe.status_state || "Offline"}).`);
        return;
      }
      const directWorker: RemoteWorkerConfig = {
        id: `worker-${cleanHost.replace(/\./g, "-")}-${portNum}`,
        name: workerName.trim() || `Helper (${cleanHost})`,
        host: cleanHost,
        port: portNum,
        added_at_ms: Date.now(),
        is_active: true,
        transport: "tcp",
      };
      await supervisor.registerWorker(directWorker);
      setConnectedWorker(directWorker);
      setProbeResult(probe);
      await onWorkerRegistered();
      sessionRefetch();
      setView("success");
    } catch (err: any) {
      setDirectError(err?.message || "Connection probe failed.");
    } finally {
      setIsDirectProbing(false);
    }
  };

  // Activation & Coordinator restart handler
  const handleActivateAndClose = async (restartEngine: boolean) => {
    if (restartEngine && isCoordinatorActive) {
      setIsActivatingEngine(true);
      try {
        await stopEngine();
        await new Promise((resolve) => setTimeout(resolve, 800));
        await startEngine(true);
        await onWorkerRegistered();
        sessionRefetch();
      } catch (err) {
        console.error("Coordinator restart failed:", err);
      } finally {
        setIsActivatingEngine(false);
      }
    }
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(18, 24, 20, 0.48)",
        backdropFilter: "blur(4px)",
        padding: 16,
      }}
    >
      <div
        className="animate-fade-in"
        style={{
          width: "100%",
          maxWidth: 480,
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius)",
          boxShadow: "0 12px 32px rgba(0, 0, 0, 0.12)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "var(--radius-sm)",
                background: "var(--color-accent-subtle)",
                color: "var(--color-accent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Smartphone size={16} />
            </div>
            <div>
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text)", margin: 0 }}>
                {view === "success" ? "Device Connected" : "Pair Compute Node"}
              </h2>
              <div style={{ fontSize: 11.5, color: "var(--color-text-3)", marginTop: 1 }}>
                {view === "success"
                  ? "Node ready to process model layers"
                  : "Android phone, tablet, or secondary PC"}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            aria-label="Close dialog"
            style={{ width: 28, height: 28, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 18 }}>
          {/* ── STATE 1: PAIRING (Default) ───────────── */}
          {view === "pair" && (
            <>
              {/* LAN Auto-Discovery Pill (if phone is broadcasting on local Wi-Fi) */}
              {detectedWorker && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "9px 12px",
                    background: "var(--color-accent-subtle)",
                    border: "1px solid rgba(27, 94, 73, 0.25)",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--color-ok)", flexShrink: 0 }} />
                    <div style={{ fontSize: 12, color: "var(--color-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      Found nearby: <strong>{detectedWorker.name}</strong>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => handlePairDiscovered(detectedWorker)}
                    style={{ padding: "4px 12px", fontSize: 11.5, height: 26, flexShrink: 0 }}
                  >
                    Pair Now
                  </button>
                </div>
              )}

              {/* 6-Digit Segmented PIN Card */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 12,
                  padding: "16px 12px",
                  background: "var(--color-surface-subtle)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-border)",
                }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-text)" }}>
                  Enter 6-Digit Pairing Code
                </div>

                {/* Tactile 6-Box PIN Inputs */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                  onPaste={handlePaste}
                >
                  {digits.map((digit, idx) => (
                    <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        ref={(el) => {
                          pinInputsRef.current[idx] = el;
                        }}
                        type="text"
                        inputMode="numeric"
                        maxLength={1}
                        value={digit}
                        onChange={(e) => handleDigitChange(idx, e.target.value)}
                        onKeyDown={(e) => handleKeyDown(idx, e)}
                        autoComplete="one-time-code"
                        style={{
                          width: 44,
                          height: 52,
                          textAlign: "center",
                          fontSize: 22,
                          fontWeight: 700,
                          fontFamily: "var(--font-mono)",
                          background: "var(--color-surface)",
                          color: "var(--color-accent)",
                          border: digit
                            ? "2px solid var(--color-accent)"
                            : "1px solid var(--color-border-strong)",
                          borderRadius: "var(--radius-sm)",
                          outline: "none",
                          transition: "border-color var(--dur-fast)",
                        }}
                      />
                      {idx === 2 && (
                        <span style={{ fontSize: 18, color: "var(--color-text-3)", fontWeight: 300 }}>
                          —
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                <div style={{ fontSize: 11.5, color: "var(--color-text-3)", textAlign: "center", lineHeight: 1.45, maxWidth: 360 }}>
                  Tap <strong>Start Sharing</strong> on the phone. Connects anywhere: local Wi-Fi, 5G cellular, or USB.
                </div>
              </div>

              {/* Error Message */}
              {errorMessage && (
                <div
                  role="alert"
                  style={{
                    padding: "8px 12px",
                    borderRadius: "var(--radius-sm)",
                    background: "rgba(185, 28, 28, 0.08)",
                    border: "1px solid rgba(185, 28, 28, 0.25)",
                    color: "var(--color-error)",
                    fontSize: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <AlertCircle size={14} style={{ flexShrink: 0 }} />
                  <span>{errorMessage}</span>
                </div>
              )}

              {/* Device Name (Optional, compact) */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <label
                  htmlFor="worker-custom-name"
                  style={{ fontSize: 11.5, color: "var(--color-text-3)", whiteSpace: "nowrap" }}
                >
                  Device Name:
                </label>
                <input
                  id="worker-custom-name"
                  type="text"
                  placeholder="e.g. Pixel 8 / Motorola Edge (Optional)"
                  value={workerName}
                  onChange={(e) => setWorkerName(e.target.value)}
                  style={{
                    flex: 1,
                    padding: "5px 10px",
                    fontSize: 12,
                    background: "var(--color-surface-subtle)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-sm)",
                    outline: "none",
                  }}
                />
              </div>

              {/* Secondary Options Divider */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 4 }}>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setView("qr")}
                  style={{ padding: "4px 8px", fontSize: 11.5, display: "flex", alignItems: "center", gap: 5 }}
                >
                  <QrCode size={13} />
                  <span>Show QR Code</span>
                </button>

                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setShowAdvanced((v) => !v)}
                  style={{ padding: "4px 8px", fontSize: 11.5, display: "flex", alignItems: "center", gap: 5 }}
                >
                  <span>Direct IP / LAN</span>
                  {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
              </div>

              {/* Advanced Direct IP Form (Collapsed by default) */}
              {showAdvanced && (
                <div
                  className="animate-fade-in"
                  style={{
                    padding: "12px 14px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--color-surface-sunken)",
                    border: "1px solid var(--color-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--color-text)" }}>
                    Connect Directly by IP (Same Network or WireGuard)
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 100px auto", gap: 8, alignItems: "center" }}>
                    <input
                      type="text"
                      placeholder="192.168.1.50"
                      value={directHost}
                      onChange={(e) => setDirectHost(e.target.value)}
                      style={{
                        padding: "6px 8px",
                        fontSize: 12,
                        fontFamily: "var(--font-mono)",
                        background: "var(--color-surface)",
                        border: "1px solid var(--color-border)",
                        borderRadius: "var(--radius-sm)",
                      }}
                    />
                    <input
                      type="text"
                      placeholder="50052"
                      value={directPort}
                      onChange={(e) => setDirectPort(e.target.value)}
                      style={{
                        padding: "6px 8px",
                        fontSize: 12,
                        fontFamily: "var(--font-mono)",
                        background: "var(--color-surface)",
                        border: "1px solid var(--color-border)",
                        borderRadius: "var(--radius-sm)",
                      }}
                    />
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={handleDirectConnect}
                      disabled={isDirectProbing}
                      style={{ padding: "6px 12px", fontSize: 11.5, height: 32 }}
                    >
                      {isDirectProbing ? <RefreshCw size={12} className="animate-spin" /> : "Connect"}
                    </button>
                  </div>
                  {directError && (
                    <div style={{ fontSize: 11, color: "var(--color-error)" }}>{directError}</div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── STATE 2: CONNECTING ──────────────────── */}
          {view === "connecting" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "36px 16px",
                gap: 14,
                textAlign: "center",
              }}
            >
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: "50%",
                  background: "var(--color-accent-subtle)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--color-accent)",
                }}
              >
                <RefreshCw size={22} className="animate-spin" />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text)" }}>
                  Connecting to Device…
                </div>
                <div style={{ fontSize: 12, color: "var(--color-text-3)", marginTop: 4 }}>
                  Establishing encrypted QUIC tunnel and verifying GGML RPC response
                </div>
              </div>
            </div>
          )}

          {/* ── STATE 3: SUCCESS ─────────────────────── */}
          {view === "success" && connectedWorker && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Node Card */}
              <div
                style={{
                  padding: "16px 18px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--color-ok-bg)",
                  border: "1px solid rgba(30, 126, 89, 0.25)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: "50%",
                      background: "#FFFFFF",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--color-ok)",
                      boxShadow: "0 2px 6px rgba(0,0,0,0.06)",
                    }}
                  >
                    <CheckCircle2 size={20} />
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-ok)" }}>
                      {connectedWorker.name}
                    </div>
                    <div className="mono" style={{ fontSize: 11.5, color: "var(--color-text-2)", marginTop: 2 }}>
                      {probeResult?.p50_ms != null
                        ? `${probeResult.p50_ms} ms p50 · `
                        : probeResult?.latency_ms != null
                        ? `${probeResult.latency_ms} ms · `
                        : ""}
                      {connectedWorker.transport === "iroh" ? "Encrypted Cellular Tunnel" : "Local LAN Socket"}
                    </div>
                  </div>
                </div>

                <div
                  className="badge badge-ok"
                  style={{ fontSize: 11, padding: "3px 8px", display: "flex", alignItems: "center", gap: 4 }}
                >
                  <ShieldCheck size={11} />
                  <span>Authenticated</span>
                </div>
              </div>

              {/* Action notice depending on engine state */}
              {isCoordinatorActive ? (
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--color-surface-subtle)",
                    border: "1px solid var(--color-border)",
                    fontSize: 11.5,
                    color: "var(--color-text-2)",
                    lineHeight: 1.45,
                  }}
                >
                  To offload model layers to this newly paired node, restart the running engine.
                </div>
              ) : (
                <div style={{ fontSize: 11.5, color: "var(--color-text-3)", textAlign: "center" }}>
                  This device is registered and will automatically participate when the engine starts.
                </div>
              )}

              {/* Footer Actions */}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => handleActivateAndClose(false)}
                  style={{ padding: "6px 14px", fontSize: 12.5 }}
                >
                  {isCoordinatorActive ? "Save for Later" : "Done"}
                </button>

                {isCoordinatorActive && (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => handleActivateAndClose(true)}
                    disabled={isActivatingEngine || isStarting || isStopping}
                    style={{ padding: "6px 16px", fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <RefreshCw size={13} className={isActivatingEngine ? "animate-spin" : undefined} />
                    <span>{isActivatingEngine ? "Reloading Model…" : "Reload & Activate Now"}</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── STATE 4: QR CODE VIEW ────────────────── */}
          {view === "qr" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
              <div style={{ fontSize: 12, color: "var(--color-text-2)", textAlign: "center" }}>
                Scan with the Swarm camera on an Android device connected to this Wi-Fi network.
              </div>

              <div
                style={{
                  padding: 12,
                  background: "#FFFFFF",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="Pairing QR Code" width={200} height={200} />
                ) : (
                  <div style={{ width: 200, height: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <RefreshCw size={20} className="animate-spin text-[var(--color-accent)]" />
                  </div>
                )}
              </div>

              <button
                type="button"
                className="btn-ghost"
                onClick={() => setView("pair")}
                style={{ padding: "5px 14px", fontSize: 12 }}
              >
                Back to 6-Digit PIN
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
