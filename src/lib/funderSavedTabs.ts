import type { CoSupportInvite } from '@/lib/coSupport';

/**
 * Saved Items (hamburger menu) is three tabs, shown as pills:
 *   Co-support  - Rent Plans / houses I am sharing with another partner, or joined
 *   Bookmarked  - houses and Rent Plans I bookmarked (this device only)
 *   Booked      - empty houses booked for me through a promissory note
 * Pure logic only; the screen lives in FunderSavedItemsDialog (UI).
 */
export type FunderSavedTab = 'co_support' | 'bookmarked' | 'booked';

export const FUNDER_SAVED_TABS: ReadonlyArray<{ id: FunderSavedTab; label: string }> = [
  { id: 'co_support', label: 'Co-support' },
  { id: 'bookmarked', label: 'Bookmarked' },
  { id: 'booked', label: 'Booked' },
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Closed invitations that stay listed for a week so the partner sees what happened. */
const CLOSED: CoSupportInvite['status'][] = [
  'declined', 'expired', 'cancelled', 'replaced', 'funded_alone', 'plan_unavailable',
];

/** An open invitation I shared that still holds my half of the float. */
export function isHoldingInvite(i: Pick<CoSupportInvite, 'your_role' | 'status' | 'expires_at'>, now = Date.now()): boolean {
  return i.your_role === 'lead' && i.status === 'open' && new Date(i.expires_at).getTime() > now;
}

/** True while the invite needs the partner to do something (or to wait): open, or a house waiting for Partner Ops. */
export function isLiveInvite(i: CoSupportInvite, now = Date.now()): boolean {
  if (i.status === 'open') return new Date(i.expires_at).getTime() > now;
  return i.status === 'completed' && i.awaiting_partner_ops === true;
}

/**
 * Rows for the Co-support tab: every invitation I shared or joined, minus closed ones older
 * than a week. Live ones first (soonest to expire on top), then the rest newest first.
 */
export function coSupportTabRows(invites: CoSupportInvite[] | null | undefined, now = Date.now()): CoSupportInvite[] {
  const rows = (invites ?? []).filter(
    (i) => i.your_role !== 'other' && !(CLOSED.includes(i.status) && now - new Date(i.created_at).getTime() > WEEK_MS),
  );
  return rows.sort((a, b) => {
    const la = isLiveInvite(a, now), lb = isLiveInvite(b, now);
    if (la !== lb) return la ? -1 : 1;
    if (la) return new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime();
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

export interface FunderSavedCounts { co_support: number; bookmarked: number; booked: number }

/**
 * The number on each pill: live co-support invitations, bookmarks, and houses still held
 * for me (a booking that was released, funded or taken is listed but not counted).
 */
export function funderSavedCounts(input: {
  invites: CoSupportInvite[] | null | undefined;
  bookmarked: number;
  bookedHeld: number;
  now?: number;
}): FunderSavedCounts {
  const now = input.now ?? Date.now();
  return {
    co_support: coSupportTabRows(input.invites, now).filter((i) => isLiveInvite(i, now)).length,
    bookmarked: Math.max(0, input.bookmarked),
    booked: Math.max(0, input.bookedHeld),
  };
}

/** Badge total for the hamburger menu's Saved Items entry. */
export const funderSavedTotal = (c: FunderSavedCounts) => c.co_support + c.bookmarked + c.booked;

/**
 * Which pill opens first: the one asked for (e.g. a "held for co-support" link), else the
 * first tab, in tab order, that has something in it; Bookmarked when all are empty.
 */
export function defaultFunderSavedTab(counts: FunderSavedCounts, requested?: FunderSavedTab | null): FunderSavedTab {
  if (requested) return requested;
  return FUNDER_SAVED_TABS.find((t) => counts[t.id] > 0)?.id ?? 'bookmarked';
}

// ---------------------------------------------------------------- float holds

export interface FloatHoldShare { id: string; title: string; held: number; expiresAt: string }

export interface FloatHoldBreakdown {
  /** Operational float in the wallet (get_user_float_available_balance). */
  floatBalance: number;
  /** What the Support screen can spend (funder_support_capacity = float minus holds, floor 0). */
  available: number;
  /** floatBalance - available. When available is 0 the real hold can be larger. */
  held: number;
  /** Part of `held` set aside for open co-support invitations I shared. */
  coSupportHeld: number;
  /** The rest: supports still waiting to be taken from the float (pending portfolios). */
  otherHeld: number;
  shares: FloatHoldShare[];
  /** When the soonest co-support hold ends if nobody accepts it (ISO), or null. */
  nextReleaseAt: string | null;
}

const shareTitle = (i: CoSupportInvite) =>
  i.kind === 'house'
    ? (i.house_title?.trim() || 'Empty house')
    : `${i.tenant_first_name?.trim() || 'Tenant'}'s Rent Plan`;

/**
 * Splits "why is my available float lower than my float?" into its parts. Mirrors the server's
 * funder_float_available = float - funder_pending_hold, where the hold is pending portfolios
 * plus the sharer's half of every open, unexpired co-support invitation.
 */
export function floatHoldBreakdown(input: {
  floatBalance: number | null | undefined;
  available: number | null | undefined;
  invites: CoSupportInvite[] | null | undefined;
  now?: number;
}): FloatHoldBreakdown {
  const now = input.now ?? Date.now();
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  const floatBalance = num(input.floatBalance);
  const available = Math.min(num(input.available), floatBalance);
  const held = Math.max(0, floatBalance - available);
  const holding = (input.invites ?? []).filter((i) => isHoldingInvite(i, now));
  const shares = holding
    .map((i) => ({ id: i.id, title: shareTitle(i), held: num(i.your_share), expiresAt: i.expires_at }))
    .sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime());
  const coSupportTotal = shares.reduce((s, x) => s + x.held, 0);
  const coSupportHeld = Math.min(coSupportTotal, held);
  return {
    floatBalance,
    available,
    held,
    coSupportHeld,
    otherHeld: Math.max(0, held - coSupportHeld),
    shares,
    nextReleaseAt: shares[0]?.expiresAt ?? null,
  };
}

const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-US')}`;

const kampalaTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });

/**
 * One line under "Available operational float" when part of the float is held, else null.
 * e.g. "UGX 357,000 is held for your co-support of Odenyo's Rent Plan until your partner joins
 * or the link ends on 13 Nov, 16:59."
 */
export function floatHoldLine(b: FloatHoldBreakdown): string | null {
  if (b.held <= 0) return null;
  const parts: string[] = [];
  if (b.coSupportHeld > 0) {
    const what = b.shares.length === 1 ? `your co-support of ${b.shares[0].title}` : `${b.shares.length} co-support invitations`;
    const until = b.nextReleaseAt
      ? b.shares.length === 1
        ? ` until your partner joins or the link ends on ${kampalaTime(b.nextReleaseAt)}`
        : ` (the first link ends on ${kampalaTime(b.nextReleaseAt)})`
      : '';
    parts.push(`${ugx(b.coSupportHeld)} is held for ${what}${until}.`);
  }
  if (b.otherHeld > 0) parts.push(`${ugx(b.otherHeld)} is held for supports still being processed.`);
  return parts.join(' ');
}

/** Extra sentence for the "float is short" error when a co-support hold is the reason. */
export function floatShortHoldHint(b: FloatHoldBreakdown): string {
  if (b.coSupportHeld <= 0) return '';
  return ` ${ugx(b.coSupportHeld)} is held for your open co-support. Cancel it in Saved Items > Co-support to use that float.`;
}
