/**
 * Real URLs for Financial Ops panels.
 *
 * A panel opens at `/admin/financial-ops/<slug>` (for example
 * `/admin/financial-ops/payout-verification`). The slug is the panel id with
 * underscores written as hyphens, so the mapping needs no table and works in
 * both directions (a few awkward ids have a readable alias). The older `?tool=<id>` / `?view=<id>` links still work: the
 * console rewrites them to the path form the first time they are opened.
 */

export const FINOPS_BASE = '/admin/financial-ops';

/** Panels that are "views" (a sub-screen) rather than tools; same URL shape. */
const VIEW_IDS = ['deposits', 'offline_collections'] as const;

/** Panels whose id makes an awkward URL get a readable slug instead. */
const SLUG_ALIASES: Record<string, string> = { email_tx: 'email-transactions' };
const ID_FROM_ALIAS = Object.fromEntries(Object.entries(SLUG_ALIASES).map(([id, slug]) => [slug, id]));

export const finopsSlug = (id: string): string => SLUG_ALIASES[id] ?? id.replace(/_/g, '-');
export const finopsIdFromSlug = (slug: string): string => ID_FROM_ALIAS[slug] ?? slug.replace(/-/g, '_');
export const isFinopsViewId = (id: string): boolean => (VIEW_IDS as readonly string[]).includes(id);

/** The URL of a panel, or the overview when no id is given. */
export function finopsPath(id?: string | null): string {
  return id ? `${FINOPS_BASE}/${finopsSlug(id)}` : FINOPS_BASE;
}

/** True when the page is mounted on the Financial Ops route itself (not an embed elsewhere). */
export const isOnFinopsRoute = (pathname: string): boolean =>
  pathname === FINOPS_BASE || pathname.startsWith(`${FINOPS_BASE}/`);
