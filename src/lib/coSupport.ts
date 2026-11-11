/**
 * Co-support: two partners share one Rent Plan 50/50 through a 48-hour link.
 *
 * Everything here is pure (no Supabase calls) so it is unit-tested; the data
 * calls live in src/hooks/useCoSupport.ts. Server truth is the co_support_*
 * functions (migration 20261115090000_co_support_phase1.sql).
 *
 * Copy rules: "Rent Plan", "Rent Profit Share", "partner"; never "loan",
 * "interest", "ROI" or "Returns".
 */
/**
 * Same host and override as SHARE_LINK_HOST in planShareLink.ts (not imported:
 * that module loads the Supabase client, and this file must stay pure).
 */
const SHARE_LINK_HOST =
  (import.meta.env.VITE_SHARE_LINK_HOST as string | undefined)?.replace(/\/+$/, '') ||
  'https://share.welileapp.com';

/** Invitation codes are 12 letters/digits (stored upper-case). */
export const CO_SUPPORT_CODE_RE = /^[A-Za-z0-9]{12}$/;

export function normalizeCoSupportCode(raw: string | null | undefined): string | null {
  const code = String(raw ?? '').trim();
  return CO_SUPPORT_CODE_RE.test(code) ? code.toUpperCase() : null;
}

/** Branded link to send: share.welileapp.com/c/<code> (shows the house photo on WhatsApp). */
export function coSupportShareUrl(code: string): string {
  return `${SHARE_LINK_HOST}/c/${code}`;
}

/** The in-app page the link opens: /co-support/<code>. */
export function coSupportPath(code: string): string {
  return `/co-support/${code}`;
}

export type CoSupportStatus =
  | 'open'
  | 'declined'
  | 'expired'
  | 'completed'
  | 'cancelled'
  | 'replaced'
  | 'funded_alone'
  | 'plan_unavailable';

/** One invitation as co_support_preview / co_support_my_invites return it. */
export interface CoSupportInvite {
  id: string;
  code: string | null; // only for the person who shared it
  status: CoSupportStatus;
  expires_at: string;
  rent_request_id: string;
  tenant_first_name: string | null;
  city: string | null;
  house_image_url: string | null;
  rent_amount: number;
  plan_amount: number;
  your_role: 'lead' | 'invitee' | 'other';
  your_share: number;
  partner_share: number;
  partner_first_name: string | null;
  your_monthly_rent_profit_share: number | null;
  your_portfolio_id: string | null;
  accepted_at: string | null;
  created_at: string;
}

export type CoSupportBlockReason =
  | 'paused'
  | 'not_a_partner'
  | 'agreement_required'
  | 'rate_unavailable'
  | 'funds_short'
  | `invite_${Exclude<CoSupportStatus, 'open'>}`;

export interface CoSupportPreview extends Partial<CoSupportInvite> {
  found: boolean;
  lead_first_name?: string | null;
  /** The person who shared the link: funder-onboarding records them as the referrer. */
  referrer_id?: string;
  signed_in?: boolean;
  can_accept?: boolean;
  reason?: CoSupportBlockReason | null;
  is_partner?: boolean;
  agreement_signed?: boolean;
  float_available?: number;
  float_needed?: number;
}

const ugx = (n: number | null | undefined) => `UGX ${Math.round(Number(n ?? 0)).toLocaleString('en-US')}`;

/** The message the sharer sends with the link (WhatsApp, SMS, copy). */
export function coSupportShareText(input: {
  tenantFirstName?: string | null;
  city?: string | null;
  partnerShare: number;
  url: string;
}): string {
  const tenant = (input.tenantFirstName ?? '').trim();
  const city = (input.city ?? '').trim();
  const home = tenant ? `${tenant}'s rent` : 'a tenant’s rent';
  const where = city ? ` in ${city}` : '';
  return (
    `I'm supporting ${home}${where} on Welile and I'd like to do it with you, 50/50. ` +
    `Your half is ${ugx(input.partnerShare)} and you earn Rent Profit Share every month. ` +
    `The invitation is open for 48 hours: ${input.url}`
  );
}

export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** Where someone who is not signed in should go from the invitation page. */
export function coSupportSignInPath(code: string): string {
  return `/auth?redirect=${encodeURIComponent(coSupportPath(code))}`;
}

/** No account yet: funder-onboarding (it collects the contract signature), with the sharer as referrer. */
export function coSupportOnboardingPath(code: string, referrerId?: string | null): string {
  const qs = new URLSearchParams();
  if (referrerId) qs.set('ref', referrerId);
  qs.set('cosupport', code);
  return `/funder-onboarding?${qs.toString()}`;
}

// ---------------------------------------------------------------------------
// Coming back to the invitation after funder-onboarding
// ---------------------------------------------------------------------------

const PENDING_KEY = 'welile.cosupport.pending';
/** Same life as an invitation. */
const PENDING_TTL_MS = 48 * 60 * 60 * 1000;

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStore = (): KV | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

