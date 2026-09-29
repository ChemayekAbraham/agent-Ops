import { useMemo, useState } from 'react';
import { CalendarClock, ChevronRight, History, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { kampalaLabel, kampalaOffsetYmd } from '@/lib/kampalaDays';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useReceivablesPredictiveForecast } from '@/hooks/useReceivables';
import { usePayablesPredictiveForecast } from '@/hooks/usePayables';

/** Kampala (EAT) calendar day `offset` days from today, e.g. "Tue, 29 Sept". */
const fmt = (offset: number) => kampalaLabel(kampalaOffsetYmd(offset));

interface Source { who: string; category: string; product: string; amount: number; kind: string; count?: number }
interface Row { label: string; amount: number; sources: Source[] }
type Cat = {
  label: string;
  products: { label: string; items: { counterparty: string | null; amount: number; due_date: string | null; due_kind?: string }[] }[];
};

/**
 * CFO Home: receivables and payables for the past 7 days (still-outstanding
 * amounts that fell due) and the next 7 days (server prediction). Selecting a
 * day shows where the amount came from. Read-only.
 */
type FullLine = { day_offset: number; category_label: string; product_label: string; amount: number; item_count: number };

/** Every qualifying record (no top-100 cap), grouped by day and product on the server. */
function useSevenDayLines(side: 'payables' | 'receivables') {
  return useQuery({
    queryKey: ['cfo-seven-day-lines', side],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cfo_seven_day_lines', { p_side: side });
      if (error) throw error;
      return (data ?? []) as unknown as FullLine[];
    },
    staleTime: 60_000,
  });
}

function fromFull(lines: FullLine[] | undefined, from: number, to: number, kindLabel: string): Row[] {
  const rows: Row[] = [];
  for (let i = from; i < to; i++) rows.push({ label: fmt(i), amount: 0, sources: [] });
  for (const l of lines ?? []) {
    if (l.day_offset < from || l.day_offset >= to) continue;
    const amount = Number(l.amount) || 0;
    const r = rows[l.day_offset - from];
    r.amount += amount;
    r.sources.push({ who: '', category: l.category_label, product: l.product_label, amount, kind: kindLabel, count: Number(l.item_count) || 0 });
  }
  return rows;
}

type ExpLine = { day_offset: number; category: string; amount: number; item_count: number; is_predicted: boolean };
const expLabel = (c: string) => c.replace(/_expense$/, '').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()) + ' Expense';

/** Platform expenses: recorded in the past 7 days; next 7 days predicted from the 28-day daily average. */
function useSevenDayExpenses() {
  return useQuery({
    queryKey: ['cfo-seven-day-expenses'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cfo_seven_day_expenses');
      if (error) throw error;
      return (data ?? []) as unknown as ExpLine[];
    },
    staleTime: 60_000,
  });
}

function expRows(lines: ExpLine[] | undefined, from: number, to: number, predicted: boolean): Row[] {
  const rows: Row[] = [];
  for (let i = from; i < to; i++) rows.push({ label: fmt(i), amount: 0, sources: [] });
  for (const l of lines ?? []) {
    if (l.is_predicted !== predicted || l.day_offset < from || l.day_offset >= to) continue;
    const amount = Number(l.amount) || 0;
    const r = rows[l.day_offset - from];
    r.amount += amount;
    r.sources.push({ who: '', category: 'Expenses', product: expLabel(l.category), amount, kind: predicted ? 'Predicted' : 'Recorded', count: Number(l.item_count) || 0 });
  }
  return rows;
}

