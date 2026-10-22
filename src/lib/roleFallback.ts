import type { AppRole } from '@/hooks/auth/types';

/**
 * When a signed-in person's roles have not loaded (the lookup came back
 * unresolved — typically right after sign-in while the session token is
 * still refreshing), the app acts as if they hold the agent role and lands
 * them on the agent dashboard. Every account holds `agent` (fetchUserRoles
 * always adds it), so this never shows anyone a dashboard they lack.
 *
 * "Not loaded" is different from "loaded and empty": an account whose roles
 * all came back disabled is restricted and still goes to /select-role.
 * `rolesResolved` (from useAuth) tells the two apart.
 *
 * Before this, an unresolved lookup was read as "no roles": 74 users in 14
 * days were sent to /select-role while holding roles, and others saw every
 * role "locked" in the switcher (Muhwezi Ian Martine, 2026-10-21).
 */
export const FALLBACK_ROLE: AppRole = 'agent';
export const FALLBACK_ROUTE = '/dashboard/agent';
export const NO_ROLES_ROUTE = '/select-role';

/** The roles to act on: the loaded roles, or the agent fallback while they have not loaded. */
export function effectiveRoles(roles: readonly AppRole[], rolesResolved: boolean): AppRole[] {
  if (roles.length > 0) return [...roles];
  return rolesResolved ? [] : [FALLBACK_ROLE];
}

/** Where to send a signed-in person who has no roles in hand. */
export function landingWithoutRoles(rolesResolved: boolean): string {
  return rolesResolved ? NO_ROLES_ROUTE : FALLBACK_ROUTE;
}
