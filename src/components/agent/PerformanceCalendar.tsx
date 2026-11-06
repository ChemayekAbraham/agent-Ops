import { useMemo, useState } from 'react';
import { CheckCircle2, XCircle, CalendarDays, Phone } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { shortDay, type PerformanceWeek } from '@/lib/weeklyPerformance';
import { useMyDailyCollections, kampalaDay, type DayCell } from '@/hooks/useMyDailyCollections';

const DOW = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'];

function addDays(d: string, n: number) {
  const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
}

type Tone = 'none' | 'future' | 'missed' | 'partial' | 'paid' | 'over' | 'bonus';
function toneOf(c: DayCell | undefined, day: string, today: string): Tone {
  if (day > today) return 'future';
  const e = c?.expected ?? 0, k = c?.collected ?? 0;
  if (e <= 0) return k > 0 ? 'bonus' : 'none';
  if (k <= 0) return 'missed';
  if (k >= e * 1.2) return 'over';
  if (k >= e) return 'paid';
  return 'partial';
}

const toneCls: Record<Tone, string> = {
  none: 'bg-muted/40 text-muted-foreground border-border/40',
  future: 'bg-background text-muted-foreground/60 border-dashed border-border/60',
  missed: 'bg-destructive/15 text-destructive border-destructive/40',
  partial: 'bg-warning/20 text-foreground border-warning/50',
  paid: 'bg-success/20 text-success border-success/50',
  over: 'bg-success text-success-foreground border-success',
  bonus: 'bg-primary/15 text-primary border-primary/40',
};
const legend: [Tone, string][] = [
  ['over', 'Beat target'], ['paid', 'Collected'], ['partial', 'Part paid'],
  ['missed', 'Missed'], ['bonus', 'Extra'], ['none', 'Nothing due'],
];

