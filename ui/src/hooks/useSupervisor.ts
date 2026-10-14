import { useState, useEffect, useCallback } from "react";
import {
  supervisor,
  isDesktopShell,
  type ClusterStatus,
  type RuntimeProfileMetadata,
  type PreflightReport,
} from "../lib/supervisor";

export function useSupervisor(pollIntervalMs = 3000) {
  const [engineStatus, setEngineStatus] = useState<ClusterStatus | null>(null);
  const [profiles, setProfiles] = useState<RuntimeProfileMetadata[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("default");
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!isDesktopShell) return;
    try {
      const status = await supervisor.getEngineStatus();
      if (status) {
        setEngineStatus(status);
        if (status.active_profile) {
          setSelectedProfileId(status.active_profile);
        }
      }
    } catch (err) {
      console.warn("Failed to poll engine status:", err);
    }
  }, []);

  const refreshProfiles = useCallback(async () => {
    if (!isDesktopShell) return;
    try {
      const resp = await supervisor.getAvailableProfiles();
      if (resp && resp.profiles.length > 0) {
        setProfiles(resp.profiles);
        // Default cluster remains default unless explicitly selected
        if (!selectedProfileId) {
          setSelectedProfileId(resp.default_profile_id || "default");
        }
      }
    } catch (err) {
      console.warn("Failed to fetch available profiles:", err);
    }
  }, [selectedProfileId]);

  const runPreflight = useCallback(
    async (profileId?: string) => {
      if (!isDesktopShell) return null;
      try {
        const target = profileId || selectedProfileId;
        const rep = await supervisor.preflightCheck(target);
        setPreflight(rep);
        return rep;
      } catch (err) {
        console.warn("Preflight check failed:", err);
        return null;
      }
    },
    [selectedProfileId]
  );

  useEffect(() => {
    if (!isDesktopShell) return;
    refreshStatus();
    refreshProfiles();
    runPreflight();

    const interval = setInterval(refreshStatus, pollIntervalMs);
    return () => clearInterval(interval);
  }, [refreshStatus, refreshProfiles, runPreflight, pollIntervalMs]);

  const handleStart = async (allowReal = false) => {
    if (!isDesktopShell) return;
    setIsStarting(true);
    setErrorMessage(null);
    try {
      const res = await supervisor.startEngine({
        profile: selectedProfileId,
        mode: allowReal ? "real" : "simulated",
        allow_real_runtime: allowReal,
      });
      if (res.preflight) {
        setPreflight(res.preflight);
      }
      setEngineStatus(res.status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      // Run preflight to show detailed issues
      runPreflight();
    } finally {
      setIsStarting(false);
      refreshStatus();
    }
  };

  const handleStop = async () => {
    if (!isDesktopShell) return;
    setIsStopping(true);
    setErrorMessage(null);
    try {
      const status = await supervisor.stopEngine();
      setEngineStatus(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
    } finally {
      setIsStopping(false);
      refreshStatus();
    }
  };

  const handleCancel = async () => {
    if (!isDesktopShell) return;
    try {
      await supervisor.cancelStartup();
    } catch (err) {
      console.warn("Cancel startup failed:", err);
    } finally {
      refreshStatus();
    }
  };

  const selectedProfile =
    profiles.find((p) => p.id === selectedProfileId) ||
    profiles.find((p) => p.is_default) ||
    null;

  return {
    isDesktop: isDesktopShell,
    engineStatus,
    profiles,
    selectedProfileId,
    selectedProfile,
    setSelectedProfileId: (id: string) => {
      setSelectedProfileId(id);
      runPreflight(id);
    },
    preflight,
    isStarting,
    isStopping,
    errorMessage,
    setErrorMessage,
    startEngine: handleStart,
    stopEngine: handleStop,
    cancelStartup: handleCancel,
    refreshStatus,
    runPreflight,
  };
}
