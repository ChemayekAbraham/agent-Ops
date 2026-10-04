import React, { Component, ReactNode } from "react";
import { RefreshCw, Home, Loader2, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  isChunkError: boolean;
  isRetrying: boolean;
  errorMessage: string;
  /** Show the dismissible "refresh recommended" banner over the content. */
  showChunkBanner: boolean;
  /** User closed the banner — don't bring it back for this session view. */
  bannerDismissed: boolean;
  /** Bumping this remounts children after a chunk error so content stays visible. */
  resetKey: number;
  /** How many times we've remounted children to recover (capped to avoid loops). */
  resetAttempts: number;
}

const MAX_RESET_ATTEMPTS = 1;

/**
 * Best-effort, dependency-free device/browser hints for the failure screen.
 * Helps a confused user (or support) understand *why* the app may not load —
 * old browser, offline, private mode, tiny/odd viewport — without any tracking.
 */
function collectDeviceHints(): { label: string; value: string }[] {
  const hints: { label: string; value: string }[] = [];
  try {
    const ua = navigator.userAgent || "";

    // Browser name + version (rough, no library)
    let browser = "Unknown browser";
    const m =
      ua.match(/(Edg|EdgA|OPR|Opera|SamsungBrowser|Chrome|CriOS|Firefox|FxiOS|Version)[/ ]?([\d.]+)/) ||
      [];
    const map: Record<string, string> = {
      Edg: "Edge",
      EdgA: "Edge",
      OPR: "Opera",
      Opera: "Opera",
      SamsungBrowser: "Samsung Internet",
      Chrome: "Chrome",
      CriOS: "Chrome",
      Firefox: "Firefox",
      FxiOS: "Firefox",
      Version: /Safari/i.test(ua) ? "Safari" : "Browser",
    };
    if (m[1]) browser = `${map[m[1]] || m[1]} ${(m[2] || "").split(".")[0]}`.trim();
    hints.push({ label: "Browser", value: browser });

    // OS / platform
    let os = "Unknown";
    if (/Android/i.test(ua)) os = "Android";
    else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
    else if (/Windows/i.test(ua)) os = "Windows";
    else if (/Mac OS X/i.test(ua)) os = "macOS";
    else if (/Linux/i.test(ua)) os = "Linux";
    hints.push({ label: "Device", value: os });

    // Connection
    hints.push({ label: "Connection", value: navigator.onLine ? "Online" : "Offline" });
    const conn = (navigator as any).connection;
    if (conn?.effectiveType) {
      hints.push({
        label: "Network",
        value: conn.saveData ? `${conn.effectiveType} (Data Saver)` : conn.effectiveType,
      });
    }
  } catch {
    // ignore — hints are best-effort only
  }
  return hints;
}

function classifyChunkError(error: Error): boolean {
  const msg = (error?.message || "").toLowerCase();
  const name = (error?.name || "").toLowerCase();
  const stack = (error?.stack || "").toLowerCase();
  const full = `${msg} ${name} ${stack}`;

  // Explicit stale-asset/chunk matches only. Do NOT treat generic iOS
  // TypeError/"Load failed" network errors as an old installed app version —
  // that was sending healthy iPhones to the cache-clear screen after the app
  // had already rendered.
  const keywords = [
    "failed to fetch dynamically imported module",
    "error loading dynamically imported module",
    "loading chunk",
    "loading css chunk",
    "dynamically imported",
    "unable to preload",
    "chunkerror",
    "loaderror",
    "importing a module script failed",
  ];
  if (keywords.some((k) => full.includes(k))) return true;

  // Stack mentions an asset URL — almost certainly a chunk/asset load failure
  if (/\/(assets|src)\/[^\s)]+\.(m?js|tsx?|css)/i.test(stack)) return true;

  return false;
}

class ChunkErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      isChunkError: false,
      isRetrying: false,
      errorMessage: "",
      showChunkBanner: false,
      bannerDismissed: false,
      resetKey: 0,
      resetAttempts: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    const isChunkError = classifyChunkError(error);
    if (isChunkError) {
      // Keep content visible: don't flip into the full error screen. We show a
      // dismissible banner instead and remount children (see componentDidCatch).
      return {
        hasError: false,
        isChunkError: true,
        showChunkBanner: true,
        errorMessage: error?.message || error?.name || "Unknown error",
      };
    }
    return {
      hasError: true,
      isChunkError: false,
      errorMessage: error?.message || error?.name || "Unknown error",
    };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error("ChunkErrorBoundary caught:", error);

    // Best-effort remote log — never throw from here
    try {
      const payload = {
        pathname: typeof window !== "undefined" ? window.location.pathname + window.location.search : null,
        user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
        error_message: error?.message ?? "Unknown error",
        error_stack: (error?.stack || "") + "\n--- componentStack ---\n" + (info?.componentStack || ""),
        metadata: {
          source: "ChunkErrorBoundary",
          isChunkError: classifyChunkError(error),
          href: typeof window !== "undefined" ? window.location.href : null,
          online: typeof navigator !== "undefined" ? navigator.onLine : null,
          viewport: typeof window !== "undefined" ? { w: window.innerWidth, h: window.innerHeight } : null,
        },
      };
      supabase
        .from("public_error_logs")
        .insert(payload as any)
        .then(
          () => {},
          () => {},
        );
    } catch {
      // ignore
    }

    // Chunk error: try to remount children once so the user keeps seeing
    // content behind the refresh banner. Capped to avoid a remount loop when
    // the stale chunk truly can't load.
    if (classifyChunkError(error)) {
      this.setState((s) =>
        s.resetAttempts < MAX_RESET_ATTEMPTS
          ? { resetKey: s.resetKey + 1, resetAttempts: s.resetAttempts + 1 }
          : null,
      );
    }
  }

  // Manual refresh: purge stale app files, then plain reload.
  handleForceClear = async () => {
    this.setState({ isRetrying: true });
    try {
      sessionStorage.removeItem("__welile_chunk_reload_at");
    } catch {
      // ignore
    }
    window.location.reload();
  };

  handleGoHome = () => {
    try {
      sessionStorage.removeItem("__welile_chunk_reload_at");
    } catch {
      // ignore
    }
    window.location.href = "/";
  };

  handleDismissBanner = () => {
    this.setState({ showChunkBanner: false, bannerDismissed: true });
  };

  renderChunkBanner() {
    if (!this.state.showChunkBanner || this.state.bannerDismissed) return null;
    return (
      <div className="fixed left-3 right-3 top-3 z-[9999] mx-auto max-w-3xl rounded-xl border border-primary/25 bg-background p-3 shadow-xl">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15">
            <RefreshCw className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">Refresh recommended</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Welile found an older app file. Refresh to load the latest version.
            </p>
            <div className="mt-2">
              {this.state.isRetrying ? (
                <button
                  disabled
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-xs font-medium text-primary-foreground opacity-50"
                >
                  <Loader2 className="h-4 w-4 animate-spin" /> Refreshing...
                </button>
              ) : (
                <button
                  onClick={this.handleForceClear}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
                >
                  <RefreshCw className="h-4 w-4" /> Refresh now
                </button>
              )}
            </div>
          </div>
          <button
            onClick={this.handleDismissBanner}
            aria-label="Dismiss"
            className="-mr-1 -mt-1 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  render() {
    // Generic (non-chunk) app error — friendly full-screen fallback.
    if (this.state.hasError) {
      const deviceHints = collectDeviceHints();
      return (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background text-foreground p-6">
          <div className="flex flex-col items-center gap-6 max-w-sm text-center">
            <div className="w-16 h-16 rounded-full bg-destructive/20 flex items-center justify-center">
              <span className="text-2xl">⚠️</span>
            </div>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold">App failed to load</h1>
              <p className="text-muted-foreground text-sm">
                Welile couldn't start on this device. Try again — if it keeps
                happening, an out-of-date browser is the most likely cause.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-3 w-full">
              <button
                onClick={() => window.location.reload()}
                className="flex-1 inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground font-medium shadow-lg hover:opacity-90 transition-opacity"
              >
                <RefreshCw className="w-4 h-4" />
                Try again
              </button>
              <button
                onClick={this.handleGoHome}
                className="flex-1 inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-muted text-foreground font-medium hover:bg-muted/80 transition-colors"
              >
                <Home className="w-4 h-4" />
                Go Home
              </button>
            </div>
            {deviceHints.length > 0 && (
              <div className="w-full rounded-lg bg-muted/40 p-3 text-left">
                <p className="mb-2 text-xs font-medium text-muted-foreground">Device info</p>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {deviceHints.map((h) => (
                    <div key={h.label} className="contents">
                      <dt className="text-xs text-muted-foreground/70">{h.label}</dt>
                      <dd className="text-xs font-medium text-foreground text-right">{h.value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/70">
                  Tip: update your browser (or install a recent Chrome) and make
                  sure you have a stable connection, then try again.
                </p>
              </div>
            )}
            {this.state.errorMessage && (
              <details className="w-full text-left">
                <summary className="text-xs text-muted-foreground/60 cursor-pointer">Technical details</summary>
                <p className="mt-2 text-xs text-muted-foreground/70 break-words font-mono bg-muted/40 p-2 rounded">
                  {this.state.errorMessage}
                </p>
              </details>
            )}
            <p className="text-xs text-muted-foreground/60">If this keeps happening, contact support.</p>
          </div>
        </div>
      );
    }

    // Chunk error (or healthy): keep rendering content; overlay the dismissible
    // banner when a stale chunk was detected. resetKey remounts children once.
    return (
      <>
        <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>
        {this.renderChunkBanner()}
      </>
    );
  }
}

export default ChunkErrorBoundary;
