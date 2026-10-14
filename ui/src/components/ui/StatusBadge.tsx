import { cn } from "../../lib/utils";

type Variant = "ok" | "busy" | "error" | "idle" | "warn";

interface StatusBadgeProps {
  variant: Variant;
  label: string;
  dot?: boolean;
  className?: string;
}

export function StatusBadge({ variant, label, dot = true, className }: StatusBadgeProps) {
  return (
    <span className={cn(`badge badge-${variant}`, className)}>
      {dot && <span className={cn("dot", `dot-${variant}`)} />}
      {label}
    </span>
  );
}

interface ConnectionIndicatorProps {
  online: boolean;
  label?: string;
}

export function ConnectionIndicator({ online, label }: ConnectionIndicatorProps) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("dot", online ? "dot-ok" : "dot-error")} />
      {label && (
        <span style={{ fontSize: 12, color: "var(--color-text-2)" }}>{label}</span>
      )}
    </span>
  );
}
