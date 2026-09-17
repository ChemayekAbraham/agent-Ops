import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
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
  const [monthIndex, setMonthIndex] = useState(0); // 0 = newest month
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

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
          .select('amount, created_at').is('reversed_at', null)
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

  const idx = Math.min(Math.max(monthIndex, 0), months.length - 1);
  const mo = months[idx];

  return (
    <div className="mt-2 rounded-lg border border-border bg-background/70 p-2">
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

      <div className="mt-2 flex flex-col gap-2 lg:flex-row">
        <div className="rounded-md border border-border bg-background p-2 lg:w-[60%]">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              aria-label="Previous month"
              disabled={idx >= months.length - 1}
              onClick={(e) => { e.stopPropagation(); setMonthIndex(idx + 1); }}
              className="h-6 w-6 rounded-md border border-border flex items-center justify-center disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <div className="text-center min-w-0">
              <p className="text-[11px] font-semibold text-foreground truncate">{mo.label}</p>
              <p className="text-[9px] text-muted-foreground tabular-nums">
                {formatUGX(mo.total)} · {mo.activeDays} active day{mo.activeDays === 1 ? '' : 's'}
              </p>
            </div>
            <button
              type="button"
              aria-label="Next month"
              disabled={idx <= 0}
              onClick={(e) => { e.stopPropagation(); setMonthIndex(idx - 1); }}
              className="h-6 w-6 rounded-md border border-border flex items-center justify-center disabled:opacity-30"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 mt-2">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <div key={i} className="text-[9px] text-muted-foreground text-center font-medium">{d}</div>
            ))}
            {mo.cells.map((cell, i) => cell === null ? (
              <div key={`pad-${i}`} className="h-9" />
            ) : (
              <button
                key={cell.day}
                type="button"
                onClick={(e) => { e.stopPropagation(); setSelectedDay(cell.day); }}
                title={cell.amount > 0
                  ? `${cell.day}: ${formatUGX(cell.amount)} from ${cell.count} payment${cell.count === 1 ? '' : 's'}`
                  : `${cell.day}: no collection`}
                className={cn(
                  'h-9 w-full rounded-md flex flex-col items-center justify-center text-[9px] font-bold tabular-nums leading-tight transition',
                  tone(cell.amount),
                  selectedDay === cell.day && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                )}
              >
                <span>{Number(cell.day.slice(-2))}</span>
                {cell.amount > 0 && (
                  <span className="text-[7px] font-medium opacity-90">
                    {Math.round(cell.amount / 1000)}k
                  </span>
                )}
              </button>
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

        <div className="rounded-md border border-border bg-background p-2 lg:w-[40%]">
          <DaySummary agentId={agentId} day={selectedDay} />
        </div>
      </div>
    </div>
  );
}

interface DayRecord {
  id: string;
  tenantName: string;
  amount: number;
  expected: number;
  outstanding: number;
  cycle: string;
  time: string;
}

function DaySummary({ agentId, day }: { agentId: string; day: string | null }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['agent-repayment-calendar-day', agentId, day],
    enabled: !!agentId && !!day,
    staleTime: 60_000,
    queryFn: async (): Promise<DayRecord[]> => {
      const start = new Date(`${day}T00:00:00+03:00`).toISOString();
      const end = new Date(`${day}T23:59:59.999+03:00`).toISOString();
      const { data: res, error: rpcErr } = await supabase.rpc('get_agent_collection_records', {
        p_agent_id: agentId,
        p_start: start,
        p_end: end,
      });
      if (rpcErr) throw rpcErr;
      const rows = (Array.isArray(res) ? res : []) as any[];
      return rows.map((r) => ({
        id: String(r.id),
        tenantName: r.tenant_name || 'Tenant',
        amount: Number(r.amount) || 0,
        expected: Number(r.expected_amount) || 0,
        outstanding: Number(r.tenant_outstanding) || 0,
        cycle: r.cycle ? String(r.cycle) : '—',
        time: new Intl.DateTimeFormat('en-GB', {
          timeZone: KAMPALA, hour: '2-digit', minute: '2-digit',
        }).format(new Date(r.created_at)),
      }));
    },
  });

  if (!day) {
    return (
      <p className="text-[10px] text-muted-foreground italic">
        Select a day on the calendar to see the tenants paid for, amounts collected and balances for that day.
      </p>
    );
  }
  if (isLoading) return <p className="text-[10px] text-muted-foreground">Loading {day}…</p>;
  if (error) return <p className="text-[10px] text-destructive">Could not load records for {day}.</p>;

  const rows = data ?? [];
  const collected = rows.reduce((s, r) => s + r.amount, 0);
  const expected = rows.reduce((s, r) => s + r.expected, 0);
  const balance = rows.reduce((s, r) => s + Math.max(0, r.expected - r.amount), 0);
  const tenants = new Set(rows.map((r) => r.tenantName)).size;

  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold text-foreground">{day}</p>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <div className="rounded-md border border-border p-1.5">
          <p className="text-[9px] text-muted-foreground">Tenants paid for</p>
          <p className="text-sm font-bold tabular-nums text-foreground">{tenants}</p>
        </div>
        <div className="rounded-md border border-border p-1.5">
          <p className="text-[9px] text-muted-foreground">Payments</p>
          <p className="text-sm font-bold tabular-nums text-foreground">{rows.length}</p>
        </div>
        <div className="rounded-md border border-border p-1.5">
          <p className="text-[9px] text-muted-foreground">Collected</p>
          <p className="text-sm font-bold tabular-nums text-emerald-600">{formatUGX(collected)}</p>
        </div>
        <div className="rounded-md border border-border p-1.5">
          <p className="text-[9px] text-muted-foreground">Balance</p>
          <p className="text-sm font-bold tabular-nums text-destructive">{formatUGX(balance)}</p>
        </div>
      </div>
      <p className="mt-1 text-[9px] text-muted-foreground tabular-nums">Expected that day: {formatUGX(expected)}</p>

      {rows.length === 0 ? (
        <p className="mt-2 text-[10px] text-muted-foreground italic">No collections recorded on this day.</p>
      ) : (
        <div className="mt-2 max-h-64 overflow-y-auto space-y-1">
          {rows.map((r) => (
            <div key={r.id} className="rounded-md border border-border p-1.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[11px] font-semibold text-foreground truncate">{r.tenantName}</p>
                <p className="text-[11px] font-bold tabular-nums text-emerald-600">{formatUGX(r.amount)}</p>
              </div>
              <p className="text-[9px] text-muted-foreground tabular-nums">
                {r.time} · {r.cycle} · expected {formatUGX(r.expected)} · balance{' '}
                <span className="text-destructive font-medium">{formatUGX(Math.max(0, r.expected - r.amount))}</span> ·
                outstanding <span className="text-primary font-medium">{formatUGX(r.outstanding)}</span>
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default AgentRepaymentCalendar;
