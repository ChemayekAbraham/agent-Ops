/**
 * Weekly Staff Forwarding Report — Wednesday to Tuesday.
 *
 * Additive and read-only. It reads exactly the same authoritative forwarding
 * record the Combined Calling Center Report reads — the period-wide
 * `cc_concern_handling_report` reporting function over `cc_forwarded_concerns` —
 * so the figures here always agree with the existing reports. Nothing here
 * writes, and no existing report, filter or PDF is touched.
 *
 * Weeks run Wednesday → Tuesday. Every concern is counted once, against the
 * staff member it was forwarded to, so a concern later shared with more
 * reviewers is never double-counted. Both call sources are included: concerns
 * raised from calls we made (`outbound_call`) and from calls that came in
 * (`received_call`).
 */
import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarRange, ChevronLeft, ChevronRight, FileText, Flame, Users } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { KPICard } from '../../KPICard';
import { generateWeeklyForwardingPdf } from '@/lib/callingCenterWeeklyForwardingPdf';

const anyDb = supabase as any;

type ReportRow = {
  id: string;
  source_kind: string;
  forwarded_to_name: string | null;
  created_at: string;
  cycle_row_id?: string | null;
  received_call_id?: string | null;
};

/** One call closed at the Calling Center with nothing forwarded on. */
type ResolvedEntry = { name: string; at: string; source: 'made' | 'received' };

const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};


const isoDay = (d: Date) => format(d, 'yyyy-MM-dd');

/** Wednesday that opens the week containing `d`. Wed = 0 … Tue = 6. */
function weekStart(d: Date) {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 4) % 7));
  return start;
}

function weekWindow(anchorDay: string) {
  const start = weekStart(new Date(`${anchorDay}T00:00:00`));
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start);
    day.setDate(day.getDate() + i);
    return day;
  });
  return {
    start,
    end,
    days,
    fromIso: start.toISOString(),
    toIso: end.toISOString(),
    label: `Wed ${format(start, 'dd MMM yyyy')} — Tue ${format(days[6], 'dd MMM yyyy')}`,
  };
}

