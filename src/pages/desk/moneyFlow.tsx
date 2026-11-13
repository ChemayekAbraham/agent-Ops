import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { rpc } from './reviewApi';
import { fmt } from './format';
import { CALM, FOCUS, LABEL, statusText, type Status } from './deskTheme';
import { Skeleton } from './Skeleton';
import { Chip, EmptyState, ErrorLine, Sheet, moneyFull, stackLayout } from './ui';
import { releaseTone, waitedText } from './AwaitingRelease';

/**
 * Live funder money after release (E85, E93): `funded_money_flow(p_days)`.
 * Small lines under the funders cards on the Command Centre and its wall view
 * (the CFO's Funders Dashboard uses the same lines):
 *
 *   Released to agents: 12 · UGX 8,400,000
 *   Selected, waiting: 5 · UGX 3,500,000 · oldest 30 h               (amber > 24 h, red > 72 h)
 *   With agents, landlord not paid: 3 · UGX 2,100,000 · oldest 30 h  (amber > 24 h, red > 72 h)
 *   Sold (landlord paid, OTP): 9 · UGX 6,300,000
 *
 * E93: a plan is sold when the landlord is paid after the landlord's OTP and
 * the merchant payment (`sold`); "Selected, waiting" is every plan a funder
 * selected that is not sold yet (`selected_waiting`, right now, not the period).
 * Refetched every 30 s so the figures move as agents pay landlords. A tap
 * (not on the wall view) lists the items, newest selected first. A skeleton
 * while loading, the server's words on a failure: never a zero it has not been told.
 */

export const MONEY_FLOW_DAYS = 30;
export const MONEY_FLOW_REFRESH_MS = 30_000;

/** 'paid_to_landlord' and 'plan_live' are the older names for 'live'. */
export type FlowStage = 'with_agent' | 'part_paid' | 'live' | 'sold' | 'paid_to_landlord' | 'plan_live';
export type MoneyFlowItem = {
  rent_request_id?: string;
  tenant: string | null;
  agent: string | null;
  landlord: string | null;
  amount: number | null;
  paid_out: number | null;
  stage: FlowStage | string;
  hours_since_release: number | null;
  /** E93. */
  funder?: string | null;
  selected_at?: string | null;
};
type CountUgx = { count: number; ugx: number };
export type MoneyFlow = {
  released: CountUgx;
  with_agent: CountUgx & { oldest_hours: number | null };
  part_paid: { count: number; ugx_paid: number; ugx_left: number };
  /** Landlord paid = plan live. */
  live: CountUgx;
  /** Kept by the server for compatibility; `live` is what the desks show. */
  paid_to_landlord: CountUgx;
  plan_live: CountUgx;
  /** E93: landlord paid after OTP + merchant payment, in the period. Null from a server without it. */
  sold: CountUgx | null;
  /** E93: selected by a funder, not sold yet. Null from a server without it. */
  selected_waiting: (CountUgx & { oldest_hours: number | null }) | null;
  items: MoneyFlowItem[];
};

const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const cu = (x: unknown): CountUgx => {
  const o = (x ?? {}) as Record<string, unknown>;
  return { count: num(o.count), ugx: num(o.ugx) };
};
const hours = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

export function useMoneyFlow(enabled = true) {
  return useQuery({
    queryKey: ['desk-feed', 'money-flow', MONEY_FLOW_DAYS],
    enabled,
    queryFn: async (): Promise<MoneyFlow> => {
      const { data, error } = await rpc('funded_money_flow', { p_days: MONEY_FLOW_DAYS });
      if (error) throw error;
      const d = (data ?? {}) as Record<string, unknown>;
      const wa = (d.with_agent ?? {}) as Record<string, unknown>;
      const pp = (d.part_paid ?? {}) as Record<string, unknown>;
      const sw = d.selected_waiting as Record<string, unknown> | null | undefined;
      return {
        released: cu(d.released),
        with_agent: { ...cu(wa), oldest_hours: hours(wa.oldest_hours) },
        part_paid: { count: num(pp.count), ugx_paid: num(pp.ugx_paid), ugx_left: num(pp.ugx_left) },
        paid_to_landlord: cu(d.paid_to_landlord),
        plan_live: cu(d.plan_live),
        // `live` from the server; should it be missing, the two older parts add up to it.
        live: d.live
          ? cu(d.live)
          : { count: cu(d.paid_to_landlord).count + cu(d.plan_live).count, ugx: cu(d.paid_to_landlord).ugx + cu(d.plan_live).ugx },
        sold: d.sold ? cu(d.sold) : null,
        selected_waiting: sw ? { ...cu(sw), oldest_hours: hours(sw.oldest_hours) } : null,
        items: Array.isArray(d.items) ? (d.items as MoneyFlowItem[]) : [],
      };
    },
    refetchInterval: MONEY_FLOW_REFRESH_MS,
    staleTime: 15_000,
    retry: 1,
  });
}

