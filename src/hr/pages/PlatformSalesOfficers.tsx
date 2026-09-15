import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  notes_unapproved: number;
  notes_funded: number;
  funders_converted: number;
  topups: number;
  amount_deployed: number;
  commission_base: number;
  commission_accrued: number;
  pre_enrolment_notes: number;
  pre_enrolment_funded: number;
  pre_enrolment_amount: number;
  as_at: string;
}

type WindowMode = 'DAILY' | 'WEEKLY' | 'MONTHLY';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function getKampalaParts(d: Date): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function kampalaDate(d: Date = new Date()): Date {
  const p = getKampalaParts(d);
  return new Date(p.year, p.month - 1, p.day, 12, 0, 0);
}

function formatKampalaDate(d: Date): string {
  const p = getKampalaParts(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function formatKampalaDisplay(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(`${d}T12:00:00`) : d;
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Kampala',
  }).format(date);
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

function formatUgxCompact(v: number): string {
  if (v >= 1_000_000) return `UGX ${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `UGX ${(v / 1_000).toFixed(0)}K`;
  return `UGX ${v.toLocaleString('en-UG')}`;
}

// 0 = Monday. Local getters on a midday anchor, never UTC getters.
function kampalaWeekdayIndex(day: string): number {
  const d = new Date(`${day}T12:00:00`);
  return (d.getDay() + 6) % 7;
}

function getWindowDates(mode: WindowMode, todayStr: string): { from: string; to: string; label: string } {
  const today = new Date(`${todayStr}T12:00:00`);

  if (mode === 'DAILY') {
    return { from: todayStr, to: todayStr, label: `DAILY · ${formatKampalaDisplay(todayStr)}` };
  }

  if (mode === 'WEEKLY') {
    const mondayStr = formatKampalaDate(startOfISOWeek(today));
    return {
      from: mondayStr,
      to: todayStr,
      label: `WEEKLY · ${formatKampalaDisplay(mondayStr)} – ${formatKampalaDisplay(todayStr)}`,
    };
  }

  const firstStr = formatKampalaDate(new Date(today.getFullYear(), today.getMonth(), 1, 12, 0, 0));
  return {
    from: firstStr,
    to: todayStr,
    label: `MONTHLY · ${formatKampalaDisplay(firstStr)} – ${formatKampalaDisplay(todayStr)}`,
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
  reversals: number;
  netNotes: number;
  partnerRegistered: number;
  weekday: number[];
  notesUnapproved: number;
  notesFunded: number;
  fundersConverted: number;
  topups: number;
  amountDeployed: number;
  commissionBase: number;
  commissionAccrued: number;
  preEnrolmentNotes: number;
  preEnrolmentFunded: number;
  preEnrolmentAmount: number;
}

export default function PlatformSalesOfficersPage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<WindowMode>('WEEKLY');

  // The Kampala calendar date is state, not a one-off computation, so a screen
  // left open rolls its window over at 00:00 EAT without a reload.
  const [todayStr, setTodayStr] = useState<string>(() => formatKampalaDate(kampalaDate()));

  useEffect(() => {
    const id = setInterval(() => {
      const next = formatKampalaDate(kampalaDate());
      setTodayStr((prev) => (prev === next ? prev : next));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const { from, to, label } = useMemo(() => getWindowDates(mode, todayStr), [mode, todayStr]);
  const todayWeekday = useMemo(() => kampalaWeekdayIndex(todayStr), [todayStr]);

  const {
    data: rows = [],
    isLoading,
    error,
  } = useQuery<PsoRow[]>({
    queryKey: ['pso-daily-series-officers', from, to],
    queryFn: () => fetchPsoSeries(from, to),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
  });

  const { data: fundedSummaries = [] } = useQuery<PsoFundedSummary[]>({
    queryKey: ['pso-funded-summary-officers', from, to],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const { data, error } = (await supabase.rpc('pso_funded_summary' as any, {
        p_from: from,
        p_to: to,
      })) as unknown as { data: PsoFundedSummary[] | null; error: { message: string } | null };
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });

  // Commission lands the instant a promissory commission event is paid — no
  // waiting for the 60s poll. Any change re-asks the RPC (which is the only
  // permitted source of these figures) rather than patching numbers locally.
  useEffect(() => {
    const channel = supabase
      .channel('pso-commission-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'promissory_commission_events' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['pso-funded-summary-officers'] });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

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
          daysElapsed: 0,
          notesCreated: 0,
          reversals: 0,
          netNotes: 0,
          partnerRegistered: 0,
          weekday: [0, 0, 0, 0, 0, 0, 0],
          notesUnapproved: funded?.notes_unapproved ?? 0,
          notesFunded: funded?.notes_funded ?? 0,
          fundersConverted: funded?.funders_converted ?? 0,
          topups: funded?.topups ?? 0,
          amountDeployed: funded?.amount_deployed ?? 0,
          commissionBase: funded?.commission_base ?? 0,
          commissionAccrued: funded?.commission_accrued ?? 0,
          preEnrolmentNotes: funded?.pre_enrolment_notes ?? 0,
          preEnrolmentFunded: funded?.pre_enrolment_funded ?? 0,
          preEnrolmentAmount: funded?.pre_enrolment_amount ?? 0,
        };
        byId.set(row.staff_id, entry);
      }
      entry.daysElapsed += 1;
      entry.notesCreated += row.notes_created ?? 0;
      entry.reversals += row.notes_reversed ?? 0;
      entry.netNotes += row.net_notes ?? 0;
      entry.partnerRegistered += row.partner_registered ?? 0;
      entry.weekday[kampalaWeekdayIndex(row.day)] += row.net_notes ?? 0;
    }

    return Array.from(byId.values()).sort(
      (a, b) => b.netNotes - a.netNotes || a.staff_ref.localeCompare(b.staff_ref),
    );
  }, [rows, fundedSummaries]);

  // Officers on the same total share a rank; the next distinct total takes the
  // position after the whole tied group. Repeated numbers are correct.
  const ranks = useMemo(() => {
    const out: number[] = [];
    officers.forEach((o, i) => {
      out.push(i > 0 && officers[i - 1].netNotes === o.netNotes ? out[i - 1] : i + 1);
    });
    return out;
  }, [officers]);

  const netTotal = useMemo(() => officers.reduce((s, o) => s + o.netNotes, 0), [officers]);
  const fundedTotal = useMemo(() => officers.reduce((s, o) => s + o.notesFunded, 0), [officers]);
  const moneyTotal = useMemo(() => officers.reduce((s, o) => s + o.amountFunded, 0), [officers]);

  const isNotPermitted = error instanceof Error && error.message.includes('not permitted');

  if (isNotPermitted) {
    return (
      <PersonalLayout title="Platform Sales Officers">
        <p className="text-sm text-muted-foreground">You do not have access to this report.</p>
      </PersonalLayout>
    );
  }

  return (
    <PersonalLayout title="Platform Sales Officers">
      <div className="space-y-4 sm:space-y-6">
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </span>
            <span className="text-[11px] text-muted-foreground">live · refreshes every minute</span>
          </div>

          <div className="grid w-full grid-cols-3 gap-1 rounded-lg border p-1 sm:inline-grid sm:w-auto">
            {(['DAILY', 'WEEKLY', 'MONTHLY'] as WindowMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                className={cn(
                  'min-h-11 px-3 text-xs font-semibold tracking-wide rounded-md transition-colors',
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

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border bg-card px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Officers</div>
            <div className="text-base font-bold tabular-nums sm:text-lg">{officers.length}</div>
          </div>
          <div className="rounded-lg border bg-card px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Net notes</div>
            <div className="text-base font-bold tabular-nums sm:text-lg">{netTotal}</div>
          </div>
          <div className="rounded-lg border bg-card px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Funded</div>
            <div className="text-base font-bold tabular-nums sm:text-lg">{fundedTotal}</div>
          </div>
          <div className="rounded-lg border bg-card px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Money funded</div>
            <div className="text-base font-bold tabular-nums sm:text-lg">{formatUgxCompact(moneyTotal)}</div>
          </div>
        </div>

        {mode === 'MONTHLY' && (
          <p className="text-xs text-muted-foreground">
            on MONTHLY each column totals every occurrence of that weekday in the window
          </p>
        )}

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
          <>
            <div className="space-y-2 md:hidden">
              {officers.map((officer, i) => (
                <div key={officer.staff_id} className="rounded-xl border bg-card p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-bold tabular-nums text-muted-foreground">#{ranks[i]}</div>
                      <div className="text-sm font-semibold">{officer.staff_ref}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold leading-none tabular-nums">{officer.netNotes}</div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">net notes</div>
                    </div>
                  </div>

                  {mode === 'DAILY' ? (
                    <p className="mt-2 text-[11px] text-muted-foreground">today only</p>
                  ) : (
                    <div className="mt-3 grid grid-cols-7 gap-1">
                      {officer.weekday.map((v, wi) => (
                        <div
                          key={wi}
                          className={cn(
                            'rounded-md bg-muted/40 py-1.5 text-center',
                            wi === todayWeekday && 'ring-1 ring-border',
                          )}
                        >
                          <div className="text-[10px] font-semibold uppercase text-muted-foreground">
                            {WEEKDAY_INITIALS[wi]}
                          </div>
                          <div className="text-sm font-semibold tabular-nums">{v}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t pt-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Funded</div>
                      <div className="text-xs font-semibold tabular-nums">{officer.notesFunded}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Money funded</div>
                      <div className="text-xs font-semibold tabular-nums">{formatUgxCompact(officer.amountFunded)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Commission</div>
                      <div className="text-xs font-semibold tabular-nums">{formatUgxCompact(officer.commissionAccrued)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden md:block">
              <div className="overflow-x-auto rounded-md border [overscroll-behavior-x:contain]">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">#</th>
                      <th className="px-4 py-2 text-left font-medium">Officer</th>
                      {WEEKDAY_LABELS.map((d) => (
                        <th key={d} className="px-2 py-2 text-right font-medium">{d}</th>
                      ))}
                      <th className="px-4 py-2 text-right font-medium">Total</th>
                      <th className="px-4 py-2 text-right font-medium">Funded</th>
                      <th className="px-4 py-2 text-right font-medium">Money funded</th>
                      <th className="px-4 py-2 text-right font-medium">Commission</th>
                    </tr>
                  </thead>
                  <tbody>
                    {officers.map((officer, i) => (
                      <tr key={officer.staff_id} className="border-t">
                        <td className="px-4 py-2 text-left tabular-nums">{ranks[i]}</td>
                        <td className="px-4 py-2 font-medium">{officer.staff_ref}</td>
                        {officer.weekday.map((v, wi) => (
                          <td key={wi} className="px-2 py-2 text-right tabular-nums">{v}</td>
                        ))}
                        <td className="px-4 py-2 text-right tabular-nums">{officer.netNotes}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{officer.notesFunded}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          UGX {officer.amountFunded.toLocaleString('en-UG')}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          UGX {officer.commissionAccrued.toLocaleString('en-UG')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        <p className="text-xs text-muted-foreground">
          Bands and targets are not set. Officers see a ranked leaderboard of note volume with no
          money figures.
        </p>
        <p className="text-xs text-muted-foreground">
          as at {fundedAsAt ? formatKampalaDateTime(fundedAsAt) : '—'} · funded figures are never frozen
        </p>
      </div>
    </PersonalLayout>
  );
}
