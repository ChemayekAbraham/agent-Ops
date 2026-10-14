import { downloadXlsxWorkbook } from '@/lib/xlsxExport';
import { noPaymentBands, noPaymentFileStem, withoutPaymentText } from '@/lib/noPaymentDays';
import type { TenantOpsNoPaymentReportV2 } from '@/hooks/useTenantOpsNoPaymentReportV2';

/**
 * The N+ days report in one place, so the screen and both exports read the same figures. Totals are the sums of
 * the server's per-agent counts (the agent breakdown always covers every agent); the money and day figures on
 * each tenant come from the server row.
 */
export interface NoPaymentTotals {
  min: number;
  min10: number;
  min20: number;
  outstanding: number;
  dailyAtRisk: number;
}

export function summariseNoPayment(report: TenantOpsNoPaymentReportV2): NoPaymentTotals {
  const agents = report.agent_summary ?? [];
  const tenants = report.tenants ?? [];
  return {
    min: agents.reduce((s, a) => s + a.gte_min, 0),
    min10: agents.reduce((s, a) => s + a.gte_min_10, 0),
    min20: agents.reduce((s, a) => s + a.gte_min_20, 0),
    outstanding: tenants.reduce((s, t) => s + (Number(t.outstanding_balance) || 0), 0),
    dailyAtRisk: tenants.reduce((s, t) => s + (Number(t.expected_daily_payment) || 0), 0),
  };
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

export const NO_PAYMENT_TENANT_HEADERS = [
  'Tenant', 'Account number', 'Agent', 'Last payment', 'Days since last payment', 'Expected daily payment (UGX)',
  'Outstanding balance (UGX)', 'Total paid (UGX)', 'Progress %', 'Status',
];

/** Excel export: Summary (the cards), Agents (the breakdown), Tenants (the list). Titles carry N. */
export async function exportNoPaymentXlsx(report: TenantOpsNoPaymentReportV2, agentLabel: string | null): Promise<void> {
  const n = report.min_days;
  const [b1, b2, b3] = noPaymentBands(n);
  const totals = summariseNoPayment(report);
  const agents = (report.agent_summary ?? []).slice().sort((a, b) => b.gte_min - a.gte_min || a.label.localeCompare(b.label));
  const tenants = (report.tenants ?? []).slice().sort((a, b) => b.days_since_last_payment - a.days_since_last_payment);

  await downloadXlsxWorkbook(`Welile_TenantOps_${noPaymentFileStem(n)}_${new Date().toISOString().slice(0, 10)}.xlsx`, [
    {
      name: 'Summary',
      headers: [`Tenants ${withoutPaymentText(n)}`, 'Count'],
      rows: [
        [`${b1}+ days`, totals.min],
        [`${b2}+ days`, totals.min10],
        [`${b3}+ days`, totals.min20],
        ['Outstanding (listed), UGX', Math.round(totals.outstanding)],
        ['Expected daily payments missed (listed), UGX', Math.round(totals.dailyAtRisk)],
        ['Tenants in this list', tenants.length],
        ['As of', report.as_of],
        ['Agent filter', agentLabel ?? 'All agents'],
      ],
    },
    {
      name: 'Agents',
      headers: ['Agent', `${b1}+ days`, `${b2}+ days`, `${b3}+ days`],
      rows: [
        ...agents.map((a) => [a.label, a.gte_min, a.gte_min_10, a.gte_min_20]),
        ['All agents', totals.min, totals.min10, totals.min20],
      ],
    },
    {
      name: 'Tenants',
      headers: NO_PAYMENT_TENANT_HEADERS,
      rows: tenants.map((t) => [
        t.tenant_name ?? 'Unnamed tenant',
        t.tenant_account_number ?? '',
        t.agent_name,
        day(t.date_of_last_payment),
        t.days_since_last_payment,
        Math.round(Number(t.expected_daily_payment) || 0),
        Math.round(Number(t.outstanding_balance) || 0),
        Math.round(Number(t.total_amount_paid) || 0),
        Number(t.progress_pct) || 0,
        t.tenant_status.replace(/_/g, ' '),
      ]),
    },
  ]);
}
