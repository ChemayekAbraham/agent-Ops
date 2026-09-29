import { createElement, lazy, type ComponentType } from "react";

/**
 * Concurrency-limited dynamic import queue.
 *
 * On slow networks (2G/3G in the field), Vite/React can fan out dozens of
 * lazy chunk requests in parallel when a route mounts (providers + page +
 * deferred extras + preloads). The browser's 6-connection-per-host limit
 * then makes every request slower, increases the chance any one of them
 * times out, and trips the "Connection Error" fallback.
 *
 * We funnel all dynamic imports through a tiny FIFO queue so the network
 * stays healthy. The limit is tuned to the user's effective connection.
 */

function getImportConcurrency(): number {
  if (typeof navigator === "undefined") return 4;
  const conn = (navigator as any).connection;
  if (!conn) return 4;
  if (conn.saveData) return 1;
  switch (conn.effectiveType) {
    case "slow-2g":
    case "2g":
      return 1;
    case "3g":
      return 2;
    case "4g":
    default:
      return 4;
  }
}

let active = 0;
const queue: Array<() => void> = [];
const EmptyComponent = (() => null) as ComponentType<any>;

/**
 * One-time hard reload to recover from stale/rotated chunks after a deploy.
 * Guarded by sessionStorage so we never trap the user in a reload loop.
 */
/**
 * Once a reload is under way, keep Suspense on its spinner until the page goes.
 * Throwing here instead hands the error to the dashboard error boundary, which
 * flashes the crash screen and files a client_error_reports row for what is
 * actually a successful recovery (doc 159).
 */
const untilReload = <T,>() => new Promise<T>(() => {});

function reloadOnceForStaleChunk(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const KEY = "welile:lazy-reload-at";
    const last = Number(sessionStorage.getItem(KEY) || 0);
    // Only reload if we haven't already done so in the last 30s.
    if (Date.now() - last > 30_000) {
      sessionStorage.setItem(KEY, String(Date.now()));
      window.location.reload();
      return true;
    }
  } catch {
    /* ignore storage errors */
  }
  return false;
}

/**
 * Shown instead of a blank screen when a chunk cannot be resolved and we have
 * already used our one-time reload. Gives the user an explicit way out.
 */
const StaleChunkFallback = (() =>
  createElement(
    "div",
    {
      style: {
        padding: "24px",
        textAlign: "center",
        fontFamily: "system-ui, sans-serif",
      },
    },
    createElement("p", { style: { marginBottom: "12px" } }, "This screen needs to reload."),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => {
          try {
            sessionStorage.removeItem("welile:lazy-reload-at");
          } catch {
            /* ignore */
          }
          window.location.reload();
        },
        style: {
          padding: "10px 18px",
          borderRadius: "8px",
          border: "1px solid currentColor",
          background: "transparent",
          cursor: "pointer",
        },
      },
      "Reload app",
    ),
  )) as ComponentType<any>;

function hasValidDefault<T extends ComponentType<any>>(
  mod: { default?: T | null } | null | undefined,
): mod is { default: T } {
  const candidate = mod?.default;
  return typeof candidate === "function" || typeof candidate === "object";
}

/**
 * Some bundler/chunk edge cases (interop wrappers, namespace re-exports) hand us
 * a module whose `default` is missing even though the component is present as a
 * named export. Recover by picking the single component-like export instead of
 * crashing the whole route to a blank screen.
 */
function coerceModule<T extends ComponentType<any>>(
  mod: any,
): { default: T } | null {
  if (!mod) return null;
  if (hasValidDefault(mod)) return mod as { default: T };
  // CJS/interop wrapper: the real module namespace lives under `default`.
  const inner = mod.default;
  if (inner && typeof inner === "object" && hasValidDefault(inner)) {
    return inner as { default: T };
  }
  // Accept plain function components AND memo/forwardRef wrappers (objects
  // carrying a React `$$typeof` marker).
  const isComponentLike = (v: any) =>
    typeof v === "function" || (v && typeof v === "object" && "$$typeof" in v);
  const candidates = Object.keys(mod).filter(
    (k) => k !== "default" && /^[A-Z]/.test(k) && isComponentLike(mod[k]),
  );
  if (candidates.length === 1) return { default: mod[candidates[0]] as T };
  return null;
}

function next() {
  if (active >= getImportConcurrency()) return;
  const job = queue.shift();
  if (!job) return;
  active++;
  job();
}

/**
 * Wrap any dynamic import so it waits its turn in the global import queue.
 * Resolves/rejects with the same value as the underlying factory.
 */
export function queuedImport<T>(factory: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      factory()
        .then(resolve, reject)
        .finally(() => {
          active = Math.max(0, active - 1);
          // Drain on next tick to avoid deep sync chains
          setTimeout(next, 0);
        });
    };
    queue.push(run);
    next();
  });
}

/**
 * Wraps React.lazy with:
 *  1. A concurrency-limited import queue (prevents slow-network overload).
 *  2. Automatic retry on transient chunk-load failures (flaky networks,
 *     stale service-worker caches, post-deploy asset rotation).
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  retries = 2
) {
  return lazy(async () => {
    let lastErr: unknown;
    for (let i = 0; i <= retries; i++) {
      try {
        const mod = await queuedImport(factory);
        const coerced = coerceModule<T>(mod);
        if (!coerced) {
          // A resolved module with an undefined default is not a transient
          // network failure — it is almost always a stale/rotated chunk left
          // over from a previous deploy. Retrying re-reads the same cached
          // module and fails identically, so recover immediately with a
          // one-time hard reload to pull fresh assets instead of burning
          // retries and crashing to the recovery screen.
          // If the one-time reload is already spent, render an explicit
          // recovery card instead of throwing to a blank screen.
          if (!reloadOnceForStaleChunk()) {
            return { default: StaleChunkFallback as T };
          }
          return untilReload<{ default: T }>();
        }
        return coerced;
      } catch (e) {
        lastErr = e;
        // Linear backoff: 400ms, 800ms
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    // All retries exhausted — likely a stale chunk after a deploy. Try a
    // one-time reload to fetch fresh assets instead of crashing to a blank screen.
    if (!reloadOnceForStaleChunk()) {
      return { default: StaleChunkFallback as T };
    }
    console.warn("[lazyWithRetry] reloading for stale chunk:", lastErr);
    return untilReload<{ default: T }>();
  });
}

/**
 * Optional shell UI (install prompt, floating tools, toasters) must never trap
 * iPhone users on a full-screen recovery page. If one optional chunk resolves
 * badly on Safari, log it and render nothing so the core app can continue.
 */
export function optionalLazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default?: T | null }>,
  label: string,
  retries = 2,
) {
  return lazy(async () => {
    try {
      let lastErr: unknown;
      for (let i = 0; i <= retries; i++) {
        try {
          const mod = await queuedImport(factory);
          const coerced = coerceModule<T>(mod);
          if (coerced) return coerced;
          throw new Error(`Optional lazy module ${label} has no React default export`);
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        }
      }
      throw lastErr;
    } catch (error) {
      console.warn(`[optionalLazyWithRetry] ${label} disabled:`, error);
      return { default: EmptyComponent as T };
    }
  });
}
