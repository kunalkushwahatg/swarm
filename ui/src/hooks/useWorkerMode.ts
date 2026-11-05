import { useState, useEffect, useCallback, useRef } from "react";
import {
  supervisor,
  type WorkerModeConfig,
  type WorkerModeStatus,
  type WorkerHardwareTelemetry,
} from "../lib/supervisor";

export function useWorkerMode() {
  const [config, setConfig] = useState<WorkerModeConfig | null>(null);
  const [status, setStatus] = useState<WorkerModeStatus | null>(null);
  const [hardware, setHardware] = useState<WorkerHardwareTelemetry | null>(null);
  const [firewallOk, setFirewallOk] = useState<boolean | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [isStopping, setIsStopping] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mountedRef = useRef(true);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await supervisor.getWorkerStatus();
      if (!mountedRef.current) return;
      if (s) {
        setStatus(s);
        if (s.hardware) {
          setHardware(s.hardware);
        }
        if (s.last_error) {
          setErrorMessage((previous) => previous ?? s.last_error);
        }
      }
    } catch (err) {
      console.warn("Failed to refresh worker status:", err);
    }
  }, []);

  const refreshHardware = useCallback(async () => {
    try {
      const hw = await supervisor.getWorkerHardware();
      if (!mountedRef.current) return;
      if (hw) setHardware(hw);
    } catch (err) {
      console.warn("Failed to probe hardware telemetry:", err);
    }
  }, []);

  const checkFirewall = useCallback(async () => {
    try {
      const fw = await supervisor.checkFirewallStatus();
      if (!mountedRef.current) return;
      setFirewallOk(fw);
    } catch (err) {
      console.warn("Failed to check firewall status:", err);
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      const lines = await supervisor.getWorkerLogs(40);
      if (!mountedRef.current) return;
      setLogs(lines);
    } catch (err) {
      console.warn("Failed to get worker logs:", err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    let isSubscribed = true;

    async function init() {
      setIsLoading(true);
      try {
        const [loadedConfig, currentStatus, hw, fw] = await Promise.all([
          supervisor.getWorkerConfig(),
          supervisor.getWorkerStatus(),
          supervisor.getWorkerHardware(),
          supervisor.checkFirewallStatus(),
        ]);
        if (!isSubscribed) return;
        if (loadedConfig) setConfig(loadedConfig);
        if (currentStatus) setStatus(currentStatus);
        if (hw) setHardware(hw);
        setFirewallOk(fw);
      } catch (err) {
        if (isSubscribed) {
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (isSubscribed) {
          setIsLoading(false);
        }
      }
    }

    init();

    // Polling interval
    const interval = setInterval(() => {
      refreshStatus();
      fetchLogs();
    }, 2500);

    return () => {
      isSubscribed = false;
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [refreshStatus, fetchLogs]);

  const saveConfig = useCallback(async (newConfig: WorkerModeConfig) => {
    setErrorMessage(null);
    try {
      const saved = await supervisor.saveWorkerConfig(newConfig);
      setConfig(saved);
      return saved;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      throw err;
    }
  }, []);

  const startWorker = useCallback(async (customConfig?: WorkerModeConfig) => {
    setIsStarting(true);
    setErrorMessage(null);
    try {
      const cfgToUse = customConfig || config || undefined;
      const result = await supervisor.startWorker(cfgToUse);
      if (result.success) {
        setStatus(result.status);
      } else {
        setErrorMessage(result.message);
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      throw err;
    } finally {
      setIsStarting(false);
      refreshStatus();
      fetchLogs();
    }
  }, [config, refreshStatus, fetchLogs]);

  const stopWorker = useCallback(async () => {
    setIsStopping(true);
    setErrorMessage(null);
    try {
      const s = await supervisor.stopWorker();
      setStatus(s);
      return s;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      throw err;
    } finally {
      setIsStopping(false);
      refreshStatus();
      fetchLogs();
    }
  }, [refreshStatus, fetchLogs]);

  const revokeRemoteAccess = useCallback(async () => {
    setErrorMessage(null);
    try {
      const s = await supervisor.revokeRemoteAccess();
      setStatus(s);
      setConfig(s.config);
      return s;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      throw err;
    } finally {
      refreshStatus();
      fetchLogs();
    }
  }, [refreshStatus, fetchLogs]);

  const applyFirewallRule = useCallback(async (port?: number, controllerIp?: string) => {
    setErrorMessage(null);
    try {
      const res = await supervisor.applyFirewallRule(port, controllerIp);
      await checkFirewall();
      await refreshStatus();
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      throw err;
    }
  }, [checkFirewall, refreshStatus]);

  const clearError = useCallback(() => {
    setErrorMessage(null);
  }, []);

  return {
    config,
    status,
    hardware,
    firewallOk,
    logs,
    isLoading,
    isStarting,
    isStopping,
    errorMessage,
    startWorker,
    stopWorker,
    revokeRemoteAccess,
    applyFirewallRule,
    saveConfig,
    refreshStatus,
    refreshHardware,
    checkFirewall,
    fetchLogs,
    clearError,
  };
}
