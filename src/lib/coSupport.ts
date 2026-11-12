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

/** What is being shared: a Rent Plan (tenant) or a verified empty house. */
export type CoSupportKind = 'rent_plan' | 'house';

/** One invitation as co_support_preview / co_support_my_invites return it. */
export interface CoSupportInvite {
  id: string;
  kind: CoSupportKind;
  code: string | null; // only for the person who shared it
  status: CoSupportStatus;
  expires_at: string;
  rent_request_id: string | null;
  /** Empty houses only. */
  house_id: string | null;
  house_title: string | null;
  /** Empty houses only: accepted, both halves waiting for Partner Ops to approve them together. */
  awaiting_partner_ops: boolean;
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
  /** Signed-in invitee only (never the other partner's figures): operational float in the wallet. */
  float_balance?: number;
  /** Part of float_balance set aside for Rent Plans / houses this person is sharing themselves. */
  float_held_for_your_shares?: number;
  /** Part of float_balance set aside for anything else waiting (pending portfolios). */
  float_held_other?: number;
  your_open_shares?: Array<{ id: string; kind: CoSupportKind; title: string; held: number; expires_at: string }>;
}

const ugx =(n: number | null | undefined) => `UGX ${Math.round(Number(n ?? 0)).toLocaleString('en-US')}`;