export function PerformanceCalendar({ weeks, today, names }: {
  weeks: PerformanceWeek[]; today: string;
  names: Record<string, { name: string; phone: string | null }>;
}) {
  const rows = useMemo(() => {
    const starts = new Set(weeks.map((w) => w.week_start));
    // include the week in progress
    const latest = [...starts].sort().pop();
    if (latest) { let s = addDays(latest, 7); while (s <= today) { starts.add(s); s = addDays(s, 7); } }
    return [...starts].sort().reverse().map((s) => ({
      start: s, week: weeks.find((w) => w.week_start === s) ?? null,
      days: Array.from({ length: 7 }, (_, i) => addDays(s, i)),
    }));
  }, [weeks, today]);
  const from = rows.length ? rows[rows.length - 1].start : null;
  const to = rows.length ? rows[0].days[6] : null;
  const { data: cells, isLoading } = useMyDailyCollections(from, to, names);
  const [open, setOpen] = useState<string | null>(null);
  const sel = open ? cells?.[open] : undefined;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <CalendarDays className="h-5 w-5 text-primary" />
        <h2 className="text-base font-bold">Collection calendar</h2>
      </div>
      <div className="rounded-2xl border border-border/60 bg-card p-2 sm:p-3 space-y-2 w-full max-w-xl mx-auto overflow-hidden">
        <div className="grid grid-cols-[repeat(7,minmax(0,1fr))_1.5rem] sm:grid-cols-[repeat(7,minmax(0,1fr))_2.25rem] gap-1 sm:gap-1.5 text-center text-[9px] sm:text-[10px] font-semibold uppercase text-muted-foreground">
          {DOW.map((d) => <span key={d}>{d}</span>)}<span>Week</span>
        </div>
        {rows.map((r) => (
          <div key={r.start} className="space-y-1">
            <p className="text-[10px] text-muted-foreground flex flex-wrap items-center gap-y-1">
              {shortDay(r.start)} – {shortDay(r.days[6])}
              {r.week?.is_judged && <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold text-primary">Decides this week</span>}
              {r.week && r.week.book !== 'none' && (
                <span className={cn('ml-1.5 font-semibold', r.week.passes ? 'text-success' : 'text-destructive')}>
                  {((r.week.in_window_pct ?? r.week.expired_pct ?? 0) * 100).toFixed(0)}%
                </span>
              )}
            </p>
            <div className="grid grid-cols-[repeat(7,minmax(0,1fr))_1.5rem] sm:grid-cols-[repeat(7,minmax(0,1fr))_2.25rem] gap-1 sm:gap-1.5">
              {r.days.map((d) => {
                const c = cells?.[d]; const t = toneOf(c, d, today);
                const pct = c && c.expected > 0 ? Math.min(999, Math.round((c.collected / c.expected) * 100)) : null;
                return isLoading ? <Skeleton key={d} className="aspect-square rounded-xl" /> : (
                  <button key={d} type="button" disabled={t === 'future'} onClick={() => setOpen(d)}
                    className={cn('relative min-w-0 aspect-square rounded-lg sm:rounded-xl border flex flex-col items-center justify-center transition-transform hover:scale-105 active:scale-95 disabled:hover:scale-100',
                      toneCls[t], d === today && 'ring-2 ring-primary ring-offset-1 ring-offset-background')}>
                    <span className="text-xs sm:text-sm font-bold leading-none">{Number(d.slice(8))}</span>
                    {pct !== null && t !== 'future' && <span className="mt-0.5 text-[8px] sm:text-[9px] font-semibold leading-none opacity-80">{pct}%</span>}
                    {t === 'missed' && <XCircle className="absolute right-0.5 top-0.5 h-2.5 w-2.5" />}
                    {t === 'over' && <CheckCircle2 className="absolute right-0.5 top-0.5 h-2.5 w-2.5" />}
                  </button>
                );
              })}
              <div className={cn('flex items-center justify-center rounded-xl',
                !r.week || r.week.book === 'none' ? 'text-muted-foreground' : r.week.passes ? 'text-success' : 'text-destructive')}>
                {r.week && r.week.book !== 'none' ? (r.week.passes ? <CheckCircle2 className="h-4 w-4 sm:h-5 sm:w-5" /> : <XCircle className="h-4 w-4 sm:h-5 sm:w-5" />) : <span className="text-[10px]">—</span>}
              </div>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-x-3 gap-y-1 pt-2 border-t border-border/40">
          {legend.map(([t, l]) => (
            <span key={t} className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className={cn('h-3 w-3 rounded border', toneCls[t])} />{l}
            </span>
          ))}
        </div>
      </div>

      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-3xl">
          <SheetHeader>
            <SheetTitle>{open && new Date(`${open}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}</SheetTitle>
            <SheetDescription>Expected and collected per tenant</SheetDescription>
          </SheetHeader>
          {open && (
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-2xl bg-muted/50 p-3">
                  <p className="text-[11px] text-muted-foreground">Expected</p>
                  <p className="text-lg font-bold">{formatUGX(sel?.expected ?? 0)}</p>
                </div>
                <div className={cn('rounded-2xl p-3', (sel?.collected ?? 0) >= (sel?.expected ?? 0) && (sel?.collected ?? 0) > 0 ? 'bg-success/15' : 'bg-destructive/10')}>
                  <p className="text-[11px] text-muted-foreground">Collected</p>
                  <p className="text-lg font-bold">{formatUGX(sel?.collected ?? 0)}</p>
                </div>
              </div>
              {!sel || sel.tenants.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">Nothing was due or collected on this day.</p>
              ) : sel.tenants.map((t) => {
                const missed = t.expected > 0 && t.collected <= 0;
                const ok = t.collected >= t.expected && t.collected > 0;
                return (
                  <div key={t.tenant_id} className={cn('flex items-center gap-3 rounded-2xl border p-3',
                    missed ? 'border-destructive/40 bg-destructive/5' : ok ? 'border-success/40 bg-success/5' : 'border-warning/50 bg-warning/10')}>
                    <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                      missed ? 'bg-destructive/15 text-destructive' : ok ? 'bg-success/15 text-success' : 'bg-warning/20 text-foreground')}>
                      {missed ? <XCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{t.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        Expected {formatUGX(t.expected)} · Collected <span className={cn('font-semibold', missed ? 'text-destructive' : ok ? 'text-success' : '')}>{formatUGX(t.collected)}</span>
                      </p>
                    </div>
                    {t.phone && (
                      <a href={`tel:${t.phone}`} aria-label={`Call ${t.name}`} className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Phone className="h-4 w-4" />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

export { kampalaDay };
