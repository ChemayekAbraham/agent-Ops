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

interface PsoPromiseSummary {
  staff_id: string;
  staff_ref: string;
  notes_activated: number;
  notes_pending: number;
  promised_amount: number;
  promised_activated: number;
  pre_enrolment_promised: number;
  as_at: string;
}

interface NonOfficerRow {
  person_user_id: string;
  person_name: string;
  day: string;
  notes_created: number;
  notes_reversed: number;
  net_notes: number;
  partner_registered: number;
}

interface NonOfficerFunded {
  person_user_id: string;
  person_name: string;
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

// Numeric value a row is ranked by for a given sort key. 'day-N' keys read the
// per-weekday buckets; anything else reads the named numeric field.
function sortValue(row: { weekday: number[] }, key: string): number {
  if (key.startsWith('day-')) {
    return row.weekday[Number(key.slice(4))] ?? 0;
  }
  const v = (row as unknown as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : 0;
}

interface SortableThProps {
  label: string;
  sortKey: string;
  activeKey: string;
  onSort: (key: string) => void;
  align?: 'left' | 'right';
  topHint?: string;
}

// Column header that sorts the table highest-first when tapped. The active
// column stays highlighted until another is picked.
function SortableTh({ label, sortKey, activeKey, onSort, align = 'right', topHint }: SortableThProps) {
  const active = sortKey === activeKey;
  return (
    <th className={cn('px-2 py-2 font-medium', align === 'left' ? 'text-left' : 'text-right')}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
        className={cn(
          'inline-flex w-full flex-col rounded-md px-1.5 py-0.5 transition-colors',
          align === 'left' ? 'items-start' : 'items-end',
          active
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'text-foreground hover:bg-muted',
        )}
        aria-pressed={active}
      >
        {topHint != null && (
          <span
            className={cn(
              'block text-[10px] font-semibold tabular-nums',
              active ? 'text-primary-foreground/80' : 'text-muted-foreground',
            )}
          >
            {topHint}
          </span>
        )}
        <span className="inline-flex items-center gap-0.5">
          {label}
          {active && <span aria-hidden>▼</span>}
        </span>
      </button>
    </th>
  );
}

// The reporting week runs Wednesday → Tuesday, so the day columns start on Wed.
const WEEKDAY_LABELS = ['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue'];
const WEEKDAY_INITIALS = ['W', 'T', 'F', 'S', 'S', 'M', 'T'];

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

// 0 = Wednesday (the first day of the reporting week).
// Local getters on a midday anchor, never UTC getters.
function kampalaWeekdayIndex(day: string): number {
  const d = new Date(`${day}T12:00:00`);
  return (d.getDay() + 4) % 7;
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

// Wednesday that opens the reporting week containing `day`.
function startOfReportingWeek(day: Date): Date {
  return addDays(day, -((day.getDay() + 4) % 7));
}

function getWindowDates(
  mode: WindowMode,
  todayStr: string,
  weekOffset = 0,
): { from: string; to: string; label: string } {
  const today = new Date(`${todayStr}T12:00:00`);

  if (mode === 'DAILY') {
    return { from: todayStr, to: todayStr, label: `DAILY · ${formatKampalaDisplay(todayStr)}` };
  }

  if (mode === 'WEEKLY') {
    const start = addDays(startOfReportingWeek(today), weekOffset * 7);
    const end = addDays(start, 6);
    const startStr = formatKampalaDate(start);
    // The live week stops at today; a past week shows its full Wed–Tue span.
    const endStr = end > today ? todayStr : formatKampalaDate(end);
    return {
      from: startStr,
      to: endStr,
      label: `WEEKLY · ${formatKampalaDisplay(startStr)} – ${formatKampalaDisplay(endStr)}`,
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
  notesActivated: number;
  notesPending: number;
  promisedAmount: number;
  preEnrolmentPromised: number;
}

interface PersonSummary {
  person_user_id: string;
  person_name: string;
  netNotes: number;
  weekday: number[];
  notesUnapproved: number;
  notesFunded: number;
  fundersConverted: number;
  topups: number;
  amountDeployed: number;
  commissionBase: number;
  commissionAccrued: number;
}

export default function PlatformSalesOfficersPage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<WindowMode>('WEEKLY');
  // 0 = the live Wed–Tue week, -1 = the week before it, and so on.
  const [weekOffset, setWeekOffset] = useState(0);
  // Column the tables are ranked by; 'day-N' sorts by a single weekday column.
  const [sortKey, setSortKey] = useState<string>('netNotes');

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

  const { from, to, label } = useMemo(
    () => getWindowDates(mode, todayStr, weekOffset),
    [mode, todayStr, weekOffset],
  );
  // Only the live week highlights today's column.
  const todayWeekday = useMemo(
    () => (mode === 'WEEKLY' && weekOffset !== 0 ? -1 : kampalaWeekdayIndex(todayStr)),
    [mode, weekOffset, todayStr],
  );

  // In DAILY mode the table shows just the selected day; otherwise the full Wed–Tue week.
  const dayIndices = useMemo(
    () => (mode === 'DAILY' ? [kampalaWeekdayIndex(todayStr)] : [0, 1, 2, 3, 4, 5, 6]),
    [mode, todayStr],
  );


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

  // Promised value of the notes themselves, separate from what funders deployed.
  const { data: promiseSummaries = [] } = useQuery<PsoPromiseSummary[]>({
    queryKey: ['pso-promise-summary-officers', from, to],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const { data, error } = (await supabase.rpc('pso_promise_summary' as any, {
        p_from: from,
        p_to: to,
      })) as unknown as { data: PsoPromiseSummary[] | null; error: { message: string } | null };
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

  const { data: nonOfficerRows = [] } = useQuery<NonOfficerRow[]>({
    queryKey: ['pso-daily-series-non-officers', from, to],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const { data, error } = (await supabase.rpc('pso_non_officer_series' as any, {
        p_from: from,
        p_to: to,
      })) as unknown as { data: NonOfficerRow[] | null; error: { message: string } | null };
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });

  const { data: nonOfficerFunded = [] } = useQuery<NonOfficerFunded[]>({
    queryKey: ['pso-funded-summary-non-officers', from, to],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const { data, error } = (await supabase.rpc('pso_non_officer_funded_summary' as any, {
        p_from: from,
        p_to: to,
      })) as unknown as { data: NonOfficerFunded[] | null; error: { message: string } | null };
      if (error) throw new Error(error.message);
      return data ?? [];
    },
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

    // Commission is a tracking point in its own right: an officer who earned a
    // 2% conversion or 1% top-up commission in this window is listed even when
    // no note of theirs falls inside it (or they were enrolled after it).
    for (const funded of fundedSummaries) {
      if (byId.has(funded.staff_id)) continue;
      const hasMoneyActivity =
        (funded.commission_accrued ?? 0) > 0 ||
        (funded.commission_base ?? 0) > 0 ||
        (funded.amount_deployed ?? 0) > 0 ||
        (funded.notes_funded ?? 0) > 0 ||
        (funded.topups ?? 0) > 0;
      if (!hasMoneyActivity) continue;
      byId.set(funded.staff_id, {
        staff_id: funded.staff_id,
        staff_ref: funded.staff_ref,
        daysElapsed: 0,
        notesCreated: 0,
        reversals: 0,
        netNotes: 0,
        partnerRegistered: 0,
        weekday: [0, 0, 0, 0, 0, 0, 0],
        notesUnapproved: funded.notes_unapproved ?? 0,
        notesFunded: funded.notes_funded ?? 0,
        fundersConverted: funded.funders_converted ?? 0,
        topups: funded.topups ?? 0,
        amountDeployed: funded.amount_deployed ?? 0,
        commissionBase: funded.commission_base ?? 0,
        commissionAccrued: funded.commission_accrued ?? 0,
        preEnrolmentNotes: funded.pre_enrolment_notes ?? 0,
        preEnrolmentFunded: funded.pre_enrolment_funded ?? 0,
        preEnrolmentAmount: funded.pre_enrolment_amount ?? 0,
      });
    }

    return Array.from(byId.values());
  }, [rows, fundedSummaries]);

  // Highest-first on the selected column; ties fall back to net notes then name.
  const sortedOfficers = useMemo(
    () =>
      [...officers].sort(
        (a, b) =>
          sortValue(b, sortKey) - sortValue(a, sortKey) ||
          b.netNotes - a.netNotes ||
          a.staff_ref.localeCompare(b.staff_ref),
      ),
    [officers, sortKey],
  );

  // Officers on the same sort value share a rank; the next distinct value takes
  // the position after the whole tied group. Repeated numbers are correct.
  const ranks = useMemo(() => {
    const out: number[] = [];
    sortedOfficers.forEach((o, i) => {
      out.push(
        i > 0 && sortValue(sortedOfficers[i - 1], sortKey) === sortValue(o, sortKey)
          ? out[i - 1]
          : i + 1,
      );
    });
    return out;
  }, [sortedOfficers, sortKey]);

  const people = useMemo<PersonSummary[]>(() => {
    const fundedById = new Map(nonOfficerFunded.map((s) => [s.person_user_id, s]));
    const byId = new Map<string, PersonSummary>();

    for (const row of nonOfficerRows) {
      let entry = byId.get(row.person_user_id);
      if (!entry) {
        const funded = fundedById.get(row.person_user_id);
        entry = {
          person_user_id: row.person_user_id,
          person_name: row.person_name,
          netNotes: 0,
          weekday: [0, 0, 0, 0, 0, 0, 0],
          notesUnapproved: funded?.notes_unapproved ?? 0,
          notesFunded: funded?.notes_funded ?? 0,
          fundersConverted: funded?.funders_converted ?? 0,
          topups: funded?.topups ?? 0,
          amountDeployed: funded?.amount_deployed ?? 0,
          commissionBase: funded?.commission_base ?? 0,
          commissionAccrued: funded?.commission_accrued ?? 0,
        };
        byId.set(row.person_user_id, entry);
      }
      entry.netNotes += row.net_notes ?? 0;
      entry.weekday[kampalaWeekdayIndex(row.day)] += row.net_notes ?? 0;
    }

    // Same rule for other contributors: commission earned in the window puts a
    // person on the list even with no note of their own inside it.
    for (const funded of nonOfficerFunded) {
      if (byId.has(funded.person_user_id)) continue;
      const hasMoneyActivity =
        (funded.commission_accrued ?? 0) > 0 ||
        (funded.commission_base ?? 0) > 0 ||
        (funded.amount_deployed ?? 0) > 0 ||
        (funded.notes_funded ?? 0) > 0 ||
        (funded.topups ?? 0) > 0;
      if (!hasMoneyActivity) continue;
      byId.set(funded.person_user_id, {
        person_user_id: funded.person_user_id,
        person_name: funded.person_name,
        netNotes: 0,
        weekday: [0, 0, 0, 0, 0, 0, 0],
        notesUnapproved: funded.notes_unapproved ?? 0,
        notesFunded: funded.notes_funded ?? 0,
        fundersConverted: funded.funders_converted ?? 0,
        topups: funded.topups ?? 0,
        amountDeployed: funded.amount_deployed ?? 0,
        commissionBase: funded.commission_base ?? 0,
        commissionAccrued: funded.commission_accrued ?? 0,
      });
    }

    return Array.from(byId.values());
  }, [nonOfficerRows, nonOfficerFunded]);

  const sortedPeople = useMemo(
    () =>
      [...people].sort(
        (a, b) =>
          sortValue(b, sortKey) - sortValue(a, sortKey) ||
          b.netNotes - a.netNotes ||
          a.person_name.localeCompare(b.person_name),
      ),
    [people, sortKey],
  );

  const peopleRanks = useMemo(() => {
    const out: number[] = [];
    sortedPeople.forEach((p, i) => {
      out.push(
        i > 0 && sortValue(sortedPeople[i - 1], sortKey) === sortValue(p, sortKey)
          ? out[i - 1]
          : i + 1,
      );
    });
    return out;
  }, [sortedPeople, sortKey]);

  const netTotal = useMemo(() => officers.reduce((s, o) => s + o.netNotes, 0), [officers]);
  const officerNetTarget = useMemo(() => officers.length * 40, [officers]);
  const officerNetPct = useMemo(() => {
    if (officerNetTarget <= 0) return 0;
    return Math.round((netTotal / officerNetTarget) * 100);
  }, [netTotal, officerNetTarget]);
  const fundedTotal = useMemo(() => officers.reduce((s, o) => s + o.notesFunded, 0), [officers]);
  const moneyTotal = useMemo(() => officers.reduce((s, o) => s + o.amountDeployed, 0), [officers]);

  const peopleNetTotal = useMemo(() => people.reduce((s, p) => s + p.netNotes, 0), [people]);
  const peopleFundedTotal = useMemo(() => people.reduce((s, p) => s + p.notesFunded, 0), [people]);
  const peopleMoneyTotal = useMemo(() => people.reduce((s, p) => s + p.amountDeployed, 0), [people]);
  const combinedNetTotal = netTotal + peopleNetTotal;
  const combinedNetTarget = useMemo(() => {
    if (mode === 'DAILY') return 100;
    if (mode === 'WEEKLY') return 700;
    return 3000;
  }, [mode]);
  const combinedNetPct = useMemo(() => {
    if (combinedNetTarget <= 0) return 0;
    return Math.round((combinedNetTotal / combinedNetTarget) * 100);
  }, [combinedNetTotal, combinedNetTarget]);
  const combinedFundedTotal = fundedTotal + peopleFundedTotal;
  const combinedMoneyTotal = moneyTotal + peopleMoneyTotal;
  const combinedContributors = officers.length + people.length;
  const combinedUnapproved = useMemo(
    () => officers.reduce((s, o) => s + o.notesUnapproved, 0) + people.reduce((s, p) => s + p.notesUnapproved, 0),
    [officers, people],
  );
  const combinedFunders = useMemo(
    () => officers.reduce((s, o) => s + o.fundersConverted, 0) + people.reduce((s, p) => s + p.fundersConverted, 0),
    [officers, people],
  );
  const combinedTopups = useMemo(
    () => officers.reduce((s, o) => s + o.topups, 0) + people.reduce((s, p) => s + p.topups, 0),
    [officers, people],
  );
  const combinedCommission = useMemo(
    () => officers.reduce((s, o) => s + o.commissionAccrued, 0) + people.reduce((s, p) => s + p.commissionAccrued, 0),
    [officers, people],
  );

  // Per-table day-column sums for the window currently shown. Recompute
  // whenever the window or the polled data changes.
  const officerWeekdayTotals = useMemo(() => {
    const weekday = [0, 0, 0, 0, 0, 0, 0];
    for (const o of officers) o.weekday.forEach((v, wi) => { weekday[wi] += v; });
    return weekday;
  }, [officers]);

  const peopleWeekdayTotals = useMemo(() => {
    const weekday = [0, 0, 0, 0, 0, 0, 0];
    for (const p of people) p.weekday.forEach((v, wi) => { weekday[wi] += v; });
    return weekday;
  }, [people]);


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
            <span className="text-[11px] text-muted-foreground">
              {mode === 'WEEKLY' && weekOffset !== 0
                ? 'past week · Wed to Tue'
                : 'live · refreshes every minute'}
            </span>
          </div>

          {mode === 'WEEKLY' && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setWeekOffset((w) => w - 1)}
                style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                className="min-h-9 rounded-md border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Previous week"
              >
                ← Previous week
              </button>
              <button
                type="button"
                onClick={() => setWeekOffset((w) => Math.min(0, w + 1))}
                disabled={weekOffset >= 0}
                style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                className="min-h-9 rounded-md border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                aria-label="Next week"
              >
                Next week →
              </button>
              {weekOffset !== 0 && (
                <button
                  type="button"
                  onClick={() => setWeekOffset(0)}
                  style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                  className="min-h-9 rounded-md border px-3 text-xs font-semibold text-foreground"
                >
                  This week
                </button>
              )}
            </div>
          )}




          <div className="grid w-full grid-cols-3 gap-1 rounded-lg border p-1 sm:inline-grid sm:w-auto">

            {(['DAILY', 'WEEKLY', 'MONTHLY'] as WindowMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); if (m !== 'WEEKLY') setWeekOffset(0); }}
                style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                className={cn(
                  'min-h-11 px-3 text-xs font-semibold tracking-wide rounded-md transition-colors',
                  mode === m
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-background text-muted-foreground hover:text-foreground',
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
            <div className="flex items-center justify-between gap-2">
              <div className="text-base font-bold tabular-nums sm:text-lg">{netTotal}/{officerNetTarget}</div>
              <div
                className={cn(
                  'text-sm font-bold tabular-nums',
                  netTotal >= officerNetTarget ? 'text-green-600' : 'text-red-600',
                )}
              >
                {officerNetTarget <= 0 ? 0 : officerNetPct}%
              </div>
            </div>
          </div>
          <div className="rounded-lg border bg-card px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Funded</div>
            <div className="text-base font-bold tabular-nums sm:text-lg">{fundedTotal}</div>
          </div>
          <div className="rounded-lg border bg-card px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Money deployed</div>
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
              {sortedOfficers.map((officer, i) => (
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
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Money deployed</div>
                      <div className="text-xs font-semibold tabular-nums">{formatUgxCompact(officer.amountDeployed)}</div>
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
                      {dayIndices.map((wi) => (
                        <SortableTh
                          key={wi}
                          label={WEEKDAY_LABELS[wi]}
                          sortKey={`day-${wi}`}
                          activeKey={sortKey}
                          onSort={setSortKey}
                          topHint={String(officerWeekdayTotals[wi])}
                        />
                      ))}

                      <SortableTh label="Total" sortKey="netNotes" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Unapproved" sortKey="notesUnapproved" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Funded" sortKey="notesFunded" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Funders" sortKey="fundersConverted" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Top-ups" sortKey="topups" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Money deployed" sortKey="amountDeployed" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Commission base" sortKey="commissionBase" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Commission" sortKey="commissionAccrued" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Pre-enrol" sortKey="preEnrolmentNotes" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Pre-enrol funded" sortKey="preEnrolmentFunded" activeKey={sortKey} onSort={setSortKey} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedOfficers.map((officer, i) => (
                      <tr key={officer.staff_id} className="border-t">
                        <td className="px-4 py-2 text-left tabular-nums">{ranks[i]}</td>
                        <td className="px-4 py-2 font-medium">{officer.staff_ref}</td>
                        {dayIndices.map((wi) => (
                          <td key={wi} className="px-2 py-2 text-right tabular-nums">{officer.weekday[wi]}</td>
                        ))}

                        <td className="px-4 py-2 text-right tabular-nums">{officer.netNotes}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {officer.notesUnapproved === 0 ? '—' : officer.notesUnapproved}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{officer.notesFunded}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{officer.fundersConverted}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {officer.topups === 0 ? '—' : officer.topups}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          UGX {officer.amountDeployed.toLocaleString('en-UG')}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          UGX {officer.commissionBase.toLocaleString('en-UG')}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          UGX {officer.commissionAccrued.toLocaleString('en-UG')}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {officer.preEnrolmentNotes === 0 ? '—' : officer.preEnrolmentNotes}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          <div>{officer.preEnrolmentFunded}</div>
                          <div className="text-[11px] text-muted-foreground">
                            UGX {officer.preEnrolmentAmount.toLocaleString('en-UG')}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {!isLoading && people.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-col gap-0.5 border-t pt-4">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Other contributors
              </span>
              <span className="text-[11px] text-muted-foreground">
                promissory notes brought in by everyone except platform sales officers
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border bg-card px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Contributors</div>
                <div className="text-base font-bold tabular-nums sm:text-lg">{people.length}</div>
              </div>
              <div className="rounded-lg border bg-card px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Net notes</div>
                <div className="text-base font-bold tabular-nums sm:text-lg">{peopleNetTotal}</div>
              </div>
              <div className="rounded-lg border bg-card px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Funded</div>
                <div className="text-base font-bold tabular-nums sm:text-lg">{peopleFundedTotal}</div>
              </div>
              <div className="rounded-lg border bg-card px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Money deployed</div>
                <div className="text-base font-bold tabular-nums sm:text-lg">{formatUgxCompact(peopleMoneyTotal)}</div>
              </div>
            </div>

            <div className="space-y-2 md:hidden">
              {sortedPeople.map((person, i) => (
                <div key={person.person_user_id} className="rounded-xl border bg-card p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-bold tabular-nums text-muted-foreground">#{peopleRanks[i]}</div>
                      <div className="text-sm font-semibold">{person.person_name}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold leading-none tabular-nums">{person.netNotes}</div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">net notes</div>
                    </div>
                  </div>

                  {mode === 'DAILY' ? (
                    <p className="mt-2 text-[11px] text-muted-foreground">today only</p>
                  ) : (
                    <div className="mt-3 grid grid-cols-7 gap-1">
                      {person.weekday.map((v, wi) => (
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
                      <div className="text-xs font-semibold tabular-nums">{person.notesFunded}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Money deployed</div>
                      <div className="text-xs font-semibold tabular-nums">{formatUgxCompact(person.amountDeployed)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Commission</div>
                      <div className="text-xs font-semibold tabular-nums">{formatUgxCompact(person.commissionAccrued)}</div>
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
                      {dayIndices.map((wi) => (
                        <SortableTh
                          key={wi}
                          label={WEEKDAY_LABELS[wi]}
                          sortKey={`day-${wi}`}
                          activeKey={sortKey}
                          onSort={setSortKey}
                          topHint={String(peopleWeekdayTotals[wi])}
                        />
                      ))}

                      <SortableTh label="Total" sortKey="netNotes" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Unapproved" sortKey="notesUnapproved" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Funded" sortKey="notesFunded" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Funders" sortKey="fundersConverted" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Top-ups" sortKey="topups" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Money deployed" sortKey="amountDeployed" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Commission base" sortKey="commissionBase" activeKey={sortKey} onSort={setSortKey} />
                      <SortableTh label="Commission" sortKey="commissionAccrued" activeKey={sortKey} onSort={setSortKey} />
                      <th className="px-4 py-2 text-right font-medium">Pre-enrol</th>
                      <th className="px-4 py-2 text-right font-medium">Pre-enrol funded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPeople.map((person, i) => (
                      <tr key={person.person_user_id} className="border-t">
                        <td className="px-4 py-2 text-left tabular-nums">{peopleRanks[i]}</td>
                        <td className="px-4 py-2 font-medium">{person.person_name}</td>
                        {dayIndices.map((wi) => (
                          <td key={wi} className="px-2 py-2 text-right tabular-nums">{person.weekday[wi]}</td>
                        ))}

                        <td className="px-4 py-2 text-right tabular-nums">{person.netNotes}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {person.notesUnapproved === 0 ? '—' : person.notesUnapproved}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{person.notesFunded}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{person.fundersConverted}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {person.topups === 0 ? '—' : person.topups}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          UGX {person.amountDeployed.toLocaleString('en-UG')}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          UGX {person.commissionBase.toLocaleString('en-UG')}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          UGX {person.commissionAccrued.toLocaleString('en-UG')}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">—</td>
                        <td className="px-4 py-2 text-right tabular-nums">—</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}


        {!isLoading && (officers.length > 0 || people.length > 0) && (
          <div className="space-y-2">
            <div className="flex flex-col gap-0.5 border-t pt-4">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Combined totals
              </span>
              <span className="text-[11px] text-muted-foreground">
                officers + other contributors · {label.toLowerCase()}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border bg-card px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Contributors</div>
                <div className="text-base font-bold tabular-nums sm:text-lg">{combinedContributors}</div>
              </div>
              <div className="rounded-lg border bg-card px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Net notes</div>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-base font-bold tabular-nums sm:text-lg">{combinedNetTotal}/{combinedNetTarget}</div>
                  <div
                    className={cn(
                      'text-sm font-bold tabular-nums',
                      combinedNetTotal >= combinedNetTarget ? 'text-green-600' : 'text-red-600',
                    )}
                  >
                    {combinedNetPct}%
                  </div>
                </div>
              </div>
              <div className="rounded-lg border bg-card px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Funded</div>
                <div className="text-base font-bold tabular-nums sm:text-lg">{combinedFundedTotal}</div>
              </div>
              <div className="rounded-lg border bg-card px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Money deployed</div>
                <div className="text-base font-bold tabular-nums sm:text-lg">{formatUgxCompact(combinedMoneyTotal)}</div>
              </div>
              <div className="rounded-lg border bg-card px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Unapproved</div>
                <div className="text-base font-bold tabular-nums sm:text-lg">{combinedUnapproved}</div>
              </div>
              <div className="rounded-lg border bg-card px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Funders</div>
                <div className="text-base font-bold tabular-nums sm:text-lg">{combinedFunders}</div>
              </div>
              <div className="rounded-lg border bg-card px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Top-ups</div>
                <div className="text-base font-bold tabular-nums sm:text-lg">{combinedTopups}</div>
              </div>
              <div className="rounded-lg border bg-card px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Commission</div>
                <div className="text-base font-bold tabular-nums sm:text-lg">{formatUgxCompact(combinedCommission)}</div>
              </div>
            </div>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Money deployed is what the funder put in. Commission base is the amount commission was
          calculated on, capped at the note's promised amount. Pre-enrol counts notes and conversions
          dated before the officer's assignment start and is excluded from the ranked total.
        </p>
        <p className="text-xs text-muted-foreground">
          as at {fundedAsAt ? formatKampalaDateTime(fundedAsAt) : '—'} · funded figures are never frozen
        </p>
      </div>
    </PersonalLayout>
  );
}
