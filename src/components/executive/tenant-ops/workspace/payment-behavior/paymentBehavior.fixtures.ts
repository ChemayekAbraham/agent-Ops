/** Test fixtures shaped exactly like the tops_payment_behaviour_* responses (figures taken from a real 30-day run, trimmed). */
import type {
  DimensionRow, PaymentBehaviorOverview, PaymentBehaviorReportData, PaymentBehaviorTiming, PaymentBehaviorTrend, PaymentBehaviorWatchlist,
} from '@/hooks/tenantOpsWorkspace/usePaymentBehavior';

export const overviewFixture: PaymentBehaviorOverview = {
  summary: {
    window: { start_day: '2026-09-07', end_day: '2026-10-06', asof: '2026-10-06', days: 30 },
    data_since: { first_self_payment_day: '2026-09-04', first_billed_day: '2026-09-10' },
    basis: 'Self = tenant_deposit_auto. Agent = agent_float.',
    payments: {
      self: { n: 137, counted_n: 129, ugx: 1757731, avg_ugx: 13626, median_ugx: 11000, tenants: 39, paid_ahead_ugx: 131200, paid_ahead_n: 8 },
      agent: { n: 4918, counted_n: 3733, ugx: 86389448, avg_ugx: 23142, median_ugx: 10000, tenants: 742, paid_ahead_ugx: 56169647, paid_ahead_n: 1324 },
      other: { n: 1, counted_n: 1, ugx: 44769, avg_ugx: 44769, median_ugx: 44769, tenants: 1, paid_ahead_ugx: 55231, paid_ahead_n: 1 },
      total_n: 5056, total_ugx: 88191948, raw_total_ugx: 144548026, self_share_pct: 2.0, agent_share_pct: 98.0, self_count_share_pct: 2.7,
    },
    paid_ahead: {
      definition: 'Money paid on a Rent Plan above what that plan was billed for the period, plus payments on plans with no bill in the period. Not counted as collected, the same as Tenant Ops Home.',
      paid_ahead_ugx: 56356078, paid_ahead_n: 1333,
      self: { paid_ahead_ugx: 131200, paid_ahead_n: 8 },
      agent: { paid_ahead_ugx: 56169647, paid_ahead_n: 1324 },
      other: { paid_ahead_ugx: 55231, paid_ahead_n: 1 },
      no_bill: { plans: 177, paid_ahead_ugx: 34210746, paid_ahead_n: 828 },
      above_bill: { plans: 142, paid_ahead_ugx: 22145332, paid_ahead_n: 505 },
    },
    tenants: {
      billed: 719, paying: 748, self_payers: 38, agent_paid: 737, self_only: 11, agent_only: 710, mixed: 27, billed_not_paying: 131,
      self_payers_pct: 5.1, self_only_pct: 1.5, agent_only_pct: 94.9, mixed_pct: 3.6,
      previous: { paying: 566, self_payers: 2, self_payers_pct: 0.4 }, self_payers_pct_change_pp: 4.7,
    },
    coverage: {
      billed_ugx: 227715911, covered_ugx: 86853389, short_ugx: 140862522, coverage_pct: 38.1,
      by_segment: [
        { segment: 'self_only', tenants: 11, billed_ugx: 1287820, covered_ugx: 824500, short_ugx: 463320, coverage_pct: 64.0 },
        { segment: 'mixed', tenants: 27, billed_ugx: 6133359, covered_ugx: 3169932, short_ugx: 2963427, coverage_pct: 51.7 },
        { segment: 'agent_only', tenants: 710, billed_ugx: 189359040, covered_ugx: 82858957, short_ugx: 106500083, coverage_pct: 43.8 },
        { segment: 'no_payment', tenants: 131, billed_ugx: 30935692, covered_ugx: 0, short_ugx: 30935692, coverage_pct: 0 },
      ],
    },
  },
  segments: {
    definition: 'Share of the tenant paid amount that came from their own payments.',
    rows: [
      { segment: 'self_reliant', tenants: 12, billed_ugx: 1441457, covered_ugx: 860500, short_ugx: 580957, coverage_pct: 59.7, self_ugx: 859500, agent_ugx: 1000, avg_paid_day_pct: 62.8 },
      { segment: 'hybrid', tenants: 13, billed_ugx: 2835009, covered_ugx: 1387604, short_ugx: 1447405, coverage_pct: 48.9, self_ugx: 665997, agent_ugx: 848638, avg_paid_day_pct: 55.2 },
      { segment: 'agent_dependent', tenants: 710, billed_ugx: 189359040, covered_ugx: 82858957, short_ugx: 106500083, coverage_pct: 43.8, self_ugx: 0, agent_ugx: 137980735, avg_paid_day_pct: 46.9 },
    ],
  },
  shift: {
    definition: 'Each tenant now versus the previous window.',
    previous_window: { start_day: '2026-08-08', end_day: '2026-09-06' },
    counts: { moving_to_agents: 1, moving_to_self: 1, new_self_adopter: 1 },
    rows: [
      { shift: 'moving_to_agents', tenant_id: 't-1', tenant_name: 'Sandra Diana Amolo', tenant_phone: '+256754081966', agent_id: 'a-1', previous_self_share_pct: 4.6, self_share_pct: 0, self_ugx: 0, agent_ugx: 245000 },
      { shift: 'moving_to_self', tenant_id: 't-2', tenant_name: 'Wafula Stephen', tenant_phone: '+256781514599', agent_id: 'a-2', previous_self_share_pct: 0, self_share_pct: 50, self_ugx: 119600, agent_ugx: 119600 },
      { shift: 'new_self_adopter', tenant_id: 't-3', tenant_name: 'Bwire Brian Elijah', tenant_phone: '+256752353883', agent_id: 'a-3', previous_self_share_pct: 0, self_share_pct: 17.4, self_ugx: 73600, agent_ugx: 349600 },
    ],
  },
  comparison: {
    definition: 'Average coverage of the bill. Observational.',
    self_payers: { tenants: 36, coverage_pct: 58.1, paid_day_pct: 54.6 },
    agent_only: { tenants: 552, coverage_pct: 54.6, paid_day_pct: 46.9 },
    difference_pp: 3.5, margin_pp_95: 9.4, enough_data: true,
  },
  correlations: {
    definition: 'Pearson correlation across tenants.',
    tenants_with_self_pay: 38, enough_data: true,
    pairs: [
      { key: 'self_share_vs_coverage', label: 'Self-pay share vs % of bill covered', r: 0.02, n: 588 },
      { key: 'self_share_vs_paid_days', label: 'Self-pay share vs share of billed days paid', r: 0.08, n: 588 },
      { key: 'self_share_vs_rent', label: 'Self-pay share vs rent level', r: -0.04, n: 748 },
      { key: 'self_share_vs_plan_age', label: 'Self-pay share vs Rent Plan age', r: -0.19, n: 748 },
    ],
  },
};

