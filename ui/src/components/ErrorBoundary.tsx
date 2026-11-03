import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("UI Uncaught Exception caught by ErrorBoundary:", error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "24px", margin: "16px", borderRadius: "var(--radius)", background: "var(--color-surface)", border: "1px solid var(--color-error)", color: "var(--color-text)", maxWidth: "560px", marginLeft: "auto", marginRight: "auto", boxShadow: "0 4px 16px rgba(32,40,33,0.08)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "var(--color-error)", fontWeight: 600, fontSize: "14px", marginBottom: "12px" }}>
            <span style={{ fontSize: "18px" }}>⚠</span>
            <span>{this.props.fallbackTitle || "An unexpected UI error occurred"}</span>
          </div>

          <div style={{ fontSize: "12px", color: "var(--color-text-2)", background: "var(--color-surface-subtle)", padding: "12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)", fontFamily: "var(--font-mono)", wordBreak: "break-word", maxHeight: "160px", overflowY: "auto" }}>
            {this.state.error?.message || String(this.state.error)}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "16px" }}>
            <button
              type="button"
              onClick={this.handleReset}
              className="btn-primary"
              style={{ padding: "6px 14px", fontSize: "12px" }}
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
