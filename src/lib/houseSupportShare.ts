import { supabase } from '@/integrations/supabase/client';
import { SHARE_LINK_HOST } from '@/lib/planShareLink';
import { formatDynamic } from '@/lib/currencyFormat';

/** Monthly return rate a supporter earns on a supported empty house. */
export const HOUSE_SHARE_ROI_RATE = 15;

export const houseMonthlyReturn = (rent: number) =>
  Math.round((Number(rent || 0) * HOUSE_SHARE_ROI_RATE) / 100);

/**
 * Opaque, attribution-carrying share link for one verified empty house.
 *
 * Reuses the existing `short_links` architecture: the sharing agent is stored
 * as `short_links.user_id` server-side, so attribution can never be forged by
 * editing the URL. `welileapp.com/s/<code>` resolves through the normal tracked
 * redirect to the public support page `/support-house?s=<code>`.
 */
export async function createHouseShareLink(houseId: string) {
  const { data, error } = await supabase
    .rpc('get_or_create_house_share_link', { p_house_id: houseId })
    .maybeSingle();
  if (error) throw error;
  if (!data?.code) throw new Error('Could not create the share link');
  return {
    code: data.code as string,
    share_url: `${SHARE_LINK_HOST}/s/${data.code}`,
    og_title: data.og_title as string | null,
    og_description: data.og_description as string | null,
  };
}

export interface HouseShareSummary {
  title: string;
  place: string;
  monthly_rent: number;
}

/** Short, plain-text share description. No emojis, exactly one URL. */
export function houseShareMessage(house: HouseShareSummary, url: string) {
  return [
    'Support this available house through Welile.',
    '',
    `House: ${house.title}`,
    `Location: ${house.place}`,
    `Monthly Rent: ${formatDynamic(house.monthly_rent)}`,
    `Monthly Return: ${formatDynamic(houseMonthlyReturn(house.monthly_rent))} for 12 months`,
    '',
    'View the house and support plan:',
    url,
  ].join('\n');
}

export type HouseShareEvent =
  | 'opened'
  | 'visit_location_clicked'
  | 'support_clicked'
  | 'auth_started'
  | 'signup_completed'
  | 'support_started'
  | 'support_completed';

/** Fire-and-forget funnel event. Attribution is resolved server-side. */
export function logHouseShareEvent(
  code: string | null | undefined,
  event: HouseShareEvent,
  commitmentId?: string | null,
) {
  if (!code) return;
  void supabase
    .rpc('log_house_support_share_event', {
      p_code: code,
      p_event: event,
      p_commitment_id: commitmentId ?? null,
      p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 300) : null,
    })
    .then(() => undefined, () => undefined);
}

/* -------------------------------------------------------------------------- */
/* Support intent that must survive login, signup, phone verification and     */
/* onboarding. Stored outside React state so a refresh or an in-app browser   */
/* tab close cannot lose the house the visitor was looking at.                */
/* -------------------------------------------------------------------------- */

const INTENT_KEY = 'welile_house_support_intent';
const INTENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface HouseSupportIntent {
  share_code: string;
  house_id: string;
  intended_action: 'support_house';
  return_path: string;
  saved_at: number;
}

export function saveHouseSupportIntent(shareCode: string, houseId: string) {
  const intent: HouseSupportIntent = {
    share_code: shareCode,
    house_id: houseId,
    intended_action: 'support_house',
    return_path: `/support-house?s=${encodeURIComponent(shareCode)}`,
    saved_at: Date.now(),
  };
  try {
    localStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* storage unavailable */
  }
  try {
    sessionStorage.setItem('welile_post_auth_redirect', intent.return_path);
  } catch {
    /* storage unavailable */
  }
  return intent;
}

export function getHouseSupportIntent(): HouseSupportIntent | null {
  try {
    const raw = localStorage.getItem(INTENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HouseSupportIntent;
    if (!parsed?.share_code || Date.now() - Number(parsed.saved_at || 0) > INTENT_TTL_MS) {
      clearHouseSupportIntent();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearHouseSupportIntent() {
  try {
    localStorage.removeItem(INTENT_KEY);
  } catch {
    /* storage unavailable */
  }
}

export const houseMapsUrl = (lat?: number | null, lng?: number | null) =>
  typeof lat === 'number' && typeof lng === 'number' && (lat !== 0 || lng !== 0)
    ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
    : null;
