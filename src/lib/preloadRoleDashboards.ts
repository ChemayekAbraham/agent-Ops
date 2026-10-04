/**
 * Background warming of persona dashboard chunks.
 *
 * Switching persona (Tenant -> Agent -> Funder -> Owner) used to fetch that
 * dashboard's JS chunk only on tap, which shows a full-screen "Loading..."
 * pause on slower phones. We instead warm the chunks the user actually holds
 * once the visible dashboard is done rendering, so the switch renders from
 * memory.
 *
 * Rules:
 *  - Code only. No data fetching happens here.
 *  - Lowest priority: routed through the same `queuedImport` FIFO used by
 *    `lazyWithRetry`, one chunk at a time, never in parallel.
 *  - Fully skippable on constrained connections — the real lazy load still
 *    runs (with retries) if a warm never happened or failed.
 */

import { queuedImport } from "@/lib/lazyWithRetry";
import type { AppRole } from "@/hooks/useAuth";

type Factory = () => Promise<unknown>;

/**
 * Must use the exact same specifiers as `src/pages/Dashboard.tsx` so Vite
 * resolves them to the same chunk and React reuses the resolved module.
 */
const PRELOADABLE: Partial<Record<AppRole, Factory>> = {
  tenant: () => import("@/components/dashboards/TenantDashboard"),
  agent: () => import("@/components/dashboards/AgentDashboard"),
  supporter: () => import("@/components/dashboards/SupporterDashboard"),
  landlord: () => import("@/components/dashboards/LandlordDashboard"),
  manager: () => import("@/components/dashboards/ManagerDashboard"),
};

/** Heaviest / most-switched-to first, so the biggest win lands earliest. */
const WARM_ORDER: AppRole[] = ["agent", "manager", "supporter", "tenant", "landlord"];

const warmed = new Set<AppRole>();
let chain: Promise<unknown> = Promise.resolve();

/** True when the network/user is too constrained to justify speculative fetches. */
export function shouldSkipPreload(): boolean {
  if (typeof navigator === "undefined") return true;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return true;
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!conn) return false;
  if (conn.saveData) return true;
  return conn.effectiveType === "2g" || conn.effectiveType === "slow-2g";
}

/**
 * Warm a single persona chunk. Idempotent, serial, and silent on failure.
 */
export function preloadRole(role: AppRole): void {
  const factory = PRELOADABLE[role];
  if (!factory || warmed.has(role)) return;
  warmed.add(role);
  chain = chain.then(() =>
    queuedImport(factory).catch((error) => {
      // A failed warm is not a user-visible problem: allow a later retry.
      warmed.delete(role);
      if (import.meta.env.DEV) {
        console.warn("[preloadRoleDashboards] warm failed for", role, error);
      }
    }),
  );
}

/**
 * Warm every persona the user holds except the one already on screen.
 * Call after the active dashboard has mounted.
 */
export function preloadOtherRoles(roles: AppRole[], activeRole: AppRole | null | undefined): void {
  if (shouldSkipPreload()) return;
  const held = new Set(roles);
  for (const role of WARM_ORDER) {
    if (role !== activeRole && held.has(role)) preloadRole(role);
  }
}

/**
 * Run `preloadOtherRoles` when the browser is idle (Safari has no
 * requestIdleCallback, so fall back to a timer).
 */
export function schedulePreloadOtherRoles(
  roles: AppRole[],
  activeRole: AppRole | null | undefined,
): () => void {
  if (typeof window === "undefined") return () => {};
  const run = () => preloadOtherRoles(roles, activeRole);
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  }).requestIdleCallback;
  if (typeof ric === "function") {
    const handle = ric(run, { timeout: 4000 });
    return () => {
      const cancel = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
      cancel?.(handle);
    };
  }
  const timer = window.setTimeout(run, 2500);
  return () => window.clearTimeout(timer);
}