/** The message the sharer sends with the link (WhatsApp, SMS, copy). */
export function coSupportShareText(input: {
  kind?: CoSupportKind;
  tenantFirstName?: string | null;
  houseTitle?: string | null;
  city?: string | null;
  partnerShare: number;
  url: string;
}): string {
  const tenant = (input.tenantFirstName ?? '').trim();
  const house = (input.houseTitle ?? '').trim();
  const city = (input.city ?? '').trim();
  const home =
    input.kind === 'house'
      ? house ? `an empty house (${house})` : 'an empty house'
      : tenant ? `${tenant}'s rent` : 'a tenant’s rent';
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
  HOUSE_NOT_AVAILABLE: 'This house is no longer available. Choose another one.',
  HOUSES_UNAVAILABLE: 'This house is no longer available. Choose another one.',
  HOUSE_ALREADY_SUPPORTED: 'This house already has a supporter. Choose another one.',
  // Partner Ops screens
  NOT_AUTHORIZED: 'Only Partner Operations can do this.',
  PENDING_APPROVAL: 'This shared house is still waiting for approval. Reject it from the approval queue instead (both halves are rejected together).',
  NOT_FUNDED: 'This shared support has no funding to cancel.',
  LANDLORD_ALREADY_PAID: 'The landlord has already been paid from this float, so the funding cannot be cancelled here.',
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

/**
 * Short reason text for a preview that cannot be accepted. For a shortfall it
 * now explains the float (what you have, what is set aside, what is missing):
 * pass the whole preview. Prefer coSupportInviteCopy for the full page.
 */
export function coSupportBlockMessage(p: Partial<CoSupportPreview>): string | null {
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
      return coSupportInviteCopy(p).blockDetail;
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

// ---------------------------------------------------------------------------
// Personal wording for the invitation page (/co-support/:code)
// ---------------------------------------------------------------------------

export interface CoSupportInviteCopy {
  /** e.g. "Benjamin invited you to support Nakasagga's home together" */
  headline: string;
  /** one or two sentences under the photo */
  intro: string;
  /** "Your half: UGX 1,530,000" */
  yourHalf: string;
  /** "You'd earn UGX 229,500 a month in Rent Profit Share", or null when unknown */
  yourEarning: string | null;
  /** "Benjamin is holding this for you for 46h 34m", or null when closed */
  holdLine: string | null;
  acceptLabel: string;
  declineLabel: string;
  /** shown under the buttons when signed out */
  signedOutHint: string;
  signInLabel: string;
  joinLabel: string;
  /** after a successful accept */
  successTitle: string;
  successDetail: string;
  /** why they cannot accept right now (null when they can) */
  blockTitle: string | null;
  blockDetail: string | null;
  /** label for the button that fixes it (wallet, agreement, sign-up), or null */
  blockAction: string | null;
}

const firstName = (s: string | null | undefined, fallback: string) => {
  const v = String(s ?? '').trim().split(/\s+/)[0];
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : fallback;
};

/**
 * Every sentence of the invitation page, written to the person who opened the
 * link, by name, from the server's figures. The sharer is named, never
 * "he"/"she". No rate, no other person's figures, approved words only
 * ("Rent Plan", "partner", "Rent Profit Share").
 */
export function coSupportInviteCopy(p: Partial<CoSupportPreview>, now = Date.now()): CoSupportInviteCopy {
  // "your partner" mid-sentence, "Your partner" at the start of one.
  const lead = firstName(p.lead_first_name, 'your partner');
  const Lead = lead.charAt(0).toUpperCase() + lead.slice(1);
  const isHouse = p.kind === 'house';
  const tenant = firstName(p.tenant_first_name, '');
  const house = String(p.house_title ?? '').trim();
  const what = isHouse ? (house ? `this house (${house})` : 'this empty house') : tenant ? `${tenant}'s home` : 'this home';
  const half = ugx(p.your_share);

  const headline = isHouse
    ? `${Lead} invited you to support an empty house together`
    : tenant
      ? `${Lead} invited you to support ${tenant}'s home together`
      : `${Lead} invited you to support a Rent Plan together`;

  const intro = isHouse
    ? `${Lead} has already set aside one half. Take the other half and you'll support ${what} together, ` +
      `each earning Rent Profit Share every month. Partner Ops approve shared houses before any money moves.`
    : `${Lead} has already set aside one half. Take the other half and you'll support ${what} together, ` +
      `each earning Rent Profit Share every month.`;

  const earning =
    p.your_monthly_rent_profit_share != null && Number(p.your_monthly_rent_profit_share) > 0
      ? `You'd earn ${ugx(p.your_monthly_rent_profit_share)} a month in Rent Profit Share`
      : null;

  const left = p.expires_at ? coSupportTimeLeft(p.expires_at, now) : null;
  const holdLine =
    p.status === 'open' && left && !left.expired
      ? `${Lead} is holding this for you for ${left.hours}h ${String(left.minutes).padStart(2, '0')}m`
      : null;

  const successTitle = isHouse
    ? `You and ${lead} have shared ${what}`
    : `You and ${lead} now support ${what} together`;
  const successDetail = isHouse
    ? `Partner Ops will approve it soon. Your half (${half}) stays set aside for it until then.`
    : `Your portfolio: ${half}.` + (earning ? ` ${earning.replace("You'd earn", 'You earn')}.` : '');

  let blockTitle: string | null = null;
  let blockDetail: string | null = null;
  let blockAction: string | null = null;
  switch (p.reason) {
    case null:
    case undefined:
      break;
    case 'funds_short': {
      const needed = Number(p.float_needed ?? 0);
      // float_balance comes from the server since 20261116120000; without it only the gap is known.
      const known = p.float_balance != null;
      const balance = Number(p.float_balance ?? 0);
      const heldShares = Number(p.float_held_for_your_shares ?? 0);
      const heldOther = Number(p.float_held_other ?? 0);
      const free = Number(p.float_available ?? 0);
      const shares = p.your_open_shares ?? [];
      blockTitle = `You're ${ugx(needed)} short of your half`;
      const parts: string[] = [];
      if (!known) {
        // nothing to explain beyond the gap
      } else if (balance <= 0) {
        parts.push("You don't have any float in your wallet yet.");
      } else if (heldShares > 0 || heldOther > 0) {
        const why: string[] = [];
        if (heldShares > 0) {
          const named = shares.length === 1 ? shares[0].title : `${shares.length} plans you're sharing`;
          why.push(`${ugx(heldShares)} is set aside for ${named}${shares.length === 1 ? " that you're sharing" : ''}`);
        }
        if (heldOther > 0) why.push(`${ugx(heldOther)} is waiting on another support`);
        parts.push(`You have ${ugx(balance)} of float. ${why.join(' and ')}, so ${ugx(free)} is free right now.`);
      } else {
        parts.push(`You have ${ugx(balance)} of float right now.`);
      }
      parts.push(`Add ${ugx(needed)} to your wallet, then open this link again to join ${lead}.`);
      if (heldShares > 0 && free + heldShares >= Number(p.your_share ?? Infinity)) {
        parts.push(`Or stop sharing your own plan to free ${ugx(heldShares)}.`);
      }
      blockDetail = parts.join(' ');
      blockAction = 'Add float to your wallet';
      break;
    }
    case 'agreement_required':
      blockTitle = 'One step first: your partnership agreement';
      blockDetail = `Sign your partnership agreement, then open this link again to join ${lead}.`;
      blockAction = 'Sign my agreement';
      break;
    case 'not_a_partner':
      blockTitle = 'Finish becoming a Welile partner';
      blockDetail = `Complete your partner sign-up, then open this link again to join ${lead}.`;
      blockAction = 'Finish partner sign-up';
      break;
    case 'paused':
      blockTitle = 'Sharing is paused for a moment';
      blockDetail = `Supporting together is paused right now. ${Lead}'s invitation is still here; please try again later.`;
      break;
    case 'rate_unavailable':
      blockTitle = 'We need to check your account';
      blockDetail = 'Your Rent Profit Share could not be confirmed. Please contact Welile and we will sort it out.';
      break;
    case 'invite_expired':
      blockTitle = 'This invitation has ended';
      blockDetail = `The 48 hours ran out. Ask ${lead} to send you a new link.`;
      break;
    case 'invite_declined':
      blockTitle = 'You said no to this invitation';
      blockDetail = `If you change your mind, ask ${lead} to send it again.`;
      break;
    case 'invite_completed':
      blockTitle = `${Lead} found a partner for this one`;
      blockDetail = 'It is fully supported. Open Welile to find another Rent Plan or house to support.';
      break;
    default:
      blockTitle = 'This invitation is closed';
      blockDetail = `Ask ${lead} to send you a new link.`;
  }

  return {
    headline,
    intro,
    yourHalf: `Your half: ${half}`,
    yourEarning: earning,
    holdLine,
    acceptLabel: `Join ${lead === 'your partner' ? 'your partner' : Lead}`,
    declineLabel: 'Not this time',
    signedOutHint: `Sign in to join ${lead}. New to Welile? Create your partner account first, it takes a few minutes, and this link will bring you back here.`,
    signInLabel: 'I have a Welile account',
    joinLabel: "I'm new to Welile",
    successTitle,
    successDetail,
    blockTitle,
    blockDetail,
    blockAction,
  };
}

/** One row of co_support_staff_list (Partner Ops). */
export interface CoSupportStaffRow {
  invite_id: string;
  kind: CoSupportKind;
  rent_request_id: string | null;
  house_id: string | null;
  title: string;
  place: string | null;
  rent_amount: number;
  plan_amount: number;
  /** house pairs wait for Partner Ops; Rent Plans are funded at once */
  status: 'awaiting_approval' | 'funded';
  /** > 0: the landlord was already paid from the float, so it cannot be cancelled here */
  landlord_paid_out: number;
  partners: Array<{ role: 'lead' | 'invitee'; partner_id: string; name: string | null; amount: number; portfolio_id: string | null }>;
  accepted_at: string | null;
}

/** Whole hours and minutes left, for "Open for 31h 20m". */
export function coSupportTimeLeft(expiresAt: string, now = Date.now()): { expired: boolean; hours: number; minutes: number } {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return { expired: true, hours: 0, minutes: 0 };
  const totalMin = Math.floor(ms / 60000);
  return { expired: false, hours: Math.floor(totalMin / 60), minutes: totalMin % 60 };
}
