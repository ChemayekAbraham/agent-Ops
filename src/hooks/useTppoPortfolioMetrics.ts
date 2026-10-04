import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { TppoZoneAReport } from '@/components/tenant-ops/tppo/tppoTypes';

/**
 * Read-only reporting hook for the Tenant Ops copy of Portfolio Performance.
 *
 * It calls exactly the same RPCs the Agent Ops page already uses
 * (`tppo_get_report_zone_a`, `tppo_arrears_movement`, `tppo_period_plan_detail`)
 * and renders their figures as supplied. No collection, arrears or commission
 * figure is recomputed here: for a custom range the daily figures each RPC
 * returns are added together, flows summed and stocks taken from the range's
 * first opening and last closing balance.
 */

export type TppoPeriodMode = 'day' | 'week' | 'month' | 'range';

export interface TppoMovementPeriod {
  period_index: number;
  period_start: string;
  period_end: string;
  counted_through: string;
  still_counting: boolean;
  label: string;
  opening_arrears: number;
  accrued: number;
  prepaid_credit_absorbed: number;
  cleared_by_payment: number;
  closing_arrears: number;
  net_added_to_arrears: number;
  collected_in_period: number;
  plans_owing_open: number;
  plans_owing_close: number;
  newly_in_arrears: number;
  fully_cleared: number;
}

interface MovementPayload {
  granularity: string;
  anchor: string;
  periods: TppoMovementPeriod[];
}

export interface TppoPlanDetailRow {
  rent_request_id: string;
  tenant_name: string;
  agent_name: string;
  daily_amount: number;
  scheduled_in_period: number;
  arrears: number;
  paid_in_period: number;
  scheduled_outstanding: number;
  overpaid_in_period: number;
}

interface PlanDetailPayload {
  granularity: string;
  period_start: string;
  period_end: string;
  totals: {
    plans: number;
    scheduled_total: number;
    arrears_total: number;
    plans_in_arrears: number;
    paid_total: number;
    collected_total: number;
  };
  rows: TppoPlanDetailRow[];
}

/** One reporting cell: a whole period, or a single day inside a custom range. */
export interface TppoCell {
  key: string;
  label: string;
  start: string;
  end: string;
  stillCounting: boolean;
  scheduled: number | null;
  collectedScheduled: number | null;
  collectedTotal: number | null;
  accrued: number | null;
  clearedByPayment: number | null;
  openingArrears: number | null;
  closingArrears: number | null;
}

export interface TppoPortfolioMetrics {
  /** Scheduled due in the period plus arrears brought forward at its start. */
  expectedCollection: number | null;
  scheduledDue: number | null;
  arrearsBroughtForward: number | null;
  totalCollected: number | null;
  collectedFromScheduled: number | null;
  collectedInArrears: number | null;
  addedInArrears: number | null;
  /** Added in arrears − collected in arrears. */
  differenceInArrears: number | null;
  /** Closing arrears of the period immediately before this one. */
  closingArrearsPrevious: number | null;
  newClosingArrears: number | null;
  scheduledRatePct: number | null;
  expectedRatePct: number | null;
  arrearsRecoveryRatePct: number | null;
  arrearsChangePct: number | null;
}

export interface UseTppoPortfolioMetricsArgs {
  mode: TppoPeriodMode;
  /** Anchor date (YYYY-MM-DD) for day/week/month. */
  anchor: string;
  /** Inclusive range for `mode === 'range'`. */
  rangeStart?: string;
  rangeEnd?: string;
}

const MAX_RANGE_DAYS = 92;

function toUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): string[] {
  if (!start || !end || end < start) return [];
  const out: string[] = [];
  const cursor = toUtc(start);
  const last = toUtc(end);
  while (cursor <= last && out.length < MAX_RANGE_DAYS) {
    out.push(isoOf(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(toUtc(iso));
}

const num = (v: number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

function sum(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0);
}

function rate(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole === 0) return null;
  return (part / whole) * 100;
}

async function fetchZoneA(granularity: string, anchor: string): Promise<TppoZoneAReport> {
  const { data, error } = await supabase.rpc('tppo_get_report_zone_a', {
    p_granularity: granularity,
    p_anchor: anchor,
  });
  if (error) throw error;
  return (data ?? {}) as unknown as TppoZoneAReport;
}

async function fetchMovement(granularity: string, anchor: string): Promise<MovementPayload> {
  const { data, error } = await supabase.rpc('tppo_arrears_movement', {
    p_granularity: granularity,
    p_anchor: anchor,
  });
  if (error) throw error;
  return (data ?? {}) as unknown as MovementPayload;
}

async function fetchPlanDetail(granularity: string, anchor: string): Promise<PlanDetailPayload> {
  const { data, error } = await supabase.rpc('tppo_period_plan_detail', {
    p_granularity: granularity,
    p_anchor: anchor,
  });
  if (error) throw error;
  return (data ?? {}) as unknown as PlanDetailPayload;
}

function currentMovement(payload?: MovementPayload | null): TppoMovementPeriod | null {
  const periods = [...(payload?.periods ?? [])].sort((a, b) => a.period_index - b.period_index);
  if (periods.length === 0) return null;
  return periods.find((p) => p.period_index === 2) ?? periods[periods.length - 1];
}

function priorMovement(payload?: MovementPayload | null): TppoMovementPeriod | null {
  const periods = [...(payload?.periods ?? [])].sort((a, b) => a.period_index - b.period_index);
  if (periods.length < 2) return null;
  return periods.find((p) => p.period_index === 1) ?? periods[periods.length - 2];
}

export function useTppoPortfolioMetrics({
  mode,
  anchor,
  rangeStart,
  rangeEnd,
}: UseTppoPortfolioMetricsArgs) {
  const isRange = mode === 'range';
  const rangeDays = useMemo(
    () => (isRange && rangeStart && rangeEnd ? daysBetween(rangeStart, rangeEnd) : []),
    [isRange, rangeStart, rangeEnd],
  );

  // Period mode: one zone-A + one movement call, exactly as the Agent Ops page does.
  const periodQueryDefs: Array<{
    queryKey: unknown[];
    queryFn: () => Promise<unknown>;
    staleTime: number;
  }> = isRange
    ? []
    : [
        {
          queryKey: ['tppo-report-zone-a', mode, anchor],
          queryFn: () => fetchZoneA(mode, anchor),
          staleTime: 30_000,
        },
        {
          queryKey: ['tppo-arrears-movement', mode, anchor],
          queryFn: () => fetchMovement(mode, anchor),
          staleTime: 30_000,
        },
      ];
  const periodQueries = useQueries({ queries: periodQueryDefs });


  // Custom range: the same two RPCs, per Kampala day, then flows added together.
  const rangeQueries = useQueries({
    queries: rangeDays.flatMap((day) => [
      {
        queryKey: ['tppo-report-zone-a', 'day', day],
        queryFn: () => fetchZoneA('day', day),
        staleTime: 60_000,
      },
      {
        queryKey: ['tppo-arrears-movement', 'day', day],
        queryFn: () => fetchMovement('day', day),
        staleTime: 60_000,
      },
    ]),
  });

  const planDetail = useQueries({
    queries: [
      {
        queryKey: ['tppo-plan-detail', isRange ? 'range' : mode, isRange ? (rangeEnd ?? anchor) : anchor],
        queryFn: () => fetchPlanDetail(isRange ? 'day' : mode, isRange ? (rangeEnd ?? anchor) : anchor),
        staleTime: 30_000,
      },
    ],
  })[0];

  const active = isRange ? rangeQueries : periodQueries;
  const isLoading = active.some((q) => q.isPending) || rangeQueries.some((q) => q.isPending);
  const error = (active.find((q) => q.error)?.error ?? null) as Error | null;

  const { cells, metrics, periodLabel, stillCounting } = useMemo(() => {
    if (isRange) {
      const built: TppoCell[] = rangeDays.map((day, i) => {
        const zone = rangeQueries[i * 2]?.data as TppoZoneAReport | undefined;
        const move = currentMovement(rangeQueries[i * 2 + 1]?.data as MovementPayload | undefined);
        return {
          key: day,
          label: dayLabel(day),
          start: day,
          end: day,
          stillCounting: move?.still_counting ?? zone?.provisional === true,
          scheduled: num(zone?.scheduled_due_ugx),
          collectedScheduled: num(zone?.collected_ugx),
          collectedTotal: num(zone?.collected_total_ugx),
          accrued: num(move?.accrued),
          clearedByPayment: num(move?.cleared_by_payment),
          openingArrears: num(move?.opening_arrears),
          closingArrears: num(move?.closing_arrears),
        };
      });

      const first = built[0];
      const last = built[built.length - 1];
      const scheduled = sum(built.map((c) => c.scheduled));
      const collectedScheduled = sum(built.map((c) => c.collectedScheduled));
      const totalCollected = sum(built.map((c) => c.collectedTotal));
      // Collected in arrears = total collected − collected from scheduled.
      const collectedArrears =
        totalCollected === null && collectedScheduled === null
          ? null
          : (totalCollected ?? 0) - (collectedScheduled ?? 0);
      // Added in arrears = amount scheduled − amount collected from scheduled.
      const added =
        scheduled === null && collectedScheduled === null
          ? null
          : (scheduled ?? 0) - (collectedScheduled ?? 0);
      const broughtForward = first?.openingArrears ?? null;
      const closing = last?.closingArrears ?? null;
      const expected =
        scheduled === null && broughtForward === null ? null : (scheduled ?? 0) + (broughtForward ?? 0);

      const m: TppoPortfolioMetrics = {
        expectedCollection: expected,
        scheduledDue: scheduled,
        arrearsBroughtForward: broughtForward,
        totalCollected,
        collectedFromScheduled: collectedScheduled,
        collectedInArrears: collectedArrears,
        addedInArrears: added,
        differenceInArrears:
          added === null && collectedArrears === null ? null : (added ?? 0) - (collectedArrears ?? 0),
        closingArrearsPrevious: broughtForward,
        newClosingArrears: closing,
        scheduledRatePct: rate(collectedScheduled, scheduled),
        expectedRatePct: rate(sum(built.map((c) => c.collectedTotal)), expected),
        arrearsRecoveryRatePct: rate(collectedArrears, broughtForward),
        arrearsChangePct:
          broughtForward && closing !== null ? ((closing - broughtForward) / broughtForward) * 100 : null,
      };

      return {
        cells: built,
        metrics: m,
        periodLabel:
          rangeDays.length === 0
            ? '—'
            : `${dayLabel(rangeDays[0])} to ${dayLabel(rangeDays[rangeDays.length - 1])}`,
        stillCounting: built.some((c) => c.stillCounting),
      };
    }

    const zone = periodQueries[0]?.data as TppoZoneAReport | undefined;
    const movement = periodQueries[1]?.data as MovementPayload | undefined;
    const cur = currentMovement(movement);
    const prev = priorMovement(movement);

    const allPeriods = [...(movement?.periods ?? [])].sort((a, b) => a.period_index - b.period_index);
    const built: TppoCell[] = allPeriods.map((p) => {
      const isCurrent = p.period_index === (cur?.period_index ?? -1);
      const isPrior = p.period_index === (prev?.period_index ?? -1);
      return {
        key: `${p.period_index}-${p.period_start}`,
        label: p.label,
        start: p.period_start,
        end: p.period_end,
        stillCounting: p.still_counting,
        scheduled: isCurrent
          ? num(zone?.scheduled_due_ugx)
          : isPrior
            ? num(zone?.prior?.scheduled_due_ugx)
            : null,
        collectedScheduled: isCurrent
          ? num(zone?.collected_ugx)
          : isPrior
            ? num(zone?.prior?.collected_ugx)
            : null,
        collectedTotal: isCurrent
          ? num(zone?.collected_total_ugx)
          : isPrior
            ? num(zone?.prior?.collected_total_ugx)
            : num(p.collected_in_period),
        accrued: num(p.accrued),
        clearedByPayment: num(p.cleared_by_payment),
        openingArrears: num(p.opening_arrears),
        closingArrears: num(p.closing_arrears),
      };
    });

    const scheduled = num(zone?.scheduled_due_ugx);
    const collectedScheduled = num(zone?.collected_ugx);
    const collectedTotal = num(zone?.collected_total_ugx);
    // Collected in arrears = total collected − collected from scheduled.
    const collectedArrears =
      collectedTotal === null && collectedScheduled === null
        ? null
        : (collectedTotal ?? 0) - (collectedScheduled ?? 0);
    // Added in arrears = amount scheduled − amount collected from scheduled.
    const added =
      scheduled === null && collectedScheduled === null
        ? null
        : (scheduled ?? 0) - (collectedScheduled ?? 0);
    const broughtForward = num(zone?.arrears_target_ugx) ?? num(cur?.opening_arrears);
    const expected =
      num(zone?.total_field_target_ugx) ??
      (scheduled === null && broughtForward === null ? null : (scheduled ?? 0) + (broughtForward ?? 0));
    const closing = num(cur?.closing_arrears);
    const closingPrev = num(prev?.closing_arrears) ?? num(cur?.opening_arrears);

    const m: TppoPortfolioMetrics = {
      expectedCollection: expected,
      scheduledDue: scheduled,
      arrearsBroughtForward: broughtForward,
      totalCollected: collectedTotal,
      collectedFromScheduled: collectedScheduled,
      collectedInArrears: collectedArrears,
      addedInArrears: added,
      differenceInArrears:
        added === null && collectedArrears === null ? null : (added ?? 0) - (collectedArrears ?? 0),
      closingArrearsPrevious: closingPrev,
      newClosingArrears: closing,
      scheduledRatePct: num(zone?.collection_rate_pct) ?? rate(collectedScheduled, scheduled),
      expectedRatePct: rate(collectedTotal, expected),
      arrearsRecoveryRatePct: rate(collectedArrears, broughtForward),
      arrearsChangePct:
        closingPrev && closing !== null ? ((closing - closingPrev) / closingPrev) * 100 : null,
    };

    return {
      cells: built,
      metrics: m,
      periodLabel:
        zone?.period_start && zone?.period_end && zone.period_start !== zone.period_end
          ? `${dayLabel(zone.period_start)} to ${dayLabel(zone.period_end)}`
          : zone?.period_start
            ? dayLabel(zone.period_start)
            : '—',
      stillCounting: cur?.still_counting ?? zone?.provisional === true,
    };
  }, [isRange, rangeDays, rangeQueries, periodQueries]);

  return {
    isLoading,
    error,
    cells,
    metrics,
    periodLabel,
    stillCounting,
    /** Plan-level detail for the agent breakdown, straight from the shared RPC. */
    planDetail: planDetail.data as PlanDetailPayload | undefined,
    planDetailLoading: planDetail.isPending,
    rangeTruncated: isRange && Boolean(rangeStart && rangeEnd) && rangeDays.length === MAX_RANGE_DAYS,
    maxRangeDays: MAX_RANGE_DAYS,
  };
}
