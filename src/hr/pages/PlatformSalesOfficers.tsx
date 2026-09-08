import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { startOfISOWeek } from 'date-fns';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { supabase } from '@/hr/api/client';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

interface PsoRow {
  staff_id: string;
  staff_ref: string;
  day: string;
  notes_created: number;
  notes_reversed: number;
  net_notes: number;
  partner_registered: number;
}

interface PsoFundedSummary {
  staff_id: string;
  staff_ref: string;
  notes_in_cohort: number;
  notes_funded: number;
  amount_funded: number;
  commission_accrued: number;
  as_at: string;
}

function formatKampalaDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Kampala',
  }).format(new Date(iso));
}

type WindowMode = 'DAILY' | 'WEEKLY' | 'MONTHLY';

function getKampalaParts(d: Date): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function kampalaDate(d: Date = new Date()): Date {
  const p = getKampalaParts(d);
  return new Date(p.year, p.month - 1, p.day, 12, 0, 0);
}

function formatKampalaDate(d: Date): string {
  const p = getKampalaParts(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function formatKampalaDisplay(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Kampala',
  }).format(d);
}

function getWindowDates(
  mode: WindowMode,
  todayStr: string,
): { from: string; to: string; label: string } {
  const today = new Date(`${todayStr}T12:00:00`);

  if (mode === 'DAILY') {
    return { from: todayStr, to: todayStr, label: `DAILY · ${formatKampalaDisplay(today)}` };
  }

  if (mode === 'WEEKLY') {
    const monday = startOfISOWeek(today);
    return {
      from: formatKampalaDate(monday),
      to: todayStr,
      label: `WEEKLY · ${formatKampalaDisplay(monday)} – ${formatKampalaDisplay(today)}`,
    };
  }

  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1, 12, 0, 0);
  return {
    from: formatKampalaDate(firstOfMonth),
    to: todayStr,
    label: `MONTHLY · ${formatKampalaDisplay(firstOfMonth)} – ${formatKampalaDisplay(today)}`,
  };
}

async function fetchPsoSeries(from: string, to: string): Promise<PsoRow[]> {
  const { data, error } = (await supabase.rpc('pso_daily_series' as any, {
    p_from: from,
    p_to: to,
  })) as unknown as { data: PsoRow[] | null; error: { message: string } | null };

  if (error) throw new Error(error.message);
  return data ?? [];
}