export const trendFixture: PaymentBehaviorTrend = {
  bucket: 'day',
  window: { start_day: '2026-09-07', end_day: '2026-10-06', asof: '2026-10-06' },
  points: [
    { bucket_start: '2026-10-04', bucket_end: '2026-10-04', partial: false, self_ugx: 40000, agent_ugx: 3500000, other_ugx: 0, self_n: 4, agent_n: 150, self_tenants: 4, agent_tenants: 140, paying_tenants: 144, self_share_pct: 1.1, self_tenant_pct: 2.8 },
    { bucket_start: '2026-10-05', bucket_end: '2026-10-05', partial: false, self_ugx: 60000, agent_ugx: 3100000, other_ugx: 0, self_n: 6, agent_n: 140, self_tenants: 6, agent_tenants: 130, paying_tenants: 135, self_share_pct: 1.9, self_tenant_pct: 4.4 },
    { bucket_start: '2026-10-06', bucket_end: '2026-10-06', partial: true, self_ugx: 14000, agent_ugx: 32200, other_ugx: 0, self_n: 1, agent_n: 2, self_tenants: 1, agent_tenants: 2, paying_tenants: 3, self_share_pct: 30.3, self_tenant_pct: 33.3 },
  ],
  projection: {
    available: true, estimate: true, method: 'Straight-line fit of the weekly self-pay share.', weeks_used: 5, first_week: '2026-08-31', last_week: '2026-09-28',
    slope_pp_per_week: 1.12, r_squared: 0.8, confidence: 'low',
    projected: [
      { week_start: '2026-10-05', self_share_pct: 4.9, self_ugx: 900660 },
      { week_start: '2026-10-12', self_share_pct: 6.0, self_ugx: 1101438 },
      { week_start: '2026-10-19', self_share_pct: 7.1, self_ugx: 1302216 },
      { week_start: '2026-10-26', self_share_pct: 8.2, self_ugx: 1502994 },
    ],
  },
};

