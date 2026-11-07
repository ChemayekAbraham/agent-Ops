import { useQuery } from '@tanstack/react-query';
import { rpc } from '../reviewApi';
import type { Status } from '../deskTheme';

/**
 * Partner Ops as the sales desk: what is listed for funders, what Welile must
 * fund (day 7 and on), what sold and who sold it, the funder money waiting for
 * approval, and how the field officers are doing — all from
 * `partner_ops_board(p_period)`.
 */

export const PARTNER_PERIODS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
] as const;
export type PartnerPeriod = (typeof PARTNER_PERIODS)[number]['value'];
export const DEFAULT_PERIOD: PartnerPeriod = '30d';

export type CountUgx = { n: number; ugx: number };

export type ListingDecision = 'fresh' | 'follow_up' | 'held' | 'welile_due' | 'frozen';

export type Listing = {
  id: string;
  req: string | null;
  tenant: string | null;
  agent: string | null;
  /** For "Call agent". */
  agent_id: string | null;
  agent_phone: string | null;
  rent: number | null;
  days_on_board: number | null;
  decision: ListingDecision | string;
  why: string | null;
  /** The last follow-up Partner Ops noted on this request, or null. */
  last_followup: { note: string | null; at: string | null; by: string | null } | null;
};

export type PendingPortfolio = {
  portfolio_id: string;
  code: string | null;
  funder: string | null;
  funder_phone: string | null;
  amount: number | null;
  months: number | null;
  payment_method: string | null;
  receipt_file_url: string | null;
  officer: string | null;
  created_at: string | null;
  hours_waiting: number | null;
};

export type Officer = {
  agent_id: string;
  officer: string | null;
  phone: string | null;
  invites: number;
  signups: number;
  funders: number;
  funded: number;
  funded_ugx: number;
  contacts: number;
  /** A count of funders (target_unit 'funders'), not UGX. Null when no target is set. */
  monthly_target: number | null;
  target_unit?: string | null;
  /** New funders this month, when the board sends it; the target is measured against it. */
  funders_this_month?: number | null;
};

export type Sold = {
  id: string;
  req: string | null;
  tenant: string | null;
  rent: number | null;
  by: string | null;
  funded_at: string | null;
  days_to_sell: number | null;
};

export type PartnerBoard = {
  period: string | null;
  tiles: {
    listed: CountUgx;
    welile_due: CountUgx;
    held: number;
    frozen: number;
    pending_portfolios: CountUgx;
    sold: CountUgx & { by_officers: CountUgx; by_self: CountUgx; by_welile: CountUgx; avg_days_coo_to_funded: number | null };
    sell_through_7d: { listed_last_30d: number; sold_within_7d: number; pct: number | null };
  };
  listings: Listing[];
  pending_portfolios: PendingPortfolio[];
  officers: Officer[];
  funnel: { invites: number; signups: number; funded: number; funded_ugx: number; officers: number; officers_active: number; contacts: number };
  sold_24h: Sold[];
};

