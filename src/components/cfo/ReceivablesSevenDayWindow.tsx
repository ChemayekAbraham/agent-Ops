import { useMemo } from 'react';
import { CalendarClock, History } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import type { ReceivableItem } from '@/hooks/useReceivables';

const DAY = 86_400_000;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Outstanding receivables of one product split into two windows by due date:
 * past 7 days (fell due, still open) and next 7 days (falling due).
 * Read-only view over the existing breakdown items.
 */
export function ReceivablesSevenDayWindow({ items }: { items: ReceivableItem[] }) {
  const { past, next } = useMemo(() => {
    const today = startOfToday();
    const past: ReceivableItem[] = [];
    const next: ReceivableItem[] = [];
    for (const it of items ?? []) {
      if (!it.due_date) continue;
      const t = new Date(it.due_date).getTime();
      if (Number.isNaN(t)) continue;
      if (t >= today - 7 * DAY && t < today) past.push(it);
      else if (t >= today && t < today + 8 * DAY) next.push(it);
    }
    const byDate = (a: ReceivableItem, b: ReceivableItem) =>
      (a.due_date ?? '').localeCompare(b.due_date ?? '');
    return { past: past.sort(byDate).reverse(), next: next.sort(byDate) };
  }, [items]);

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <WindowCard
        title="Receivables in the next 7 days"
        hint="Falling due from today"
        icon={<CalendarClock className="h-4 w-4 text-primary" />}
        rows={next}
      />
      <WindowCard
        title="Receivables in the past 7 days"
        hint="Fell due in the last 7 days, still open"
        icon={<History className="h-4 w-4 text-muted-foreground" />}
        rows={past}
      />
    </div>
  );
}

function WindowCard({
  title,
  hint,
  icon,
  rows,
}: {
  title: string;
  hint: string;
  icon: React.ReactNode;
  rows: ReceivableItem[];
}) {
  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return (
    <Card className="border-border/60">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {icon}
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{title}</p>
              <p className="text-[11px] text-muted-foreground">{hint}</p>
            </div>
          </div>
          <div className="text-right shrink-0">
            <p className="text-base font-bold font-mono tabular-nums">{formatUGX(total)}</p>
            <p className="text-[11px] text-muted-foreground">
              {rows.length} {rows.length === 1 ? 'item' : 'items'}
            </p>
          </div>
        </div>
        <div className="mt-3 max-h-64 overflow-y-auto space-y-1.5">
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No receivables in this window.</p>
          ) : (
            rows.map((r) => (
              <div
                key={r.item_id}
                className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <p className="text-xs truncate">{r.counterparty ?? 'Unnamed'}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {r.due_date ? new Date(r.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : ''}
                    {r.due_kind === 'projected' ? ' · estimated' : ''}
                  </p>
                </div>
                <span className="text-xs font-mono tabular-nums font-semibold shrink-0">
                  {formatUGX(Number(r.amount) || 0)}
                </span>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default ReceivablesSevenDayWindow;
