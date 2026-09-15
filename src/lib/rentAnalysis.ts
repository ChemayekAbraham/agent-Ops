/**
 * Rent Analysis — Tenant Ops → Agent Monitoring.
 *
 * Presentation-side aggregation only. Every figure is derived from the SAME
 * authoritative sources Agent Monitoring already uses:
 *   - active tenants  = `rent_requests` (funded | disbursed | repaying) that are
 *                       present in `v_tenant_daily_eligibility`;
 *   - schedule maths  = `describePlanSchedule` (src/lib/agentMonitoringSchedule)
 *                       — arrears, ahead cover and outstanding plan balance;
 *   - receipts        = `agent_collections` plus the unmatched `repayments`
 *                       rows, paired by `src/lib/rentReceipts`.
 *
 * No new payment rule, no alternative calculation, no stored-data writes.
 */

import { describePlanSchedule, type PlanSchedule, type SchedulePlanInput } from './agentMonitoringSchedule';

export interface RentAnalysisPlan extends SchedulePlanInput {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  status: string;
  rent_amount: number | null;
  house_category: string | null;
}

export interface RentAnalysisReceipt {
  rent_request_id: string;
  amount: number;
  created_at: string;
}

export interface RentBand {
  key: string;
  label: string;
  /** Inclusive lower bound in UGX. */
  min: number;
  /** Exclusive upper bound in UGX; null = no ceiling. */
  max: number | null;
}

export const RENT_BANDS: RentBand[] = [
  { key: 'b1', label: 'Below 150,000', min: 0, max: 150_000 },
  { key: 'b2', label: '150,000 – 330,000', min: 150_000, max: 330_000 },
  { key: 'b3', label: '330,000 – 500,000', min: 330_000, max: 500_000 },
  { key: 'b4', label: '500,000 – 1,000,000', min: 500_000, max: 1_000_000 },
  { key: 'b5', label: 'Above 1,000,000', min: 1_000_000, max: null },
];

export const CUSTOM_BAND_KEY = 'custom';

export function bandOf(rent: number, bands: RentBand[]): RentBand | null {
  return bands.find((band) => rent >= band.min && (band.max === null || rent < band.max)) ?? null;
}

export function bandLabel(min: number, max: number | null) {
  const fmt = (value: number) => value.toLocaleString();
  if (max === null) return `Above ${fmt(min)}`;
  if (min <= 0) return `Below ${fmt(max)}`;
  return `${fmt(min)} – ${fmt(max)}`;
}

export interface TenantRentRow {
  planId: string;
  tenantId: string;
  tenantName: string;
  tenantPhone: string | null;
  agentId: string | null;
  agentName: string;
  agentPhone: string | null;
  status: string;
  houseCategory: string | null;
  rent: number;
  schedule: PlanSchedule;
  /** Receipts recorded inside the selected reporting period. */
  paymentsInPeriod: number;
  paidInPeriod: number;
  /** Mean days between consecutive receipts in the period (null when < 2). */
  averageGapDays: number | null;
  /** Last receipt date inside the period. */
  lastPaymentAt: string | null;
}

