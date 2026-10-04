/**
 * Tracks how many "priority" install cards (the dashboard header one) are
 * mounted, so the globally-mounted public-shell card can stand down instead of
 * showing a second copy on the same screen.
 */
let mountedCount = 0;
const listeners = new Set<(count: number) => void>();

function notify() {
  listeners.forEach((fn) => fn(mountedCount));
}

/** Call from a priority install card on mount; returns the unregister cleanup. */
export function registerInstallCard(): () => void {
  mountedCount += 1;
  notify();
  return () => {
    mountedCount = Math.max(0, mountedCount - 1);
    notify();
  };
}

export function hasPriorityInstallCard(): boolean {
  return mountedCount > 0;
}

export function subscribeInstallCards(fn: (count: number) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}