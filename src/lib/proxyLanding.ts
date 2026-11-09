import type { AppRole } from '@/hooks/auth/types';
import { supabase } from '@/integrations/supabase/client';
import { withUserSession } from '@/lib/authenticatedRequests';

/**
 * Proxy agents who have never collected rent land on the proxy agent dashboard.
 *
 * A proxy agent is a distinct persona (an approved `proxy_agent_identity` row), not a kind of agent. Most of them
 * also hold the standard agent and supporter roles, so the role-based landing used to drop them on the agent or
 * funder dashboard. An approved proxy agent with no `agent_collections` row has no agent work to see, so their home
 * is `/dashboard/agent/proxy`. One who has collected keeps the normal landing.
 *
 * Only persona landings are replaced. Staff roles keep their own dashboards, and an explicit choice (a URL, a
 * `?role=` hint, the Home Screen setting) always wins; the callers apply those rules before asking here.
 */

export const PROXY_DASHBOARD_ROUTE = '/dashboard/agent/proxy';

/** Landings the proxy dashboard replaces. Any other role (staff) keeps its own dashboard. */
export const PERSONA_LANDING_ROLES: readonly AppRole[] = ['tenant', 'agent', 'supporter', 'landlord'];

const CACHE_PREFIX = 'welile_proxy_landing_';
/** A cached answer is reused for this long, so most app opens need no lookup. */
export const PROXY_LANDING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Longest a landing waits for the lookup before using the normal dashboard. */
export const PROXY_LANDING_TIMEOUT_MS = 1500;

/** True when the proxy rule may replace a landing on this role (null = role not known yet, which lands on tenant). */
export function isPersonaLanding(role: AppRole | null | undefined): boolean {
  return !role || PERSONA_LANDING_ROLES.includes(role);
}

export function readCachedProxyLanding(userId: string, now = Date.now()): boolean | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: unknown; at?: unknown };
    if (typeof parsed.v !== 'boolean' || typeof parsed.at !== 'number') return null;
    if (now - parsed.at > PROXY_LANDING_CACHE_TTL_MS || parsed.at > now) return null;
    return parsed.v;
  } catch {
    return null;
  }
}

function writeCachedProxyLanding(userId: string, value: boolean): void {
  try {
    localStorage.setItem(CACHE_PREFIX + userId, JSON.stringify({ v: value, at: Date.now() }));
  } catch { /* private mode or full storage: the next landing looks it up again */ }
}

/**
 * Asks the server. Resolves true only for an approved proxy agent with no collection on record.
 * Rejects when either lookup fails, so a network or session problem is never cached as an answer.
 */
export async function checkProxyLanding(userId: string): Promise<boolean> {
  const status = await withUserSession(() => supabase.rpc('my_proxy_agent_status'));
  if (status.error) throw new Error(status.error.message);
  if ((status.data as { status?: string } | null)?.status !== 'approved') return false;

  // RLS lets an agent read their own rows; one row is enough to know they have collected.
  const collections = await withUserSession(() =>
    supabase.from('agent_collections').select('id').eq('agent_id', userId).limit(1),
  );
  if (collections.error) throw new Error(collections.error.message);
  return (collections.data ?? []).length === 0;
}

/**
 * Should this user land on the proxy dashboard? Uses a fresh cached answer at once; otherwise looks it up, waiting
 * at most `timeoutMs`. Any failure or timeout answers false, which keeps the normal landing.
 */
export async function resolveProxyLanding(
  userId: string,
  { timeoutMs = PROXY_LANDING_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<boolean> {
  const cached = readCachedProxyLanding(userId);
  if (cached !== null) return cached;

  // A slow lookup still fills the cache when it finishes, so the next landing is instant.
  const lookup = checkProxyLanding(userId).then((value) => {
    writeCachedProxyLanding(userId, value);
    return value;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  try {
    return await Promise.race([lookup, timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    lookup.catch(() => { /* already answered false */ });
  }
}
