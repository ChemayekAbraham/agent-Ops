import { useMemo } from 'react';
import { CalendarClock, History, Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useReceivablesBreakdown, useReceivablesPredictiveForecast } from '@/hooks/useReceivables';
import { usePayablesBreakdown, usePayablesPredictiveForecast } from '@/hooks/usePayables';

const DAY = 86_400_000;
const fmt = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });

interface Row { label: string; amount: number; estimated?: boolean }
type Cat = { products: { items: { amount: number; due_date: string | null }[] }[] };

function pastRows(cats: Cat[] | undefined): Row[] {
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const today = t0.getTime();
  const rows: Row[] = [];
  for (let i = 7; i >= 1; i--) rows.push({ label: fmt(new Date(today - i * DAY)), amount: 0 });
  for (const c of cats ?? []) for (const p of c.products) for (const it of p.items ?? []) {
    if (!it.due_date) continue;
    const d = new Date(it.due_date); d.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - today) / DAY);
    if (diff >= -7 && diff < 0) rows[7 + diff].amount += Number(it.amount) || 0;
  }
  return rows;
}

/**
 * CFO Home: receivables and payables for the past 7 days (still-outstanding
 * amounts that fell due) and the next 7 days (server prediction).
 * Read-only; every figure comes from the existing breakdown/forecast RPCs.
 */
export function SevenDayFlowSection() {
  const recB = useReceivablesBreakdown();
  const payB = usePayablesBreakdown();
  const recF = useReceivablesPredictiveForecast('day', 7);
  const payF = usePayablesPredictiveForecast('day', 7);

  const data = useMemo(() => {
    const next = (periods?: { period_start: string; forecast_amount: number }[]): Row[] =>
      (periods ?? []).slice(0, 7).map((p) => ({ label: fmt(new Date(p.period_start)), amount: Number(p.forecast_amount) || 0 }));
    return {
      recPast: pastRows(recB.data?.categories as Cat[] | undefined),
      payPast: pastRows(payB.data?.categories as Cat[] | undefined),
      recNext: next(recF.data?.periods),
      payNext: next(payF.data?.periods),
    };
  }, [recB.data, payB.data, recF.data, payF.data]);

  const loading = recB.isLoading || payB.isLoading || recF.isLoading || payF.isLoading;

  return (
    <section aria-label="Past and next 7 days" className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Past 7 Days &amp; Next 7 Days</h2>
        <p className="text-xs text-muted-foreground">
          Past = amounts that fell due and are still unpaid. Next = predicted from payment behaviour.
        </p>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading 7-day view…
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <Win title="Receivables — Past 7 Days" icon={<History className="h-4 w-4" />} tone="text-success" rows={data.recPast} />
          <Win title="Receivables — Next 7 Days (Prediction)" icon={<CalendarClock className="h-4 w-4" />} tone="text-success" rows={data.recNext} />
          <Win title="Payables — Past 7 Days" icon={<History className="h-4 w-4" />} tone="text-destructive" rows={data.payPast} />
          <Win title="Payables — Next 7 Days (Prediction)" icon={<CalendarClock className="h-4 w-4" />} tone="text-destructive" rows={data.payNext} />
        </div>
      )}
    </section>
  );
}

function Win({ title, icon, tone, rows }: { title: string; icon: React.ReactNode; tone: string; rows: Row[] }) {
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <div className="rounded-2xl border border-border/70 bg-card shadow-sm p-4 min-w-0">
      <div className={`flex items-center gap-2 text-sm font-semibold ${tone}`}>{icon}<span className="truncate text-foreground">{title}</span></div>
      <p className={`mt-2 text-lg font-bold font-mono tabular-nums ${tone}`}>{formatUGX(Math.round(total))}</p>
      <div className="mt-3 space-y-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between rounded-md bg-muted/30 px-2 py-1.5 text-xs">
            <span className="truncate">{r.label}</span>
            <span className="font-mono tabular-nums">{formatUGX(Math.round(r.amount))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default SevenDayFlowSection;
