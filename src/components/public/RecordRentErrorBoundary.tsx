import { Component, type ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

/**
 * Local error boundary for the public /record-rent page.
 * - Shows a friendly retry UI (no app shell, no auth dependencies)
 * - Logs errors to public_error_logs so we can debug device-specific failures
 *   (especially WhatsApp / Instagram in-app browsers on iOS).
 */
export default class RecordRentErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, errorMessage: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error?.message || 'Unknown error' };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // Best-effort remote logging — never throw from here
    try {
      const payload = {
        pathname: typeof window !== 'undefined' ? window.location.pathname + window.location.search : null,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        error_message: error?.message ?? 'Unknown error',
        error_stack: (error?.stack || '') + '\n--- componentStack ---\n' + (info?.componentStack || ''),
        metadata: {
          href: typeof window !== 'undefined' ? window.location.href : null,
          referrer: typeof document !== 'undefined' ? document.referrer : null,
          language: typeof navigator !== 'undefined' ? navigator.language : null,
          online: typeof navigator !== 'undefined' ? navigator.onLine : null,
          viewport: typeof window !== 'undefined'
            ? { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }
            : null,
        },
      };
      // Fire and forget
      supabase.from('public_error_logs').insert(payload as any).then(() => {}, () => {});
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-console
    console.error('[RecordRent] crash:', error, info);
  }

  handleRetry = () => {
    // Clear caches + SWs then reload — guarantees a clean slate on stale devices
    try {
      if ('caches' in window) {
        caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).catch(() => {});
      }
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then((regs) => {
          regs.forEach((r) => r.unregister());
        }).catch(() => {});
      }
    } catch {
      // ignore
    }
    setTimeout(() => window.location.reload(), 150);
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f8fafc',
          padding: 24,
          textAlign: 'center',
          gap: 16,
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        }}
      >
        <img
          src="/welile-logo.png"
          alt="Welile"
          width={56}
          height={56}
          style={{ borderRadius: 14 }}
        />
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', margin: 0 }}>
          We had a hiccup
        </h1>
        <p style={{ fontSize: 14, color: '#475569', margin: 0, maxWidth: 320 }}>
          Don't worry — your data is safe. Tap below to try again.
        </p>
        <button
          onClick={this.handleRetry}
          style={{
            padding: '14px 28px',
            background: '#7c3aed',
            color: '#fff',
            border: 'none',
            borderRadius: 10,
            fontSize: 15,
            fontWeight: 600,
            cursor: 'pointer',
            minHeight: 48,
            minWidth: 200,
          }}
        >
          Tap to try again
        </button>
        <p style={{ fontSize: 11, color: '#94a3b8', margin: 0, maxWidth: 320, wordBreak: 'break-word' }}>
          {this.state.errorMessage}
        </p>
      </div>
    );
  }
}
