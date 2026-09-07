import { useMemo, useState } from 'react';
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
  partner_registered: number;
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

function getWindowDates(mode: WindowMode): { from: string; to: string; label: string } {
  const today = kampalaDate();
  const todayStr = formatKampalaDate(today);

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
  daysElapsed: number;
  notesCreated: number;
  partnerRegistered: number;
}

export default function PlatformSalesOfficersPage() {
  const [mode, setMode] = useState<WindowMode>('WEEKLY');
  const { from, to, label } = useMemo(() => getWindowDates(mode), [mode]);

  const {
    data: rows = [],
    isLoading,
    error,
  } = useQuery<PsoRow[]>({
    queryKey: ['pso-daily-series-officers', from, to],
    queryFn: () => fetchPsoSeries(from, to),
  });

  const officers = useMemo<OfficerSummary[]>(() => {
    const byId = new Map<string, OfficerSummary>();
    for (const row of rows) {
      const existing = byId.get(row.staff_id);
      if (existing) {
        existing.daysElapsed += 1;
        existing.notesCreated += row.notes_created;
        existing.partnerRegistered += row.partner_registered;
      } else {
        byId.set(row.staff_id, {
          staff_id: row.staff_id,
          staff_ref: row.staff_ref,
          daysElapsed: 1,
          notesCreated: row.notes_created,
          partnerRegistered: row.partner_registered,
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.staff_ref.localeCompare(b.staff_ref));
  }, [rows]);

  const totalNotes = useMemo(
    () => officers.reduce((sum, o) => sum + o.notesCreated, 0),
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
          {officers.length} officers · {totalNotes} notes created in this window
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
                  <th className="px-4 py-2 text-right font-medium">Notes created</th>
                  <th className="px-4 py-2 text-right font-medium">Reversed</th>
                  <th className="px-4 py-2 text-right font-medium">Registered</th>
                  <th className="px-4 py-2 text-right font-medium">Average / day</th>
                </tr>
              </thead>
              <tbody>
                {officers.map((officer) => {
                  const average =
                    officer.daysElapsed > 0
                      ? (officer.notesCreated / officer.daysElapsed).toFixed(1)
                      : '0.0';
                  return (
                    <tr key={officer.staff_id} className="border-t">
                      <td className="px-4 py-2 font-medium">{officer.staff_ref}</td>
                      <td className="px-4 py-2 text-right">{officer.daysElapsed}</td>
                      <td className="px-4 py-2 text-right">{officer.notesCreated}</td>
                      <td className="px-4 py-2 text-right">—</td>
                      <td className="px-4 py-2 text-right">{officer.partnerRegistered}</td>
                      <td className="px-4 py-2 text-right">{average}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="rounded-md border p-4 space-y-2">
          <h2 className="text-sm font-semibold">Funded sales</h2>
          <p className="text-sm">
            <strong>SOURCE NOT WIRED</strong>
          </p>
          <p className="text-sm text-muted-foreground">
            Money received is not recorded against promissory notes — total_collected is zero on
            every note in the book. Commission is accrued at note creation, not on receipt. Funded
            sales, money received, funding rate and commission are therefore not shown.
          </p>
        </div>

        <p className="text-xs text-muted-foreground">
          Bands, targets and the officer-facing leaderboard are withheld pending a written decision
          by the Managing Director.
        </p>
      </div>
    </PersonalLayout>
  );
}
