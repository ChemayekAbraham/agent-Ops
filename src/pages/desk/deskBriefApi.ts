import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * The three read-only desk RPCs behind the morning brief, the trend arrows and
 * the CFO burn chart. All three already exist in production; none of them
 * writes anything.
 *
 * They are not in the generated Supabase types, so the calls go through the
 * same cast `useDeskFeed` uses. Every key starts with 'desk-feed' so the
 * toolbar's "Refresh" — which invalidates that prefix — reloads these too.
 */
type RpcFn = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

async function call<T>(fn: string): Promise<T> {
  const { data, error } = await rpc(fn, {});
  if (error) throw new Error(error.message);
  return data as T;
}

/* ───────────────────────── A: the morning brief ───────────────────────── */

export type BudgetRoom = {
  /** Null when the funding plan could not be read at all; 0 when there is no room. */
  room_ugx: number | null;
  can_approve: number | null;
  can_approve_ugx: number | null;
  rule: string | null;
};

export type MorningBrief = {
  clauses: string[];
  budget_room: BudgetRoom | null;
  generated_at: string;
};

/** Refreshed every five minutes — the brief is a morning read, not a ticker. */
export function useMorningBrief(enabled: boolean) {
  return useQuery({
    queryKey: ['desk-feed', 'morning-brief'],
    enabled,
    queryFn: () => call<MorningBrief>('desk_morning_brief'),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

/* ───────────────────────── B: 24-hour stage trend ───────────────────────── */

export type Arrow = 'up' | 'down' | 'flat' | 'none';

export type StageTrend = {
  /** Matches `ord` on the stage-flow rows: '1' Service Centre … '8' Landlord paid. */
  stage_ord: string;
  stage: string;
  waiting_now: number | null;
  waiting_24h_ago: number | null;
  change: number | null;
  arrow: Arrow;
  waiting_ugx_now: number | null;
  days_to_clear: number | null;
  compared_at: string | null;
};

export function useStageTrend(enabled: boolean) {
  const q = useQuery({
    queryKey: ['desk-feed', 'stage-trend'],
    enabled,
    queryFn: () => call<StageTrend[]>('desk_stage_trend'),
    refetchInterval: 60_000,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const byOrd = new Map<string, StageTrend>();
  (Array.isArray(q.data) ? q.data : []).forEach((t) => byOrd.set(String(t.stage_ord), t));
  return { byOrd, loading: q.isLoading, error: q.error ? (q.error as Error).message : null };
}

/* ───────────────────────── D: the CFO weekly burn ───────────────────────── */

export type BurnDay = { day: string; daily_budget: number | null; spent: number | null };

export type BudgetBurn = {
  /** Null when no weekly budget is set; `message` then says so. */
  week_start: string | null;
  message?: string | null;
  week_end?: string | null;
  weekly_budget?: number | null;
  spent?: number | null;
  remaining?: number | null;
  avg_per_day?: number | null;
  runs_out_on?: string | null;
  lasts_the_week?: boolean | null;
  days?: BurnDay[];
};

export function useBudgetBurn(enabled: boolean) {
  return useQuery({
    queryKey: ['desk-feed', 'budget-burn'],
    enabled,
    queryFn: () => call<BudgetBurn>('desk_budget_burn'),
    refetchInterval: 60_000,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

/** Weekday a date string falls on, in the desks' own timezone. */
export function weekdayOf(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Africa/Kampala' });
}

/** Short weekday for a chart axis. */
export function shortDayOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Africa/Kampala' });
}
