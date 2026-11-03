import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  supervisor,
  isDesktopShell,
  type ClusterStatus,
  type RuntimeProfileMetadata,
  type PreflightReport,
} from "../lib/supervisor";

type SupervisorState = {
  isDesktop: boolean;
  engineStatus: ClusterStatus | null;
  profiles: RuntimeProfileMetadata[];
  selectedProfileId: string;
  selectedProfile: RuntimeProfileMetadata | null;
  activeProfileId: string | null;
  activeProfile: RuntimeProfileMetadata | null;
  preflight: PreflightReport | null;
  isStarting: boolean;
  isStopping: boolean;
  errorMessage: string | null;
  setErrorMessage: (message: string | null) => void;
  setSelectedProfileId: (id: string) => void;
  startEngine: (allowReal?: boolean, overrideProfileId?: string) => Promise<void>;
  stopEngine: () => Promise<void>;
  cancelStartup: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  runPreflight: (profileId?: string) => Promise<PreflightReport | null>;
};

const SupervisorContext = createContext<SupervisorState | null>(null);

function isEngineRunning(status: ClusterStatus | null): boolean {
  if (!status) return false;
  return (
    status.coord_healthy === true ||
    status.state === "Ready" ||
    status.state === "Healthy"
  );
}

function recommendedProfileId(
  response: { profiles: RuntimeProfileMetadata[]; default_profile_id: string } | null
): string {
  if (!response || response.profiles.length === 0) return "default";

  const defaultProfile = response.profiles.find((profile) => profile.id === "default");
  const standalone = response.profiles.find(
    (profile) => profile.id === "low_memory_cuda_standalone"
  );

  const defaultEligible = defaultProfile?.eligibility?.can_launch_now ?? true;
  const standaloneEligible = standalone?.eligibility?.can_launch_now ?? true;

  if (!defaultEligible && standaloneEligible && standalone) {
    return standalone.id;
  }

  return response.default_profile_id || defaultProfile?.id || response.profiles[0].id;
}

