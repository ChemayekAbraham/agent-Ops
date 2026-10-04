import { useSyncExternalStore } from 'react';

/**
 * Shared "auto-refresh" toggle for Financial Ops surfaces.
 *
 * The Wallet Management card and the Verify Deposits hub both poll the
 * backend on a short interval. When an operator is mid-review (reading a
 * deposit, looking up a TID, etc.) those polls reshuffle the screen and
 * cost them context. This hook exposes a single boolean both surfaces can
 * honor so one toggle pauses everything at once.
 *
 * We persist the choice to localStorage so the preference survives a
 * tab refresh — operators usually want the same behavior every shift.
 */
const STORAGE_KEY = 'finops:autoRefreshEnabled';

let enabled: boolean = (() => {
  if (typeof window === 'undefined') return true;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === null ? true : raw === '1';
})();

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return enabled;
}

function getServerSnapshot() {
  return true;
}

export function setFinOpsAutoRefresh(next: boolean) {
  if (enabled === next) return;
  enabled = next;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      // ignore quota / private-mode failures — runtime state still updates
    }
  }
  listeners.forEach((l) => l());
}

export function useFinOpsAutoRefresh() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
