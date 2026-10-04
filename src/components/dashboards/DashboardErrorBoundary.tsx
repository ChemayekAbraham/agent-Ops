import { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Send, Check, Copy } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useQueryClient } from '@tanstack/react-query';
import { reportClientError } from '@/lib/errorReporting';

interface Props {
  children: ReactNode;
  /** Friendly role label shown in the fallback, e.g. "agent dashboard". */
  label?: string;
  /** When this value changes, the boundary automatically clears its error state. */
  resetKey?: string | number;
  /**
   * Called when the user clicks "Try again". Use this to refetch data,
   * invalidate caches, etc. Boundary state is cleared after this resolves.
   */
  onReset?: () => void | Promise<void>;
  /** Captured automatically and used for "Report this error". */
  reportContext?: {
    userId?: string | null;
    role?: string | null;
    route?: string;
  };
}

interface State {
  hasError: boolean;
  message?: string;
  componentStack?: string;
  reportState?: 'idle' | 'sending' | 'sent' | 'failed';
  copyState?: 'idle' | 'copied' | 'failed';
}

/**
 * Full-screen error boundary for a role dashboard. Prevents a single render
 * error inside the dashboard subtree from blanking out the whole app — instead
 * the user sees a readable message with Reload / Sign out actions.
 */
export class DashboardErrorBoundaryInner extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error(
      `[DashboardErrorBoundary] ${this.props.label ?? 'dashboard'} crashed:`,
      error,
      info.componentStack,
    );
    this.setState({ componentStack: info.componentStack, reportState: 'idle' });
    // Auto-capture into the central pipeline so route + role tags are recorded
    // even if the user never clicks "Report this error".
    void reportClientError({
      source: 'dashboard-error-boundary',
      label: this.props.label ?? null,
      message: error?.message ?? null,
      stack: error?.stack ?? null,
      componentStack: info.componentStack,
      extra: { auto: true },
    });
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, message: undefined, componentStack: undefined, reportState: 'idle' });
    }
  }

  handleTryAgain = async () => {
    try {
      await this.props.onReset?.();
    } catch (err) {
      console.error('[DashboardErrorBoundary] onReset failed:', err);
    }
    this.setState({ hasError: false, message: undefined, componentStack: undefined, reportState: 'idle' });
  };

  handleReportError = async () => {
    if (this.state.reportState === 'sending' || this.state.reportState === 'sent') return;
    this.setState({ reportState: 'sending' });
    const ok = await reportClientError({
      source: 'manual',
      label: this.props.label ?? null,
      message: this.state.message ?? null,
      componentStack: this.state.componentStack ?? null,
      extra: { manual: true },
    });
    this.setState({ reportState: ok ? 'sent' : 'failed' });
  };

  handleCopyDetails = async () => {
    const ctx = this.props.reportContext ?? {};
    const route =
      ctx.route ?? (typeof window !== 'undefined' ? window.location.pathname : 'unknown');
    const href = typeof window !== 'undefined' ? window.location.href : 'unknown';
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
    const details = [
      `Welile error report — ${new Date().toISOString()}`,
      `Label:       ${this.props.label ?? 'dashboard'}`,
      `Route:       ${route}`,
      `URL:         ${href}`,
      `User ID:     ${ctx.userId ?? 'anonymous'}`,
      `Role:        ${ctx.role ?? 'none'}`,
      `User-Agent:  ${ua}`,
      '',
      `Message:`,
      this.state.message ?? '(no message)',
      '',
      `Component stack:`,
      this.state.componentStack?.trim() || '(unavailable)',
    ].join('\n');

    const writeViaClipboardAPI = async () => {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(details);
        return true;
      }
      return false;
    };

    const writeViaTextarea = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = details;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    };

    let ok = false;
    try {
      ok = await writeViaClipboardAPI();
    } catch {
      ok = false;
    }
    if (!ok) ok = writeViaTextarea();

    this.setState({ copyState: ok ? 'copied' : 'failed' });
    setTimeout(() => {
      this.setState((s) => (s.copyState ? { ...s, copyState: 'idle' } : s));
    }, 2500);
  };

  handleReload = () => {
    try { window.location.reload(); } catch { /* ignore */ }
  };

  handleHardReload = () => {
    try {
      // Clear caches that commonly cause stuck broken states for field agents.
      Object.keys(localStorage).forEach((k) => {
        if (k.startsWith('agent-listings:') || k.startsWith('welile-')) {
          try { localStorage.removeItem(k); } catch { /* ignore */ }
        }
      });
    } catch { /* ignore */ }
    try { window.location.href = '/'; } catch { /* ignore */ }
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        role="alert"
        className="min-h-screen w-full flex items-center justify-center bg-background px-5 py-10"
      >
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold text-foreground">
                Your {this.props.label ?? 'dashboard'} couldn't load
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Something went wrong while loading this page. Your data is safe — please reload to try again.
              </p>
              {this.state.message && (
                <p className="mt-2 text-xs text-muted-foreground break-words">
                  Details: {this.state.message}
                </p>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={this.handleTryAgain}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  <RefreshCw className="h-4 w-4" />
                  Try again
                </button>
                <button
                  type="button"
                  onClick={this.handleReload}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted transition-colors"
                >
                  Reload
                </button>
                <button
                  type="button"
                  onClick={this.handleHardReload}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted transition-colors"
                >
                  Clear cache &amp; restart
                </button>
                <button
                  type="button"
                  onClick={this.handleReportError}
                  disabled={this.state.reportState === 'sending' || this.state.reportState === 'sent'}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {this.state.reportState === 'sent' ? (
                    <>
                      <Check className="h-4 w-4" />
                      Reported
                    </>
                  ) : this.state.reportState === 'sending' ? (
                    <>
                      <Send className="h-4 w-4 animate-pulse" />
                      Sending…
                    </>
                  ) : this.state.reportState === 'failed' ? (
                    <>
                      <Send className="h-4 w-4" />
                      Retry report
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4" />
                      Report this error
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={this.handleCopyDetails}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted transition-colors"
                >
                  {this.state.copyState === 'copied' ? (
                    <>
                      <Check className="h-4 w-4" />
                      Copied
                    </>
                  ) : this.state.copyState === 'failed' ? (
                    <>
                      <Copy className="h-4 w-4" />
                      Copy failed
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" />
                      Copy error details
                    </>
                  )}
                </button>
              </div>
              {this.state.reportState === 'failed' && (
                <p className="mt-2 text-xs text-destructive">
                  Couldn't send the report. Please try again.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
}

/**
 * Route-aware wrapper: forwards the current pathname as `resetKey`, so the
 * boundary clears its error state automatically when the user navigates away.
 */
export function DashboardErrorBoundary(props: Props) {
  const location = useLocation();
  const { user, role } = useAuth();
  const queryClient = useQueryClient();
  const autoKey = `${location.pathname}|${user?.id ?? 'anon'}|${role ?? 'none'}`;
  const handleReset = async () => {
    if (props.onReset) {
      await props.onReset();
      return;
    }
    // Default: invalidate all React Query caches so the dashboard refetches
    // fresh data when it re-mounts after the boundary clears.
    await queryClient.invalidateQueries();
  };
  return (
    <DashboardErrorBoundaryInner
      {...props}
      resetKey={props.resetKey ?? autoKey}
      onReset={handleReset}
      reportContext={props.reportContext ?? {
        userId: user?.id ?? null,
        role: role ?? null,
        route: location.pathname,
      }}
    />
  );
}

export default DashboardErrorBoundary;