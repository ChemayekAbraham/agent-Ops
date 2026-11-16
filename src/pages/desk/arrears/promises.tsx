import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../reviewApi';
import { useMyStaffRef } from '../reviewApi';
import { LABEL, statusText, type Status } from '../deskTheme';
import { fmt } from '../format';
import { Card, Chip, EmptyState, ErrorLine, LoadingRows, Segmented, moneyFull, stackLayout } from '../ui';
import { plainError, yesterdayKampala, type Party } from './arrearsApi';
import { ACTION_BUTTON, CallButtons, LogCallSheet, dayText } from './ArrearsParts';

/**
 * PROMISES-KEPT (E116): `promises_kept(p_days, p_desk)`. A promise is a call
 * logged as "promised a date" or "will pay today"; kept when the money came
 * by the date (the amount, if one was given, else half of what was due),
 * broken when the date passed without it. Every count and % is the server's.
 */

export type Officer = {
  staff_ref: string | null;
  name: string | null;
  desk: string | null;
  promises: number;
  kept: number;
  broken: number;
  open: number;
  kept_pct: number | null;
  collected_on_kept: number;
};
export type BrokenPromise = {
  call_id: number | string;
  desk: string | null;
  by: string | null;
  party: string | null;
  promise_on: string | null;
  target: number | null;
  collected: number | null;
  rent_request_id: string | null;
  tenant: { name: string | null; phone: string | null } | null;
  agent: { id: string | null; name: string | null; phone: string | null } | null;
};
export type Promises = {
  days: number;
  rule: string | null;
  totals: { promises: number; kept: number; broken: number; open: number; kept_pct: number | null; collected_on_kept: number } | null;
  officers: Officer[];
  broken_recent: BrokenPromise[];
};

export type ArrearsDesk = 'agent-ops' | 'tenant-ops';
export const PROMISE_DAYS = [7, 30, 90] as const;
export type PromiseDays = (typeof PROMISE_DAYS)[number];
export const DESK_WORDS: Record<string, string> = { 'agent-ops': 'Agent Ops', 'tenant-ops': 'Tenant Ops' };

export function usePromisesKept(days: number, desk: ArrearsDesk | null) {
  return useQuery({
    queryKey: ['desk-feed', 'arrears', 'promises', days, desk],
    queryFn: async (): Promise<Promises> => {
      const { data, error } = await rpc('promises_kept', { p_days: days, p_desk: desk });
      if (error) throw error;
      const d = (data ?? {}) as Partial<Promises>;
      return {
        days: Number(d.days ?? days),
        rule: d.rule ?? null,
        totals: d.totals ?? null,
        officers: Array.isArray(d.officers) ? d.officers : [],
        broken_recent: Array.isArray(d.broken_recent) ? d.broken_recent : [],
      };
    },
    staleTime: 60_000,
    retry: 1,
  });
}

/** Kept % in the 50%-rule colours. */
export const keptTone = (pct: number | null | undefined): Status => (pct === null || pct === undefined ? 'idle' : pct >= 70 ? 'ok' : pct >= 50 ? 'warn' : 'bad');
const pctText = (pct: number | null | undefined) => (pct === null || pct === undefined ? '—' : `${pct}%`);

/** "My promises": the signed-in officer's row, matched by staff ID. */
export function MyPromises({ officers }: { officers: Officer[] }) {
  const me = useMyStaffRef();
  if (me.isLoading) return null;
  if (!me.data) {
    return (
      <p className={LABEL} style={{ margin: 0 }} data-my-promises="no-staff-id">
        My promises: your staff ID is not on file, so your promises cannot be matched.
      </p>
    );
  }
  const mine = officers.find((o) => o.staff_ref === me.data);
  if (!mine) {
    return (
      <span data-my-promises="none">
        <Chip tone="idle">My promises: none logged yet</Chip>
      </span>
    );
  }
  return (
    <span data-my-promises={mine.staff_ref} style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <Chip tone={keptTone(mine.kept_pct)} strong>
        My promises: {pctText(mine.kept_pct)} kept
      </Chip>
      <span className="text-sm text-foreground tabular-nums">
        {fmt('int', mine.kept)} kept / {fmt('int', mine.broken)} broken / {fmt('int', mine.open)} open · {moneyFull(mine.collected_on_kept)} collected on kept
      </span>
    </span>
  );
}

