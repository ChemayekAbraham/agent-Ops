import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { rpc } from '../reviewApi';
import { CALM, FOCUS, LABEL, statusText, type Status } from '../deskTheme';
import { fmt } from '../format';
import { Card, Chip, EmptyState, ErrorLine, LoadingRows, Sheet, moneyFull, pctWhole, stackLayout } from '../ui';
import { plainError, useArrearsTotals } from '../arrears/arrearsApi';
import { TierCounts } from '../arrears/TenantArrearsTab';
import { dayText } from '../arrears/ArrearsParts';
import { MarkerStrip, daysBefore, monthEnd, useChangeMarkerList } from './markers';

/**
 * The COO / CEO signals on the Command Centre (E103–E105, E102 totals):
 * the demand alarm, the balance meter, the cohort board and the arrears tile.
 * Every figure is the server's; a viewer the server refuses sees nothing.
 */

const refused = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null;
  return x?.code === '42501' || /^(COO_ONLY|BALANCE_METER_DENIED|COHORT_DENIED|ARREARS_WATCH_DENIED)\b/.test(String(x?.message ?? ''));
};
const SIGNAL_WORDS: Record<string, string> = {
  COO_ONLY: 'Only the COO can acknowledge an alarm.',
  STAFF_ID_REQUIRED: 'Your staff ID is not on file, so this cannot be recorded. Ask HR to add your staff ID.',
};
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

/* ───────────── Demand alarm (E103) ───────────── */

type DemandDay = {
  day: string;
  weekday?: string;
  submissions: number;
  same_weekday_avg_4w: number | null;
  pct: number | null;
  last_7_days: number;
  weekly_avg_prev_4w: number | null;
  pct_7d: number | null;
  fired: boolean;
  rule?: string;
};
type Alarm = { id: number; day: string; kind: string; value: number | null; baseline: number | null; pct: number | null; acknowledged: boolean; acknowledged_by: string | null; acknowledged_at: string | null };
export const ALARMS_KEY = ['desk-feed', 'coo-alarms', 30] as const;

export function useCooAlarms() {
  return useQuery({
    queryKey: ALARMS_KEY,
    queryFn: async () => {
      const { data, error } = await rpc('coo_alarms_view', { p_days: 30 });
      if (error) throw error;
      const d = (data ?? {}) as { today?: DemandDay; alarms?: Alarm[] };
      return { today: d.today ?? null, alarms: Array.isArray(d.alarms) ? d.alarms : [] };
    },
    refetchInterval: 5 * 60_000,
    retry: 1,
  });
}

