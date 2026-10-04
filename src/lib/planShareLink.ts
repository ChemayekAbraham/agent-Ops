import { supabase } from '@/integrations/supabase/client';
import { formatDynamic } from '@/lib/currencyFormat';

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

export function planShareDescription(plan: SharePlanInput): string {
  const rent = Number(plan.funding_amount || 0);
  const monthly = Math.round((rent * SHARE_ROI_RATE) / 100);
  return `Support this tenant for ${formatDynamic(rent)} by paying their landlord on the platform and earn ${formatDynamic(
    monthly,
  )} per month for the next 12 months Start here today.`;
}

/**
 * Branded host for every user-facing share link. This is the ONLY host that may
 * appear in a WhatsApp message, native share sheet, copied link or the UI.
 *
 * The backend `og-plan` edge function stays internal: `welileapp.com/s/<code>`
 * is served by the Cloudflare Worker in `infra/share-proxy/` (route
 * `welileapp.com/s/*`), which PROXIES the function so crawlers receive the
 * per-plan Open Graph head (house photo, rent, returns) at the branded URL.
 * Never build a share URL from VITE_SUPABASE_URL.
 */
export const SHARE_LINK_HOST =
  (import.meta.env.VITE_SHARE_LINK_HOST as string | undefined)?.replace(/\/+$/, '') ||
  'https://welileapp.com';

/** Public, branded share URL for a short-link code — safe to expose anywhere. */
export function planShareUrl(code: string): string {
  return `${SHARE_LINK_HOST}/s/${code}`;
}

/** SPA route a human lands on after the branded link returns its metadata. */
export function planShareDestinationUrl(code: string): string {
  return `${SHARE_LINK_HOST}/?share=${code}`;
}

/**
 * Create (or reuse) a trackable short link for a fundable rent plan.
 *
 * Returns the branded, click-counted link for the existing code:
 * - `short_code` / `code`  the stable short code (never rotated)
 * - `share_url` / `shortUrl` / `shareUrl`  https://welileapp.com/s/<code>
 * The internal edge-function URL is never returned or shared.
 */
export async function createPlanShareLink(
  userId: string,
  planId: string,
): Promise<{ code: string; short_code: string; share_url: string; shortUrl: string; shareUrl: string }> {
  const targetPath = '/funder-onboarding';
  const targetParams = { plan: planId, ref: userId } as Record<string, string>;
  const build = (code: string) => ({
    code,
    short_code: code,
    share_url: planShareUrl(code),
    shortUrl: planShareUrl(code),
    shareUrl: planShareUrl(code),
  });

  // Preferred path: the DB does an authoritative, idempotent get-or-create and
  // refreshes only the preview metadata that changed. The short code, row id and
  // attribution (user_id) are never rotated.
  const { data: rpc, error: rpcError } = await supabase
    .rpc('get_or_create_plan_share_link', { p_plan_id: planId })
    .maybeSingle();
  if (!rpcError && (rpc as any)?.code) return build((rpc as any).code as string);

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
