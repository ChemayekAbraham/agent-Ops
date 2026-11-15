import { useQuery } from '@tanstack/react-query';
import { rpc } from '../reviewApi';
import { isMissingDbObject, logMissingOnce } from '../deskLive';
import { isDenied } from '../accountability/accountabilityApi';

/**
 * The Command Centre's Concerns tab (E64 queue): one list across payout
 * disputes, desk concerns, customer-care hand-offs and concerns, HR tickets,
 * staff-assistant and partner escalations and CRM issues, money first —
 * `concerns_queue(p_scope, p_source, p_limit)`. Read-only; the server orders
 * the rows and counts everything.
 */

export type ConcernsScope = 'open' | 'all';

export type ConcernSource = { source: string; label: string; open: number; overdue: number; money_ugx: number | null };
export type ConcernParked = { parked_at: string; open: number; overdue: number };
export type ConcernRow = {
  key: string;
  source: string;
  source_label: string;
  ref: string | null;
  title: string;
  about: string | null;
  owner_name: string | null;
  parked_at: string | null;
  status: string | null;
  is_open: boolean;
  opened_at: string | null;
  due_at: string | null;
  severity: string | null;
  money_ugx: number | null;
  age_days: number | null;
  overdue: boolean;
  link_path: string | null;
};
export type ConcernsQueue = {
  generated_at: string | null;
  open_total: number;
  overdue_total: number;
  logged_per_day_8wk: number | null;
  by_source: ConcernSource[];
  by_parked: ConcernParked[];
  rows: ConcernRow[];
};

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

export function parseConcernsQueue(v: unknown): ConcernsQueue {
  const d = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    generated_at: str(d.generated_at),
    open_total: num(d.open_total) ?? 0,
    overdue_total: num(d.overdue_total) ?? 0,
    logged_per_day_8wk: num(d.logged_per_day_8wk),
    by_source: arr(d.by_source).map((s) => ({
      source: String(s.source ?? ''),
      label: str(s.label) ?? String(s.source ?? 'Other'),
      open: num(s.open) ?? 0,
      overdue: num(s.overdue) ?? 0,
      money_ugx: num(s.money_ugx),
    })),
    by_parked: arr(d.by_parked).map((p) => ({ parked_at: str(p.parked_at) ?? 'Not parked anywhere', open: num(p.open) ?? 0, overdue: num(p.overdue) ?? 0 })),
    rows: arr(d.rows).map((r, i) => {
      const source = String(r.source ?? '');
      const id = String(r.item_id ?? r.ref ?? i);
      return {
        key: `${source}:${id}`,
        source,
        source_label: str(r.source_label) ?? source,
        ref: str(r.ref),
        title: str(r.title) ?? 'Concern',
        about: str(r.about),
        owner_name: str(r.owner_name),
        parked_at: str(r.parked_at),
        status: str(r.status),
        is_open: r.is_open !== false,
        opened_at: str(r.opened_at),
        due_at: str(r.due_at),
        severity: str(r.severity),
        money_ugx: num(r.money_ugx),
        age_days: num(r.age_days),
        overdue: r.overdue === true,
        link_path: str(r.link_path),
      };
    }),
  };
}

/** A refusal or a missing RPC hides the tab's figures rather than showing an error. */
async function fetchQueue(scope: ConcernsScope, source: string | null, limit: number): Promise<ConcernsQueue | null> {
  const { data, error } = await rpc('concerns_queue', { p_scope: scope, p_source: source, p_limit: limit });
  if (error) {
    if (isMissingDbObject(error)) {
      logMissingOnce('concerns_queue', error);
      return null;
    }
    throw error;
  }
  return parseConcernsQueue(data);
}

export const CONCERNS_LIMIT = 500;

export function useConcernsQueue(scope: ConcernsScope, source: string | null, enabled = true) {
  return useQuery({
    queryKey: ['desk-feed', 'concerns-queue', scope, source],
    enabled,
    queryFn: () => fetchQueue(scope, source, CONCERNS_LIMIT),
    refetchInterval: 60_000,
    staleTime: 20_000,
    retry: (n, e) => !isDenied(e) && n < 1,
  });
}

/**
 * Just the open count, for the chips on the Command Centre tab and the
 * Concerns tab: the same RPC with one row. null while loading, refused or
 * missing — the chip then shows nothing rather than a false 0.
 */
export function useOpenConcernsCount(enabled = true): number | null {
  const q = useQuery({
    queryKey: ['desk-feed', 'concerns-queue', 'open-count'],
    enabled,
    queryFn: () => fetchQueue('open', null, 1),
    refetchInterval: 120_000,
    staleTime: 60_000,
    retry: (n, e) => !isDenied(e) && n < 1,
  });
  return q.data ? q.data.open_total : null;
}

/** "UGX 1,250,000"; null when there is no money on the item. */
export function ugxFull(v: number | null | undefined): string | null {
  return v === null || v === undefined || !Number.isFinite(Number(v)) || Number(v) === 0 ? null : `UGX ${Math.round(Number(v)).toLocaleString('en-US')}`;
}

/** "12 Nov 2026" in Kampala; "—" with no date. */
export function kampalaDay(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala' });
}

/** "3.5 days" / "1 day" / "today". */
export function ageText(days: number | null): string {
  if (days === null) return '—';
  if (days < 1) return 'today';
  const n = Math.round(days * 10) / 10;
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'day' : 'days'}`;
}

/** Client-side filters on the loaded rows: Overdue only. Source and scope go to the server. */
export function filterRows(rows: ConcernRow[], overdueOnly: boolean): ConcernRow[] {
  return overdueOnly ? rows.filter((r) => r.overdue) : rows;
}

/** An internal path opens in the app; anything else in a new tab. Null when there is nowhere to go. */
export function linkTarget(path: string | null): { internal: boolean; href: string } | null {
  if (!path) return null;
  return path.startsWith('/') ? { internal: true, href: path } : { internal: false, href: path };
}
