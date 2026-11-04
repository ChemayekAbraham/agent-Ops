import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fmt } from './format';
import type { FeedState, Row } from './useDeskFeed';
import { rpc } from './reviewApi';
import { isMissingDbObject, logMissingOnce } from './deskLive';
import { CALM, FOCUS, LABEL, PANEL, statusGlass, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';
import {
  OWNER_LABEL,
  WAIT_DESKS,
  WAIT_DESK_NAME,
  isTimeUp,
  timeLeftText,
  useAllWaiting,
  type WaitDesk,
  type WaitingItem,
} from './waitOn';

/**
 * What the command centre gained in Operations 4. Everything that was on it
 * stays; these only add. Where an L1 card already carries a figure (budget
 * room today, the money blocker on the budget tile) the line links to it
 * instead of printing it twice.
 */

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v);

const DESK_ROUTE: Record<WaitDesk, string> = {
  service_centre: 'service-centre',
  agent_ops: 'agent-ops',
  tenant_ops: 'tenant-ops',
  landlord_ops: 'landlord-ops',
  coo: 'coo',
  cfo: 'cfo',
};

function Card({ title, note, board, children }: { title: string; note?: string; board: boolean; children: ReactNode }) {
  return (
    <section className={`${PANEL} flex min-h-0 flex-col gap-3 p-4 sm:p-5`}>
      <div className="shrink-0 space-y-1">
        <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>{title}</h2>
        {note && <p className="text-xs leading-snug text-muted-foreground">{note}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

/* ───────────────────────── money line ───────────────────────── */

type Gap = { label: string; n: number | null; ugx: number | null; oldestDays: number | null };

/**
 * The payment-gap rows are keyed by `ord`:
 *   '1' funded, landlord not yet paid
 *   '2' paid, receipt missing over 24 h
 * A missing row shows as a dash.
 */
export const GAP_ORD = { funded_not_paid: '1', receipts_missing: '2' } as const;

export function findGap(rows: Row[], kind: keyof typeof GAP_ORD): Gap | null {
  const row = rows.find((r) => String(r.ord) === GAP_ORD[kind]);
  return row ? { label: String(row.gap ?? ''), n: num(row.n), ugx: num(row.ugx), oldestDays: num(row.oldest_days) } : null;
}

function kpi(rows: Row[], metric: string): number | null {
  const r = rows.find((x) => String(x.metric) === metric);
  return r ? num(r.value) : null;
}

function Figure({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5" title={title}>
      <span className={LABEL}>{label}</span>
      <span className="tabular-nums text-foreground">{children}</span>
    </span>
  );
}

export function MoneyLine({ kpis, gaps, board }: { kpis: FeedState | undefined; gaps: FeedState; board: boolean }) {
  if (kpis?.loading || gaps.loading) return <Skeleton className="h-6 w-full max-w-4xl" />;

  const rows = kpis?.rows ?? [];
  const week = kpi(rows, 'budget_week_ugx');
  const weekUsed = kpi(rows, 'budget_week_used_ugx') ?? 0;
  const weekRoom = week === null ? null : Math.max(0, week - weekUsed);
  const fnp = findGap(gaps.rows, 'funded_not_paid');
  const rcp = findGap(gaps.rows, 'receipts_missing');
  const dot = <span className="text-muted-foreground" aria-hidden>·</span>;

  return (
    <p
      className={`${board ? 'text-base' : 'text-sm'} flex flex-wrap items-baseline gap-x-3 gap-y-1.5`}
      aria-label="Money today"
    >
      <Figure label="Budget room today">
        <a href="#budget-room" className={`rounded text-[hsl(var(--desk-lavender))] underline underline-offset-4 ${FOCUS}`}>
          on the Budget room card
        </a>
      </Figure>
      {dot}
      <Figure label="This week">{week === null ? <span className={statusText.bad}>No weekly budget set</span> : `UGX ${fmt('ugxfull', weekRoom)}`}</Figure>
      {dot}
      <Figure label="Funded, not paid" title={fnp?.label || undefined}>
        {fnp
          ? `${fmt('int', fnp.n)} · UGX ${fmt('ugxfull', fnp.ugx)}${fnp.oldestDays !== null ? ` · oldest ${fmt('days', fnp.oldestDays)} days` : ''}`
          : '—'}
      </Figure>
      {dot}
      <Figure label="Receipts missing over 24 h" title={rcp?.label || undefined}>
        {rcp ? `${fmt('int', rcp.n)} · UGX ${fmt('ugxfull', rcp.ugx)}` : '—'}
      </Figure>
      {dot}
      <a href="#money-blocker" className={`rounded text-xs text-[hsl(var(--desk-lavender))] underline underline-offset-4 ${FOCUS}`}>
        Money blocked today: see the budget tile
      </a>
    </p>
  );
}

/* ───────────────────────── waiting on, by desk ───────────────────────── */

type Placed = WaitingItem & { desk: WaitDesk };

/** The time-up wait whose end passed longest ago (earliest `until_at`). */
export function oldestTimeUp(items: Placed[]): Placed | null {
  const up = items.filter(isTimeUp);
  if (up.length === 0) return null;
  return up.reduce((a, b) => (Date.parse(b.untilAt) < Date.parse(a.untilAt) ? b : a));
}

/** Whole hours since a wait ran out. */
const hoursPast = (w: WaitingItem, now = Date.now()): number => Math.max(0, Math.round((now - Date.parse(w.untilAt)) / 3_600_000));

export function WaitingByDesk({ board, waiting }: { board: boolean; waiting: ReturnType<typeof useAllWaiting> }) {
  const desks = WAIT_DESKS.filter((d) => !waiting[d].missing);
  if (desks.length === 0) return null;
  const loading = desks.some((d) => waiting[d].loading);
  const all: Placed[] = desks.flatMap((d) => waiting[d].items.map((w) => ({ ...w, desk: d })));
  const oldest = oldestTimeUp(all);

  return (
    <Card title="Waiting on, by desk" note="Requests parked at a desk while someone outside it acts." board={board}>
      {loading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="space-y-3">
          <ul className="space-y-1.5">
            {desks.map((d) => {
              const list = waiting[d];
              const up = list.items.filter(isTimeUp).length;
              return (
                <li key={d}>
                  <Link
                    to={`/desk/${DESK_ROUTE[d]}`}
                    className={`flex items-baseline justify-between gap-3 rounded-lg -mx-1 px-1 py-0.5 ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)]`}
                  >
                    <span className="text-sm text-foreground">{WAIT_DESK_NAME[d]}</span>
                    <span className="flex items-baseline gap-2 text-sm tabular-nums">
                      {list.error ? <span className={statusText.bad}>could not load</span> : fmt('int', list.items.length)}
                      {up > 0 && <span className={`text-xs ${statusText.bad}`}>{fmt('int', up)} time up</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {oldest ? (
            <p className={`rounded-xl border px-3 py-2 text-sm ${statusGlass.bad}`}>
              Oldest time-up: {oldest.tenant} at {WAIT_DESK_NAME[oldest.desk]}, waiting on{' '}
              {oldest.ownerName ?? (OWNER_LABEL[oldest.ownerKind] ?? oldest.ownerKind).toLowerCase()} ({oldest.reasonCode}) —{' '}
              {hoursPast(oldest)} h past its time.
            </p>
          ) : (
            <p className={LABEL}>No wait has run out of time.</p>
          )}
        </div>
      )}
    </Card>
  );
}

/* ───────────────────────── top 3 blockers ───────────────────────── */

/** `ugx` is null for a waiting item: `pipeline_waiting_list` carries no amount. */
export type MoneyBlocker = { key: string; what: string; ugx: number | null; owner: string; next: string; timeUp: boolean };

/**
 * The three largest by UGX across payment gaps and waiting items. Waiting
 * items have no amount on their list, so they rank after every gap with money
 * attached — time-up first — and only fill the slots the gaps leave.
 */
export function topBlockers(gaps: Row[], waiting: Placed[]): MoneyBlocker[] {
  const out: MoneyBlocker[] = [];
  gaps.forEach((g, i) => {
    const ugx = num(g.ugx) ?? 0;
    if (ugx <= 0) return;
    out.push({
      key: `gap-${String(g.ord ?? i)}`,
      what: `${String(g.gap ?? 'Payment gap')} (${fmt('int', g.n)})`,
      ugx,
      owner: String(g.owner ?? '—'),
      next: String(g.next_step ?? '—'),
      timeUp: false,
    });
  });
  waiting.forEach((w) => {
    const owner = OWNER_LABEL[w.ownerKind] ?? w.ownerKind;
    const who = w.ownerName ? `${owner} (${w.ownerName})` : owner;
    const up = isTimeUp(w);
    out.push({
      key: `wait-${w.waitingId}`,
      what: `${w.tenant} waiting at ${WAIT_DESK_NAME[w.desk]} (${w.reasonCode})`,
      ugx: null,
      owner: who,
      next: up ? `Time up: chase the ${owner.toLowerCase()} or put it back in the queue` : `Chase the ${owner.toLowerCase()} — ${timeLeftText(w.hoursLeft)}`,
      timeUp: up,
    });
  });
  return out
    .sort(
      (a, b) =>
        (b.ugx ?? -1) - (a.ugx ?? -1) || Number(b.timeUp) - Number(a.timeUp),
    )
    .slice(0, 3);
}

export function TopBlockers({ board, gaps, waiting }: { board: boolean; gaps: FeedState; waiting: ReturnType<typeof useAllWaiting> }) {
  const all: Placed[] = WAIT_DESKS.flatMap((d) => waiting[d].items.map((w) => ({ ...w, desk: d })));
  const loading = gaps.loading || WAIT_DESKS.some((d) => waiting[d].loading);
  const items = loading ? [] : topBlockers(gaps.rows, all);

  return (
    <Card title="Top 3 blockers" note="The largest by UGX across payment gaps and waiting requests." board={board}>
      {loading && <Skeleton className="h-24 w-full" />}
      {!loading && items.length === 0 && <p className="text-sm text-muted-foreground">Nothing is blocked.</p>}
      {!loading && items.length > 0 && (
        <ol className="space-y-3">
          {items.map((b) => (
            <li key={b.key} className="space-y-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-foreground">{b.what}</span>
                <span className={`shrink-0 text-sm tabular-nums ${b.timeUp ? statusText.bad : 'text-foreground'}`}>
                  {b.ugx === null ? (b.timeUp ? 'Time up' : 'Waiting') : `UGX ${fmt('ugxfull', b.ugx)}`}
                </span>
              </div>
              <p className={LABEL}>
                Owner: {b.owner} · Next: {b.next}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/* ───────────────────────── service centre people ───────────────────────── */

/** One row of `desk_sc_people()`. */
type ScPersonRow = {
  person_id: string;
  name: string | null;
  phone: string | null;
  open_new: number | null;
  open_batch: number | null;
  oldest_new_days: number | null;
  has_staff_id: boolean;
  has_desk_role: boolean;
};

type Person = { key: string; name: string; openNew: number; oldestDays: number | null; hasStaffId: boolean };

export function toPerson(r: ScPersonRow): Person {
  return {
    key: String(r.person_id),
    name: r.name ?? '—',
    openNew: num(r.open_new) ?? 0,
    oldestDays: num(r.oldest_new_days),
    hasStaffId: r.has_staff_id === true,
  };
}

function useScPeople(enabled: boolean) {
  return useQuery({
    queryKey: ['desk-feed', 'sc-people'],
    enabled,
    queryFn: async (): Promise<{ people: Person[]; missing: boolean }> => {
      const { data, error } = await rpc('desk_sc_people', {});
      if (error) {
        if (isMissingDbObject(error)) {
          logMissingOnce('desk_sc_people', error);
          return { people: [], missing: true };
        }
        throw error;
      }
      const rows = Array.isArray(data) ? (data as ScPersonRow[]) : [];
      return { people: rows.map(toPerson).sort((a, b) => b.openNew - a.openNew), missing: false };
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}

const SC_TOP = 5;

export function ScPeople({ board, enabled }: { board: boolean; enabled: boolean }) {
  const q = useScPeople(enabled);
  const [all, setAll] = useState(false);
  if (!enabled || q.data?.missing) return null;
  const people = q.data?.people ?? [];
  const shown = all ? people : people.slice(0, SC_TOP);

  return (
    <Card title="Service Centre people" note="Who holds the new requests, most first." board={board}>
      {q.isLoading && <Skeleton className="h-24 w-full" />}
      {q.error && <p className={`text-sm ${statusText.bad}`}>Could not load the Service Centre people.</p>}
      {!q.isLoading && !q.error && people.length === 0 && <p className="text-sm text-muted-foreground">No one holds a new request.</p>}
      {shown.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className={`${LABEL} text-left`}>
              <th className="py-1 pr-2 font-normal">Name</th>
              <th className="py-1 pr-2 text-right font-normal">Open new</th>
              <th className="py-1 pr-2 text-right font-normal">Oldest days</th>
              <th className="py-1 text-right font-normal">Staff ID</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.key} className="border-t border-[var(--desk-line-color)]">
                <td className="py-1.5 pr-2 text-foreground">{p.name}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-foreground">{fmt('int', p.openNew)}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-foreground">{fmt('days', p.oldestDays)}</td>
                <td className={`py-1.5 text-right ${p.hasStaffId ? statusText.ok : statusText.bad}`}>{p.hasStaffId ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {people.length > SC_TOP && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          aria-expanded={all}
          className={`${LABEL} mt-2 w-fit rounded underline underline-offset-4 ${CALM} ${FOCUS} hover:text-foreground`}
        >
          {all ? 'Show top 5' : `See all ${fmt('int', people.length)}`}
        </button>
      )}
    </Card>
  );
}

/** The three new cards, in one row. */
export function CommandAdditionCards({ board, gaps, enabled }: { board: boolean; gaps: FeedState; enabled: boolean }) {
  const waiting = useAllWaiting(enabled);
  if (!enabled) return null;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <WaitingByDesk board={board} waiting={waiting} />
      <TopBlockers board={board} gaps={gaps} waiting={waiting} />
      <ScPeople board={board} enabled={enabled} />
    </div>
  );
}
