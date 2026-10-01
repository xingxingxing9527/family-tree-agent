import React, { Component, type ErrorInfo, type JSX, type ReactNode } from "react";

interface ErrorBoundaryProps { children: ReactNode; }
interface ErrorBoundaryState { failed: boolean; diagnosticId: string; }

const diagnosticId = (): string => {
  const value = globalThis.crypto?.randomUUID?.() ?? `UI-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return value.toUpperCase();
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false, diagnosticId: "" };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true, diagnosticId: diagnosticId() };
  }

  componentDidCatch(_error: Error, _details: ErrorInfo): void {
    // Intentionally do not persist renderer exceptions: they can contain paths, keys, or family facts.
  }

  private recover = (): void => {
    this.setState({ failed: false, diagnosticId: "" });
    window.location.hash = "#/";
  };

  render(): JSX.Element {
    if (!this.state.failed) return <>{this.props.children}</>;
    return (
      <main className="fatal-error" aria-labelledby="fatal-error-title">
        <section className="state-card" role="alert">
          <h1 id="fatal-error-title">界面暂时无法显示</h1>
          <p>你的家谱资料没有在此处显示。请返回首页后重试。</p>
          <p>诊断编号：{this.state.diagnosticId}</p>
          <button className="button primary-button" type="button" onClick={this.recover}>返回首页</button>
        </section>
      </main>
    );
  }
}
