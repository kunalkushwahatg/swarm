import { useState, useEffect } from "react";
import QRCode from "qrcode";
import {
  supervisor,
  type DiscoveredWorker,
  type RemoteWorkerConfig,
  type WorkerProbeResult,
  type HostNetworkInfo,
} from "../../lib/supervisor";
import { isAndroid } from "../../lib/platform";
import {
  Copy,
  Check,
  AlertCircle,
  Shield,
  QrCode,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ArrowRight,
  ArrowLeft,
  Terminal,
  Info,
  Smartphone,
  KeyRound,
} from "lucide-react";

export type OnboardingStep = 1 | 2 | 3 | 4 | 5;
export type OnboardingMethod = "code" | "manual" | "qr";

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
  const [currentStep, setCurrentStep] = useState<OnboardingStep>(1);
  const [method, setMethod] = useState<OnboardingMethod>("code");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isRestartingCoordinator, setIsRestartingCoordinator] = useState(false);

  // Pairing Code Mode State
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [isPairingCodeSubmitting, setIsPairingCodeSubmitting] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairedWorkerConfig, setPairedWorkerConfig] = useState<RemoteWorkerConfig | null>(null);

  // Step 2 Configuration State
  const [workerHost, setWorkerHost] = useState("");
  const [workerPort, setWorkerPort] = useState("50052");
  const [workerName, setWorkerName] = useState("");
  const [addressTouched, setAddressTouched] = useState(false);
  const [portTouched, setPortTouched] = useState(false);
  const [detectedWorker, setDetectedWorker] = useState<DiscoveredWorker | null>(null);
  // Platform of the device being ADDED (the worker), not of this host. It
  // decides which startup instructions are relevant in steps 3 and 4.
  const [workerPlatform, setWorkerPlatform] = useState<"android" | "windows">(
    isAndroid ? "windows" : "android"
  );

  // Host Network Information for QR pairing
  const [hostNetwork, setHostNetwork] = useState<HostNetworkInfo | null>(null);
  const [selectedHostIp, setSelectedHostIp] = useState<string>("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Step 3 Live Probe State
  const [isProbing, setIsProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<WorkerProbeResult | null>(null);

  // Step 4 Verification / Monitoring State
  const [isVerifyingDaemon, setIsVerifyingDaemon] = useState(false);
  const [daemonVerified, setDaemonVerified] = useState(false);

  // Load host network info and auto-discover nearby phone workers on open
  useEffect(() => {
    if (isOpen) {
      // Every open starts a brand-new pairing session. Without this the modal
      // resumes on the previous run's final step and the operator never sees
      // the method picker again.
      setCurrentStep(1);
      setMethod("code");
      setPairingCodeInput("");
      setPairingError(null);
      setPairedWorkerConfig(null);
      setIsPairingCodeSubmitting(false);
      setWorkerHost("");
      setWorkerPort("50052");
      setWorkerName("");
      setAddressTouched(false);
      setPortTouched(false);
      setDetectedWorker(null);
      setProbeResult(null);
      setDaemonVerified(false);
      setWorkerPlatform(isAndroid ? "windows" : "android");

      supervisor.getHostNetworkInfo().then((info) => {
        if (info) {
          setHostNetwork(info);
          setSelectedHostIp(info.preferred_ip || info.ip_addresses[0] || "127.0.0.1");
        }
      });
      supervisor.discoverWorkers(1200).then((workers) => {
        if (workers && workers.length > 0) {
          const w = workers[0];
          setDetectedWorker(w);
          setWorkerHost((prev) => (prev ? prev : w.host));
          setWorkerPort((prev) => (prev && prev !== "50052" ? prev : String(w.port)));
          setWorkerName((prev) => (prev ? prev : w.name));
          setWorkerPlatform(/android/i.test(w.platform || "") ? "android" : "windows");
          setAddressTouched(true);
        }
      }).catch(() => {});
    }
  }, [isOpen]);

  // Copy helper
  const copyCmd = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Validation
  const cleanIp = workerHost.trim();
  const cleanPort = workerPort.trim();
  const ipv4Octets = cleanIp.split(".");
  const isIpv4 =
    ipv4Octets.length === 4 &&
    ipv4Octets.every((oct) => /^\d{1,3}$/.test(oct) && Number(oct) >= 0 && Number(oct) <= 255);
  const hostnamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  // A dotted-numeric string that fails IPv4 (e.g. 192.168.1.300) is a typo,
  // not a hostname. Only accept the hostname path when letters are present.
  const looksNumeric = /^[0-9.]+$/.test(cleanIp);
  const isHostname = cleanIp.length > 2 && hostnamePattern.test(cleanIp) && !isIpv4 && !looksNumeric;
  const isAddressValid = isIpv4 || isHostname;

  const portNum = Number(cleanPort);
  const isPortValid = !isNaN(portNum) && Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;

  let addressError: string | null = null;
  if (addressTouched && cleanIp.length > 0 && !isAddressValid) {
    addressError = "Please enter a valid private IPv4 address (e.g. 192.168.1.50) or mesh hostname.";
  }

  let portError: string | null = null;
  if (portTouched && !isPortValid) {
    portError = "Port must be an integer between 1 and 65535 (default: 50052).";
  }

  const cleanPairCode = pairingCodeInput.trim().replace(/\s+/g, "");
  const isCodeValid = cleanPairCode.length >= 6;
  const isFormValid = method === "code" ? isCodeValid : (isAddressValid && isPortValid);
  const effectiveWorkerIp = isAddressValid ? cleanIp : "192.168.x.x";
  const effectiveWorkerPort = isPortValid ? cleanPort : "50052";
  const effectiveHostIp = selectedHostIp || hostNetwork?.preferred_ip || "127.0.0.1";

  // Generate scoped QR pairing payload (omitting sensitive long-lived bearer tokens for security)
  const pairingPayload = JSON.stringify({
    coord: `http://${effectiveHostIp}:8080`,
    rpc_port: Number(effectiveWorkerPort),
    host: hostNetwork?.hostname || "Host-PC",
    mode: "lan_pairing",
    network: "private_lan",
  });

  // Render QR Code as PNG data URL
  useEffect(() => {
    if (isOpen && method === "qr") {
      QRCode.toDataURL(pairingPayload, {
        width: 176,
        margin: 1,
        color: {
          dark: "#1C2024",
          light: "#FFFFFF",
        },
      })
        .then((url) => setQrDataUrl(url))
        .catch((err) => console.error("QR Code generation error:", err));
    }
  }, [isOpen, method, pairingPayload]);

  // Auto-detect when phone scans the QR code and announces itself
  useEffect(() => {
    if (!isOpen || method !== "qr" || currentStep !== 2) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const found = await supervisor.discoverWorkers(800);
        if (!active || found.length === 0) return;
        const worker = found[0];
        setWorkerHost(worker.host);
        setWorkerPort(String(worker.port));
        setAddressTouched(true);
        if (worker.name && workerName === "Worker-Node") {
          setWorkerName(worker.name);
        }
        // Advance automatically
        setCurrentStep(3);
        executeConnectionProbe(worker.host, worker.port);
      } catch (_) {}
    }, 1500);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [isOpen, method, currentStep, workerName]);

  // Step 3: Run Live Connection Probe
  const executeConnectionProbe = async (host = cleanIp, port = portNum) => {
    setIsProbing(true);
    setProbeResult(null);
    try {
      const res = await supervisor.probeWorkerEndpoint(host, port, 3500);
      setProbeResult(res);
    } catch (err) {
      setProbeResult({
        reachable: false,
        host,
        port,
        latency_ms: 0,
        status_state: "ERROR",
        message: err instanceof Error ? err.message : String(err),
        actionable_recovery: "Ensure the remote worker is connected to the same LAN or VPN subnet.",
      });
    } finally {
      setIsProbing(false);
    }
  };

  // Step 4: Verify Worker Daemon
  const executeDaemonCheck = async () => {
    setIsVerifyingDaemon(true);
    try {
      const res = await supervisor.probeWorkerEndpoint(cleanIp, portNum, 3000);
      if (res.reachable) {
        setDaemonVerified(true);
      } else {
        setDaemonVerified(false);
      }
      setProbeResult(res);
    } catch {
      setDaemonVerified(false);
    } finally {
      setIsVerifyingDaemon(false);
    }
  };

  // Restart coordinator safely: stops existing cluster if running, then starts with updated endpoints
  const handleRestartCoordinator = async () => {
    setIsRestartingCoordinator(true);
    try {
      if (engineStatus?.coord_healthy || engineStatus?.state === "Ready") {
        await stopEngine();
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      await startEngine(true);
      await onWorkerRegistered();
      sessionRefetch();
    } catch (err) {
      console.error("Failed to restart coordinator:", err);
    } finally {
      setIsRestartingCoordinator(false);
    }
  };

  // Pair worker via 6-digit code or link over the encrypted tunnel
  const handlePairWorker = async () => {
    setIsPairingCodeSubmitting(true);
    setPairingError(null);
    setIsProbing(true);
    setProbeResult(null);
    try {
      const res = await supervisor.pairWorker(cleanPairCode, workerName.trim() || undefined);
      if (!res.success) {
        setPairingError(res.message);
        return;
      }
      setPairedWorkerConfig(res.worker);
      if (res.worker) {
        setWorkerHost(res.worker.host);
        setWorkerPort(String(res.worker.port));
        setWorkerName(res.worker.name);
      }
      if (res.probe) {
        setProbeResult(res.probe);
      }
      await onWorkerRegistered();
      sessionRefetch();
      // Paired successfully — advance directly to completion
      setCurrentStep(5);
    } catch (err: any) {
      setPairingError(err?.message || String(err));
    } finally {
      setIsPairingCodeSubmitting(false);
      setIsProbing(false);
    }
  };

  // Step 5: Save & Register Worker
  const handleCompleteRegistration = async (restartEngine = false) => {
    if (!pairedWorkerConfig) {
      const newWorker: RemoteWorkerConfig = {
        id: `worker-${cleanIp.replace(/\./g, "-")}-${cleanPort}`,
        name: workerName.trim() || `Helper (${cleanIp})`,
        host: cleanIp,
        port: portNum,
        added_at_ms: Date.now(),
        is_active: true,
      };

      try {
        await supervisor.registerWorker(newWorker);
        await onWorkerRegistered();
        sessionRefetch();
      } catch (err) {
        console.error("Failed to register remote worker:", err);
      }
    }

    if (restartEngine) {
      await handleRestartCoordinator();
    }

    onClose();
  };

  // Commands for manual copying
  const generatedWorkerCmd = `.\\Start-RemoteWorker.ps1 -CoordinatorUrl "http://${effectiveHostIp}:8080" -WorkerIp "${effectiveWorkerIp}" -RpcPort ${effectiveWorkerPort}`;
  const directRpcCmd = `.\\ggml-rpc-server.exe --host 0.0.0.0 --port ${effectiveWorkerPort} --threads 4`;
  const firewallCmd = `New-NetFirewallRule -DisplayName "Swarm GGML RPC" -Direction Inbound -LocalPort ${effectiveWorkerPort} -Protocol TCP -Action Allow`;

  if (!isOpen) return null;

  return (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(28, 32, 36, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 16,
            backdropFilter: "blur(3px)",
          }}
        >
          <div
            className="card"
            style={{
              width: "100%",
              maxWidth: 620,
              maxHeight: "92vh",
              overflowY: "auto",
              padding: 24,
              boxShadow: "0 20px 50px rgba(0,0,0,0.22)",
              display: "flex",
              flexDirection: "column",
              gap: 18,
              background: "var(--color-surface)",
            }}
          >
            {/* Modal Header & 5-Step Progress Indicator */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div>
                  <h2 className="section-title" style={{ fontSize: 18 }}>
                    Add Worker Computer
                  </h2>
                  <p className="page-subtitle" style={{ marginTop: 2, fontSize: 12.5 }}>
                    Connect a phone or computer on your network to distribute and offload LLM layers.
                  </p>
                </div>
                <button
                  className="btn-ghost"
                  onClick={onClose}
                  style={{ padding: "4px 8px", fontSize: 12 }}
                >
                  Cancel
                </button>
              </div>

              {/* 5-Step Progress Stepper Bar */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4, padding: "8px 0", borderBottom: "1px solid var(--color-border)" }}>
                {[
                  { step: 1, label: "Choose Method" },
                  { step: 2, label: "Enter Details" },
                  { step: 3, label: "Check Connection" },
                  { step: 4, label: "Start Worker" },
                  { step: 5, label: "Complete" },
                ].map((s) => {
                  const isActive = currentStep === s.step;
                  const isDone = currentStep > s.step;
                  return (
                    <div
                      key={s.step}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        opacity: isActive ? 1 : isDone ? 0.9 : 0.45,
                        fontSize: 12,
                        fontWeight: isActive ? 600 : 400,
                        color: isActive ? "var(--color-accent)" : isDone ? "var(--color-text)" : "var(--color-text-3)",
                      }}
                    >
                      <span
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          background: isDone ? "var(--color-accent)" : isActive ? "var(--color-accent-subtle)" : "var(--color-surface-subtle)",
                          color: isDone ? "#FFFFFF" : isActive ? "var(--color-accent)" : "var(--color-text-3)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 11,
                          fontWeight: 600,
                        }}
                      >
                        {isDone ? <Check size={12} /> : s.step}
                      </span>
                      <span style={{ display: "inline" }}>{s.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── STEP 1: CHOOSE METHOD ────────────────── */}
            {currentStep === 1 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ fontSize: 13, color: "var(--color-text-2)" }}>
                  Select how you want to connect the remote device. An Android phone running Swarm
                  and a Windows PC running the worker package are both equal compute peers.
                </div>

                {detectedWorker && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                      background: "rgba(31, 111, 102, 0.08)",
                      border: "1px solid var(--color-accent)",
                      padding: "10px 12px",
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    <div style={{ fontSize: 12, color: "var(--color-text)", minWidth: 0 }}>
                      <strong>Detected on this network:</strong> {detectedWorker.name}
                      <span className="mono" style={{ marginLeft: 6, color: "var(--color-text-2)" }}>
                        {detectedWorker.host}:{detectedWorker.port}
                      </span>
                      <span style={{ marginLeft: 6, color: "var(--color-text-3)" }}>
                        ({detectedWorker.platform || "unknown platform"})
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => {
                        setWorkerHost(detectedWorker.host);
                        setWorkerPort(String(detectedWorker.port));
                        setWorkerName(detectedWorker.name);
                        setWorkerPlatform(/android/i.test(detectedWorker.platform || "") ? "android" : "windows");
                        setAddressTouched(true);
                        setMethod("manual");
                        setCurrentStep(2);
                      }}
                      style={{ padding: "4px 10px", fontSize: 11.5, flexShrink: 0 }}
                    >
                      Use this device
                    </button>
                  </div>
                )}

                {/* Option 0: 6-Digit Pairing Code (Recommended) */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setMethod("code")}
                  onKeyDown={(e) => e.key === "Enter" && setMethod("code")}
                  style={{
                    padding: 16,
                    borderRadius: "var(--radius)",
                    border: method === "code" ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
                    background: method === "code" ? "rgba(31,111,102,0.05)" : "var(--color-surface)",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    position: "relative",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <KeyRound size={22} color="var(--color-accent)" />
                      <span style={{ fontWeight: 600, fontSize: 14.5, color: "var(--color-text)" }}>
                        Pair with 6-Digit Code
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 10.5,
                        background: "var(--color-accent-subtle)",
                        color: "var(--color-accent)",
                        padding: "2px 8px",
                        borderRadius: 4,
                        fontWeight: 600,
                      }}
                    >
                      Recommended · Cellular &amp; Wi-Fi
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--color-text-2)", lineHeight: 1.45 }}>
                    Connect a phone or computer anywhere over an encrypted tunnel. No Wi-Fi restrictions, port forwarding, or VPN needed. Just enter the 6-digit code shown in Swarm on the phone.
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {/* Option 1: Manual Address */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setMethod("manual")}
                    onKeyDown={(e) => e.key === "Enter" && setMethod("manual")}
                    style={{
                      padding: 16,
                      borderRadius: "var(--radius)",
                      border: method === "manual" ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
                      background: method === "manual" ? "rgba(31,111,102,0.04)" : "var(--color-surface)",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      position: "relative",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <Terminal size={24} color="var(--color-accent)" />
                      <span
                        style={{
                          fontSize: 10.5,
                          background: "var(--color-accent-subtle)",
                          color: "var(--color-accent)",
                          padding: "2px 6px",
                          borderRadius: 4,
                          fontWeight: 600,
                        }}
                      >
                        Auto-detect or enter
                      </span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: "var(--color-text)" }}>
                      Enter Address Manually
                    </div>
                    <div style={{ fontSize: 12, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                      Directly enter the device’s private IPv4 address (e.g. 192.168.x.x) and port. The Swarm Worker app shows this address on its main screen.
                    </div>
                  </div>

                  {/* Option 2: QR Code */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setMethod("qr")}
                    onKeyDown={(e) => e.key === "Enter" && setMethod("qr")}
                    style={{
                      padding: 16,
                      borderRadius: "var(--radius)",
                      border: method === "qr" ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
                      background: method === "qr" ? "rgba(31,111,102,0.04)" : "var(--color-surface)",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <QrCode size={24} color="var(--color-steel)" />
                      <span
                        style={{
                          fontSize: 10.5,
                          background: "var(--color-surface-subtle)",
                          color: "var(--color-text-3)",
                          padding: "2px 6px",
                          borderRadius: 4,
                          fontWeight: 500,
                        }}
                      >
                        Mobile / Camera
                      </span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: "var(--color-text)" }}>
                      Scan QR Code
                    </div>
                    <div style={{ fontSize: 12, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                      Displays a QR code for mobile devices, tablets, or barcode scanners on the same Wi-Fi network to inspect connection and authentication payload.
                    </div>
                  </div>
                </div>

                {/* Private Network Security Reminder */}
                <div className="banner-warn" style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 14px", borderRadius: "var(--radius)" }}>
                  <Shield size={18} color="var(--color-warn)" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ fontSize: 12, lineHeight: 1.45 }}>
                    <strong>Private Network Mandatory:</strong> GGML RPC uses unauthenticated, unencrypted TCP.
                    Keep RPC traffic restricted to USB tethering, a trusted home/office Wi-Fi network, or a private WireGuard/Tailscale VPN. For anything that crosses the public internet, use the encrypted Internet (QUIC) transport instead of port 50052 directly.
                  </div>
                </div>

                {/* Footer Controls */}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
                  <button className="btn-ghost" onClick={onClose}>
                    Cancel
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => setCurrentStep(2)}
                    style={{ padding: "7px 16px", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <span>Continue to Details</span>
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            )}

            {/* ── STEP 2: ENTER DETAILS ────────────────── */}
            {currentStep === 2 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* Target platform drives which startup instructions are shown later. */}
                {method !== "code" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                        color: "var(--color-text-3)",
                      }}
                    >
                      Remote device type
                    </span>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {([
                        { id: "android", label: "Android phone" },
                        { id: "windows", label: "Windows PC" },
                      ] as const).map((option) => {
                        const selected = workerPlatform === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setWorkerPlatform(option.id)}
                            style={{
                              padding: "6px 12px",
                              minHeight: 34,
                              fontSize: 12,
                              fontWeight: selected ? 600 : 500,
                              borderRadius: "var(--radius-sm)",
                              border: selected
                                ? "1px solid var(--color-accent)"
                                : "1px solid var(--color-border)",
                              background: selected
                                ? "var(--color-accent-subtle)"
                                : "var(--color-surface)",
                              color: selected ? "var(--color-accent)" : "var(--color-text-2)",
                              cursor: "pointer",
                            }}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                    <span style={{ fontSize: 11, color: "var(--color-text-3)", lineHeight: 1.4 }}>
                      {workerPlatform === "android"
                        ? "Step 4 will show the on-device Share Compute flow — the phone needs no terminal."
                        : "Step 4 will show the PowerShell worker launcher for a Windows PC."}
                    </span>
                  </div>
                )}

                {method === "code" ? (
                  /* 6-Digit Pairing Code Mode */
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ fontSize: 12.5, color: "var(--color-text-2)" }}>
                      Enter the 6-digit code shown in Swarm on the remote device:
                    </div>

                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "rgba(31, 111, 102, 0.06)", padding: "12px 14px", borderRadius: "var(--radius-sm)", border: "1px solid rgba(31, 111, 102, 0.2)" }}>
                      <Smartphone size={18} color="var(--color-accent)" style={{ flexShrink: 0, marginTop: 2 }} />
                      <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--color-text)" }}>
                        <strong>On the phone:</strong> Open Swarm → <strong>Share Compute</strong> → tap <strong>Start Sharing</strong>.
                        A 6-digit code will appear on the phone screen. Enter it below to establish an encrypted tunnel.
                      </div>
                    </div>

                    <div>
                      <label htmlFor="pairing-code-input" style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--color-text)", marginBottom: 6 }}>
                        6-Digit Pairing Code:
                      </label>
                      <input
                        id="pairing-code-input"
                        type="text"
                        value={pairingCodeInput}
                        onChange={(e) => {
                          setPairingCodeInput(e.target.value);
                          setPairingError(null);
                        }}
                        placeholder="e.g. 742 918"
                        autoFocus
                        style={{
                          width: "100%",
                          padding: "10px 14px",
                          fontSize: 18,
                          fontWeight: 700,
                          letterSpacing: "0.15em",
                          fontFamily: "var(--font-mono)",
                          background: "var(--color-surface-subtle)",
                          border: pairingError ? "1px solid var(--color-error)" : "1px solid var(--color-hairline)",
                          borderRadius: "var(--radius-sm)",
                          outline: "none",
                          color: "var(--color-accent)",
                        }}
                      />
                      {pairingError ? (
                        <span style={{ fontSize: 11, color: "var(--color-error)", marginTop: 4, display: "block" }}>
                          {pairingError}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 4, display: "block" }}>
                          Enter the 6-digit code or paste a complete pairing link. Works anywhere, even over cellular data without VPN.
                        </span>
                      )}
                    </div>

                    <div>
                      <label htmlFor="code-worker-name" style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--color-text)", marginBottom: 4 }}>
                        Device Name (Optional):
                      </label>
                      <input
                        id="code-worker-name"
                        type="text"
                        value={workerName}
                        onChange={(e) => setWorkerName(e.target.value)}
                        placeholder="e.g. Pixel 8 or Living Room Phone"
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          fontSize: 12.5,
                          background: "var(--color-surface-subtle)",
                          border: "1px solid var(--color-hairline)",
                          borderRadius: "var(--radius-sm)",
                          outline: "none",
                        }}
                      />
                    </div>
                  </div>
                ) : method === "qr" ? (
                  /* QR Pairing Mode */
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ fontSize: 12.5, color: "var(--color-text-2)" }}>
                      The remote device will connect to this host. Verify this host’s private network address:
                    </div>

                    {/* Host LAN Interface Selector */}
                    <div style={{ background: "var(--color-surface-subtle)", padding: 12, borderRadius: "var(--radius)", display: "flex", flexDirection: "column", gap: 8 }}>
                      <label style={{ fontSize: 11.5, fontWeight: 500, color: "var(--color-text-2)" }}>
                        Host Coordinator Address (on your LAN):
                      </label>
                      {hostNetwork?.ip_addresses && hostNetwork.ip_addresses.length > 1 ? (
                        <select
                          value={selectedHostIp}
                          onChange={(e) => setSelectedHostIp(e.target.value)}
                          style={{
                            padding: "6px 10px",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                            background: "var(--color-surface)",
                            border: "1px solid var(--color-border)",
                            borderRadius: "var(--radius-sm)",
                          }}
                        >
                          {hostNetwork.ip_addresses.map((ip) => (
                            <option key={ip} value={ip}>
                              http://{ip}:8080 {ip === hostNetwork.preferred_ip ? "(Primary)" : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="mono" style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                          http://{effectiveHostIp}:8080
                        </div>
                      )}
                    </div>

                    {/* QR Code Card & Payload */}
                    <div style={{ display: "flex", gap: 16, alignItems: "center", background: "var(--color-surface)", padding: 14, border: "1px solid var(--color-border)", borderRadius: "var(--radius)" }}>
                      <div style={{ flexShrink: 0 }}>
                        {qrDataUrl ? (
                          <img src={qrDataUrl} alt="Swarm Pairing QR Code" style={{ width: 140, height: 140, display: "block", borderRadius: 4 }} />
                        ) : (
                          <div style={{ width: 140, height: 140, background: "var(--color-surface-subtle)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            Generating...
                          </div>
                        )}
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                          1-Click QR Code Pairing
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                          Open <strong>Swarm Worker</strong> on your phone → Tap <strong>📷 Scan Desktop Pairing QR</strong> → Point at this code. The app will pair and advance automatically!
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            background: "var(--color-surface-subtle)",
                            border: "1px solid var(--color-border)",
                            padding: "6px 10px",
                            borderRadius: 6,
                            gap: 8,
                          }}
                        >
                          <code className="mono" style={{ fontSize: 10.5, wordBreak: "break-all" }}>
                            coord: http://{effectiveHostIp}:8080 | rpc: 50052
                          </code>
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => copyCmd(pairingPayload, "cmd-qr-payload")}
                            style={{ padding: "3px 8px", fontSize: 11, flexShrink: 0 }}
                          >
                            {copiedId === "cmd-qr-payload" ? <Check size={12} color="var(--color-ok)" /> : <Copy size={12} />}
                            <span>{copiedId === "cmd-qr-payload" ? "Copied" : "Copy"}</span>
                          </button>
                        </div>
                        <div style={{ fontSize: 10.5, color: "var(--color-text-3)", lineHeight: 1.3 }}>
                          <strong>Security Design:</strong> Sensitive bearer tokens are excluded from QR payloads to prevent credential interception. Authentication is provisioned via local secret files on the remote device.
                        </div>
                      </div>
                    </div>

                    {/* Target Worker IP Input */}
                    <div>
                      {detectedWorker && (
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(31, 111, 102, 0.08)", border: "1px solid var(--color-accent)", padding: "8px 12px", borderRadius: "var(--radius-sm)", marginBottom: 10 }}>
                          <div style={{ fontSize: 12, color: "var(--color-text)" }}>
                            <strong>✓ Auto-detected phone:</strong> {detectedWorker.name} (<span className="mono">{detectedWorker.host}:{detectedWorker.port}</span>)
                          </div>
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={() => {
                              setWorkerHost(detectedWorker.host);
                              setWorkerPort(String(detectedWorker.port));
                              setAddressTouched(true);
                            }}
                            style={{ padding: "3px 8px", fontSize: 11 }}
                          >
                            Fill Address
                          </button>
                        </div>
                      )}

                      <label htmlFor="qr-worker-ip" style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--color-text)", marginBottom: 4 }}>
                        Remote Device IP Address (Phone / PC):
                      </label>
                      <input
                        id="qr-worker-ip"
                        type="text"
                        value={workerHost}
                        onChange={(e) => {
                          setWorkerHost(e.target.value);
                          setAddressTouched(true);
                        }}
                        placeholder="e.g. 192.168.137.233"
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          fontSize: 12.5,
                          fontFamily: "var(--font-mono)",
                          background: "var(--color-surface-subtle)",
                          border: addressError ? "1px solid var(--color-error)" : "1px solid var(--color-hairline)",
                          borderRadius: "var(--radius-sm)",
                          outline: "none",
                        }}
                      />
                      {addressError ? (
                        <span style={{ fontSize: 11, color: "var(--color-error)", marginTop: 3, display: "block" }}>
                          {addressError}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 3, display: "block" }}>
                          {workerHost ? "✓ Device address ready — click Check Connection below to test latency." : "Point your phone camera at the QR code above, or enter the IP shown on your phone screen."}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  /* Manual Configuration Mode */
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ fontSize: 12.5, color: "var(--color-text-2)" }}>
                      Enter the network details for the remote worker:
                    </div>

                    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", background: "var(--color-surface-subtle)", padding: "8px 12px", borderRadius: "var(--radius-sm)", fontSize: 11.5, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                      <Info size={14} color="var(--color-steel)" style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>
                        <strong>Outbound RPC Architecture:</strong> The coordinator initiates an outbound TCP socket to the worker on port 50052 to stream model tensor layers.
                      </span>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "2.5fr 1fr", gap: 12 }}>
                      <div>
                        <label htmlFor="manual-ip-input" style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--color-text)", marginBottom: 4 }}>
                          Worker IPv4 Address / Hostname:
                        </label>
                        <input
                          id="manual-ip-input"
                          type="text"
                          value={workerHost}
                          onChange={(e) => {
                            setWorkerHost(e.target.value);
                            setAddressTouched(true);
                          }}
                          placeholder="e.g. 192.168.204.45 or worker-b.local"
                          style={{
                            width: "100%",
                            padding: "8px 12px",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                            background: "var(--color-surface-subtle)",
                            border: addressError ? "1px solid var(--color-error)" : "1px solid var(--color-hairline)",
                            borderRadius: "var(--radius-sm)",
                            outline: "none",
                          }}
                        />
                        {addressError ? (
                          <span style={{ fontSize: 11, color: "var(--color-error)", marginTop: 3, display: "block" }}>
                            {addressError}
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 3, display: "block" }}>
                            Must be on the same subnet (e.g. 192.168.x.x) or private VPN
                          </span>
                        )}
                      </div>

                      <div>
                        <label htmlFor="manual-port-input" style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--color-text)", marginBottom: 4 }}>
                          RPC Port:
                        </label>
                        <input
                          id="manual-port-input"
                          type="number"
                          value={workerPort}
                          onChange={(e) => {
                            setWorkerPort(e.target.value);
                            setPortTouched(true);
                          }}
                          placeholder="50052"
                          style={{
                            width: "100%",
                            padding: "8px 12px",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                            background: "var(--color-surface-subtle)",
                            border: portError ? "1px solid var(--color-error)" : "1px solid var(--color-hairline)",
                            borderRadius: "var(--radius-sm)",
                            outline: "none",
                          }}
                        />
                        {portError && (
                          <span style={{ fontSize: 11, color: "var(--color-error)", marginTop: 3, display: "block" }}>
                            {portError}
                          </span>
                        )}
                      </div>
                    </div>

                    <div>
                      <label htmlFor="manual-name-input" style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--color-text)", marginBottom: 4 }}>
                        Display Name (Optional):
                      </label>
                      <input
                        id="manual-name-input"
                        type="text"
                        value={workerName}
                        onChange={(e) => setWorkerName(e.target.value)}
                        placeholder="e.g. Office Laptop or Pixel"
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          fontSize: 12.5,
                          background: "var(--color-surface-subtle)",
                          border: "1px solid var(--color-hairline)",
                          borderRadius: "var(--radius-sm)",
                          outline: "none",
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Footer Controls */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                  <button className="btn-ghost" onClick={() => setCurrentStep(1)}>
                    <ArrowLeft size={14} style={{ marginRight: 4 }} />
                    Back
                  </button>
                  {method === "code" ? (
                    <button
                      className="btn-primary"
                      disabled={!isFormValid || isPairingCodeSubmitting}
                      onClick={handlePairWorker}
                      style={{
                        padding: "7px 18px",
                        fontSize: 13,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        opacity: isFormValid && !isPairingCodeSubmitting ? 1 : 0.5,
                        cursor: isFormValid && !isPairingCodeSubmitting ? "pointer" : "not-allowed",
                      }}
                    >
                      <RefreshCw size={14} className={isPairingCodeSubmitting ? "animate-spin" : ""} />
                      <span>{isPairingCodeSubmitting ? "Connecting..." : "Pair Device"}</span>
                      {!isPairingCodeSubmitting && <ArrowRight size={14} />}
                    </button>
                  ) : (
                    <button
                      className="btn-primary"
                      disabled={!isFormValid}
                      onClick={() => {
                        setCurrentStep(3);
                        executeConnectionProbe(cleanIp, portNum);
                      }}
                      style={{
                        padding: "7px 16px",
                        fontSize: 13,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        opacity: isFormValid ? 1 : 0.5,
                        cursor: isFormValid ? "pointer" : "not-allowed",
                      }}
                    >
                      <span>Check Connection</span>
                      <ArrowRight size={14} />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ── STEP 3: CHECK CONNECTION ────────────── */}
            {currentStep === 3 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ fontSize: 13, color: "var(--color-text-2)" }}>
                  Testing network reachability to <span className="mono" style={{ fontWeight: 600, color: "var(--color-text)" }}>{cleanIp}:{portNum}</span>:
                </div>

                {isProbing ? (
                  /* Probing Spinner */
                  <div className="well-sunken" style={{ padding: 24, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <RefreshCw size={24} className="animate-spin" color="var(--color-accent)" />
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>Connecting to {cleanIp}:{portNum}...</div>
                    <div style={{ fontSize: 11.5, color: "var(--color-text-3)" }}>
                      Sending TCP SYN handshake to verify open port and route
                    </div>
                  </div>
                ) : probeResult?.reachable ? (
                  /* Success State */
                  <div
                    style={{
                      padding: 16,
                      borderRadius: "var(--radius)",
                      background: "var(--color-ok-bg)",
                      border: "1px solid rgba(22, 101, 52, 0.25)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 14, color: "var(--color-ok)" }}>
                      <CheckCircle2 size={18} />
                      <span>Network Connection Verified!</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--color-text)", lineHeight: 1.45 }}>
                      Successfully reached <span className="mono">{cleanIp}:{portNum}</span> in <span className="mono">{probeResult.latency_ms} ms</span>.
                      {" "}The remote worker is reachable and its RPC port is listening.
                    </div>
                  </div>
                ) : (
                  /* Probe Failure State */
                  <div
                    style={{
                      padding: 16,
                      borderRadius: "var(--radius)",
                      background: "rgba(239, 68, 68, 0.05)",
                      border: "1px solid rgba(239, 68, 68, 0.25)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 14, color: "var(--color-error)" }}>
                      <XCircle size={18} />
                      <span>Unable to Connect ({probeResult?.status_state || "UNREACHABLE"})</span>
                    </div>

                    <div style={{ fontSize: 12.5, color: "var(--color-text-2)", lineHeight: 1.45 }}>
                      {probeResult?.message || `Could not establish a TCP connection to ${cleanIp}:${portNum}.`}
                    </div>

                    {/* The backend recovery text is Windows-firewall specific. Showing it
                        for an Android target contradicts the Android guidance below. */}
                    {probeResult?.actionable_recovery && workerPlatform === "windows" && (
                      <div
                        style={{
                          background: "var(--color-surface)",
                          padding: "10px 12px",
                          borderRadius: "var(--radius-sm)",
                          border: "1px solid var(--color-border)",
                          fontSize: 12,
                          color: "var(--color-text)",
                        }}
                      >
                        <strong>Troubleshooting &amp; Recovery:</strong>
                        <p style={{ marginTop: 4, color: "var(--color-text-2)", lineHeight: 1.4 }}>
                          {probeResult.actionable_recovery}
                        </p>
                      </div>
                    )}

                    {/* Platform-aware recovery: firewall rules only apply to Windows. */}
                    {workerPlatform === "windows" ? (
                      <div style={{ background: "var(--color-surface)", padding: 10, borderRadius: 6, border: "1px solid var(--color-border)" }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-2)", marginBottom: 4 }}>
                          If blocked by Windows Firewall, run in PowerShell on the worker PC:
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                          <code className="mono" style={{ fontSize: 10.5, wordBreak: "break-all" }}>
                            {firewallCmd}
                          </code>
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => copyCmd(firewallCmd, "cmd-firewall")}
                            style={{ padding: "3px 8px", fontSize: 11, flexShrink: 0 }}
                          >
                            {copiedId === "cmd-firewall" ? <Check size={12} color="var(--color-ok)" /> : <Copy size={12} />}
                            <span>{copiedId === "cmd-firewall" ? "Copied" : "Copy"}</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ background: "var(--color-surface)", padding: "10px 12px", borderRadius: 6, border: "1px solid var(--color-border)", fontSize: 11.5, color: "var(--color-text-2)", lineHeight: 1.45 }}>
                        <strong style={{ color: "var(--color-text)" }}>On the phone:</strong> open Swarm →
                        Share Compute → Start Sharing. Confirm the phone is on the same Wi-Fi network as
                        this host. Android has no inbound host firewall to configure.
                      </div>
                    )}
                  </div>
                )}

                {/* Footer Controls */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                  <button className="btn-ghost" onClick={() => setCurrentStep(2)}>
                    <ArrowLeft size={14} style={{ marginRight: 4 }} />
                    Back
                  </button>

                  <div style={{ display: "flex", gap: 8 }}>
                    {!probeResult?.reachable && (
                      <button
                        className="btn-ghost"
                        onClick={() => executeConnectionProbe(cleanIp, portNum)}
                        style={{ padding: "7px 14px", fontSize: 12.5 }}
                      >
                        Retry Probe
                      </button>
                    )}

                    <button
                      className="btn-primary"
                      onClick={() => setCurrentStep(4)}
                      style={{ padding: "7px 16px", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
                    >
                      <span>Continue to Start Worker</span>
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── STEP 4: START WORKER ────────────────── */}
            {currentStep === 4 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ fontSize: 13, color: "var(--color-text-2)" }}>
                  {workerPlatform === "android"
                    ? "Start sharing on the phone. No terminal, install step, or firewall rule is needed."
                    : "Start the worker daemon on the Windows PC. Keep its terminal window open while it participates."}
                </div>

                {/* Android worker — the zero-install, zero-terminal path */}
                <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", padding: 14, borderRadius: "var(--radius)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13.5, color: "var(--color-text)" }}>
                    <Smartphone size={16} color="var(--color-accent)" />
                    <span>
                      {workerPlatform === "android"
                        ? "Android phone (recommended, no terminal)"
                        : "Android phone (alternative compute worker)"}
                    </span>
                  </div>
                  <ol style={{ margin: "8px 0 0 18px", padding: 0, fontSize: 12, color: "var(--color-text-2)", lineHeight: 1.65 }}>
                    <li>Open the <strong>Swarm Worker</strong> app on the phone.</li>
                    <li>
                      For the lowest latency, connect the USB cable and enable <strong>USB tethering</strong>
                      {" "}(~1 ms). Otherwise join the same Wi-Fi network.
                    </li>
                    <li>Tap <strong>Start Sharing Compute</strong>. The phone displays its address, port, and endpoint ID.</li>
                    <li>Enter that address above and continue.</li>
                  </ol>
                </div>

                {workerPlatform === "windows" && (
                  <>
                {/* Important notice regarding manual execution on the worker PC */}
                <div className="banner-warn" style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--radius)", fontSize: 12, lineHeight: 1.4 }}>
                  <Terminal size={16} color="var(--color-warn)" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <strong>Windows PC workers only:</strong> These options run the worker manually on a Windows machine. Open PowerShell in the extracted worker package folder (<code>dist\swarm-worker-windows-x64</code>) and run the command below. Keep the window open while participating in the cluster. Android workers do not need this.
                  </div>
                </div>

                {/* Option A: Automated PowerShell Launcher */}
                <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", padding: 14, borderRadius: "var(--radius)" }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--color-text)" }}>
                    Option A: Automated Launcher (Recommended)
                  </div>
                  <p style={{ fontSize: 12, color: "var(--color-text-2)", marginTop: 2, marginBottom: 8 }}>
                    Starts both the GGML RPC server and the hardware telemetry reporting agent:
                  </p>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      background: "var(--color-surface-subtle)",
                      border: "1px solid var(--color-border)",
                      padding: "6px 10px",
                      borderRadius: 6,
                      gap: 8,
                    }}
                  >
                    <code className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>
                      {generatedWorkerCmd}
                    </code>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => copyCmd(generatedWorkerCmd, "cmd-step4-worker")}
                      style={{ padding: "3px 8px", fontSize: 11, flexShrink: 0 }}
                    >
                      {copiedId === "cmd-step4-worker" ? <Check size={12} color="var(--color-ok)" /> : <Copy size={12} />}
                      <span>{copiedId === "cmd-step4-worker" ? "Copied" : "Copy"}</span>
                    </button>
                  </div>
                </div>

                {/* Option B: Direct GGML RPC Executable */}
                <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", padding: 14, borderRadius: "var(--radius)" }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>
                    Option B: Standalone RPC Binary
                  </div>
                  <p style={{ fontSize: 12, color: "var(--color-text-2)", marginTop: 2, marginBottom: 8 }}>
                    Launches only the core GGML tensor computation daemon:
                  </p>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      background: "var(--color-surface-subtle)",
                      border: "1px solid var(--color-border)",
                      padding: "6px 10px",
                      borderRadius: 6,
                      gap: 8,
                    }}
                  >
                    <code className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>
                      {directRpcCmd}
                    </code>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => copyCmd(directRpcCmd, "cmd-step4-direct")}
                      style={{ padding: "3px 8px", fontSize: 11, flexShrink: 0 }}
                    >
                      {copiedId === "cmd-step4-direct" ? <Check size={12} color="var(--color-ok)" /> : <Copy size={12} />}
                      <span>{copiedId === "cmd-step4-direct" ? "Copied" : "Copy"}</span>
                    </button>
                  </div>
                </div>

                  </>
                )}

                {/* Live Process Verify Button */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--color-surface-subtle)", padding: "10px 14px", borderRadius: "var(--radius)" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12.5, color: "var(--color-text)" }}>
                      Live Process Detection
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--color-text-2)" }}>
                      {daemonVerified
                        ? "Worker daemon detected listening on port 50052!"
                        : "Verify that the process is actively listening on the remote device."}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={executeDaemonCheck}
                    disabled={isVerifyingDaemon}
                    style={{ padding: "5px 12px", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <RefreshCw size={13} className={isVerifyingDaemon ? "animate-spin" : ""} />
                    <span>{isVerifyingDaemon ? "Checking..." : daemonVerified ? "Verified (Listening)" : "Check Daemon Status"}</span>
                  </button>
                </div>

                {/* Graceful shutdown instructions */}
                <div style={{ fontSize: 11.5, color: "var(--color-text-3)", lineHeight: 1.4 }}>
                  <Shield size={13} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} />
                  {workerPlatform === "android" ? (
                    <>
                      <strong>Lifecycle:</strong> Tap <strong>Stop Sharing</strong> in Swarm → Share Compute.
                      The foreground service releases its CPU wake lock and Wi-Fi lock immediately.
                    </>
                  ) : (
                    <>
                      <strong>Lifecycle:</strong> To stop the worker cleanly, press <kbd>Ctrl+C</kbd> in the
                      worker PC's terminal window. Processes terminate gracefully without orphaned handles.
                    </>
                  )}
                </div>

                {/* Footer Controls */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                  <button className="btn-ghost" onClick={() => setCurrentStep(3)}>
                    <ArrowLeft size={14} style={{ marginRight: 4 }} />
                    Back
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => setCurrentStep(5)}
                    style={{ padding: "7px 16px", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <span>Next: Complete Setup</span>
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            )}

            {/* ── STEP 5: COMPLETE ────────────────────── */}
            {currentStep === 5 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* Celebration Card */}
                <div
                  style={{
                    padding: 20,
                    borderRadius: "var(--radius)",
                    background: "var(--color-ok-bg)",
                    border: "1px solid rgba(22, 101, 52, 0.2)",
                    textAlign: "center",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <CheckCircle2 size={36} color="var(--color-ok)" />
                  <div style={{ fontWeight: 600, fontSize: 16, color: "var(--color-ok)" }}>
                    {pairedWorkerConfig ? "Device Paired & Registered Successfully" : "Worker Node Configured Successfully"}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--color-text)", maxWidth: 460 }}>
                    {pairedWorkerConfig ? (
                      <span>
                        <strong style={{ fontWeight: 600 }}>{pairedWorkerConfig.name}</strong> is now securely paired over the encrypted tunnel.
                      </span>
                    ) : (
                      <span>
                        <span className="mono" style={{ fontWeight: 600 }}>{cleanIp}:{portNum}</span> has been added to your Swarm cluster device registry.
                      </span>
                    )}
                  </div>
                </div>

                {/* Configuration Summary */}
                <div
                  style={{
                    padding: 14,
                    borderRadius: "var(--radius-sm)",
                    background: "var(--color-surface-subtle)",
                    fontSize: 12,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--color-text-2)" }}>Worker Name:</span>
                    <span style={{ fontWeight: 600 }}>{workerName || (pairedWorkerConfig ? pairedWorkerConfig.name : `Helper (${cleanIp})`)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--color-text-2)" }}>Endpoint:</span>
                    <span className="mono">
                      {pairedWorkerConfig?.pairing_code
                        ? `Encrypted tunnel · Code ${pairedWorkerConfig.pairing_code}`
                        : pairedWorkerConfig
                        ? `Encrypted tunnel (127.0.0.1:${pairedWorkerConfig.port})`
                        : `${cleanIp}:{portNum}`}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--color-text-2)" }}>Transport Mode:</span>
                    <span>{pairedWorkerConfig ? "Encrypted Tunnel (QUIC / Cellular)" : "Direct TCP (Local LAN)"}</span>
                  </div>
                </div>

                {/* Important Inference Notice */}
                <div className="banner-warn" style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 14px", borderRadius: "var(--radius)" }}>
                  <AlertCircle size={18} color="var(--color-warn)" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ fontSize: 12, lineHeight: 1.45 }}>
                    <strong>Coordinator Restart Required for Activation:</strong> GGML partitions model weights across all registered RPC endpoints during startup.
                    To allocate model layers across both computers and engage this node in inference, restart the coordinator.
                  </div>
                </div>

                {/* Actions */}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
                  <button
                    className="btn-ghost"
                    onClick={() => handleCompleteRegistration(false)}
                    style={{ padding: "7px 14px", fontSize: 13 }}
                  >
                    Save for Later
                  </button>

                  <button
                    className="btn-primary"
                    onClick={() => handleCompleteRegistration(true)}
                    disabled={isRestartingCoordinator || isStarting || isStopping}
                    style={{ padding: "7px 16px", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <RefreshCw size={14} className={isRestartingCoordinator ? "animate-spin" : ""} />
                    <span>{isRestartingCoordinator ? "Restarting..." : "Save & Restart Coordinator Now"}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

  );
}