export function DemandAlarm({ board }: { board: boolean }) {
  const q = useCooAlarms();
  const qc = useQueryClient();
  const [acking, setAcking] = useState<number | null>(null);
  // E110: what changed in the 7 days the alarm compares.
  const markers = useChangeMarkerList(30);
  if (q.error && refused(q.error)) return null;
  if (q.isLoading) return <LoadingRows rows={1} label="Loading the demand alarm" />;
  if (q.error) return <ErrorLine>{plainError(q.error, SIGNAL_WORDS)}</ErrorLine>;
  const t = q.data?.today;
  const alarms = q.data?.alarms ?? [];

  const ack = async (id: number) => {
    setAcking(id);
    const { error } = await rpc('coo_alarm_ack', { p_id: id });
    setAcking(null);
    if (error) {
      toast.error(plainError(error, SIGNAL_WORDS));
      return;
    }
    toast.success('Alarm acknowledged');
    void qc.invalidateQueries({ queryKey: ALARMS_KEY });
  };

  const fired = t?.fired === true;
  return (
    <section
      aria-label="Demand alarm"
      data-demand-alarm={fired ? 'fired' : 'quiet'}
      className={`desk-panel min-w-0 ${fired ? 'border-[hsl(var(--destructive)/0.7)] bg-[hsl(var(--destructive)/0.12)]' : ''}`}
      style={{ ...stackLayout(8), padding: 16, borderWidth: fired ? 2 : undefined }}
      role={fired ? 'alert' : undefined}
    >
      {t && (
        <div style={stackLayout(4)}>
          <p className={`${board ? 'text-lg' : 'text-base'} font-semibold ${fired ? statusText.bad : 'text-foreground'}`} style={{ margin: 0 }} data-demand-today>
            {fired ? 'Demand alarm: ' : 'Demand: '}
            {fmt('int', t.submissions)} rent requests on {t.weekday ? `${t.weekday} ` : ''}
            {dayText(t.day)} vs {t.same_weekday_avg_4w ?? '—'} same-weekday average ({pctWhole(t.pct)})
          </p>
          <p className="text-sm text-foreground" style={{ margin: 0 }} data-demand-7d>
            Last 7 days: {fmt('int', t.last_7_days)} vs {t.weekly_avg_prev_4w ?? '—'} weekly average ({pctWhole(t.pct_7d)})
          </p>
          {t.rule && (
            <p className={LABEL} style={{ margin: 0 }}>
              {t.rule}
            </p>
          )}
          <MarkerStrip markers={markers} from={daysBefore(t.day, 6)} to={t.day} label="Changes in these 7 days" />
        </div>
      )}
      {!board && alarms.length > 0 && (
        <ul style={{ ...stackLayout(6), margin: 0, padding: 0, listStyle: 'none' }} aria-label="Alarms, last 30 days">
          {alarms.map((a) => (
            <li key={a.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }} data-alarm={a.id}>
              <span className="text-sm text-foreground" style={{ overflowWrap: 'anywhere' }}>
                {dayText(a.day)} · {a.kind.replace(/_/g, ' ')} · {a.value ?? '—'} vs {a.baseline ?? '—'} ({pctWhole(a.pct)})
              </span>
              {a.acknowledged ? (
                <span className={LABEL}>Acknowledged{a.acknowledged_by ? ` by ${a.acknowledged_by}` : ''}</span>
              ) : (
                <button
                  type="button"
                  disabled={acking === a.id}
                  onClick={() => void ack(a.id)}
                  className={`rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2.5 py-1 text-xs text-foreground hover:bg-[var(--desk-surface-hover)] disabled:opacity-50 ${CALM} ${FOCUS}`}
                >
                  {acking === a.id ? 'Saving…' : 'Acknowledge'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ───────────── Balance meter (E104) ───────────── */

type Meter = {
  ratio: number | null;
  state: string;
  verified_waiting: number;
  verified_waiting_rent: number;
  frozen_waiting: number;
  frozen_waiting_rent?: number;
  funder_money_ready: number;
  funders_with_money: number;
  rule?: string;
};
export const METER_STATE: Record<string, { text: string; tone: Status }> = {
  tenants_short: { text: 'Tenants short — more verified tenants needed', tone: 'warn' },
  balanced: { text: 'Balanced', tone: 'ok' },
  funders_short: { text: 'Funders short — Partner Ops brings funders', tone: 'bad' },
  empty: { text: 'Nothing waiting', tone: 'idle' },
};

export function useBalanceMeter() {
  return useQuery({
    queryKey: ['desk-feed', 'balance-meter'],
    queryFn: async (): Promise<Meter> => {
      const { data, error } = await rpc('balance_meter');
      if (error) throw error;
      return (data ?? {}) as Meter;
    },
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function BalanceMeter({ board }: { board: boolean }) {
  const q = useBalanceMeter();
  const [rule, setRule] = useState(false);
  if (q.error && refused(q.error)) return null;
  const m = q.data;
  const st = m ? (METER_STATE[m.state] ?? { text: m.state.replace(/_/g, ' '), tone: 'idle' as Status }) : null;
  return (
    <Card board={board} title="Balance meter" ariaLabel="Balance meter" busy={q.isLoading}>
      {q.isLoading ? (
        <LoadingRows rows={2} label="Loading the balance meter" />
      ) : q.error ? (
        <ErrorLine>{plainError(q.error)}</ErrorLine>
      ) : m && st ? (
        <button type="button" onClick={() => setRule(true)} className={`w-full rounded-lg text-left hover:bg-[var(--desk-surface-hover)] ${CALM} ${FOCUS}`} title="How it is worked out" data-balance-meter={m.state}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 10 }}>
            <span className={`${board ? 'text-5xl' : 'text-4xl'} font-semibold tabular-nums ${statusText[st.tone] || 'text-foreground'}`} data-ratio>
              {num(m.ratio) === null ? '—' : `${Number(m.ratio).toFixed(2)}×`}
            </span>
            <Chip tone={st.tone} strong>
              {st.text}
            </Chip>
          </div>
          <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2" style={{ margin: 0 }}>
            <div>
              <dt className={LABEL}>Verified waiting</dt>
              <dd className="tabular-nums text-foreground" style={{ margin: 0 }}>
                {fmt('int', m.verified_waiting)} · {moneyFull(m.verified_waiting_rent)}
              </dd>
            </div>
            <div>
              <dt className={LABEL}>Frozen waiting (agent below 50%)</dt>
              <dd className="tabular-nums text-foreground" style={{ margin: 0 }}>
                {fmt('int', m.frozen_waiting)}
              </dd>
            </div>
            <div>
              <dt className={LABEL}>Funder money ready</dt>
              <dd className="tabular-nums text-foreground" style={{ margin: 0 }}>
                {moneyFull(m.funder_money_ready)}
              </dd>
            </div>
            <div>
              <dt className={LABEL}>Funders with money</dt>
              <dd className="tabular-nums text-foreground" style={{ margin: 0 }}>
                {fmt('int', m.funders_with_money)}
              </dd>
            </div>
          </dl>
        </button>
      ) : null}
      {rule && m && (
        <Sheet title="Balance meter" onClose={() => setRule(false)}>
          <p className="text-sm text-foreground" style={{ margin: 0 }} data-meter-rule>
            {m.rule ?? 'No rule text came with the figures.'}
          </p>
        </Sheet>
      )}
    </Card>
  );
}

/* ───────────── Cohort board (E105) ───────────── */

type Cohort = { month: string; month_start: string; plans: number; rent_funded: number; due: number; collected: number; pct: number | null; repaying: number; silent_7d: number; completed: number };
export const pctTone = (pct: number | null): Status => (pct === null ? 'idle' : pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'bad');

export function useCohortBoard() {
  return useQuery({
    queryKey: ['desk-feed', 'cohort-board', 6],
    queryFn: async () => {
      const { data, error } = await rpc('cohort_board', { p_months: 6 });
      if (error) throw error;
      const d = (data ?? {}) as { cohorts?: Cohort[]; rule?: string };
      return { cohorts: Array.isArray(d.cohorts) ? d.cohorts : [], rule: d.rule ?? null };
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function CohortBoard({ board }: { board: boolean }) {
  const q = useCohortBoard();
  const markers = useChangeMarkerList(30);
  if (q.error && refused(q.error)) return null;
  const th = `${LABEL} px-2 py-1.5 text-right font-normal`;
  const td = 'px-2 py-1.5 text-right tabular-nums text-foreground';
  return (
    <Card board={board} title="Cohorts by month funded" ariaLabel="Cohort board" footnote={q.data?.rule ?? undefined} busy={q.isLoading}>
      {q.isLoading ? (
        <LoadingRows rows={3} label="Loading the cohorts" />
      ) : q.error ? (
        <ErrorLine>{plainError(q.error)}</ErrorLine>
      ) : !q.data || q.data.cohorts.length === 0 ? (
        <EmptyState>No plan funded in the last 6 months.</EmptyState>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          {/* The server's order: newest month first. */}
          <table className="w-full text-sm" data-cohort-board>
            <thead>
              <tr>
                <th className={`${LABEL} px-2 py-1.5 text-left font-normal`}>Month</th>
                <th className={th}>Plans</th>
                <th className={th}>Rent funded</th>
                <th className={th}>Due</th>
                <th className={th}>Collected</th>
                <th className={th}>%</th>
                <th className={th}>Repaying</th>
                <th className={th}>Silent 7d</th>
                <th className={th}>Completed</th>
                <th className={`${LABEL} px-2 py-1.5 text-left font-normal`}>Changes</th>
              </tr>
            </thead>
            <tbody>
              {q.data.cohorts.map((c) => (
                <tr key={c.month_start ?? c.month} className="border-t border-[var(--desk-line-color)]" data-cohort={c.month}>
                  <td className="whitespace-nowrap px-2 py-1.5 text-left text-foreground">{c.month}</td>
                  <td className={td}>{fmt('int', c.plans)}</td>
                  <td className={td}>{moneyFull(c.rent_funded)}</td>
                  <td className={td}>{moneyFull(c.due)}</td>
                  <td className={td}>{moneyFull(c.collected)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${pctTone(num(c.pct)) === 'idle' ? 'text-muted-foreground' : statusText[pctTone(num(c.pct))]}`} data-pct-tone={pctTone(num(c.pct))}>
                    {c.pct === null ? '—' : `${c.pct}%`}
                  </td>
                  <td className={td}>{fmt('int', c.repaying)}</td>
                  <td className={td}>{fmt('int', c.silent_7d)}</td>
                  <td className={td}>{fmt('int', c.completed)}</td>
                  <td className="px-2 py-1.5 align-top">
                    {c.month_start && <MarkerStrip markers={markers} from={c.month_start} to={monthEnd(c.month_start)} label="" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ───────────── Arrears tile (E102 totals) ───────────── */

export function ArrearsTile({ board }: { board: boolean }) {
  const q = useArrearsTotals();
  const markers = useChangeMarkerList(30);
  if (q.error && refused(q.error)) return null;
  const t = q.data?.totals;
  return (
    <Card board={board} title="Arrears watch" hint={q.data?.day ? dayText(q.data.day) : undefined} ariaLabel="Arrears watch" busy={q.isLoading}>
      {q.isLoading ? (
        <LoadingRows rows={2} label="Loading the arrears" />
      ) : q.error ? (
        <ErrorLine>{plainError(q.error)}</ErrorLine>
      ) : t ? (
        <div style={stackLayout(8)} data-arrears-tile>
          <p className={`${board ? 'text-lg' : 'text-base'} text-foreground`} style={{ margin: 0 }}>
            <span className="font-semibold tabular-nums">{fmt('int', t.plans)}</span> plans short ·{' '}
            <span className="tabular-nums">{fmt('int', t.agents)}</span> agents
          </p>
          <p className="text-sm text-foreground" style={{ margin: 0 }}>
            Shortfall <span className={`tabular-nums ${t.shortfall > 0 ? statusText.bad : ''}`}>{moneyFull(t.shortfall)}</span> · Arrears to date{' '}
            <span className="tabular-nums">{moneyFull(t.arrears_to_date)}</span>
          </p>
          <TierCounts totals={t} />
          <p className={LABEL} style={{ margin: 0 }}>
            Tenants called {fmt('int', t.tenant_called)} / agents called {fmt('int', t.agent_called)}
          </p>
          {q.data?.day && <MarkerStrip markers={markers} from={daysBefore(q.data.day, 6)} to={q.data.day} label="Changes in the 7 days to it" />}
        </div>
      ) : (
        <EmptyState>No arrears figures came back.</EmptyState>
      )}
    </Card>
  );
}