const oldest = (count: number, h: number | null) => (count > 0 && h !== null && Number.isFinite(h) ? ` · oldest ${fmt('int', Math.round(h))} h` : '');

/** The lines, in the order the money moves. */
export function moneyFlowLines(f: MoneyFlow): { key: string; text: string; tone: Status }[] {
  const out: { key: string; text: string; tone: Status }[] = [
    { key: 'released', text: `Released to agents: ${fmt('int', f.released.count)} · ${moneyFull(f.released.ugx)}`, tone: 'idle' },
  ];
  const sw = f.selected_waiting;
  if (sw) {
    out.push({
      key: 'selected_waiting',
      text: `Selected, waiting: ${fmt('int', sw.count)} · ${moneyFull(sw.ugx)}${oldest(sw.count, sw.oldest_hours)}`,
      tone: sw.count > 0 ? releaseTone(sw.oldest_hours) : 'idle',
    });
  }
  out.push({
    key: 'with_agent',
    text: `With agents, landlord not paid: ${fmt('int', f.with_agent.count)} · ${moneyFull(f.with_agent.ugx)}${oldest(f.with_agent.count, f.with_agent.oldest_hours)}`,
    tone: f.with_agent.count > 0 ? releaseTone(f.with_agent.oldest_hours) : 'idle',
  });
  // Only when some is part paid, so the lines add up to what was released.
  if (f.part_paid.count > 0) {
    out.push({
      key: 'part_paid',
      text: `Part paid to landlords: ${fmt('int', f.part_paid.count)} · ${moneyFull(f.part_paid.ugx_paid)} paid · ${moneyFull(f.part_paid.ugx_left)} left`,
      tone: 'warn',
    });
  }
  // The final line (E93): the landlord was paid after the OTP and the merchant payment.
  // A server without `sold` still gets its older LIVE line rather than a zero it never said.
  out.push(
    f.sold
      ? { key: 'sold', text: `Sold (landlord paid, OTP): ${fmt('int', f.sold.count)} · ${moneyFull(f.sold.ugx)}`, tone: 'ok' }
      : { key: 'live', text: `LIVE (landlord paid): ${fmt('int', f.live.count)} · ${moneyFull(f.live.ugx)}`, tone: 'ok' },
  );
  return out;
}

export const STAGE_WORDS: Record<string, { text: string; tone: Status }> = {
  with_agent: { text: 'With agent', tone: 'warn' },
  part_paid: { text: 'Part paid', tone: 'warn' },
  live: { text: 'LIVE', tone: 'ok' },
  // Older stage names for the same thing.
  paid_to_landlord: { text: 'LIVE', tone: 'ok' },
  plan_live: { text: 'LIVE', tone: 'ok' },
  // E93: landlord paid after the OTP and the merchant payment.
  sold: { text: 'Sold', tone: 'ok' },
};

/**
 * The Command Centre's list (E93): now that "Sold" is the final line, a plan
 * paid out of the float with no OTP-verified landlord payment is still waiting.
 * STAGE_WORDS itself stays as the CFO's screens read it.
 */
const AWAITING_OTP = { text: 'Paid, awaiting OTP', tone: 'warn' as Status };
export const LIST_STAGE_WORDS: Record<string, { text: string; tone: Status }> = {
  ...STAGE_WORDS,
  live: AWAITING_OTP,
  paid_to_landlord: AWAITING_OTP,
  plan_live: AWAITING_OTP,
};

const when = (v: string | null | undefined) => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** Newest selected first (or oldest first); items without a time go last. */
export function sortBySelected(items: MoneyFlowItem[], newestFirst: boolean): MoneyFlowItem[] {
  return items
    .map((it, i) => ({ it, i, t: when(it.selected_at) }))
    .sort((a, b) => {
      if (a.t === null || b.t === null) return a.t === b.t ? a.i - b.i : a.t === null ? 1 : -1;
      return (newestFirst ? b.t - a.t : a.t - b.t) || a.i - b.i;
    })
    .map((x) => x.it);
}

const selectedText = (v: string | null | undefined) => {
  const t = when(v);
  if (t === null) return null;
  return new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala' });
};

