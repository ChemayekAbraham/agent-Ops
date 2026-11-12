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
  /**
   * The sharer's stored profile photo URL (avatars bucket, private): sign it with
   * getSignedUrl from src/lib/storageUtils before showing it. Null when none.
   */
  lead_avatar_url?: string | null;
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
    `You join with ${ugx(input.partnerShare)} and earn Rent Profit Share every month. ` +
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
 * says what is free in the float and what is set aside: pass the whole preview. Prefer coSupportInviteCopy for the full page.
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

export interface CoSupportTimelineStep {
  /** "Today", "12 Dec 2026", "Every month after" */
  when: string;
  /** the sentence; `amount` (when set) is shown in bold mono right after it */
  text: string;
  amount: string | null;
  /** 'now' = filled dot, 'next' = ring, 'later' = dashed ring */
  tone: 'now' | 'next' | 'later';
}

export interface CoSupportNextStep {
  /** green tick when done, a numbered ring when not */
  done: boolean;
  title: string;
  detail: string;
}

export interface CoSupportFloatLine {
  label: string;
  amount: string;
}

export interface CoSupportInviteCopy {
  // --- the person who shared the link -------------------------------------
  /** "Benjamin" ("Your partner" when the name is unknown) */
  leadName: string;
  /** "Welile partner · invited you" */
  leadTagline: string;
  /** alt text for the sharer's photo: "Benjamin's profile photo" */
  leadPhotoAlt: string;

  // --- invitation ----------------------------------------------------------
  /** e.g. "Benjamin invited you to support Nakasagga's home together" */
  headline: string;
  /** "Join Benjamin and support Nakasagga's home together. You both earn Rent Profit Share every month." */
  intro: string;
  /** alt text for the house photo */
  photoAlt: string;
  /** empty house only: "2-bedroom house" / city line; null for Rent Plans */
  houseLine: string | null;
  houseSubLine: string | null;
  /** figure row, left: "UGX 1,530,000" / "to join" */
  joinAmount: string;
  joinAmountLabel: string;
  /** figure row, right: "UGX 229,500" / "Rent Profit Share a month"; null when unknown */
  earningAmount: string | null;
  earningLabel: string;
  /** figure row, right, when signed out (no rate yet) */
  earningSignedOut: string;
  /** @deprecated use joinAmount + joinAmountLabel. "To join: UGX 1,530,000" */
  yourHalf: string;
  /** "You'd earn UGX 229,500 a month in Rent Profit Share", or null when unknown */
  yourEarning: string | null;
  /** "Benjamin is holding this for you for 46h 34m", or null when closed */
  holdLine: string | null;
  /** the parts of holdLine, so the time can be bold: prefix + time */
  holdPrefix: string | null;
  holdTime: string | null;
  /** "12 Dec 2026": the day the first Rent Profit Share is due if they join now */
  firstRentProfitShareDate: string;
  /**
   * Ready to join (Rent Plan): what happens when they join, top to bottom.
   * Empty for houses (they show the figure row instead).
   */
  timeline: CoSupportTimelineStep[];
  acceptLabel: string;
  declineLabel: string;
  /** shown under the buttons when signed out */
  signedOutHint: string;
  signInLabel: string;
  joinLabel: string;

  // --- why they cannot join yet --------------------------------------------
  /** why they cannot accept right now (null when they can) */
  blockTitle: string | null;
  /** one or two plain sentences (the float box uses floatLines/floatNotes instead) */
  blockDetail: string | null;
  /** label for the button that fixes it (add float, agreement, sign-up), or null */
  blockAction: string | null;
  /** funds_short only: the rows of the float box ("Free in your float" UGX 194,486) */
  floatLines: CoSupportFloatLine[];
  /** funds_short only: small lines under the rows ("UGX 357,000 more is held for Odenyo's Rent Plan") */
  floatNotes: string[];

