/**
 * Plain-language names and one-line explanations for the money figures on the Tenant Ops workspace tabs
 * (Top-Up Eligibility, Management Overview, Tenant Communications).
 *
 * Why this exists: those tabs read get_tenant_topup_eligibility, whose money figures are ALL-TIME per Rent Plan
 * (rent_requests.total_repayment and amount_repaid; arrears to date from calendar days since the plan started).
 * Tenant Ops Home shows PERIOD figures (the pinned bill timetable and payments limited to each plan's bill, from
 * ops_tenant_ops_home_range). Readers took the two for the same thing, so every all-time figure now says so, and
 * the period figures say "this period". Labels only: no number is changed.
 */

export type FigureKey =
  | 'totalExpected' | 'totalCollected' | 'outstanding' | 'arrears' | 'paidPct' | 'leftPct' | 'portfolioPct' | 'averageTenant'
  | 'periodExpected' | 'periodCollected' | 'periodShort' | 'periodCovered' | 'periodPaidAhead';

export interface FigureLabelText { label: string; hint: string }

export const FIGURE_LABELS: Record<FigureKey, FigureLabelText> = {
  totalExpected: {
    label: 'Total expected (full cycle)',
    hint: "The whole Rent Plan's repayment total over its full cycle, including days not yet due. It is not a period figure, so it will not match Home's Expected.",
  },
  totalCollected: {
    label: 'Total collected (all time)',
    hint: "Everything repaid on the Rent Plan since it started, as recorded on the plan. Not limited to the dates chosen, so it will not match Home's Collected.",
  },
  outstanding: {
    label: 'Outstanding (whole plan)',
    hint: 'Total expected minus total collected, never below zero. It includes days that are not yet due.',
  },
  arrears: {
    label: 'Arrears to date',
    hint: "What should have been repaid by today (the daily amount times the days since the plan started, up to the plan total) minus total collected. It counts from the plan start, not from the dates chosen, and is not Home's Short.",
  },
  paidPct: {
    label: 'Paid % (all time)',
    hint: 'Total collected as a share of total expected for the full cycle.',
  },
  leftPct: {
    label: 'Left % (all time)',
    hint: 'The part of the full-cycle total that is still unpaid.',
  },
  portfolioPct: {
    label: 'Portfolio % (all time)',
    hint: "Total collected over total expected across all of the agent's tenants' Rent Plans, all time.",
  },
  averageTenant: {
    label: 'Average tenant (all time)',
    hint: "The average of each tenant's all-time paid %, so every tenant counts equally whatever their rent.",
  },
  periodExpected: {
    label: 'Expected this period',
    hint: "What the Rent Plans were billed for in the chosen dates, up to today. The same rule as Home's Expected.",
  },
  periodCollected: {
    label: 'Collected this period',
    hint: "Payments made in the chosen dates, each Rent Plan counted only up to its own bill; cancelled payments left out. The same rule as Home's Collected. Money above the bill is shown as paid ahead.",
  },
  periodShort: {
    label: 'Short this period',
    hint: "Expected this period minus collected this period. The same as Home's Short.",
  },
  periodCovered: {
    label: 'Covered this period',
    hint: 'Collected this period as a share of expected this period.',
  },
  periodPaidAhead: {
    label: 'Paid ahead this period',
    hint: 'Money paid on a Rent Plan above its bill for the chosen dates, or on a plan with no bill in them. Not counted as collected, the same as Home.',
  },
};

/** Where a figure on a tab comes from, written for the build log / support: figure, source, scope. */
export const TAB_FIGURE_SOURCES: { tab: string; figure: string; source: string; scope: 'all time' | 'to date' | 'period' }[] = [
  { tab: 'Top-Up Eligibility', figure: 'Expected / Expected (cycle)', source: 'get_tenant_topup_eligibility total_amount = rent_requests.total_repayment (via v_rent_plan_schedule)', scope: 'all time' },
  { tab: 'Top-Up Eligibility', figure: 'Paid', source: 'amount_repaid = rent_requests.amount_repaid (via v_rent_plan_schedule)', scope: 'all time' },
  { tab: 'Top-Up Eligibility', figure: 'Outstanding', source: 'GREATEST(total_amount - amount_repaid, 0)', scope: 'all time' },
  { tab: 'Top-Up Eligibility', figure: '% covered', source: 'amount_repaid / total_amount x 100', scope: 'all time' },
  { tab: 'Management Overview', figure: 'Expected, Paid, Remaining, Paid %, Left %', source: 'same row fields as Top-Up Eligibility (latest Rent Plan per tenant)', scope: 'all time' },
  { tab: 'Management Overview', figure: 'Arrears', source: 'GREATEST(expected_to_date - amount_repaid, 0); expected_to_date from v_tenant_ops_tenant_base = MIN(total_repayment, daily_repayment x calendar days since the plan started)', scope: 'to date' },
  { tab: 'Management Overview', figure: 'Agent Total expected / collected / Portfolio / Average tenant / Arrears', source: "sums and averages of the agent's tenants' rows above", scope: 'all time' },
  { tab: 'Management Overview', figure: 'Last month', source: 'get_agent_registration_control prev_expected / prev_collected (registration rule, last calendar month)', scope: 'period' },
  { tab: 'Management Overview', figure: 'Expected / Collected / Short this period (new)', source: 'tops_agent_period_collection, the Home rule', scope: 'period' },
  { tab: 'Tenant Communications', figure: 'Amounts in the payment message', source: 'get_tenant_payment_message_vars: total_expected, paid_to_date and remaining from v_rent_plan_schedule; next-level amount = qualifying % of the plan total minus paid_to_date', scope: 'all time' },
];