const buckets = (a: number[], u: number[]) =>
  (['ahead', 'same_day', 'late_1_3', 'late_4_7', 'late_8_14', 'late_15_plus'] as const).map((key, i) => ({ key, settled_ugx: u[i], settled_pct: a[i], settled_days: 10 + i, receipts: 5 + i }));

export const timingFixture: PaymentBehaviorTiming = {
  on_time: {
    definition: 'On time = on or before the billed day.',
    settlement_detail_since: '2026-09-10', receipts_in_window: 4957, receipts_with_detail: 3265, detail_coverage_pct: 65.9,
    by_channel: {
      self: { settled_ugx: 1537216, settled_days: 217, receipts: 123, on_time_ugx: 941730, on_time_pct: 61.3, late_pct: 38.7, on_time_days_pct: 57.1, avg_days_late_when_late: 3.6, median_days_vs_due: 0, buckets: buckets([21.7, 39.6, 29.4, 2.6, 5.6, 1.1], [333487, 608243, 452483, 40558, 85445, 17000]) },
      agent: { settled_ugx: 75716058, settled_days: 6446, receipts: 3142, on_time_ugx: 41463620, on_time_pct: 54.8, late_pct: 45.2, on_time_days_pct: 54.4, avg_days_late_when_late: 4.7, median_days_vs_due: 0, buckets: buckets([45.2, 9.5, 23.2, 13.6, 6.6, 1.7], [34245876, 7217744, 17571216, 10331737, 5032367, 1317118]) },
    },
  },
  frequency: {
    definition: 'Share of billed days on which the Rent Plan received a payment.',
    by_segment: [
      { segment: 'self_only', plans: 12, paid_day_pct: 63.7, consistent: 1, patchy: 10, sporadic: 1 },
      { segment: 'agent_only', plans: 567, paid_day_pct: 46.9, consistent: 120, patchy: 164, sporadic: 283 },
    ],
    by_channel: {
      self: { tenants: 38, avg_payments_per_tenant: 3.6, avg_pay_days_per_tenant: 3.4, gaps_measured: 90, avg_days_between_payments: 1.8, median_days_between_payments: 1 },
      agent: { tenants: 737, avg_payments_per_tenant: 6.5, avg_pay_days_per_tenant: 5.6, gaps_measured: 3399, avg_days_between_payments: 2.7, median_days_between_payments: 2 },
    },
  },
  amounts: {
    self: { n: 135, avg_ugx: 12911, p10: 5000, p25: 8500, median_ugx: 11000, p75: 14000, p90: 22000, max_ugx: 36800 },
    agent: { n: 4822, avg_ugx: 29170, p10: 4000, p25: 7000, median_ugx: 10000, p75: 20000, p90: 63059, max_ugx: 700000 },
  },
  clock: {
    median_hour: { self: 19, agent: 13 },
    hours: { self: Array.from({ length: 24 }, (_, h) => (h === 21 ? 25 : 2)), agent: Array.from({ length: 24 }, (_, h) => (h === 9 ? 629 : 100)) },
    weekdays: { self: [35, 12, 14, 13, 16, 24, 21], agent: [757, 700, 1022, 641, 678, 577, 447] },
  },
};