export function WeeklyStaffForwardingReport() {
  const { user } = useAuth();
  const { profile } = useProfile();
  const [anchor, setAnchor] = useState(isoDay(new Date()));
  const [busy, setBusy] = useState(false);

  const win = useMemo(() => weekWindow(anchor), [anchor]);

  const shiftWeek = (weeks: number) => {
    const next = new Date(win.start);
    next.setDate(next.getDate() + weeks * 7);
    setAnchor(isoDay(next));
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ['cc-weekly-forwarding', win.fromIso, win.toIso],
    queryFn: async () => {
      const { data: rows, error: rpcError } = await anyDb.rpc('cc_concern_handling_report', {
        p_from: win.fromIso,
        p_to: win.toIso,
      });
      if (rpcError) throw new Error(rpcError.message);
      return (rows ?? []) as ReportRow[];
    },
    staleTime: 60_000,
  });

  const report = useMemo(() => {
    const rows = data ?? [];
    const dayKeys = win.days.map(isoDay);
    const dayLabels = win.days.map((d) => format(d, 'EEE dd MMM'));
    const blank = () => dayKeys.map(() => 0);

    const staff = new Map<string, { perDay: number[]; fromMade: number; fromReceived: number; total: number }>();
    const dailyTotals = blank();
    const dailyMade = blank();
    const dailyReceived = blank();

    rows.forEach((r) => {
      const key = isoDay(new Date(r.created_at));
      const idx = dayKeys.indexOf(key);
      if (idx < 0) return;
      const name = r.forwarded_to_name ?? 'Staff member';
      const entry = staff.get(name) ?? { perDay: blank(), fromMade: 0, fromReceived: 0, total: 0 };
      entry.perDay[idx] += 1;
      entry.total += 1;
      if (r.source_kind === 'received_call') entry.fromReceived += 1;
      else entry.fromMade += 1;
      staff.set(name, entry);
      dailyTotals[idx] += 1;
      if (r.source_kind === 'received_call') dailyReceived[idx] += 1;
      else dailyMade[idx] += 1;
    });

    const staffRows = Array.from(staff.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

    const grandTotal = dailyTotals.reduce((a, b) => a + b, 0);
    const busiestIdx = dailyTotals.reduce((best, n, i) => (n > dailyTotals[best] ? i : best), 0);
    const quietestIdx = dailyTotals.reduce((best, n, i) => (n < dailyTotals[best] ? i : best), 0);
    const topStaff = staffRows[0] ?? null;
    const daysWithActivity = dailyTotals.filter((n) => n > 0).length;

    return {
      dayLabels,
      dailyTotals,
      dailyMade,
      dailyReceived,
      staffRows,
      grandTotal,
      busiestDay: grandTotal ? `${dayLabels[busiestIdx]} · ${dailyTotals[busiestIdx]}` : '—',
      quietestDay: grandTotal ? `${dayLabels[quietestIdx]} · ${dailyTotals[quietestIdx]}` : '—',
      topStaff,
      daysWithActivity,
      fromMade: dailyMade.reduce((a, b) => a + b, 0),
      fromReceived: dailyReceived.reduce((a, b) => a + b, 0),
      perDayAverage: grandTotal ? (grandTotal / 7).toFixed(1) : '0',
    };
  }, [data, win.days]);

  const exportPdf = async () => {
    setBusy(true);
    try {
      const generatedBy =
        profile?.full_name?.trim() ||
        (typeof user?.user_metadata?.full_name === 'string' ? user.user_metadata.full_name.trim() : '') ||
        'Tenant Operations';
      const email = profile?.email?.trim() || user?.email?.trim() || '—';
      const pct = (n: number) => (report.grandTotal ? `${Math.round((n / report.grandTotal) * 100)}%` : '0%');

      const blob = await generateWeeklyForwardingPdf(
        {
          dayLabels: report.dayLabels,
          rows: report.staffRows.map((r) => ({
            name: r.name,
            perDay: r.perDay,
            total: r.total,
            fromMade: r.fromMade,
            fromReceived: r.fromReceived,
          })),
          dailyTotals: report.dailyTotals,
          grandTotal: report.grandTotal,
          tiles: [
            { label: 'Total forwarded this week', value: String(report.grandTotal) },
            { label: 'Staff members involved', value: String(report.staffRows.length) },
            { label: 'Busiest day', value: report.busiestDay },
            { label: 'From calls we made', value: String(report.fromMade) },
            { label: 'From calls that came in', value: String(report.fromReceived) },
          ],
          insights: [
            { label: 'Total concerns forwarded to staff', value: String(report.grandTotal) },
            { label: 'Staff members who received work', value: String(report.staffRows.length) },
            { label: 'Busiest day of the week', value: report.busiestDay },
            { label: 'Quietest day of the week', value: report.quietestDay },
            { label: 'Days with at least one forward', value: `${report.daysWithActivity} of 7` },
            { label: 'Average forwarded per day', value: report.perDayAverage },
            {
              label: 'Busiest staff member',
              value: report.topStaff ? `${report.topStaff.name} · ${report.topStaff.total}` : '—',
            },
            {
              label: 'Average per staff member',
              value: report.staffRows.length ? (report.grandTotal / report.staffRows.length).toFixed(1) : '0',
            },
            { label: 'Forwarded from calls we made', value: `${report.fromMade} (${pct(report.fromMade)})` },
            {
              label: 'Forwarded from calls that came in',
              value: `${report.fromReceived} (${pct(report.fromReceived)})`,
            },
          ],
          perDayBreakdown: report.dayLabels.map((day, i) => ({
            day,
            made: report.dailyMade[i],
            received: report.dailyReceived[i],
            total: report.dailyTotals[i],
            share: pct(report.dailyTotals[i]),
          })),
          note:
            'Each figure is the number of concerns forwarded to that staff member on that day, counting both calls we made and calls that came in. Every concern is counted once, against the staff member it was forwarded to, so a concern later shared with more reviewers is never counted twice. "Daily total" is every staff member added together for that day; the "Weekly total" column is one staff member across the week, and the grand total is the whole week counted once.',
        },
        {
          generatedBy,
          email,
          generatedAt: new Date(),
          reportPeriod: win.label,
        },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `weekly-staff-forwarding-${isoDay(win.start)}_to_${isoDay(win.days[6])}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build the weekly report.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-3">
        <CardTitle className="flex items-center gap-2 text-xs font-bold">
          <CalendarRange className="h-4 w-4 text-primary" />
          Weekly staff forwarding (Wednesday — Tuesday)
        </CardTitle>
        <span className="text-[10px] text-muted-foreground">{win.label}</span>
      </CardHeader>
      <CardContent className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="h-8 text-xs font-semibold" onClick={() => shiftWeek(-1)}>
            <ChevronLeft className="mr-1 h-3.5 w-3.5" />
            Previous week
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs font-semibold"
            onClick={() => setAnchor(isoDay(new Date()))}
          >
            This week
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs font-semibold" onClick={() => shiftWeek(1)}>
            Next week
            <ChevronRight className="ml-1 h-3.5 w-3.5" />
          </Button>
          <Input
            type="date"
            value={anchor}
            onChange={(e) => e.target.value && setAnchor(e.target.value)}
            className="h-8 w-[150px] text-xs"
            aria-label="Pick any day in the week"
          />
          <div className="ml-auto flex items-center gap-2">
            <Badge variant="secondary" className="h-7 text-[10px]">
              {report.grandTotal.toLocaleString()} forwarded
            </Badge>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs font-semibold"
              onClick={exportPdf}
              disabled={busy || isLoading}
            >
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              {busy ? 'Building…' : 'Weekly Forwarding PDF'}
            </Button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Could not load forwarding: {error instanceof Error ? error.message : 'unknown error'}</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <KPICard
            title="Total forwarded"
            value={report.grandTotal}
            icon={CalendarRange}
            color="bg-primary/10 text-primary"
          />
          <KPICard
            title="Staff members"
            value={report.staffRows.length}
            icon={Users}
            color="bg-emerald-500/10 text-emerald-600"
          />
          <KPICard
            title="Busiest day"
            value={report.busiestDay}
            icon={Flame}
            color="bg-amber-500/10 text-amber-600"
          />
          <KPICard
            title="Made / came in"
            value={`${report.fromMade} / ${report.fromReceived}`}
            icon={FileText}
            color="bg-muted text-foreground"
          />
        </div>

        <div className="min-w-0 overflow-x-auto rounded-xl border border-border">
          {isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : !report.staffRows.length ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              No concern was forwarded to any staff member in this week.
            </div>
          ) : (
            <table className="w-full min-w-[820px] text-xs">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="p-2.5 font-semibold">Staff member</th>
                  {report.dayLabels.map((d) => (
                    <th key={d} className="p-2.5 text-center font-semibold">
                      {d}
                    </th>
                  ))}
                  <th className="p-2.5 text-center font-semibold">Weekly total</th>
                </tr>
              </thead>
              <tbody>
                {report.staffRows.map((r) => (
                  <tr key={r.name} className="border-b border-border/50 last:border-0 hover:bg-muted/40">
                    <td className="p-2.5 font-semibold">{r.name}</td>
                    {r.perDay.map((n, i) => (
                      <td
                        key={`${r.name}-${i}`}
                        className={n ? 'p-2.5 text-center font-semibold' : 'p-2.5 text-center text-muted-foreground'}
                      >
                        {n || '—'}
                      </td>
                    ))}
                    <td className="p-2.5 text-center font-bold text-primary">{r.total}</td>
                  </tr>
                ))}
                <tr className="border-t bg-muted/40 font-bold">
                  <td className="p-2.5">Daily total — all staff</td>
                  {report.dailyTotals.map((n, i) => (
                    <td key={`daily-${i}`} className="p-2.5 text-center">
                      {n}
                    </td>
                  ))}
                  <td className="p-2.5 text-center text-primary">{report.grandTotal}</td>
                </tr>
                <tr className="border-t bg-primary/10 font-bold">
                  <td className="p-2.5">Grand total — whole week</td>
                  <td className="p-2.5 text-center text-muted-foreground" colSpan={report.dayLabels.length}>
                    counted once per concern
                  </td>
                  <td className="p-2.5 text-center text-primary">{report.grandTotal}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default WeeklyStaffForwardingReport;
