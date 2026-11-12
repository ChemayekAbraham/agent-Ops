import { useQuery } from '@tanstack/react-query';
import { rpc } from '../reviewApi';
import type { Status } from '../deskTheme';
import type { MoneyFlowItem } from '../moneyFlow';
import type { CountUgx, FundersRow, Period } from './cfoApi';

/**
 * Funder money after a selection, for the Funders Dashboard headline:
 * `funded_money_flow(p_days)` (rule E93). Read-only.
 *
 *   sold              landlord PAID: the agent started the payout, the landlord's OTP was
 *                     verified and the merchant paid; counted by payment time in the period
 *   selected_waiting  a funder selected it and the landlord is not yet paid, right now
 *                     (whatever the period), with the oldest wait in hours
 *   items             each selection with ref, tenant, agent, landlord, funder, amount, stage
 *                     (with_agent | part_paid | live | sold) and its dates; sold ones of the
 *                     period plus every one still waiting, newest selection first
 *
 * The page's period chips map to p_days 1 / 7 / 30 / 90 / 365, counted in Kampala days
 * like "posted".
 */

export const PERIOD_DAYS: Record<Period, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90, all: 365 };

export type Release = MoneyFlowItem & {
  rent_request_id: string;
  ref?: string | null;
  funder?: string | null;
  selected_at?: string | null;
  released_at?: string | null;
  otp_verified_at?: string | null;
  landlord_paid_at?: string | null;
};
export type SelectedWaiting = CountUgx & { oldestHours: number | null };
export type Released = { released: CountUgx; sold: CountUgx; selectedWaiting: SelectedWaiting; items: Release[] };

const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
const optNum = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const cu = (x: unknown): CountUgx => {
  const o = (x ?? {}) as Record<string, unknown>;
  return { n: num(o.count), ugx: num(o.ugx) };
};

export function parseReleased(data: unknown): Released {
  const d = (data ?? {}) as Record<string, unknown>;
  const sw = (d.selected_waiting ?? {}) as Record<string, unknown>;
  const items = (Array.isArray(d.items) ? d.items : []) as Record<string, unknown>[];
  return {
    released: cu(d.released),
    sold: cu(d.sold),
    selectedWaiting: { ...cu(sw), oldestHours: optNum(sw.oldest_hours) },
    items: items
      .filter((i) => typeof i.rent_request_id === 'string' && !!i.rent_request_id)
      .map((i) => ({ ...(i as unknown as Release), amount: optNum(i.amount), paid_out: num(i.paid_out) })),
  };
}

export const releasedKey = (days: number) => ['desk-feed', 'funders-released', days] as const;

export function useReleased(period: Period) {
  const days = PERIOD_DAYS[period];
  return useQuery({
    queryKey: releasedKey(days),
    queryFn: async (): Promise<Released> => {
      const { data, error } = await rpc('funded_money_flow', { p_days: days });
      if (error) throw error;
      return parseReleased(data);
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
  });
}

export const isSold = (i: Pick<Release, 'stage'>) => i.stage === 'sold';

/** Posted minus everything already taken (sold, selected and waiting), for the same period. Never below zero. */
export function waitingFrom(posted: CountUgx, ...taken: CountUgx[]): CountUgx {
  const n = taken.reduce((s, t) => s + t.n, 0);
  const ugx = taken.reduce((s, t) => s + t.ugx, 0);
  return { n: Math.max(0, posted.n - n), ugx: Math.max(0, posted.ugx - ugx) };
}

/** The stage words on this desk: Op 5's, plus "Sold" (E93: the landlord is paid, OTP confirmed). */
export const RELEASE_STAGE: Record<string, { text: string; tone: Status }> = {
  with_agent: { text: 'With agent', tone: 'warn' },
  part_paid: { text: 'Part paid', tone: 'warn' },
  live: { text: 'LIVE', tone: 'ok' },
  paid_to_landlord: { text: 'LIVE', tone: 'ok' },
  plan_live: { text: 'LIVE', tone: 'ok' },
  sold: { text: 'Sold · landlord paid', tone: 'ok' },
};
export const stageOf = (stage: unknown) => RELEASE_STAGE[String(stage)] ?? { text: String(stage ?? '—').replace(/_/g, ' '), tone: 'idle' as Status };

export type ReleaseSort = 'newest' | 'oldest' | 'amount';
export const RELEASE_SORTS: { value: ReleaseSort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'amount', label: 'Amount' },
];

const selectedMs = (i: Release) => {
  const t = Date.parse(String(i.selected_at ?? i.released_at ?? ''));
  return Number.isFinite(t) ? t : null;
};

/** By selection time (newest or oldest first; no date goes last), or by amount, largest first. Stable. */
export function sortReleases(items: Release[], sort: ReleaseSort): Release[] {
  return items
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (sort === 'amount') return (b.r.amount ?? -1) - (a.r.amount ?? -1) || a.i - b.i;
      const x = selectedMs(a.r);
      const y = selectedMs(b.r);
      if (x === null && y === null) return a.i - b.i;
      if (x === null) return 1;
      if (y === null) return -1;
      return (sort === 'newest' ? y - x : x - y) || a.i - b.i;
    })
    .map(({ r }) => r);
}

/** The plan drawer's row for a selection that is no longer on the funders' board. */
export function rowFromRelease(it: Pick<Release, 'rent_request_id' | 'tenant' | 'agent' | 'landlord' | 'amount'>): FundersRow {
  return {
    id: it.rent_request_id,
    req: it.rent_request_id.slice(0, 8),
    tenant: it.tenant ?? null,
    tenant_location: null,
    agent: it.agent ?? null,
    landlord: it.landlord ?? null,
    landlord_phone: null,
    lc1: null,
    rent: it.amount ?? null,
    funding_amount: it.amount ?? null,
    gps: null,
    photos: null,
    days_on_board: null,
    held: false,
    hold_expires_at: null,
    grade: null,
    average: null,
    ratings: null,
    rank_grade: null,
    rank_oldest: null,
  };
}