export const PARTNER_KEY = ['desk-feed', 'partner-ops-board'] as const;

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const n0 = (v: unknown) => num(v) ?? 0;
const cu = (v: unknown): CountUgx => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { n: n0(o.n), ugx: n0(o.ugx) };
};
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function toPartnerBoard(raw: unknown): PartnerBoard {
  const d = (raw ?? {}) as Record<string, unknown>;
  const t = (d.tiles ?? {}) as Record<string, unknown>;
  const sold = (t.sold ?? {}) as Record<string, unknown>;
  const st = (t.sell_through_7d ?? {}) as Record<string, unknown>;
  const f = (d.funnel ?? {}) as Record<string, unknown>;
  return {
    period: (d.period as string) ?? null,
    tiles: {
      listed: cu(t.listed),
      welile_due: cu(t.welile_due),
      held: n0(t.held),
      frozen: n0(t.frozen),
      pending_portfolios: cu(t.pending_portfolios),
      sold: {
        ...cu(sold),
        by_officers: cu(sold.by_officers),
        by_self: cu(sold.by_self),
        by_welile: cu(sold.by_welile),
        avg_days_coo_to_funded: num(sold.avg_days_coo_to_funded),
      },
      sell_through_7d: { listed_last_30d: n0(st.listed_last_30d), sold_within_7d: n0(st.sold_within_7d), pct: num(st.pct) },
    },
    listings: arr<Listing>(d.listings).map((l) => ({
      ...l,
      id: String(l.id),
      agent_id: l.agent_id ? String(l.agent_id) : null,
      agent_phone: l.agent_phone ?? null,
      rent: num(l.rent),
      days_on_board: num(l.days_on_board),
      last_followup: l.last_followup && typeof l.last_followup === 'object' ? l.last_followup : null,
    })),
    pending_portfolios: arr<PendingPortfolio>(d.pending_portfolios).map((p) => ({
      ...p,
      portfolio_id: String(p.portfolio_id),
      amount: num(p.amount),
      months: num(p.months),
      hours_waiting: num(p.hours_waiting),
    })),
    officers: arr<Officer>(d.officers).map((o) => ({
      ...o,
      agent_id: String(o.agent_id),
      invites: n0(o.invites),
      signups: n0(o.signups),
      funders: n0(o.funders),
      funded: n0(o.funded),
      funded_ugx: n0(o.funded_ugx),
      contacts: n0(o.contacts),
      monthly_target: num(o.monthly_target),
      funders_this_month: num(o.funders_this_month),
    })),
    funnel: {
      invites: n0(f.invites),
      signups: n0(f.signups),
      funded: n0(f.funded),
      funded_ugx: n0(f.funded_ugx),
      officers: n0(f.officers),
      officers_active: n0(f.officers_active),
      contacts: n0(f.contacts),
    },
    sold_24h: arr<Sold>(d.sold_24h).map((s) => ({ ...s, id: String(s.id), rent: num(s.rent), days_to_sell: num(s.days_to_sell) })),
  };
}

