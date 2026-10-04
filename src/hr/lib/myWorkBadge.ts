/**
 * Tiny in-memory store for the "assigned to me, not yet started" count.
 * MyWork publishes it whenever it loads; the HR shell subscribes so the
 * sidebar badge stays in step. No table, no persistence.
 */
type Listener = (count: number) => void;

let current = 0;
const listeners = new Set<Listener>();

export function setMyWorkBadge(count: number) {
  current = Math.max(0, count);
  listeners.forEach((l) => l(current));
}

export function getMyWorkBadge() {
  return current;
}

export function subscribeMyWorkBadge(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
