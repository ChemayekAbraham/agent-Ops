import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import { rpc } from '../reviewApi';

/**
 * The Funders Dashboard's data layer (desk id `cfo`).
 *
 * `funders_dashboard` goes through the `rpc` cast from `reviewApi`, the same
 * pattern the review drawer uses. The only call here that moves money is
 * `fundOne`, which is the CFO's existing funding action, unchanged.
 */

/**
 * The period values sent as `p_period`. The labels are what the desk shows;
 * the values are the server's.
 */
export const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
] as const;
export type Period = (typeof PERIODS)[number]['value'];

export type Ratings = {
  agent_ops?: number | null;
  tenant_ops?: number | null;
  landlord_ops?: number | null;
  [k: string]: number | null | undefined;
};

export type FundersRow = {
  id: string;
  req: string | null;
  tenant: string | null;
  tenant_location: string | null;
  agent: string | null;
  landlord: string | null;
  landlord_phone: string | null;
  lc1: string | null;
  rent: number | null;
  funding_amount: number | null;
  gps: { lat: number; lng: number } | null;
  photos: unknown[] | null;
  days_on_board: number | null;
  held: boolean;
  hold_expires_at: string | null;
  grade: string | null;
  average: number | null;
  ratings: Ratings | null;
  rank_grade: number | null;
  rank_oldest: number | null;
};

export type CountUgx = { n: number; ugx: number };

export type FundersDashboard = {
  generated_at: string | null;
  period: string | null;
  fund_today: CountUgx;
  held_by_funders: CountUgx;
  funded: {
    period: string | null;
    from: string | null;
    n: number;
    ugx: number;
    by_funders: CountUgx;
    by_welile: CountUgx;
    /** The funders split by who brought them; null while the server does not send them. */
    by_officers: CountUgx | null;
    by_self: CountUgx | null;
    avg_days_coo_to_funded: number | null;
  };
  can_fund_welile: boolean;
  rows: FundersRow[];
};

export const FUNDERS_KEY = ['desk-feed', 'funders-dashboard'] as const;

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

function countUgx(raw: unknown): CountUgx {
  const o = (raw ?? {}) as Record<string, unknown>;
  return { n: num(o.n) ?? 0, ugx: num(o.ugx) ?? 0 };
}

export function toDashboard(raw: unknown): FundersDashboard {
  const d = (raw ?? {}) as Record<string, unknown>;
  const f = (d.funded ?? {}) as Record<string, unknown>;
  const rows = (Array.isArray(d.rows) ? d.rows : []) as Record<string, unknown>[];
  return {
    generated_at: (d.generated_at as string) ?? null,
    period: (d.period as string) ?? null,
    fund_today: countUgx(d.fund_today),
    held_by_funders: countUgx(d.held_by_funders),
    funded: {
      period: (f.period as string) ?? null,
      from: (f.from as string) ?? null,
      n: num(f.n) ?? 0,
      ugx: num(f.ugx) ?? 0,
      by_funders: countUgx(f.by_funders),
      by_welile: countUgx(f.by_welile),
      by_officers: f.by_officers ? countUgx(f.by_officers) : null,
      by_self: f.by_self ? countUgx(f.by_self) : null,
      avg_days_coo_to_funded: num(f.avg_days_coo_to_funded),
    },
    can_fund_welile: d.can_fund_welile === true,
    rows: rows.map((r) => ({
      ...(r as unknown as FundersRow),
      id: String(r.id),
      rent: num(r.rent),
      funding_amount: num(r.funding_amount),
      days_on_board: num(r.days_on_board),
      held: r.held === true,
      rank_grade: num(r.rank_grade),
      rank_oldest: num(r.rank_oldest),
    })),
  };
}

/** Every 30 seconds and whenever the window regains focus, so funded or claimed rows leave on their own. */
export function useFundersDashboard(period: Period) {
  return useQuery({
    queryKey: [...FUNDERS_KEY, period],
    queryFn: async () => {
      const { data, error } = await rpc('funders_dashboard', { p_period: period });
      if (error) throw error;
      return toDashboard(data);
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
    retry: 1,
  });
}

/**
 * Fund one request with Welile money: the CFO's existing action, the same edge
 * function, body and error handling as `singleDisburse` in
 * `src/components/cfo/RentDisbursementQueue.tsx`. The function checks the CFO
 * role and the request's status, refuses to fund a request twice, and the
 * database refuses a request a funder holds or has funded. The server's words
 * come back unchanged.
 */
export type FundResult = { ok: boolean; reason?: string };

export async function fundOne(id: string): Promise<FundResult> {
  const { error, data } = await supabase.functions.invoke('fund-agent-landlord-float', {
    body: { rent_request_id: id, notes: 'Funders Dashboard' },
  });
  if (error) return { ok: false, reason: await extractFromErrorObject(error, 'Funding failed') };
  if ((data as { error?: string } | null)?.error) return { ok: false, reason: String((data as { error: string }).error) };
  return { ok: true };
}
