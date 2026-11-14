/**
 * Per-account memory of which dashboard a person last used.
 *
 * Phones are shared: an agent often signs a tenant in on the agent's own
 * phone, and family members share devices. The old `welile_last_role` key was
 * one value per browser, so the next person to sign in inherited the previous
 * person's dashboard (a new tenant landing on the funder dashboard). The role
 * is now stored under the account id and the old shared key is ignored.
 */
import type { AppRole } from '@/hooks/auth/types';

/**
 * Deterministic order used when the person has made no choice. Tenant first:
 * every account also holds supporter, so supporter-first sent tenants to the
 * funder dashboard.
 */
const FALLBACK_ROLE_PRIORITY: AppRole[] = ['tenant', 'agent', 'landlord', 'supporter'];

export function pickFallbackRole(userRoles: AppRole[]): AppRole {
  return FALLBACK_ROLE_PRIORITY.find((r) => userRoles.includes(r)) ?? userRoles[0];
}

/** The pre-2026-11-14 shared key. Read by nothing; removed on the next write. */
export const LEGACY_LAST_ROLE_KEY = 'welile_last_role';

export function lastRoleKey(userId: string): string {
  return `welile_last_role:${userId}`;
}

export function getLastUsedRole(userId: string | null | undefined): AppRole | null {
  if (!userId) return null;
  try {
    return (localStorage.getItem(lastRoleKey(userId)) as AppRole | null) || null;
  } catch {
    return null;
  }
}

export function setLastUsedRole(userId: string | null | undefined, role: AppRole): void {
  if (!userId) return;
  try {
    localStorage.setItem(lastRoleKey(userId), role);
    localStorage.removeItem(LEGACY_LAST_ROLE_KEY);
  } catch {
    /* storage may be unavailable (private mode); the landing falls back */
  }
}