interface OfficerSummary {
  staff_id: string;
  staff_ref: string;
  weekday: number[];
  netNotes: number;
  notesFunded: number;
  amountFunded: number;
  commissionAccrued: number;
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function kampalaWeekdayIndex(day: string): number {
  const d = new Date(`${day}T12:00:00`);
  const js = d.getDay(); // 0=Sun … 6=Sat, local getters only
  return js === 0 ? 6 : js - 1; // 0=Mon … 6=Sun
}

export default function PlatformSalesOfficersPage() {
  const [mode, setMode] = useState<WindowMode>('WEEKLY');
  const [todayStr, setTodayStr] = useState<string>(() => formatKampalaDate(kampalaDate()));

  useEffect(() => {
    const id = window.setInterval(() => {
      const next = formatKampalaDate(kampalaDate());
      setTodayStr((prev) => (prev === next ? prev : next));
    }, 60000);
    return () => window.clearInterval(id);
  }, []);

  const { from, to, label } = useMemo(() => getWindowDates(mode, todayStr), [mode, todayStr]);

  const {
    data: rows = [],
    isLoading,
    error,
  } = useQuery<PsoRow[]>({
    queryKey: ['pso-daily-series-officers', todayStr, from, to],
    queryFn: () => fetchPsoSeries(from, to),
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
  });

  const { data: fundedSummaries = [] } = useQuery<PsoFundedSummary[]>({
    queryKey: ['pso-funded-summary-officers', todayStr, from, to],
    queryFn: async () => {
      const { data, error } = (await supabase.rpc('pso_funded_summary' as any, {
        p_from: from,
        p_to: to,
      })) as unknown as { data: PsoFundedSummary[] | null; error: { message: string } | null };
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
  });

  const fundedAsAt = fundedSummaries[0]?.as_at ?? null;

  const officers = useMemo<OfficerSummary[]>(() => {
    const fundedById = new Map(fundedSummaries.map((s) => [s.staff_id, s]));
    const byId = new Map<string, OfficerSummary>();
    for (const row of rows) {
      let entry = byId.get(row.staff_id);
      if (!entry) {
        const funded = fundedById.get(row.staff_id);
        entry = {
          staff_id: row.staff_id,
          staff_ref: row.staff_ref,
          weekday: [0, 0, 0, 0, 0, 0, 0],
          netNotes: 0,
          notesFunded: funded?.notes_funded ?? 0,
          amountFunded: funded?.amount_funded ?? 0,
          commissionAccrued: funded?.commission_accrued ?? 0,
        };
        byId.set(row.staff_id, entry);
      }
      entry.weekday[kampalaWeekdayIndex(row.day)] += row.net_notes;
      entry.netNotes += row.net_notes;
    }
    return Array.from(byId.values()).sort(
      (a, b) => b.netNotes - a.netNotes || a.staff_ref.localeCompare(b.staff_ref),
    );
  }, [rows, fundedSummaries]);

  const ranks = useMemo(() => {
    const out: number[] = [];
    officers.forEach((o, i) => {
      out.push(i > 0 && officers[i - 1].netNotes === o.netNotes ? out[i - 1] : i + 1);
    });
    return out;
  }, [officers]);

  const netTotal = useMemo(
    () => officers.reduce((sum, o) => sum + o.netNotes, 0),
    [officers],
  );

  const fundedTotal = useMemo(
    () => officers.reduce((sum, o) => sum + o.notesFunded, 0),
    [officers],
  );

  const moneyTotal = useMemo(
    () => officers.reduce((sum, o) => sum + o.amountFunded, 0),
    [officers],
  );

  const isNotPermitted = error instanceof Error && error.message.includes('not permitted');

  if (isNotPermitted) {
    return (
      <PersonalLayout title="Platform Sales Officers">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You do not have access to this report.</p>
        </div>
      </PersonalLayout>
    );
  }

  return (
    <PersonalLayout title="Platform Sales Officers">
      <div className="p-6 space-y-6">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-lg font-semibold tracking-tight">
              PLATFORM SALES OFFICERS · note volume · {label} · LIVE
            </h1>
            <span className="text-xs text-muted-foreground">
              live figures — nothing is frozen at v1.0
            </span>
          </div>

          <div className="inline-flex items-center rounded-md border p-1 w-fit">
            {(['DAILY', 'WEEKLY', 'MONTHLY'] as WindowMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  'px-3 py-1 text-xs font-medium rounded-sm transition-colors',
                  mode === m
                    ? 'bg-background shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          {officers.length} officers · {netTotal} net notes · {fundedTotal} funded · UGX {moneyTotal.toLocaleString('en-UG')} funded
        </p>

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : officers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No officer activity in this window yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Officer</th>
                  <th className="px-4 py-2 text-right font-medium">Days elapsed</th>
                  <th className="px-4 py-2 text-right font-medium">Created</th>
                  <th className="px-4 py-2 text-right font-medium">Reversed</th>
                  <th className="px-4 py-2 text-right font-medium">Net</th>
                  <th className="px-4 py-2 text-right font-medium">Registered</th>
                  <th className="px-4 py-2 text-right font-medium">Funded</th>
                  <th className="px-4 py-2 text-right font-medium">Money funded</th>
                  <th className="px-4 py-2 text-right font-medium">Commission</th>
                  <th className="px-4 py-2 text-right font-medium">Average / day</th>
                </tr>
              </thead>
              <tbody>
                {officers.map((officer) => {
                  const average =
                    officer.daysElapsed > 0
                      ? (officer.netNotes / officer.daysElapsed).toFixed(1)
                      : '0.0';
                  return (
                    <tr key={officer.staff_id} className="border-t">
                      <td className="px-4 py-2 font-medium">{officer.staff_ref}</td>
                      <td className="px-4 py-2 text-right">{officer.daysElapsed}</td>
                      <td className="px-4 py-2 text-right">{officer.notesCreated}</td>
                      <td className="px-4 py-2 text-right">{officer.reversals}</td>
                      <td className="px-4 py-2 text-right">{officer.netNotes}</td>
                      <td className="px-4 py-2 text-right">{officer.partnerRegistered}</td>
                      <td className="px-4 py-2 text-right">{officer.notesFunded}</td>
                      <td className="px-4 py-2 text-right">UGX {officer.amountFunded.toLocaleString('en-UG')}</td>
                      <td className="px-4 py-2 text-right">UGX {officer.commissionAccrued.toLocaleString('en-UG')}</td>
                      <td className="px-4 py-2 text-right">{average}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Bands, targets and the officer-facing leaderboard are withheld pending a written decision
          by the Managing Director.
        </p>
        <p className="text-xs text-muted-foreground">
          as at {fundedAsAt ? formatKampalaDateTime(fundedAsAt) : '—'} · funded figures are never frozen
        </p>
      </div>
    </PersonalLayout>
  );
}
