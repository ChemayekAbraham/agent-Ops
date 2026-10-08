import type { Session, User } from '@supabase/supabase-js';

/**
 * Keeps the signed-in user and session objects STABLE when an auth event carries nothing new.
 *
 * The sign-in library announces "signed in" every time a tab becomes visible again (and again on every token
 * renewal), each time with a freshly parsed copy of the same user. React treats a new copy as a change, so every
 * screen that depends on the user object started its work again, and the dashboards that wrap everything threw
 * their contents away and rebuilt them. These helpers let the provider keep the object it already holds when the
 * incoming one is the same person with the same data, and only swap it for a real change (another user, new
 * user data, a new access token for the session).
 *
 * Nothing here decides who is signed in or what they may do; it only avoids handing out a new object for an
 * identical one.
 */

/** Structural equality of two JSON-shaped values; false (never throws) if either cannot be compared. */
function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Same person and same user data (not just the same id): a profile or metadata change still counts as a change. */
export function sameUser(a: User | null | undefined, b: User | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.id !== b.id) return false;
  return sameJson(a, b);
}

/** Same sign-in: same access token, refresh token and expiry, for the same user data. */
export function sameSession(a: Session | null | undefined, b: Session | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.access_token === b.access_token &&
    a.refresh_token === b.refresh_token &&
    a.expires_at === b.expires_at &&
    sameUser(a.user, b.user)
  );
}

/** The updater to hand to setUser: keeps the held object when the incoming one is identical. */
export const keepUser = (next: User | null) => (prev: User | null): User | null => (sameUser(prev, next) ? prev : next);

/** The updater to hand to setSession: keeps the held object when the incoming one is identical. */
export const keepSession = (next: Session | null) => (prev: Session | null): Session | null =>
  (sameSession(prev, next) ? prev : next);

/** True when two role lists hold the same roles in the same order. */
export function sameRoles(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((r, i) => r === b[i]);
}

/** The updater to hand to setRoles: keeps the held array when the incoming one holds the same roles. */
export const keepRoles = <T extends string>(next: T[]) => (prev: T[]): T[] => (sameRoles(prev, next) ? prev : next);