  // --- add float without leaving the invitation ----------------------------
  /** "Add UGX 1,335,514" */
  depositTitle: string;
  depositIntro: string;
  waitingTitle: string;
  /** pass the network the person paid with: "MTN" / "Airtel" */
  waitingDetail: (network?: string | null) => string;
  waitingNote: string;
  slowTitle: string;
  slowDetail: string;
  rejectedTitle: string;
  rejectedDetail: string;
  arrivedTitle: string;
  /** pass the amount that arrived */
  arrivedDetail: (amount: number) => string;
  arrivedFreeLabel: string;
  arrivedAction: string;

  // --- after a successful accept -------------------------------------------
  /** "Benjamin + you · 50/50" */
  successPill: string;
  successTitle: string;
  successDetail: string;
  successCard: {
    eyebrow: string;
    title: string;
    putInLabel: string;
    putIn: string;
    earningLabel: string;
    /** "UGX 229,500" (shown with a small " /mo"), or null when unknown */
    earning: string | null;
    firstLabel: string;
    /** "12 Dec 2026", or "30 days after approval" for a house */
    first: string;
  };
  nextStepsTitle: string;
  nextSteps: CoSupportNextStep[];
  seePortfolioLabel: string;
  findAnotherLabel: string;
}

const firstName = (s: string | null | undefined, fallback: string) => {
  const v = String(s ?? '').trim().split(/\s+/)[0];
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : fallback;
};

/** First Rent Profit Share falls due 30 days after the portfolio is approved (next_roi_date). */
export const CO_SUPPORT_FIRST_PAYOUT_DAYS = 30;