/** The officers, in the server's order (best kept % first). */
export function PromiseBoard({ officers, showDesk = false }: { officers: Officer[]; showDesk?: boolean }) {
  const me = useMyStaffRef();
  if (officers.length === 0) return <EmptyState>No promises logged in this period.</EmptyState>;
  const th = `${LABEL} px-2 py-1.5 text-right font-normal`;
  const td = 'px-2 py-1.5 text-right tabular-nums text-foreground';
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="w-full text-sm" data-promise-board>
        <thead>
          <tr>
            <th className={`${LABEL} px-2 py-1.5 text-left font-normal`}>Officer</th>
            {showDesk && <th className={`${LABEL} px-2 py-1.5 text-left font-normal`}>Desk</th>}
            <th className={th}>Promises</th>
            <th className={th}>Kept %</th>
            <th className={th}>Collected</th>
          </tr>
        </thead>
        <tbody>
          {officers.map((o, i) => {
            const mine = !!me.data && o.staff_ref === me.data;
            const tone = keptTone(o.kept_pct);
            return (
              <tr key={`${o.staff_ref ?? i}-${o.desk ?? ''}`} className={`border-t border-[var(--desk-line-color)] ${mine ? 'bg-[hsl(var(--primary)/0.10)]' : ''}`} data-officer={o.staff_ref ?? ''} data-mine={mine || undefined}>
                <td className="px-2 py-1.5 text-left text-foreground">
                  {o.name ?? o.staff_ref ?? '—'}
                  {o.staff_ref && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{o.staff_ref}</span>}
                </td>
                {showDesk && <td className="px-2 py-1.5 text-left text-muted-foreground">{DESK_WORDS[o.desk ?? ''] ?? o.desk ?? '—'}</td>}
                <td className={td}>{fmt('int', o.promises)}</td>
                <td className={`px-2 py-1.5 text-right tabular-nums ${tone === 'idle' ? 'text-muted-foreground' : statusText[tone]}`} data-kept-tone={tone}>
                  {pctText(o.kept_pct)}
                </td>
                <td className={td}>{moneyFull(o.collected_on_kept)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Recent broken promises: who to ring again, what was promised against what came. */
export function BrokenPromises({ items, onCallAgain }: { items: BrokenPromise[]; onCallAgain: (b: BrokenPromise) => void }) {
  if (items.length === 0) return <EmptyState>No broken promises in this period.</EmptyState>;
  return (
    <ul style={{ ...stackLayout(8), margin: 0, padding: 0, listStyle: 'none' }} aria-label="Broken promises" data-broken-promises>
      {items.map((b) => (
        <li key={String(b.call_id)} className="desk-panel min-w-0" style={{ ...stackLayout(6), padding: 12 }} data-broken={String(b.call_id)}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span className="text-sm font-semibold text-foreground" style={{ overflowWrap: 'anywhere' }}>
              <span className={`${LABEL} font-normal`}>Tenant </span>
              {b.tenant?.name ?? '—'}
            </span>
            <CallButtons phone={b.tenant?.phone ?? null} whatsapp who={`tenant ${b.tenant?.name ?? ''}`.trim()} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span className="text-sm text-foreground" style={{ overflowWrap: 'anywhere' }}>
              <span className={LABEL}>Agent </span>
              {b.agent?.name ?? '—'}
            </span>
            <CallButtons phone={b.agent?.phone ?? null} who={`agent ${b.agent?.name ?? ''}`.trim()} />
          </div>
          <p className="text-sm text-foreground" style={{ margin: 0 }} data-broken-figures>
            Promised for {dayText(b.promise_on)} · target {b.target === null || b.target === undefined ? '—' : moneyFull(b.target)} · collected{' '}
            <span className={statusText.bad}>{moneyFull(b.collected)}</span>
            {b.by ? <span className={LABEL}> · logged by {b.by}</span> : null}
          </p>
          <div>
            <button type="button" className={ACTION_BUTTON} onClick={() => onCallAgain(b)}>
              Call again
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

const PARTIES: Party[] = ['tenant', 'agent', 'landlord', 'funder'];
const asParty = (p: string | null | undefined, fallback: Party): Party => (PARTIES.includes(p as Party) ? (p as Party) : fallback);

/**
 * The top of a desk's Arrears calls tab (E116): my promises, the desk board,
 * and the recent broken promises with "Call again" (the Log call form).
 */
export function DeskPromises({ desk }: { desk: ArrearsDesk }) {
  const q = usePromisesKept(30, desk);
  const [again, setAgain] = useState<BrokenPromise | null>(null);
  if (q.isLoading) return <LoadingRows rows={2} label="Loading promises" />;
  if (q.error) return <ErrorLine>{plainError(q.error, { PROMISES_DENIED: 'Only Agent Ops, Tenant Ops, the COO and the CEO can see promises.' })}</ErrorLine>;
  const d = q.data;
  if (!d) return null;
  const fallback: Party = desk === 'agent-ops' ? 'agent' : 'tenant';
  return (
    <section aria-label="Promises" style={stackLayout(10)} data-desk-promises={desk}>
      <MyPromises officers={d.officers} />
      <details open data-board-fold>
        <summary className="cursor-pointer text-sm font-semibold text-foreground">Desk board · last {fmt('int', d.days)} days</summary>
        <div className="mt-2">
          <PromiseBoard officers={d.officers} />
        </div>
      </details>
      <details open data-broken-fold>
        <summary className="cursor-pointer text-sm font-semibold text-foreground">
          Broken promises <span className="tabular-nums text-muted-foreground">({fmt('int', d.broken_recent.length)})</span>
        </summary>
        <div className="mt-2">
          <BrokenPromises items={d.broken_recent} onCallAgain={setAgain} />
        </div>
      </details>
      {again && (
        <LogCallSheet
          title={`Call again · ${again.rent_request_id ? (again.tenant?.name ?? 'tenant') : (again.agent?.name ?? 'agent')}`}
          parties={again.rent_request_id ? PARTIES : ['agent']}
          defaultParty={again.rent_request_id ? asParty(again.party, fallback) : 'agent'}
          rentRequestId={again.rent_request_id}
          agentId={again.rent_request_id ? null : (again.agent?.id ?? null)}
          desk={desk}
          day={yesterdayKampala()}
          onClose={() => setAgain(null)}
        />
      )}
    </section>
  );
}

/** The Command Centre's card: both desks (p_desk null), 7 / 30 / 90 days. */
export function PromisesCard({ board }: { board: boolean }) {
  const [days, setDays] = useState<PromiseDays>(30);
  const q = usePromisesKept(days, null);
  if (q.error && (q.error as { code?: string }).code === '42501') return null;
  const t = q.data?.totals;
  return (
    <Card board={board} title="Promises kept" ariaLabel="Promises kept" busy={q.isLoading} footnote={q.data?.rule ?? undefined}>
      <Segmented<PromiseDays> ariaLabel="Days" value={days} onChange={(v) => v !== null && setDays(v)} options={PROMISE_DAYS.map((d) => ({ value: d, label: `${d} days` }))} />
      {q.isLoading ? (
        <LoadingRows rows={3} label="Loading promises" />
      ) : q.error ? (
        <ErrorLine>{plainError(q.error)}</ErrorLine>
      ) : t ? (
        <div style={stackLayout(12)} data-promises-card>
          <p className={`${board ? 'text-xl' : 'text-lg'} text-foreground`} style={{ margin: 0 }} data-promise-totals>
            <span className={`font-semibold tabular-nums ${keptTone(t.kept_pct) === 'idle' ? '' : statusText[keptTone(t.kept_pct)]}`}>{pctText(t.kept_pct)}</span> kept ·{' '}
            <span className="tabular-nums">{fmt('int', t.kept)}</span> kept / <span className="tabular-nums">{fmt('int', t.broken)}</span> broken /{' '}
            <span className="tabular-nums">{fmt('int', t.open)}</span> open of <span className="tabular-nums">{fmt('int', t.promises)}</span> · {moneyFull(t.collected_on_kept)} collected on kept
          </p>
          <PromiseBoard officers={q.data?.officers ?? []} showDesk />
        </div>
      ) : (
        <EmptyState>No promises came back.</EmptyState>
      )}
    </Card>
  );
}
