import { useMemo, useState } from 'react';
import { CalendarClock, ChevronRight, History, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { useReceivablesBreakdown, useReceivablesPredictiveForecast } from '@/hooks/useReceivables';
import { usePayablesBreakdown, usePayablesPredictiveForecast } from '@/hooks/usePayables';

const DAY = 86_400_000;
const fmt = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });

interface Source { who: string; category: string; product: string; amount: number; kind: string }
interface Row { label: string; amount: number; sources: Source[] }
type Cat = {
  label: string;
  products: { label: string; items: { counterparty: string | null; amount: number; due_date: string | null; due_kind?: string }[] }[];
};

const dayIndex = (iso: string, today: number) => {
  const d = new Date(iso); d.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today) / DAY);
};
const startToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

function collect(cats: Cat[] | undefined, from: number, to: number, kindLabel: string): Row[] {
  const today = startToday();
  const rows: Row[] = [];
  for (let i = from; i < to; i++) rows.push({ label: fmt(new Date(today + i * DAY)), amount: 0, sources: [] });
  for (const c of cats ?? []) for (const p of c.products) for (const it of p.items ?? []) {
    if (!it.due_date) continue;
    const diff = dayIndex(it.due_date, today);
    if (diff < from || diff >= to) continue;
    const r = rows[diff - from];
    const amount = Number(it.amount) || 0;
    r.amount += amount;
    r.sources.push({ who: it.counterparty || 'Unnamed', category: c.label, product: p.label, amount, kind: kindLabel });
  }
  return rows;
}

/**
 * CFO Home: receivables and payables for the past 7 days (still-outstanding
 * amounts that fell due) and the next 7 days (server prediction). Selecting a
 * day shows where the amount came from. Read-only.
 */
export function SevenDayFlowSection() {
  const recB = useReceivablesBreakdown();
  const payB = usePayablesBreakdown();
  const recF = useReceivablesPredictiveForecast('day', 7);
  const payF = usePayablesPredictiveForecast('day', 7);
  const [open, setOpen] = useState<{ title: string; row: Row } | null>(null);

  const data = useMemo(() => {
    type P = { period_start: string; forecast_amount: number; sources: { category_label: string; product_label: string; amount: number; basis: string }[] };
    const next = (cats: Cat[] | undefined, periods: P[] | undefined): Row[] => {
      const sched = collect(cats, 0, 7, 'Scheduled');
      return (periods ?? []).slice(0, 7).map((p, i) => {
        const predicted: Source[] = (p.sources ?? [])
          .filter((s) => Number(s.amount) > 0)
          .map((s) => ({ who: 'Predicted from payment behaviour', category: s.category_label, product: s.product_label, amount: Number(s.amount), kind: s.basis === 'scheduled' ? 'Scheduled' : 'Predicted' }));
        return {
          label: fmt(new Date(p.period_start)),
          amount: Number(p.forecast_amount) || 0,
          sources: [...(sched[i]?.sources ?? []), ...predicted],
        };
      });
    };
    return {
      recPast: collect(recB.data?.categories as Cat[] | undefined, -7, 0, 'Due'),
      payPast: collect(payB.data?.categories as Cat[] | undefined, -7, 0, 'Due'),
      recNext: next(recB.data?.categories as Cat[] | undefined, recF.data?.periods as unknown as P[] | undefined),
      payNext: next(payB.data?.categories as Cat[] | undefined, payF.data?.periods as unknown as P[] | undefined),
    };
  }, [recB.data, payB.data, recF.data, payF.data]);

  const loading = recB.isLoading || payB.isLoading || recF.isLoading || payF.isLoading;
  const pick = (title: string) => (row: Row) => setOpen({ title, row });

  return (
    <section aria-label="Past and next 7 days" className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Past 7 Days &amp; Next 7 Days</h2>
        <p className="text-xs text-muted-foreground">
          Past = amounts that fell due and are still unpaid. Next = predicted from payment behaviour. Select a day to see where it came from.
        </p>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading 7-day view…
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <Win title="Receivables — Past 7 Days" icon={<History className="h-4 w-4" />} tone="text-success" rows={data.recPast} onPick={pick('Receivables — Past 7 Days')} />
          <Win title="Receivables — Next 7 Days (Prediction)" icon={<CalendarClock className="h-4 w-4" />} tone="text-success" rows={data.recNext} onPick={pick('Receivables — Next 7 Days')} />
          <Win title="Payables — Past 7 Days" icon={<History className="h-4 w-4" />} tone="text-destructive" rows={data.payPast} onPick={pick('Payables — Past 7 Days')} />
          <Win title="Payables — Next 7 Days (Prediction)" icon={<CalendarClock className="h-4 w-4" />} tone="text-destructive" rows={data.payNext} onPick={pick('Payables — Next 7 Days')} />
        </div>
      )}

      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{open?.row.label} · {open?.title}</DialogTitle>
            <DialogDescription>
              {open ? `${formatUGX(Math.round(open.row.amount))} — where it came from` : ''}
            </DialogDescription>
          </DialogHeader>
          {open && open.row.sources.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Nothing fell due on this day.</p>
          ) : (
            <div className="space-y-1.5">
              {open && groupSources(open.row.sources).map((s, i) => (
                <div key={i} className="flex items-start justify-between gap-3 rounded-md bg-muted/30 px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{s.who}{s.count > 1 ? ` · ${s.count} items` : ''}</p>
                    <p className="text-muted-foreground truncate">{s.category} › {s.product} · {s.kind}</p>
                  </div>
                  <span className="font-mono tabular-nums font-semibold shrink-0">{formatUGX(Math.round(s.amount))}</span>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Merge repeated lines from the same person/product so long days stay readable. */
function groupSources(list: Source[]) {
  const m = new Map<string, Source & { count: number }>();
  for (const s of list) {
    const k = `${s.who}|${s.product}|${s.kind}`;
    const e = m.get(k);
    if (e) { e.amount += s.amount; e.count += 1; } else m.set(k, { ...s, count: 1 });
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount);
}

function Win({ title, icon, tone, rows, onPick }: { title: string; icon: React.ReactNode; tone: string; rows: Row[]; onPick: (r: Row) => void }) {
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <div className="rounded-2xl border border-border/70 bg-card shadow-sm p-4 min-w-0">
      <div className={`flex items-center gap-2 text-sm font-semibold ${tone}`}>{icon}<span className="truncate text-foreground">{title}</span></div>
      <p className={`mt-2 text-lg font-bold font-mono tabular-nums ${tone}`}>{formatUGX(Math.round(total))}</p>
      <div className="mt-3 space-y-1">
        {rows.map((r) => (
          <button
            key={r.label}
            type="button"
            onClick={() => onPick(r)}
            aria-label={`${r.label}: ${formatUGX(Math.round(r.amount))}. View where it came from`}
            className="flex w-full items-center justify-between gap-2 rounded-md bg-muted/30 px-2 py-1.5 text-xs text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="truncate">{r.label}</span>
            <span className="flex items-center gap-1 font-mono tabular-nums">
              {formatUGX(Math.round(r.amount))}
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default SevenDayFlowSection;