const notAuthorized = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null;
  return x?.code === '42501' || /not authori[sz]ed|This view is for/i.test(String(x?.message ?? ''));
};

/** Under the funders cards. `board` is the wall view: bigger text, and no tap. */
export function MoneyFlowLines({ board }: { board: boolean }) {
  const q = useMoneyFlow();
  const [open, setOpen] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  if (q.error && notAuthorized(q.error)) return null;
  const f = q.data;
  const size = board ? 'text-sm' : 'text-xs';

  const body = q.isLoading ? (
    <div style={stackLayout(4)} role="status" aria-label="Loading the money after release">
      <Skeleton className="h-3.5 w-64" />
      <Skeleton className="h-3.5 w-80" />
      <Skeleton className="h-3.5 w-56" />
    </div>
  ) : q.error ? (
    <ErrorLine>{String((q.error as { message?: string }).message ?? q.error)}</ErrorLine>
  ) : f ? (
    <div style={stackLayout(2)}>
      {moneyFlowLines(f).map((l) => (
        <span key={l.key} data-flow-line={l.key} data-tone={l.tone} className={`${size} ${l.tone === 'idle' ? 'text-muted-foreground' : statusText[l.tone]}`} style={{ display: 'block', overflowWrap: 'anywhere' }}>
          {l.text}
        </span>
      ))}
    </div>
  ) : null;

  return (
    <section aria-label="Funder money after release" data-money-flow className="px-1">
      {board || !f ? (
        body
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={`w-full rounded-lg text-left hover:bg-[var(--desk-surface-hover)] ${CALM} ${FOCUS}`} title="See each release">
          {body}
        </button>
      )}
      {open && f && (
        <Sheet title="Funder money after release" onClose={() => setOpen(false)}>
          <p className={LABEL} style={{ margin: 0 }}>
            Last {MONEY_FLOW_DAYS} days · updates every 30 seconds
          </p>
          {f.items.length === 0 ? (
            <EmptyState>Nothing released in the last {MONEY_FLOW_DAYS} days.</EmptyState>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="group" aria-label="Order">
                {[true, false].map((nf) => (
                  <button
                    key={String(nf)}
                    type="button"
                    data-sort={nf ? 'newest' : 'oldest'}
                    aria-pressed={newestFirst === nf}
                    onClick={() => setNewestFirst(nf)}
                    className={`rounded-full border px-3 py-1 text-xs ${newestFirst === nf ? 'border-foreground text-foreground' : 'border-[var(--desk-line-color)] text-muted-foreground'} ${CALM} ${FOCUS}`}
                  >
                    {nf ? 'Newest selected first' : 'Oldest selected first'}
                  </button>
                ))}
              </div>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none' }} aria-label="Releases">
                {sortBySelected(f.items, newestFirst).map((it, i) => {
                  const st = LIST_STAGE_WORDS[it.stage] ?? { text: String(it.stage).replace(/_/g, ' '), tone: 'idle' as Status };
                  const sel = selectedText(it.selected_at);
                  return (
                    <li
                      key={`${it.rent_request_id ?? i}-${i}`}
                      data-flow-item={it.stage}
                      className="border-t border-[var(--desk-line-color)] first:border-t-0"
                      style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 2, padding: '10px 0' }}
                    >
                      <span className="font-medium text-foreground" style={{ minWidth: 0, overflowWrap: 'anywhere' }} data-flow-tenant>
                        {it.tenant ?? '—'}
                      </span>
                      <span className="tabular-nums text-foreground" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {moneyFull(it.amount)}
                      </span>
                      <span className={LABEL} style={{ gridColumn: '1 / -1', overflowWrap: 'anywhere' }} data-flow-who="agent">
                        Agent {it.agent ?? '—'}
                      </span>
                      <span className={LABEL} style={{ gridColumn: '1 / -1', overflowWrap: 'anywhere' }} data-flow-who="landlord">
                        Landlord {it.landlord ?? '—'}
                      </span>
                      <span className={LABEL} style={{ gridColumn: '1 / -1', overflowWrap: 'anywhere' }} data-flow-who="funder">
                        Funder {it.funder ?? '—'}
                      </span>
                      <span style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 }}>
                        <Chip tone={st.tone}>{st.text}</Chip>
                        <span className={LABEL} style={{ overflowWrap: 'anywhere' }}>
                          {sel ? `Selected ${sel}` : `Released ${waitedText(it.hours_since_release)} ago`}
                          {num(it.paid_out) > 0 ? ` · paid out ${moneyFull(it.paid_out)}` : ''}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Sheet>
      )}
    </section>
  );
}
