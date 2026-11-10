import { supabase } from '@/integrations/supabase/client';
import { formatDynamic } from '@/lib/currencyFormat';

/**
 * @deprecated A hard-coded 15%. Share text is composed by the database (get_or_create_plan_share_link
 * returns it as `description`, at the live public new-partner rate); use
 * `link.description ?? planShareFallbackDescription(plan)`. Must have no importer at release
 * (design v2 §6.1, §8.5 #3).
 */
export const SHARE_ROI_RATE = 15;

export interface SharePlanInput {
  rent_request_id: string;
  funding_amount: number;
  house_category?: string | null;
  request_city?: string | null;
  tenant_location?: string | null;
}

const pretty = (raw?: string | null) =>
  (raw ?? '')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

/** "Single Room" — the house title used in the share metadata. */
export function planHouseTitle(plan: SharePlanInput): string {
  return pretty(plan.house_category) || 'Rental Home';
}

/** Full readable location, falling back to the district then Uganda. */
export function planLocation(plan: SharePlanInput): string {
  const parts = (plan.tenant_location || plan.request_city || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? `${parts.join(', ')}, Uganda` : 'Uganda';
}

export function planShareTitle(plan: SharePlanInput): string {
  return `Support a tenant in a ${planHouseTitle(plan)} in ${planLocation(plan)}`;
}

/** @deprecated Computes a Returns figure at a hard-coded 15%; see SHARE_ROI_RATE. */
export function planShareDescription(plan: SharePlanInput): string {
  const rent = Number(plan.funding_amount || 0);
  const monthly = Math.round((rent * SHARE_ROI_RATE) / 100);
  return `Support this tenant for ${formatDynamic(rent)} by paying their landlord on the platform and earn ${formatDynamic(
    monthly,
  )} per month for the next 12 months Start here today.`;
}

/**
 * Share text when the database did not compose one (the link came from a fallback path). It states
 * no Returns figure: only SQL composes share text with a rate (design v2 §3.6, C7). Same sentences
 * og-plan serves for a link without a stored description.
 */
export function planShareFallbackDescription(plan: SharePlanInput): string {
  const rent = Number(plan.funding_amount || 0);
  return rent > 0
    ? `Support this tenant for ${formatDynamic(rent)} by paying their landlord on the platform and earn monthly Rent profit share. Start here today.`
    : "Support a tenant's rent on Welile and earn monthly Rent profit share. Support today.";
}

/**
 * Branded host for every user-facing share link. This is the ONLY host that may
 * appear in a WhatsApp message, native share sheet, copied link or the UI.
 *
 * The backend `og-plan` edge function stays internal: `share.welileapp.com/s/<code>`
 * is served by the Cloudflare Pages project in `infra/share-host/`, which PROXIES
 * the function so crawlers receive the per-plan Open Graph head (house photo,
 * rent, returns) at the branded URL. welileapp.com itself is hosted by Lovable
 * and only ever returns the app shell, whose preview is the Welile logo.
 * Never build a share URL from VITE_SUPABASE_URL.
 */
export const SHARE_LINK_HOST =
  (import.meta.env.VITE_SHARE_LINK_HOST as string | undefined)?.replace(/\/+$/, '') ||
  'https://share.welileapp.com';

/** The app itself, where humans land after a share link. */
const APP_HOST = 'https://welileapp.com';

/** Public, branded share URL for a short-link code — safe to expose anywhere. */
export function planShareUrl(code: string): string {
  return `${SHARE_LINK_HOST}/s/${code}`;
}

/** SPA route a human lands on after the branded link returns its metadata. */
export function planShareDestinationUrl(code: string): string {
  return `${APP_HOST}/?share=${code}`;
}

export interface PlanShareLink {
  code: string;
  short_code: string;
  share_url: string;
  shortUrl: string;
  shareUrl: string;
  /** The share text the database composed (og_description, at the live public new-partner rate);
   *  null when the link came from a fallback path. Show `description ?? planShareFallbackDescription(plan)`. */
  description: string | null;
}

/**
 * Create (or reuse) a trackable short link for a fundable rent plan.
 *
 * Returns the branded, click-counted link for the existing code:
 * - `short_code` / `code`  the stable short code (never rotated)
 * - `share_url` / `shortUrl` / `shareUrl`  https://welileapp.com/s/<code>
 * - `description`  the share text the database composed, or null
 * The internal edge-function URL is never returned or shared.
 */
export async function createPlanShareLink(
  userId: string,
  planId: string,
): Promise<PlanShareLink> {
  const targetPath = '/funder-onboarding';
  const targetParams = { plan: planId, ref: userId } as Record<string, string>;
  const build = (code: string, description: string | null = null): PlanShareLink => ({
    code,
    short_code: code,
    share_url: planShareUrl(code),
    shortUrl: planShareUrl(code),
    shareUrl: planShareUrl(code),
    description,
  });

  // Preferred path: the DB does an authoritative, idempotent get-or-create and
  // refreshes only the preview metadata that changed. The short code, row id and
  // attribution (user_id) are never rotated.
  const { data: rpc, error: rpcError } = await supabase
    .rpc('get_or_create_plan_share_link', { p_plan_id: planId })
    .maybeSingle();
  if (!rpcError && (rpc as any)?.code) {
    const desc = (rpc as any).og_description;
    return build((rpc as any).code as string, typeof desc === 'string' && desc.trim() ? desc : null);
  }

  const findExisting = async () => {
    const { data } = await supabase
      .from('short_links')
      .select('code, target_params')
      .eq('user_id', userId)
      .eq('target_path', targetPath)
      .contains('target_params', targetParams as any);
    const exact = (data ?? []).find((row: any) => {
      const stored = (row.target_params ?? {}) as Record<string, string>;
      const keys = new Set([...Object.keys(stored), ...Object.keys(targetParams)]);
      for (const k of keys) {
        if (String(stored[k] ?? '') !== String(targetParams[k] ?? '')) return false;
      }
      return true;
    });
    return exact?.code ?? null;
  };

  const existing = await findExisting();
  if (existing) return build(existing);

  const { data: created, error } = await supabase
    .from('short_links')
    .insert({ user_id: userId, target_path: targetPath, target_params: targetParams as any })
    .select('code')
    .single();

  if (!error && created) return build(created.code);

  const retry = await findExisting();
  if (retry) return build(retry);
  throw error ?? new Error('Failed to create share link');
}
