import { useQuery } from '@tanstack/react-query';
import { rpc } from '../reviewApi';
import type { MoneyFlowItem } from '../moneyFlow';
import type { CountUgx, FundersRow, Period } from './cfoApi';

/**
 * Funder money released to agents' landlord floats, for the Funders Dashboard
 * headline: `funded_money_flow(p_days)`. A request counts as sold the moment a
 * funder's money is released to the agent, whatever the landlord has been paid
 * since (with agent, part paid or LIVE). Read-only.
 *
 * The page's period chips map to p_days 1 / 7 / 30 / 90 / 365. The server counts
 * back that many days from now; "posted" counts from the start of the Kampala day.
 */

export const PERIOD_DAYS: Record<Period, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90, all: 365 };

export type Release = MoneyFlowItem & { rent_request_id: string; released_at?: string | null };
export type Released = { released: CountUgx; items: Release[] };

const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));

export function parseReleased(data: unknown): Released {
  const d = (data ?? {}) as Record<string, unknown>;
  const r = (d.released ?? {}) as Record<string, unknown>;
  const items = (Array.isArray(d.items) ? d.items : []) as Record<string, unknown>[];
  return {
    released: { n: num(r.count), ugx: num(r.ugx) },
    items: items
      .filter((i) => typeof i.rent_request_id === 'string' && !!i.rent_request_id)
      .map((i) => ({ ...(i as unknown as Release), amount: i.amount === null || i.amount === undefined ? null : num(i.amount), paid_out: num(i.paid_out) })),
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

/** Posted minus released for the same period, so posted = sold + waiting. Never below zero. */
export function waitingFrom(posted: CountUgx, released: CountUgx): CountUgx {
  return { n: Math.max(0, posted.n - released.n), ugx: Math.max(0, posted.ugx - released.ugx) };
}

/** The plan drawer's row for a release that is no longer on the funders' board. */
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
