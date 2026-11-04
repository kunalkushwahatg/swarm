import { useState, useEffect } from "react";
import { TopBar } from "./components/TopBar";
import { Sidebar, type View } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { DevicesPanel } from "./components/DevicesPanel";
import { SessionPanel } from "./components/SessionPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { WorkerPanel } from "./components/WorkerPanel";
import { ModelLibraryPanel } from "./components/models/ModelLibraryPanel";
import { GlobalModelSwitchDialog } from "./components/models/GlobalModelSwitchDialog";
import { ClusterStartupModal } from "./components/ClusterStartupModal";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SupervisorProvider } from "./hooks/useSupervisor";
import { SwarmSessionProvider } from "./hooks/useSwarmSession";

import { isAndroid } from "./lib/platform";

function AppContent() {
  const [view, setView] = useState<View>(() => {
    const hash = window.location.hash.replace("#", "") as View;
    if (hash === "devices" || hash === "models" || hash === "session" || hash === "settings" || hash === "worker" || hash === "chat") {
      return hash;
    }
    return isAndroid ? "worker" : "chat";
  });

  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash.replace("#", "") as View;
      if (hash === "devices" || hash === "models" || hash === "session" || hash === "settings" || hash === "chat" || hash === "worker") {
        setView(hash);
      }
    };
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  const handleViewChange = (v: View) => {
    window.location.hash = v;
    setView(v);
  };

  // Keep every panel mounted so local view state (chat transcript, draft,
  // worker edits, modal state, scroll position) survives navigation.
  const panels = [
    { id: "chat" as View, title: "Chat", node: <ChatPanel /> },
    { id: "models" as View, title: "Model Library", node: <ModelLibraryPanel /> },
    { id: "devices" as View, title: "Devices", node: <DevicesPanel /> },
    {
      id: "worker" as View,
      title: "Share Compute",
      node: <WorkerPanel onSwitchToInference={() => handleViewChange("chat")} />,
    },
    { id: "session" as View, title: "Session", node: <SessionPanel /> },
    { id: "settings" as View, title: "Settings", node: <SettingsPanel /> },
  ];

  return (
    <div className="app-shell">
      {/* Top sticky session bar */}
      <TopBar onSelectView={handleViewChange} />

      {/* Cluster Startup & Model Streaming HUD */}
      <ClusterStartupModal />

      {/* In-place model switch confirmation (keeps current view intact) */}
      <GlobalModelSwitchDialog />

      {/* Responsive layout container */}
      <div className="app-body">
        {/* Responsive Navigation Sidebar / Bottom Nav on mobile */}
        <Sidebar
          current={view}
          onChange={handleViewChange}
        />

        {/* Main Content Area */}
        <main className="app-main">
          {panels.map((panel) => {
            const isActive = view === panel.id;
            return (
              <div
                key={panel.id}
                style={{ display: isActive ? "contents" : "none" }}
                aria-hidden={!isActive}
              >
                <ErrorBoundary
                  fallbackTitle={`An error occurred while loading ${panel.title}`}
                >
                  {panel.node}
                </ErrorBoundary>
              </div>
            );
          })}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary fallbackTitle="Swarm Desktop UI encountered an error">
      <SupervisorProvider pollIntervalMs={3000}>
        <SwarmSessionProvider pollIntervalMs={3000}>
          <AppContent />
        </SwarmSessionProvider>
      </SupervisorProvider>
    </ErrorBoundary>
  );
}