function useSupervisorState(pollIntervalMs: number): SupervisorState {
  const [engineStatus, setEngineStatus] = useState<ClusterStatus | null>(null);
  const [profiles, setProfiles] = useState<RuntimeProfileMetadata[]>([]);
  const [selectedProfileId, setSelectedProfileIdState] = useState<string>("default");
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedProfileIdRef = useRef("default");
  const lastActiveProfileRef = useRef<string | null>(null);
  const startInFlightRef = useRef(false);
  const stopInFlightRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    if (!isDesktopShell) return;
    try {
      const status = await supervisor.getEngineStatus();
      if (!status) return;

      setEngineStatus(status);

      if (isEngineRunning(status) && status.active_profile) {
        const active = status.active_profile;
        setActiveProfileId(active);

        // The engine can be started outside this window (CLI or another
        // process). Mirror that authoritative profile when it changes, but
        // never let a stopped/failed engine overwrite the operator's choice
        // for the next launch.
        if (lastActiveProfileRef.current !== active) {
          lastActiveProfileRef.current = active;
          selectedProfileIdRef.current = active;
          setSelectedProfileIdState(active);
        }
      } else if (!isEngineRunning(status)) {
        setActiveProfileId(null);
        lastActiveProfileRef.current = null;
      }
    } catch (err) {
      console.warn("Failed to poll engine status:", err);
    }
  }, []);

  const runPreflight = useCallback(async (profileId?: string) => {
    if (!isDesktopShell) return null;
    try {
      const target = profileId || selectedProfileIdRef.current || "default";
      const report = await supervisor.preflightCheck(target);
      setPreflight(report);
      return report;
    } catch (err) {
      console.warn("Preflight check failed:", err);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!isDesktopShell) return;

    let cancelled = false;

    async function initialize() {
      const [status, profileResponse] = await Promise.all([
        supervisor.getEngineStatus(),
        supervisor.getAvailableProfiles(),
      ]);
      if (cancelled) return;

      const running = isEngineRunning(status);
      let initialProfile = selectedProfileIdRef.current || "default";

      if (status) {
        setEngineStatus(status);
        if (running && status.active_profile) {
          initialProfile = status.active_profile;
          setActiveProfileId(status.active_profile);
          lastActiveProfileRef.current = status.active_profile;
        } else {
          setActiveProfileId(null);
          lastActiveProfileRef.current = null;
        }
      }

      if (profileResponse && profileResponse.profiles.length > 0) {
        setProfiles(profileResponse.profiles);
        if (!running) {
          initialProfile = recommendedProfileId(profileResponse);
        }
      }

      selectedProfileIdRef.current = initialProfile;
      setSelectedProfileIdState(initialProfile);
      await runPreflight(initialProfile);
    }

    void initialize().catch((err) => {
      console.warn("Failed to initialize supervisor state:", err);
    });

    const interval = setInterval(refreshStatus, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refreshStatus, runPreflight, pollIntervalMs]);

  const selectProfile = useCallback(
    (id: string) => {
      selectedProfileIdRef.current = id;
      setSelectedProfileIdState(id);
      void runPreflight(id);
    },
    [runPreflight]
  );

  const handleStart = useCallback(
    async (allowReal = false, overrideProfileId?: string) => {
      if (!isDesktopShell || startInFlightRef.current) return;

      startInFlightRef.current = true;
      const targetProfile = overrideProfileId || selectedProfileIdRef.current || "default";

      // The target is the operator's intent even if startup fails. This
      // prevents the next poll from silently reverting to the last profile.
      selectedProfileIdRef.current = targetProfile;
      setSelectedProfileIdState(targetProfile);
      setIsStarting(true);
      setErrorMessage(null);

      try {
        const result = await supervisor.startEngine({
          profile: targetProfile,
          mode: allowReal ? "real" : "simulated",
          allow_real_runtime: allowReal,
        });

        if (result.preflight) {
          setPreflight(result.preflight);
        }
        setEngineStatus(result.status);

        if (!result.success) {
          setErrorMessage(result.message || "Engine startup failed.");
          await runPreflight(targetProfile);
          return;
        }

        const active = result.status.active_profile || targetProfile;
        selectedProfileIdRef.current = active;
        setSelectedProfileIdState(active);
        setActiveProfileId(active);
        lastActiveProfileRef.current = active;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Auto-fallback: if default cluster fails on RAM headroom guard and
        // the standalone profile is available, try it.
        if (
          targetProfile === "default" &&
          (msg.toLowerCase().includes("headroom warning") ||
            msg.toLowerCase().includes("free ram"))
        ) {
          try {
            console.info(
              "Default cluster RAM headroom restricted; automatically attempting fallback to low_memory_cuda_standalone..."
            );
            const fallback = await supervisor.startEngine({
              profile: "low_memory_cuda_standalone",
              mode: allowReal ? "real" : "simulated",
              allow_real_runtime: allowReal,
            });

            if (fallback.preflight) {
              setPreflight(fallback.preflight);
            }
            setEngineStatus(fallback.status);

            if (fallback.success) {
              selectedProfileIdRef.current = "low_memory_cuda_standalone";
              setSelectedProfileIdState("low_memory_cuda_standalone");
              setActiveProfileId(
                fallback.status.active_profile || "low_memory_cuda_standalone"
              );
              lastActiveProfileRef.current =
                fallback.status.active_profile || "low_memory_cuda_standalone";
              setErrorMessage(null);
              return;
            }
          } catch (fallbackErr) {
            console.warn(
              "Fallback to low_memory_cuda_standalone also failed:",
              fallbackErr
            );
          }
        }

        setErrorMessage(msg);
        await runPreflight(targetProfile);
      } finally {
        startInFlightRef.current = false;
        setIsStarting(false);
        await refreshStatus();
      }
    },
    [refreshStatus, runPreflight]
  );

  const handleStop = useCallback(async () => {
    if (!isDesktopShell || stopInFlightRef.current) return;

    stopInFlightRef.current = true;
    setIsStopping(true);
    setErrorMessage(null);

    try {
      const status = await supervisor.stopEngine();
      setEngineStatus(status);
      setActiveProfileId(null);
      lastActiveProfileRef.current = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
    } finally {
      stopInFlightRef.current = false;
      setIsStopping(false);
      await refreshStatus();
    }
  }, [refreshStatus]);

  const handleCancel = useCallback(async () => {
    if (!isDesktopShell) return;
    try {
      await supervisor.cancelStartup();
    } catch (err) {
      console.warn("Cancel startup failed:", err);
    } finally {
      await refreshStatus();
    }
  }, [refreshStatus]);

  const selectedProfile = useMemo(
    () =>
      profiles.find((profile) => profile.id === selectedProfileId) ||
      profiles.find((profile) => profile.is_default) ||
      null,
    [profiles, selectedProfileId]
  );

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) || null,
    [profiles, activeProfileId]
  );

  return {
    isDesktop: isDesktopShell,
    engineStatus,
    profiles,
    selectedProfileId,
    selectedProfile,
    activeProfileId,
    activeProfile,
    preflight,
    isStarting,
    isStopping,
    errorMessage,
    setErrorMessage,
    setSelectedProfileId: selectProfile,
    startEngine: handleStart,
    stopEngine: handleStop,
    cancelStartup: handleCancel,
    refreshStatus,
    runPreflight,
  };
}

export function SupervisorProvider({
  children,
  pollIntervalMs = 3000,
}: {
  children: ReactNode;
  pollIntervalMs?: number;
}) {
  const state = useSupervisorState(pollIntervalMs);
  return createElement(SupervisorContext.Provider, { value: state }, children);
}

export function useSupervisor(_pollIntervalMs = 3000): SupervisorState {
  const state = useContext(SupervisorContext);
  if (!state) {
    throw new Error("useSupervisor must be used inside a SupervisorProvider.");
  }
  return state;
}
