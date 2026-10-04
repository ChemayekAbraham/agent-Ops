import { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Short label for the failed widget (e.g. "Recent activity"). */
  label?: string;
  /** Optional retry handler — when provided, a Retry button is shown. */
  onRetry?: () => void;
  /** Custom fallback overrides the default card. */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  message?: string;
}

/**
 * Isolates a single dashboard widget so that a runtime error or failed data
 * fetch in that widget does not blank out the entire dashboard.
 * The rest of the page keeps rendering; only this card shows the error state.
 */
export class WidgetErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error(
      `[WidgetErrorBoundary] ${this.props.label ?? 'widget'} crashed:`,
      error,
      info.componentStack,
    );
  }

  handleRetry = () => {
    this.setState({ hasError: false, message: undefined });
    this.props.onRetry?.();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div
        role="alert"
        className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-left"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-destructive">
              {this.props.label ?? 'This section'} couldn't load
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 break-words">
              {this.state.message ?? 'Something went wrong while loading this widget.'}
            </p>
            {this.props.onRetry && (
              <button
                type="button"
                onClick={this.handleRetry}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors"
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}