/** "12 Dec 2026" for `now` + 30 days, on the same (UTC) calendar the server uses. */
export function coSupportFirstPayoutDate(now = Date.now()): string {
  const d = new Date(now + CO_SUPPORT_FIRST_PAYOUT_DAYS * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Every sentence of the invitation page, written to the person who opened the
 * link, by name, from the server's figures. The sharer is named, never
 * "he"/"she". No rate, no other person's figures, approved words only
 * ("Rent Plan", "partner", "Rent Profit Share"), and never "half": the
 * person joins with an amount.
 */
export function coSupportInviteCopy(p: Partial<CoSupportPreview>, now = Date.now()): CoSupportInviteCopy {
  // "your partner" mid-sentence, "Your partner" at the start of one.
  const lead = firstName(p.lead_first_name, 'your partner');
  const Lead = lead.charAt(0).toUpperCase() + lead.slice(1);
  const isHouse = p.kind === 'house';
  const tenant = firstName(p.tenant_first_name, '');
  const house = String(p.house_title ?? '').trim();
  const city = String(p.city ?? '').trim();
  const home = tenant ? `${tenant}'s home` : 'this home';
  const joinAmount = ugx(p.your_share);
  const earns = p.your_monthly_rent_profit_share != null && Number(p.your_monthly_rent_profit_share) > 0;
  const earningAmount = earns ? ugx(p.your_monthly_rent_profit_share) : null;
  const firstDate = coSupportFirstPayoutDate(now);

  const headline = isHouse
    ? `${Lead} invited you to support an empty house together`
    : tenant
      ? `${Lead} invited you to support ${tenant}'s home together`
      : `${Lead} invited you to support a Rent Plan together`;

  const intro = `Join ${lead === 'your partner' ? 'your partner' : Lead} and support ${isHouse ? 'this house' : home} together. ` +
    'You both earn Rent Profit Share every month.';

  const left = p.expires_at ? coSupportTimeLeft(p.expires_at, now) : null;
  const holdOpen = p.status === 'open' && left && !left.expired;
  const holdTime = holdOpen ? `${left.hours}h ${String(left.minutes).padStart(2, '0')}m` : null;
  const holdPrefix = holdOpen ? `${Lead} is holding this for you for` : null;

  const timeline: CoSupportTimelineStep[] = isHouse
    ? []
    : [
        { when: 'Today', text: 'You join with', amount: joinAmount, tone: 'now' },
        { when: 'Today', text: `${tenant ? `${tenant}'s` : 'The'} rent is paid to the landlord`, amount: null, tone: 'next' },
        ...(earningAmount
          ? [
              { when: firstDate, text: 'Your first Rent Profit Share:', amount: earningAmount, tone: 'next' as const },
              { when: 'Every month after', text: `${earningAmount} Rent Profit Share`, amount: null, tone: 'later' as const },
            ]
          : [{ when: firstDate, text: 'Your first Rent Profit Share', amount: null, tone: 'next' as const }]),
      ];

  // --- why they cannot join yet ----------------------------------------------
  let blockTitle: string | null = null;
  let blockDetail: string | null = null;
  let blockAction: string | null = null;
  const floatLines: CoSupportFloatLine[] = [];
  const floatNotes: string[] = [];
  const needed = Number(p.float_needed ?? 0);
  switch (p.reason) {
    case null:
    case undefined:
      break;
    case 'funds_short': {
      // float_balance comes from the server since 20261116120000; without it only the gap is known.
      const known = p.float_balance != null;
      const heldShares = Number(p.float_held_for_your_shares ?? 0);
      const heldOther = Number(p.float_held_other ?? 0);
      const free = Number(p.float_available ?? 0);
      const shares = p.your_open_shares ?? [];
      blockTitle = `Add ${ugx(needed)} to join`;
      if (known) {
        floatLines.push({ label: 'Free in your float', amount: ugx(free) });
        if (heldShares > 0) {
          const named = shares.length === 1 ? shares[0].title : `${shares.length} plans you're sharing`;
          floatNotes.push(`${ugx(heldShares)} more is held for ${named}`);
        }
        if (heldOther > 0) floatNotes.push(`${ugx(heldOther)} more is waiting on another support`);
      }
      blockDetail = known
        ? [`You have ${ugx(free)} free in your float.`, ...floatNotes.map((n) => `${n}.`)].join(' ')
        : `Add ${ugx(needed)} of float to join ${lead}.`;
      blockAction = `Add float to join ${lead === 'your partner' ? 'your partner' : Lead}`;
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

  // --- after a successful accept -----------------------------------------------
  const successTitle = isHouse
    ? `You and ${lead} now share this house`
    : `You and ${lead} now support ${home} together`;
  const successDetail = isHouse
    ? `Partner Ops will approve it soon. Your ${joinAmount} stays set aside for it until then. Thank you for joining.`
    : `${tenant ? `${tenant}'s` : 'The'} full rent has gone to the agent to pay the landlord. Thank you for joining.`;
  const nextSteps: CoSupportNextStep[] = isHouse
    ? [
        { done: true, title: "You're in", detail: `Today · ${joinAmount} set aside from your float` },
        { done: false, title: 'Partner Ops approve the house', detail: 'Then the money moves and your portfolio starts' },
        {
          done: false,
          title: 'Your first Rent Profit Share',
          detail: `${CO_SUPPORT_FIRST_PAYOUT_DAYS} days after approval${earningAmount ? ` · ${earningAmount}` : ''}, then every month`,
        },
      ]
    : [
        { done: true, title: "You're in", detail: `Today · ${joinAmount} from your float` },
        { done: true, title: 'Rent sent to the agent', detail: `Today · the agent pays ${tenant ? `${tenant}'s` : 'the'} landlord` },
        {
          done: false,
          title: 'Your first Rent Profit Share',
          detail: `${firstDate}${earningAmount ? ` · ${earningAmount}` : ''}, then every month`,
        },
      ];

  const network = (n?: string | null) => {
    const v = String(n ?? '').toLowerCase();
    return v.includes('airtel') ? 'Airtel' : v.includes('mtn') ? 'MTN' : 'Mobile Money';
  };
  const LeadOrPartner = lead === 'your partner' ? 'your partner' : Lead;

  return {
    leadName: Lead,
    leadTagline: 'Welile partner · invited you',
    leadPhotoAlt: lead === 'your partner' ? "Your partner's profile photo" : `${Lead}'s profile photo`,

    headline,
    intro,
    photoAlt: isHouse ? (house || 'The house') : tenant ? `${tenant}'s home` : 'The home',
    houseLine: isHouse ? (house || 'Empty house') : null,
    houseSubLine: isHouse ? [city, 'verified, waiting for a tenant'].filter(Boolean).join(' · ') : null,
    joinAmount,
    joinAmountLabel: 'to join',
    earningAmount,
    earningLabel: 'Rent Profit Share a month',
    earningSignedOut: 'Sign in to see your Rent Profit Share',
    yourHalf: `To join: ${joinAmount}`,
    yourEarning: earningAmount ? `You'd earn ${earningAmount} a month in Rent Profit Share` : null,
    holdLine: holdOpen ? `${holdPrefix} ${holdTime}` : null,
    holdPrefix,
    holdTime,
    firstRentProfitShareDate: firstDate,
    timeline,
    acceptLabel: `Join ${LeadOrPartner}`,
    declineLabel: 'Not this time',
    signedOutHint: `Sign in to join ${lead}. New to Welile? Create your partner account first, it takes a few minutes, and this link will bring you back here.`,
    signInLabel: 'I have a Welile account',
    joinLabel: "I'm new to Welile",

    blockTitle,
    blockDetail,
    blockAction,
    floatLines,
    floatNotes,

    depositTitle: `Add ${ugx(needed)}`,
    depositIntro: `Pay Welile with Mobile Money. It lands in your float, then you can join ${LeadOrPartner}.`,
    waitingTitle: 'Waiting for your money',
    waitingDetail: (n) => `We're matching your ${network(n)} payment. This usually takes a few seconds.`,
    waitingNote: `You can close this and open the link again later. ${Lead} keeps holding your place.`,
    slowTitle: 'Still checking your payment',
    slowDetail: `Financial Ops will confirm it. You can close this and open the link again later. ${Lead} keeps holding your place.`,
    rejectedTitle: "We couldn't confirm that payment",
    rejectedDetail: 'Check the Transaction ID and try again, or contact Welile.',
    arrivedTitle: 'Your money has arrived',
    arrivedDetail: (amount) => `${ugx(amount)} is in your float. You can join ${LeadOrPartner} now.`,
    arrivedFreeLabel: 'Free in your float',
    arrivedAction: `Join ${LeadOrPartner} now`,

    successPill: `${lead === 'your partner' ? 'Your partner' : Lead} + you · 50/50`,
    successTitle,
    successDetail,
    successCard: {
      eyebrow: 'Your new portfolio',
      title: isHouse ? (house || 'Shared house') : tenant ? `${tenant}'s Rent Plan` : 'Shared Rent Plan',
      putInLabel: 'You put in',
      putIn: joinAmount,
      earningLabel: 'Rent Profit Share',
      earning: earningAmount,
      firstLabel: 'First Rent Profit Share',
      first: isHouse ? `${CO_SUPPORT_FIRST_PAYOUT_DAYS} days after approval` : firstDate,
    },
    nextStepsTitle: 'What happens next',
    nextSteps,
    seePortfolioLabel: 'See my portfolio',
    findAnotherLabel: isHouse ? 'Find another house' : 'Find another Rent Plan',
  };
}

/** Where the "Add float" sheet is, while the invitation waits for a deposit. */
export type CoSupportFloatWatchState = 'idle' | 'waiting' | 'slow' | 'arrived' | 'rejected';

/**
 * Decide the sheet after "I've paid": the money has arrived once the server
 * says the person can join (or is no longer short); a rejected deposit stops
 * the wait; after `slowAfterMs` without either, say it is taking longer.
 * Pure, so it is unit-tested; useCoSupportFloatWatch feeds it.
 */
export function coSupportFloatWatchState(input: {
  submittedAt: number | null;
  preview: Partial<CoSupportPreview> | null | undefined;
  depositStatus?: string | null;
  now?: number;
  slowAfterMs?: number;
}): CoSupportFloatWatchState {
  const { submittedAt, preview, depositStatus } = input;
  if (submittedAt == null) return 'idle';
  if (preview && (preview.can_accept || (preview.reason !== 'funds_short' && Number(preview.float_needed ?? 1) <= 0))) {
    return 'arrived';
  }
  const status = String(depositStatus ?? '').toLowerCase();
  if (status === 'rejected' || status === 'failed') return 'rejected';
  const now = input.now ?? Date.now();
  return now - submittedAt >= (input.slowAfterMs ?? 120_000) ? 'slow' : 'waiting';
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