const dim = (key: string, label: string, over: Partial<DimensionRow> = {}): DimensionRow => ({
  key, label, plans: 50, billed_tenants: 31, paying_tenants: 40, self_payers: 4, self_payers_pct: 10, self_only: 1, agent_only: 36, mixed: 3,
  self_ugx: 100000, agent_ugx: 7000000, self_share_pct: 1.4, billed_ugx: 8000000, covered_ugx: 5000000, short_ugx: 3000000, coverage_pct: 62.5,
  self_payers_coverage_pct: 66, agent_only_coverage_pct: 61, ...over,
});

export const byDimensionFixture: PaymentBehaviorReportData['byDimension'] = {
  agent: [dim('agent-1', 'SHAFEEQ SSENABULYA'), dim('agent-2', 'Mata Pius', { paying_tenants: 35, self_payers: 0, self_payers_pct: 0 })],
  region: [dim('Central', 'Central', { paying_tenants: 550, self_payers: 21 }), dim('Western', 'Western', { paying_tenants: 90, self_payers: 3 })],
  district: [dim('Wakiso', 'Wakiso', { paying_tenants: 355, self_payers: 15 })],
  rent_band: [dim('a_lt_150k', 'Under UGX 150,000'), dim('b_150_300k', 'UGX 150,000 - 300,000')],
  cadence: [dim('daily', 'Daily'), dim('weekly', 'Weekly')],
  cohort: [dim('2026-09', 'Sep 2026')],
};

export const watchlistFixture: PaymentBehaviorWatchlist = {
  asof: '2026-10-06',
  definition: 'Five rule-based warning signs.',
  summary: { plans_scored: 569, score_0: 92, score_1: 173, score_2: 287, score_3_plus: 17, by_flag: { silent: 331, slipping: 41, behind: 425, moving_to_agent: 0, refused_attempt: 1 } },
  total: 304,
  rows: [
    {
      rent_request_id: 'rr-1', plan_code: '408d043d', tenant_id: 't-9', tenant_name: 'Ntege Dorothy', tenant_phone: '+256730350586', agent_id: 'a-9', agent_name: 'Okwakol Micheal', agent_phone: '+256793487307',
      region: 'Central', district: 'Mpigi', cadence: 'daily', rent_ugx: 300000, score: 3, flags: ['silent', 'slipping', 'behind'], days_since_payment: 13, last_paid_day: '2026-09-23',
      median_gap_days: null, days_behind: 21, billed_7d_ugx: 97769, paid_7d_ugx: 0, billed_prev_7d_ugx: 97759, paid_prev_7d_ugx: 80700, self_paid_28d_ugx: 0, agent_paid_28d_ugx: 80700,
    },
  ],
  backtest: {
    estimate: true, cutoff_day: '2026-09-29', outcome_window: { start_day: '2026-09-30', end_day: '2026-10-06' },
    missed_definition: 'Billed in the 7 days after the cutoff and covered less than half of that bill.',
    plans: 444, missed: 372, missed_pct: 83.8, no_signs_plans: 89, no_signs_missed_pct: 61.8, two_plus_signs_plans: 236, two_plus_signs_missed_pct: 92.4, enough_data: true,
    by_score: [{ score: '0', plans: 89, missed: 55, missed_pct: 61.8 }, { score: '3+', plans: 23, missed: 21, missed_pct: 91.3 }],
    by_flag: [
      { flag: 'behind', flagged_plans: 282, flagged_missed_pct: 91.1, unflagged_plans: 162, unflagged_missed_pct: 71 },
      { flag: 'silent', flagged_plans: 230, flagged_missed_pct: 95.2, unflagged_plans: 214, unflagged_missed_pct: 71.5 },
      { flag: 'slipping', flagged_plans: 100, flagged_missed_pct: 79, unflagged_plans: 344, unflagged_missed_pct: 85.2 },
    ],
  },
};

export const reportDataFixture: PaymentBehaviorReportData = {
  overview: overviewFixture, trend: trendFixture, timing: timingFixture, byDimension: byDimensionFixture, watchlist: watchlistFixture,
};