/** Remember ?cosupport=<code> (localStorage, so it survives the email-confirmation tab). */
export function rememberCoSupportCode(search: string, store: KV | null = defaultStore(), now = Date.now()): string | null {
  if (!store) return null;
  try {
    const code = normalizeCoSupportCode(new URLSearchParams(search).get('cosupport'));
    if (!code) return null;
    store.setItem(PENDING_KEY, JSON.stringify({ code, at: now }));
    return code;
  } catch {
    return null;
  }
}

/** The page to open after sign-up / sign-in, once; null when there is none (or it is stale). */
export function takeCoSupportReturnPath(store: KV | null = defaultStore(), now = Date.now()): string | null {
  if (!store) return null;
  try {
    const raw = store.getItem(PENDING_KEY);
    if (!raw) return null;
    store.removeItem(PENDING_KEY);
    const parsed = JSON.parse(raw) as { code?: string; at?: number };
    const code = normalizeCoSupportCode(parsed.code);
    if (!code || typeof parsed.at !== 'number' || now - parsed.at > PENDING_TTL_MS || parsed.at > now) return null;
    return coSupportPath(code);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Friendly messages for the server's error codes
// ---------------------------------------------------------------------------

const MESSAGES: Record<string, string> = {
  NOT_A_PARTNER: 'Finish your partner sign-up first.',
  AGREEMENT_REQUIRED: 'Sign your partnership agreement first.',
  CO_SUPPORT_UNAVAILABLE: 'Supporting a Rent Plan with another partner is paused right now. Please try again later.',
  PLAN_NOT_AVAILABLE: 'This Rent Plan is no longer available. Choose another one.',
  PLAN_BOOKED_BY_OTHER_PARTNER: 'This Rent Plan is booked by another partner. Choose another one.',
  CO_SUPPORT_PLAN_TOO_SMALL: 'Only Rent Plans of UGX 100,000 or more can be shared.',
  INVITE_NOT_FOUND: 'This link is not valid. Ask your partner to share it again.',
  INVITE_CLOSED: 'This invitation is no longer open.',
  INVITE_EXPIRED: 'This invitation has expired. Ask your partner to send a new one.',
  INVITE_DECLINED: 'This invitation was declined. Ask your partner to send a new one.',
  OWN_INVITE: 'You shared this Rent Plan. Send the link to the partner who will support it with you.',
  LEAD_FUNDS_SHORT: 'Your partner no longer has their half in their wallet. Ask them to add float, then try again.',
  LEAD_NOT_ELIGIBLE: 'The partner who shared this Rent Plan cannot fund it right now.',
  CO_SUPPORT_RELEASE_FAILED: 'Something went wrong, so nothing was taken from either wallet. Please try again.',
  PARTNER_RATE_UNAVAILABLE: 'Your Rent Profit Share rate could not be confirmed. Please contact Welile.',
  AUTH_REQUIRED: 'Please sign in first.',
};

/**
 * Turn a Supabase/Postgres error into a sentence for the screen.
 * Server errors look like "CODE: sentence" (the sentence is already plain);
 * PARTNER_FUNDS_SHORT keeps its own sentence because it carries the amounts.
 */
export function coSupportErrorMessage(err: unknown): string {
  const msg = String((err as { message?: string })?.message ?? err ?? '').trim();
  const m = /^([A-Z][A-Z0-9_]+)(?::\s*(.*))?$/s.exec(msg);
  if (m) {
    const [, code, rest] = m;
    if (code === 'PARTNER_FUNDS_SHORT' && rest) return rest;
    if (MESSAGES[code]) return MESSAGES[code];
    if (rest) return rest;
  }
  return 'Something went wrong. Please try again.';
}

/** Short reason text for a preview that cannot be accepted. */
export function coSupportBlockMessage(p: Pick<CoSupportPreview, 'reason' | 'float_needed'>): string | null {
  switch (p.reason) {
    case null:
    case undefined:
      return null;
    case 'paused':
      return MESSAGES.CO_SUPPORT_UNAVAILABLE;
    case 'not_a_partner':
      return MESSAGES.NOT_A_PARTNER;
    case 'agreement_required':
      return MESSAGES.AGREEMENT_REQUIRED;
    case 'rate_unavailable':
      return MESSAGES.PARTNER_RATE_UNAVAILABLE;
    case 'funds_short':
      return `Add ${ugx(p.float_needed)} of float to your wallet to take your half.`;
    case 'invite_expired':
      return MESSAGES.INVITE_EXPIRED;
    case 'invite_declined':
      return MESSAGES.INVITE_DECLINED;
    case 'invite_completed':
      return 'This Rent Plan has already been fully supported.';
    default:
      return MESSAGES.INVITE_CLOSED;
  }
}

/** Whole hours and minutes left, for "Open for 31h 20m". */
export function coSupportTimeLeft(expiresAt: string, now = Date.now()): { expired: boolean; hours: number; minutes: number } {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return { expired: true, hours: 0, minutes: 0 };
  const totalMin = Math.floor(ms / 60000);
  return { expired: false, hours: Math.floor(totalMin / 60), minutes: totalMin % 60 };
}
