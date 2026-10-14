import { useState, useEffect } from "react";
import { TopBar } from "./components/TopBar";
import { Sidebar, type View } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { DevicesPanel } from "./components/DevicesPanel";
import { SessionPanel } from "./components/SessionPanel";
import { SettingsPanel } from "./components/SettingsPanel";

function AppContent() {
  const [view, setView] = useState<View>(() => {
    const hash = window.location.hash.replace("#", "") as View;
    if (hash === "devices" || hash === "session" || hash === "settings") {
      return hash;
    }
    return "chat";
  });

  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash.replace("#", "") as View;
      if (hash === "devices" || hash === "session" || hash === "settings" || hash === "chat") {
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

  return (
    <div className="app-shell">
      {/* Top sticky session bar */}
      <TopBar onSelectView={handleViewChange} />

      {/* Responsive layout container */}
      <div className="app-body">
        {/* Responsive Navigation Sidebar / Bottom Nav on mobile */}
        <Sidebar
          current={view}
          onChange={handleViewChange}
        />

        {/* Main Content Area */}
        <main className="app-main">
          {view === "chat" && <ChatPanel />}
          {view === "devices" && <DevicesPanel />}
          {view === "session" && <SessionPanel />}
          {view === "settings" && <SettingsPanel />}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return <AppContent />;
}