export interface RentBandSummary {
  band: RentBand;
  tenantCount: number;
  totalRent: number;
  averageRent: number;
  medianRent: number;
  arrearsCount: number;
  arrearsAmount: number;
  aheadCount: number;
  onScheduleCount: number;
  outstanding: number;
  scheduledToDate: number;
  paidToDate: number;
  /** Tenants with at least one receipt inside the reporting period. */
  payingCount: number;
  paymentsInPeriod: number;
  paidInPeriod: number;
  /** Share of tenants that paid at least once in the period (0–100). */
  paymentRate: number;
  /** Cumulative paid / cumulative scheduled to date (0–100). */
  scheduleAdherence: number;
  /** Mean of per-tenant average payment gaps, in days. */
  averageGapDays: number | null;
  dailyCount: number;
  weeklyCount: number;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Build one row per active rent plan, with period receipts already attached. */
export function buildTenantRows({
  plans,
  receipts,
  referenceDay,
  nameFor,
  phoneFor,
}: {
  plans: RentAnalysisPlan[];
  receipts: RentAnalysisReceipt[];
  referenceDay: Date;
  nameFor: (id: string | null) => string;
  phoneFor: (id: string | null) => string | null;
}): TenantRentRow[] {
  const byPlan = new Map<string, RentAnalysisReceipt[]>();
  receipts.forEach((receipt) => {
    const list = byPlan.get(receipt.rent_request_id) ?? [];
    list.push(receipt);
    byPlan.set(receipt.rent_request_id, list);
  });

  return plans.map((plan) => {
    const planReceipts = (byPlan.get(plan.id) ?? []).sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    let averageGapDays: number | null = null;
    if (planReceipts.length >= 2) {
      let total = 0;
      for (let index = 1; index < planReceipts.length; index += 1) {
        total +=
          (new Date(planReceipts[index].created_at).getTime() -
            new Date(planReceipts[index - 1].created_at).getTime()) /
          86_400_000;
      }
      averageGapDays = total / (planReceipts.length - 1);
    }

    return {
      planId: plan.id,
      tenantId: plan.tenant_id,
      tenantName: nameFor(plan.tenant_id),
      tenantPhone: phoneFor(plan.tenant_id),
      agentId: plan.agent_id,
      agentName: nameFor(plan.agent_id),
      agentPhone: phoneFor(plan.agent_id),
      status: plan.status,
      houseCategory: plan.house_category,
      rent: Number(plan.rent_amount ?? 0),
      schedule: describePlanSchedule(plan, referenceDay),
      paymentsInPeriod: planReceipts.length,
      paidInPeriod: planReceipts.reduce((sum, receipt) => sum + Number(receipt.amount ?? 0), 0),
      averageGapDays,
      lastPaymentAt: planReceipts.length ? planReceipts[planReceipts.length - 1].created_at : null,
    };
  });
}

export function summariseBand(band: RentBand, rows: TenantRentRow[]): RentBandSummary {
  const totalRent = rows.reduce((sum, row) => sum + row.rent, 0);
  const arrearsRows = rows.filter((row) => row.schedule.arrears > 0);
  const gaps = rows.map((row) => row.averageGapDays).filter((gap): gap is number => gap !== null);
  const scheduledToDate = rows.reduce((sum, row) => sum + row.schedule.scheduledToDate, 0);
  const paidToDate = rows.reduce((sum, row) => sum + row.schedule.paidToDate, 0);
  const payingCount = rows.filter((row) => row.paymentsInPeriod > 0).length;

  return {
    band,
    tenantCount: rows.length,
    totalRent,
    averageRent: rows.length ? totalRent / rows.length : 0,
    medianRent: median(rows.map((row) => row.rent)),
    arrearsCount: arrearsRows.length,
    arrearsAmount: arrearsRows.reduce((sum, row) => sum + row.schedule.arrears, 0),
    aheadCount: rows.filter((row) => row.schedule.periodsAhead > 0).length,
    onScheduleCount: rows.filter((row) => row.schedule.arrears === 0).length,
    outstanding: rows.reduce((sum, row) => sum + row.schedule.outstandingPlan, 0),
    scheduledToDate,
    paidToDate,
    payingCount,
    paymentsInPeriod: rows.reduce((sum, row) => sum + row.paymentsInPeriod, 0),
    paidInPeriod: rows.reduce((sum, row) => sum + row.paidInPeriod, 0),
    paymentRate: rows.length ? (payingCount / rows.length) * 100 : 0,
    scheduleAdherence: scheduledToDate > 0 ? Math.min(100, (paidToDate / scheduledToDate) * 100) : 0,
    averageGapDays: gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : null,
    dailyCount: rows.filter((row) => !row.schedule.weekly).length,
    weeklyCount: rows.filter((row) => row.schedule.weekly).length,
  };
}