export function SevenDayFlowSection() {
  const recL = useSevenDayLines('receivables');
  const payL = useSevenDayLines('payables');
  const recF = useReceivablesPredictiveForecast('day', 7);
  const payF = usePayablesPredictiveForecast('day', 7);
  const expL = useSevenDayExpenses();
  const expPast = useMemo(() => expRows(expL.data, -7, 0, false), [expL.data]);
  const expNext = useMemo(() => expRows(expL.data, 0, 7, true), [expL.data]);
  const [open, setOpen] = useState<{ title: string; row: Row } | null>(null);

  const data = useMemo(() => {
    type P = { period_start: string; forecast_amount: number; sources: { category_label: string; product_label: string; amount: number; basis: string }[] };
    // Next 7 days: all scheduled records; a day with nothing scheduled falls back to the behaviour prediction.
    const next = (lines: FullLine[] | undefined, periods: P[] | undefined): Row[] =>
      fromFull(lines, 0, 7, 'Scheduled').map((row, i) => {
        if (row.amount > 0) return row;
        const p = (periods ?? [])[i];
        if (!p) return row;
        const predicted: Source[] = (p.sources ?? [])
          .filter((s) => Number(s.amount) > 0)
          .map((s) => ({ who: '', category: s.category_label, product: s.product_label, amount: Number(s.amount), kind: 'Predicted' }));
        return { ...row, amount: Number(p.forecast_amount) || 0, sources: predicted };
      });
    return {
      recPast: fromFull(recL.data, -7, 0, 'Due'),
      payPast: fromFull(payL.data, -7, 0, 'Due'),
      recNext: next(recL.data, recF.data?.periods as unknown as P[] | undefined),
      payNext: next(payL.data, payF.data?.periods as unknown as P[] | undefined),
    };
  }, [recL.data, payL.data, recF.data, payF.data]);

  const loading = recL.isLoading || payL.isLoading || recF.isLoading || payF.isLoading;
  const pick = (title: string) => (row: Row) => setOpen({ title, row });

  return (
    <section aria-label="Past and next 7 days" className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Past 7 Days &amp; Next 7 Days</h2>
        <p className="text-xs text-muted-foreground">
          Past = amounts that fell due and are still unpaid. Next = scheduled amounts where they exist, otherwise predicted from payment
          behaviour. Select a day to see where it came from.
        </p>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading 7-day view…
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <Win title="Receivables — Past 7 Days" icon={<History className="h-4 w-4" />} tone="text-success" rows={data.recPast} onPick={pick('Receivables — Past 7 Days')} />
          <Win title="Receivables — Next 7 Days" icon={<CalendarClock className="h-4 w-4" />} tone="text-success" rows={data.recNext} onPick={pick('Receivables — Next 7 Days')} />
          <Win title="Payables — Past 7 Days" icon={<History className="h-4 w-4" />} tone="text-destructive" rows={data.payPast} onPick={pick('Payables — Past 7 Days')} />
          <Win title="Payables — Next 7 Days" icon={<CalendarClock className="h-4 w-4" />} tone="text-destructive" rows={data.payNext} onPick={pick('Payables — Next 7 Days')} />
          <Win title="Expenses — Past 7 Days" icon={<History className="h-4 w-4" />} tone="text-warning" rows={expPast} onPick={pick('Expenses — Past 7 Days')} />
          <Win title="Expenses — Next 7 Days" icon={<CalendarClock className="h-4 w-4" />} tone="text-warning" rows={expNext} onPick={pick('Expenses — Next 7 Days')} />
        </div>
      )}

      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{open?.row.label} · {open?.title}</DialogTitle>
            <DialogDescription>
              {open ? `${formatUGX(Math.round(open.row.amount))} — by product and service` : ''}
            </DialogDescription>
          </DialogHeader>
          {open && open.row.sources.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Nothing fell due on this day.</p>
          ) : (
            <div className="space-y-3">
              {open && groupByProduct(open.row.sources).map((g) => (
                <div key={g.key} className="rounded-lg border border-border/60 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{g.product}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{g.category}</p>
                    </div>
                    <span className="font-mono tabular-nums text-sm font-bold shrink-0">{formatUGX(Math.round(g.amount))}</span>
                  </div>
                  {g.items > 0 && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {g.items} {g.items === 1 ? 'item' : 'items'} due
                    </p>
                  )}
                  {g.predicted > 0 && (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Includes {formatUGX(Math.round(g.predicted))} predicted from this product's payment behaviour.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Group by product/service only — individual people are deliberately not listed. */
function groupByProduct(list: Source[]) {
  const m = new Map<string, { key: string; product: string; category: string; amount: number; predicted: number; items: number }>();
  for (const s of list) {
    const key = `${s.category}|${s.product}`;
    let g = m.get(key);
    if (!g) { g = { key, product: s.product, category: s.category, amount: 0, predicted: 0, items: 0 }; m.set(key, g); }
    g.amount += s.amount;
    if (s.kind === 'Predicted') g.predicted += s.amount; else g.items += s.count ?? 1;
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
