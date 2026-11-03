type Loader = () => Promise<unknown>;

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

/** Skip speculative downloads on Data Saver or very slow connections. */
export function canPreloadOnIdle(): boolean {
  if (typeof navigator === 'undefined') return false;
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (connection?.saveData) return false;
  return !(connection?.effectiveType && /(^|-)2g$/.test(connection.effectiveType));
}

/**
 * Starts the given dynamic imports once the browser is idle, after `delayMs`,
 * so code for things a person is likely to open next is already downloaded when
 * they do, without competing with the first paint. Returns a cancel function.
 */
export function preloadWhenIdle(loaders: Loader[], delayMs = 2500): () => void {
  if (!canPreloadOnIdle() || loaders.length === 0) return () => {};
  const run = () => loaders.forEach((load) => void load().catch(() => {}));
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  let idleHandle: number | null = null;
  const timer = window.setTimeout(() => {
    if (typeof w.requestIdleCallback === 'function') {
      idleHandle = w.requestIdleCallback(run, { timeout: 4000 });
    } else {
      run();
    }
  }, delayMs);
  return () => {
    window.clearTimeout(timer);
    if (idleHandle !== null) w.cancelIdleCallback?.(idleHandle);
  };
}
