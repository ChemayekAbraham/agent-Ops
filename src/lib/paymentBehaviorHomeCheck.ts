/**
 * Payment Behavior vs Tenant Ops Home: the built-in "matches Home" check.
 *
 * Home (`ops_tenant_ops_home_range`, read through `useTenantOpsHomeRange`) is the agreed reference for
 * Expected, Collected, Short and % covered. The Payment Behavior tab computes the same four things on
 * its own (billed, counted, short, coverage) from the `tops_payment_behaviour_*_v2` reports. This pure
 * function lines the two up so any drift shows on screen and in the PDF instead of going unnoticed.
 *
 * Home's own display rules are mirrored exactly (see TenantOpsHome.tsx): short = expected minus
 * collected, never below zero; % covered = collected over expected, rounded to a whole number and
 * capped at 100. Nothing here is a business figure; it is only the comparison.
 */

export const HOME_CHECK_TOLERANCE_UGX = 1;
/** Home shows a whole-number %, the tab one decimal; a gap above half a point cannot be rounding. */
export const HOME_CHECK_TOLERANCE_PCT = 0.5;

export interface HomeReference { expected: number; collected: number }

/** The slice of a Payment Behavior summary the check needs. */
export interface TabSummaryForCheck {
  payments: { self: { ugx: number }; agent: { ugx: number }; other: { ugx: number } };
  coverage: { billed_ugx: number; short_ugx: number; coverage_pct: number | null };
}

export interface HomeCheckFigures { expected: number; collected: number; short: number; coveragePct: number }

export interface HomeCheck {
  status: 'match' | 'differ';
  /** Home's Expected, Collected, Short and % covered. */
  home: HomeCheckFigures;
  /** The tab's billed (as expected), counted (self + agent + other), short and % covered. */
  tab: HomeCheckFigures;
  /** Absolute differences, same order as the figures. */
  diff: HomeCheckFigures;
  /** The largest UGX difference among expected/billed, collected/counted and short. */
  maxUgxDiff: number;
}

export function homeFigures(home: HomeReference): HomeCheckFigures {
  const expected = Number(home.expected) || 0;
  const collected = Number(home.collected) || 0;
  return {
    expected,
    collected,
    short: Math.max(0, expected - collected),
    coveragePct: expected > 0 ? Math.min(100, Math.round((collected / expected) * 100)) : 0,
  };
}

export function tabFigures(summary: TabSummaryForCheck): HomeCheckFigures {
  return {
    expected: Number(summary.coverage.billed_ugx) || 0,
    collected: (Number(summary.payments.self.ugx) || 0) + (Number(summary.payments.agent.ugx) || 0) + (Number(summary.payments.other?.ugx) || 0),
    short: Number(summary.coverage.short_ugx) || 0,
    coveragePct: Number(summary.coverage.coverage_pct) || 0,
  };
}

export function compareWithHome(home: HomeReference, summary: TabSummaryForCheck): HomeCheck {
  const h = homeFigures(home);
  const t = tabFigures(summary);
  const diff: HomeCheckFigures = {
    expected: Math.abs(h.expected - t.expected),
    collected: Math.abs(h.collected - t.collected),
    short: Math.abs(h.short - t.short),
    coveragePct: Math.abs(h.coveragePct - t.coveragePct),
  };
  const maxUgxDiff = Math.max(diff.expected, diff.collected, diff.short);
  const differs = maxUgxDiff > HOME_CHECK_TOLERANCE_UGX || diff.coveragePct > HOME_CHECK_TOLERANCE_PCT;
  return { status: differs ? 'differ' : 'match', home: h, tab: t, diff, maxUgxDiff };
}

/** The warning shown (and printed) when the tab and Home disagree. `formatMoney` is formatUGX. */
export function homeDifferenceMessage(check: HomeCheck, formatMoney: (n: number) => string): string {
  if (check.maxUgxDiff > HOME_CHECK_TOLERANCE_UGX) {
    return `These figures differ from Tenant Ops Home by ${formatMoney(check.maxUgxDiff)}. Home is the reference.`;
  }
  const pts = Math.round(check.diff.coveragePct * 10) / 10;
  return `These figures differ from Tenant Ops Home by ${pts} percentage points on % covered. Home is the reference.`;
}

export const HOME_CHECK_MATCH_TEXT = 'Matches Home';
export const HOME_CHECK_FILTERED_TEXT = "Filtered view: Home figures cover all tenants and can't be compared.";
export const HOME_CHECK_PLACE_FILTER_TEXT =
  'Region and district filters leave out tenants with no recorded location, so their totals can be lower than the unfiltered view.';