export function usePartnerOpsBoard(period: PartnerPeriod) {
  return useQuery({
    queryKey: [...PARTNER_KEY, period],
    queryFn: async () => {
      const { data, error } = await rpc('partner_ops_board', { p_period: period });
      if (error) throw error;
      return toPartnerBoard(data);
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
    retry: 1,
  });
}

/* ───────────── writes: the existing portfolio approvals, and a follow-up note ───────────── */

export const REJECT_REASON_MIN = 10;
export const FOLLOW_UP_MIN = 10;

/** `message` is set when `ok` is false (the app's tsconfig does not narrow a union on `ok`). */
export type Done = { ok: boolean; message?: string };
const done = (error: { message?: string } | null): Done => (error ? { ok: false, message: error.message || 'Something went wrong.' } : { ok: true });

/** Same RPC the executive "Pending portfolios" queue uses. */
export async function approvePortfolio(portfolioId: string): Promise<Done> {
  const { error } = await rpc('approve_pending_portfolio', { p_portfolio_id: portfolioId });
  return done(error);
}

export async function rejectPortfolio(portfolioId: string, reason: string): Promise<Done> {
  const r = reason.trim();
  if (r.length < REJECT_REASON_MIN) return { ok: false, message: `Write at least ${REJECT_REASON_MIN} characters for the reason.` };
  const { error } = await rpc('reject_pending_portfolio', { p_portfolio_id: portfolioId, p_reason: r });
  return done(error);
}

/** A follow-up note on the listing's request (`partner_ops_note_followup`; Partner Ops and the COO only). */
export async function noteFollowUp(requestId: string, note: string): Promise<Done> {
  const n = note.trim();
  if (n.length < FOLLOW_UP_MIN) return { ok: false, message: `Write at least ${FOLLOW_UP_MIN} characters.` };
  const { data, error } = await rpc('partner_ops_note_followup', { p_request_id: requestId, p_note: n });
  if (error) return done(error);
  const r = (data ?? {}) as { ok?: boolean; message?: string; error?: string };
  return r.ok === false ? { ok: false, message: r.message || r.error || 'The note was not saved.' } : { ok: true };
}

/* ───────────── reading helpers (tested) ───────────── */

export const DECISION_CHIP: Record<ListingDecision, { label: string; tone: Status; strong?: boolean }> = {
  fresh: { label: 'Fresh', tone: 'idle' },
  follow_up: { label: 'Follow up', tone: 'warn' },
  held: { label: 'Held by a funder', tone: 'ok' },
  welile_due: { label: 'Welile to fund', tone: 'bad', strong: true },
  frozen: { label: 'Frozen', tone: 'idle' },
};

export function decisionChip(d: string | null | undefined) {
  return DECISION_CHIP[(d ?? '') as ListingDecision] ?? { label: d ? d.replace(/_/g, ' ') : '—', tone: 'idle' as Status };
}

const ugxShort = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const ugxC = (v: number | null | undefined) => `UGX ${ugxShort.format(Number(v ?? 0))}`;
const int = (v: number | null | undefined) => Math.round(Number(v ?? 0)).toLocaleString('en');

/** A whole percentage (0–100), as the desk RPCs send them. */
export const pctText = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(Number(v))}%`);

export type TileText = { key: string; label: string; value: string; sub?: string; tone?: Status };

/** The seven tiles, as words — what the desk shows and the tests read. */
export function partnerTiles(b: PartnerBoard): TileText[] {
  const t = b.tiles;
  const avg = t.sold.avg_days_coo_to_funded;
  return [
    { key: 'listed', label: 'Listed now', value: int(t.listed.n), sub: `${ugxC(t.listed.ugx)} · ${int(t.held)} held · ${int(t.frozen)} frozen` },
    { key: 'welile_due', label: 'Welile to fund (day 7+)', value: int(t.welile_due.n), sub: ugxC(t.welile_due.ugx), tone: t.welile_due.n > 0 ? 'bad' : undefined },
    {
      key: 'sold',
      label: 'Sold',
      value: int(t.sold.n),
      sub: `${ugxC(t.sold.ugx)} · Officers ${int(t.sold.by_officers.n)} · Self ${int(t.sold.by_self.n)} · Welile ${int(t.sold.by_welile.n)}`,
    },
    {
      key: 'sell_through',
      label: 'Sell-through within 7 days',
      value: pctText(t.sell_through_7d.pct),
      sub: `${int(t.sell_through_7d.sold_within_7d)} of ${int(t.sell_through_7d.listed_last_30d)} listed in 30 days`,
    },
    { key: 'avg_days', label: 'Avg days to sell', value: avg === null ? '—' : (Math.round(avg * 10) / 10).toFixed(1), sub: 'COO approval to funded' },
    {
      key: 'pending',
      label: 'Funder money awaiting approval',
      value: ugxC(t.pending_portfolios.ugx),
      sub: `${int(t.pending_portfolios.n)} portfolio${t.pending_portfolios.n === 1 ? '' : 's'}`,
      tone: t.pending_portfolios.n > 0 ? 'warn' : undefined,
    },
    { key: 'officers', label: 'Officers active', value: `${int(b.funnel.officers_active)} of ${int(b.funnel.officers)}`, sub: `${int(b.funnel.contacts)} contacts logged` },
  ];
}

/** Best first: money funded, then plans funded, funders, sign-ups, invites; ties by name. */
export function rankOfficers(rows: Officer[]): Officer[] {
  return [...rows].sort(
    (a, b) =>
      b.funded_ugx - a.funded_ugx ||
      b.funded - a.funded ||
      b.funders - a.funders ||
      b.signups - a.signups ||
      b.invites - a.invites ||
      String(a.officer ?? '').localeCompare(String(b.officer ?? '')),
  );
}

/** Funders counted against the monthly target: this month's new funders when sent, else all funders. */
export function targetFunders(o: Pick<Officer, 'funders' | 'funders_this_month'>): number {
  return o.funders_this_month ?? o.funders;
}

/** Funders against the monthly target (a count of funders), 0–100, or null with no target. */
export function targetProgress(o: Pick<Officer, 'funders' | 'funders_this_month' | 'monthly_target'>): number | null {
  if (!o.monthly_target || o.monthly_target <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((targetFunders(o) / o.monthly_target) * 100)));
}

/** "Last follow-up · 7 Nov 09:30 · Rita: Agent will re-shoot the photos" — or null with none. */
export function lastFollowUpText(f: Listing['last_followup'], when: (iso: string) => string): string | null {
  if (!f || !(f.note || f.at)) return null;
  const parts = ['Last follow-up'];
  if (f.at) parts.push(when(f.at));
  if (f.by) parts.push(f.by);
  return `${parts.join(' · ')}${f.note ? `: ${f.note}` : ''}`;
}

export const SOLD_BY: Record<string, string> = { officer: "Officer's funder", officers: "Officer's funder", self: 'Self', welile: 'Welile' };
export const soldBy = (by: string | null | undefined) => (by ? SOLD_BY[by] ?? by : '—');
