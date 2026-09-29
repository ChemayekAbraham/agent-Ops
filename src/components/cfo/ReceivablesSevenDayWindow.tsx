import { useMemo } from 'react';
import { CalendarClock, History, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import { useReceivablesPredictiveForecast, type ReceivableItem } from '@/hooks/useReceivables';

const DAY = 86_400_000;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface Row {
  label: string;
  ideal: number;
  behaviour: number;
}

/**
 * Seven-day windows for one product.
 * Ideal     = what is contractually due (scheduled items / daily plan amount).
 * Behaviour = what the server model predicts from this product's real collection history.
 * Read-only; never writes anything.
 */
export function ReceivablesSevenDayWindow({
  items,
  categoryKey,
  productKey,
}: {
  items: ReceivableItem[];
  categoryKey: string;
  productKey: string;
}) {
  const forecast = useReceivablesPredictiveForecast('day', 7);

  const { next, past } = useMemo(() => {
    const today = startOfToday();
    const matches = (s: { category_key: string; product_key: string }) =>
      s.product_key === productKey &&
      (s.category_key === categoryKey || categoryKey === 'agent' && s.category_key === 'service_centre');

    const stream = forecast.data?.streams.find(matches);
    const dailyBehaviour = Number(stream?.median_daily ?? 0);

    // Ideal per day from contractual due dates.
    const idealByDay = new Map<string, number>();
    const pastRows: Row[] = [];
    for (let i = 7; i >= 1; i--) {
      const d = new Date(today - i * DAY);
      pastRows.push({ label: d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }), ideal: 0, behaviour: dailyBehaviour });
    }
    for (const it of items ?? []) {
      if (!it.due_date) continue;
      const t = new Date(it.due_date);
      t.setHours(0, 0, 0, 0);
      const diff = Math.round((t.getTime() - today) / DAY);
      const amt = Number(it.amount) || 0;
      if (diff >= -7 && diff < 0) pastRows[7 + diff].ideal += amt;
      else if (diff >= 0 && diff < 7) idealByDay.set(String(diff), (idealByDay.get(String(diff)) ?? 0) + amt);
    }

    const nextRows: Row[] = (forecast.data?.periods ?? []).slice(0, 7).map((p, i) => {
      const src = p.sources.filter(matches);
      const behaviour = src.reduce((s, x) => s + Number(x.amount || 0), 0);
      const scheduled = idealByDay.get(String(i)) ?? 0;
      return {
        label: new Date(p.period_start).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }),
        ideal: scheduled > 0 ? scheduled : behaviour > 0 ? Math.max(behaviour, dailyBehaviour) : dailyBehaviour,
        behaviour,
      };
    });
    return { next: nextRows, past: pastRows };
  }, [forecast.data, items, categoryKey, productKey]);

  if (forecast.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
        <Loader2 className="h-4 w-4 animate-spin" /> Building 7-day prediction…
      </div>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <WindowCard
        title="Receivables in the next 7 days"
        hint="Predicted from this product's collection behaviour"
        icon={<CalendarClock className="h-4 w-4 text-primary" />}
        rows={next}
      />
      <WindowCard
        title="Receivables in the past 7 days"
        hint="Scheduled amounts that fell due in the last 7 days"
        icon={<History className="h-4 w-4 text-muted-foreground" />}
        rows={past}
        showBehaviour={false}
      />
    </div>
  );
}

function WindowCard({ title, hint, icon, rows }: { title: string; hint: string; icon: React.ReactNode; rows: Row[] }) {
  const ideal = rows.reduce((s, r) => s + r.ideal, 0);
  const behaviour = rows.reduce((s, r) => s + r.behaviour, 0);
  return (
    <Card className="border-border/60">
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          {icon}
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{title}</p>
            <p className="text-[11px] text-muted-foreground">{hint}</p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-md bg-muted/40 px-2.5 py-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Ideal</p>
            <p className="text-sm font-bold font-mono tabular-nums">{formatUGX(Math.round(ideal))}</p>
          </div>
          <div className="rounded-md bg-primary/10 px-2.5 py-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Based on behaviour</p>
            <p className="text-sm font-bold font-mono tabular-nums text-primary">{formatUGX(Math.round(behaviour))}</p>
          </div>
        </div>
        <div className="mt-3 space-y-1">
          <div className="grid grid-cols-3 px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>Day</span><span className="text-right">Ideal</span><span className="text-right">Behaviour</span>
          </div>
          {rows.map((r) => (
            <div key={r.label} className="grid grid-cols-3 rounded-md bg-muted/30 px-2 py-1.5 text-xs">
              <span className="truncate">{r.label}</span>
              <span className="text-right font-mono tabular-nums">{formatUGX(Math.round(r.ideal))}</span>
              <span className="text-right font-mono tabular-nums font-semibold">{formatUGX(Math.round(r.behaviour))}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default ReceivablesSevenDayWindow;
