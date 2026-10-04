import type { AppRole } from '@/hooks/auth/types';

/**
 * Persona-specific URL slugs nested under `/dashboard`. The `supporter` role
 * is exposed publicly as `/dashboard/funder` (BOU/CMA terminology); the
 * internal role name stays `supporter`.
 */
export const PERSONA_SLUGS = [
  '/dashboard/tenant',
  '/dashboard/agent',
  '/dashboard/landlord',
  '/dashboard/funder',
  '/dashboard/manager',
] as const;
export type PersonaSlug = typeof PERSONA_SLUGS[number];

const ROLE_TO_SLUG: Record<string, PersonaSlug> = {
  tenant: '/dashboard/tenant',
  agent: '/dashboard/agent',
  landlord: '/dashboard/landlord',
  supporter: '/dashboard/funder',
  manager: '/dashboard/manager',
};

const SLUG_TO_ROLE: Record<PersonaSlug, AppRole> = {
  '/dashboard/tenant': 'tenant',
  '/dashboard/agent': 'agent',
  '/dashboard/landlord': 'landlord',
  '/dashboard/funder': 'supporter',
  '/dashboard/manager': 'manager',
};

/** Map an internal AppRole to its persona URL slug. Falls back to `/dashboard/tenant`. */
export function roleToSlug(role: AppRole | null | undefined): PersonaSlug {
  if (!role) return '/dashboard/tenant';
  return ROLE_TO_SLUG[role] ?? '/dashboard/tenant';
}

/**
 * Read the persona role from a pathname (e.g. "/dashboard/agent" → "agent",
 * "/dashboard/funder/anything" → "supporter"). Returns null if no persona match.
 */
export function slugToRole(pathname: string): AppRole | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'dashboard' || !parts[1]) return null;
  const seg = `/dashboard/${parts[1]}` as PersonaSlug;
  return SLUG_TO_ROLE[seg] ?? null;
}

export function isPersonaSlug(pathname: string): boolean {
  return slugToRole(pathname) !== null;
}
