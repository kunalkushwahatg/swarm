import type { ReactNode } from "react";
import { MessageSquare, HardDrive, Layers, Settings, Server, Boxes } from "lucide-react";

export type View = "chat" | "devices" | "models" | "session" | "worker" | "settings";

interface NavItemProps {
  id: string;
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}

function NavItem({ id, icon, label, active, onClick }: NavItemProps) {
  return (
    <button
      id={id}
      onClick={onClick}
      className={`nav-btn ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      <span className="nav-btn-icon">
        {icon}
      </span>
      <span className="nav-btn-label">{label}</span>
    </button>
  );
}

interface SidebarProps {
  current: View;
  onChange: (v: View) => void;
}

export function Sidebar({ current, onChange }: SidebarProps) {
  return (
    <nav className="app-sidebar" aria-label="Main Navigation">
      <div className="sidebar-nav-primary">
        <NavItem
          id="nav-chat"
          icon={<MessageSquare size={16} />}
          label="Chat"
          active={current === "chat"}
          onClick={() => onChange("chat")}
        />
        <NavItem
          id="nav-models"
          icon={<Boxes size={16} />}
          label="Models"
          active={current === "models"}
          onClick={() => onChange("models")}
        />
        <NavItem
          id="nav-devices"
          icon={<HardDrive size={16} />}
          label="Devices"
          active={current === "devices"}
          onClick={() => onChange("devices")}
        />
        <NavItem
          id="nav-worker"
          icon={<Server size={16} />}
          label="Share Compute"
          active={current === "worker"}
          onClick={() => onChange("worker")}
        />
        <NavItem
          id="nav-session"
          icon={<Layers size={16} />}
          label="Session"
          active={current === "session"}
          onClick={() => onChange("session")}
        />
      </div>

      <div className="sidebar-nav-spacer" />

      <div className="sidebar-nav-secondary">
        <NavItem
          id="nav-settings"
          icon={<Settings size={16} />}
          label="Settings"
          active={current === "settings"}
          onClick={() => onChange("settings")}
        />
      </div>
    </nav>
  );
}
