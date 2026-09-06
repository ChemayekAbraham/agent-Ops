import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { CalendarDays, ChevronDown, ChevronUp } from 'lucide-react';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { cn } from '@/lib/utils';

/** Kampala-local calendar day (YYYY-MM-DD) for a timestamptz string */
const KAMPALA = 'Africa/Kampala';
function kampalaDay(iso: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: KAMPALA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

interface Row { amount: number; created_at: string }
interface DayCell { day: string; amount: number; count: number }

/**
 * Repayment calendar: every collection this agent has ever recorded, grouped by
 * Kampala calendar day and laid out month by month (newest month first).
 * Source of truth is agent_collections — no projections, no estimates.
 */
export function AgentRepaymentCalendar({ agentId }: { agentId: string }) {
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['agent-repayment-calendar', agentId],
    enabled: !!agentId,
    staleTime: 60_000,
    queryFn: async () => {
      const all: Row[] = [];
      const PAGE = 1000;
      for (let page = 0; page < 40; page++) {
        const { data, error } = await supabase
          .from('agent_collections')
          .select('amount, created_at')
          .eq('agent_id', agentId)
          .gt('amount', 0)
          .order('created_at', { ascending: true })
          .range(page * PAGE, page * PAGE + PAGE - 1);
        if (error) throw error;
        const rows = (data ?? []) as Row[];
        all.push(...rows);
        if (rows.length < PAGE) break;
      }
      return all;
    },
  });

  const { months, totals } = useMemo(() => {
    const byDay = new Map<string, DayCell>();
    let total = 0;
    let count = 0;
    for (const r of data ?? []) {
      const amount = Number(r.amount || 0);
      if (!(amount > 0)) continue;
      const day = kampalaDay(r.created_at);
      const cell = byDay.get(day) ?? { day, amount: 0, count: 0 };
      cell.amount += amount;
      cell.count += 1;
      byDay.set(day, cell);
      total += amount;
      count += 1;
    }

    const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
    if (days.length === 0) {
      return { months: [] as { key: string; label: string; cells: (DayCell | null)[]; total: number; activeDays: number }[], totals: null };
    }

    const first = days[0].day;
    const last = days[days.length - 1].day;
    const best = days.reduce((a, b) => (b.amount > a.amount ? b : a), days[0]);

    // Month buckets from first collection month → current month (Kampala today)
    const todayKey = kampalaDay(new Date().toISOString());
    const [ty, tm] = todayKey.split('-').map(Number);
    const [fy, fm] = first.split('-').map(Number);
    const months: { key: string; label: string; cells: (DayCell | null)[]; total: number; activeDays: number }[] = [];
    let y = fy, m = fm;
    while (y < ty || (y === ty && m <= tm)) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      // 0 = Monday-first offset
      const firstWeekday = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
      const cells: (DayCell | null)[] = Array.from({ length: firstWeekday }, () => null);
      let monthTotal = 0;
      let activeDays = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const dayKey = `${key}-${String(d).padStart(2, '0')}`;
        const cell = byDay.get(dayKey) ?? { day: dayKey, amount: 0, count: 0 };
        if (cell.amount > 0) { monthTotal += cell.amount; activeDays += 1; }
        cells.push(cell);
      }
      months.push({
        key,
        label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
        cells,
        total: monthTotal,
        activeDays,
      });
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    months.reverse(); // newest month first

    return {
      months,
      totals: {
        total,
        count,
        activeDays: days.length,
        first,
        last,
        best,
        max: best.amount,
      },
    };
  }, [data]);

  if (isLoading) {
    return <div className="mt-2 text-[10px] text-muted-foreground">Loading repayment calendar…</div>;
  }
  if (!totals || months.length === 0) {
    return (
      <div className="mt-2 rounded-lg border border-border bg-background/70 p-2 text-[10px] text-muted-foreground italic">
        No collections recorded for this agent yet — the repayment calendar fills in as payments are recorded.
      </div>
    );
  }

  const tone = (amount: number) => {
    if (amount <= 0) return 'bg-muted/50 text-muted-foreground/50';
    const ratio = totals.max > 0 ? amount / totals.max : 0;
    if (ratio >= 0.75) return 'bg-emerald-600 text-white';
    if (ratio >= 0.5) return 'bg-emerald-500 text-white';
    if (ratio >= 0.25) return 'bg-emerald-400 text-emerald-950';
    return 'bg-emerald-200 text-emerald-900';
  };

  const visible = expanded ? months : months.slice(0, 2);

  return (
    <div className="mt-2 rounded-lg border border-border bg-background/70 p-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
            <CalendarDays className="h-3 w-3" />
            Repayment calendar · since {totals.first}
          </p>
          <p className="text-[10px] text-muted-foreground tabular-nums">
            <span className="font-semibold text-emerald-600">{formatUGX(totals.total)}</span> collected ·{' '}
            {totals.count} payment{totals.count === 1 ? '' : 's'} · {totals.activeDays} active day
            {totals.activeDays === 1 ? '' : 's'} · best {totals.best.day} ({formatUGX(totals.best.amount)})
          </p>
        </div>
        {months.length > 2 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
            className="flex items-center gap-1 text-[10px] font-semibold text-primary shrink-0"
          >
            {expanded ? 'Show less' : `All ${months.length} months`}
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        )}
      </div>

      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {visible.map(mo => (
          <div key={mo.key} className="rounded-md border border-border bg-background p-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[10px] font-semibold text-foreground truncate">{mo.label}</p>
              <p className="text-[9px] text-muted-foreground tabular-nums shrink-0">
                {formatUGX(mo.total)} · {mo.activeDays}d
              </p>
            </div>
            <div className="grid grid-cols-7 gap-[2px] mt-1.5">
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                <div key={i} className="text-[8px] text-muted-foreground text-center font-medium">{d}</div>
              ))}
              {mo.cells.map((cell, i) => cell === null ? (
                <div key={`pad-${i}`} />
              ) : (
                <div
                  key={cell.day}
                  title={cell.amount > 0
                    ? `${cell.day}: ${formatUGX(cell.amount)} from ${cell.count} payment${cell.count === 1 ? '' : 's'}`
                    : `${cell.day}: no collection`}
                  className={cn(
                    'aspect-square rounded-[3px] flex items-center justify-center text-[8px] font-bold tabular-nums',
                    tone(cell.amount),
                  )}
                >
                  {Number(cell.day.slice(-2))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-end gap-1 mt-1.5 text-[9px] text-muted-foreground">
        <span>less</span>
        <span className="h-2.5 w-2.5 rounded-[2px] bg-muted/50" />
        <span className="h-2.5 w-2.5 rounded-[2px] bg-emerald-200" />
        <span className="h-2.5 w-2.5 rounded-[2px] bg-emerald-400" />
        <span className="h-2.5 w-2.5 rounded-[2px] bg-emerald-500" />
        <span className="h-2.5 w-2.5 rounded-[2px] bg-emerald-600" />
        <span>more</span>
      </div>
    </div>
  );
}

export default AgentRepaymentCalendar;
