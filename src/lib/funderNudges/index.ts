import { formatDynamic } from '@/lib/currencyFormat';
import {
  canShowNudgeWith,
  kampalaClock,
  pickTemplate,
  recordNudgeWith,
  renderNudge,
  tidyName,
  type NudgeHistory,
  type NudgePacing,
  type NudgeTemplate,
  type NudgeValues,
  type RenderedNudge,
} from '@/lib/nudges/engine';
import nudgeFile from './nudges.json';

/**
 * Funder/partner dashboard nudges: warm, personal toasts about the Supporter's
 * own portfolios and Returns ("Payday 💸 UGX 675,000 just landed in your
 * wallet").
 *
 * Copy lives in `nudges.json` (no buttons). Numbers come from
 * `get_funder_nudge_stats()`, which reads only the signed-in partner's own
 * portfolios, ledger rows, houses, wallet and invites; see
 * supabase/migrations/20261021200000_funder_nudge_stats.sql. Nothing here
 * carries tenant, agent, landlord or other-partner data.
 */

/** Numbers for one partner, as returned by the stats RPC. null = unknown / not applicable. */
export interface FunderNudgeStats {
  first_name: string | null;
  active_portfolios: number;
  total_principal: number;
  /** Soonest scheduled Returns date (YYYY-MM-DD) on an active non-compounding portfolio. */
  next_payout_date: string | null;
  days_to_next_payout: number | null;
  /** Latest Returns credited to the partner's own wallet. */
  returns_last_amount: number | null;
  hours_since_last_returns: number | null;
  total_returns_received: number;
  /** 1 when total Returns crossed a round milestone in the last 7 days. */
  returns_milestone_reached: number;
  returns_this_month: number;
  /** Soonest-maturing active portfolio. */
  portfolio_label: string | null;
  maturity_date: string | null;
  days_to_maturity: number | null;
  /** Active compounding portfolio with the most reinvested Returns. */
  is_compounding: number;
  growth_portfolio_label: string | null;
  start_amount: number | null;
  current_value: number | null;
  growth_amount: number | null;
  /** Homes held for the partner's own portfolios (0 when none on file). */
  houses_supported: number;
  /** No per-partner source yet: always null, so its nudge never fires. */
  landlord_rent_paid: number | null;
  days_as_supporter: number | null;
  years_as_supporter: number | null;
  is_anniversary_today: number | null;
  wallet_balance: number | null;
  wallet_idle_days: number | null;
  referrals_30d: number;
}

export type FunderNudgeTemplate = NudgeTemplate<never>;
export type RenderedFunderNudge = RenderedNudge<never>;

export const FUNDER_NUDGES: FunderNudgeTemplate[] = (nudgeFile as { nudges: FunderNudgeTemplate[] }).nudges;

const MONEY_KEYS: ReadonlySet<string> = new Set([
  'total_principal',
  'returns_last_amount',
  'total_returns_received',
  'returns_this_month',
  'start_amount',
  'current_value',
  'growth_amount',
  'landlord_rent_paid',
  'wallet_balance',
]);

const DATE_KEYS: ReadonlySet<string> = new Set(['next_payout_date', 'maturity_date']);

/** Raw values every rule and placeholder can reference: the stats plus derived fields. */
export function buildFunderNudgeValues(stats: FunderNudgeStats, now: Date = new Date()): NudgeValues {
  const years = stats.years_as_supporter;
  return {
    ...stats,
    first_name: tidyName(stats.first_name?.trim().split(/\s+/)[0]),
    ...kampalaClock(now),
    years_as_supporter_label: years != null && years >= 1 ? `${years} ${years === 1 ? 'year' : 'years'}` : null,
  };
}

/** Every key a funder nudge may use in `when` or a {placeholder}. */
export const FUNDER_NUDGE_VALUE_KEYS: ReadonlySet<string> = new Set(
  Object.keys(buildFunderNudgeValues({
    first_name: null, active_portfolios: 0, total_principal: 0, next_payout_date: null,
    days_to_next_payout: null, returns_last_amount: null, hours_since_last_returns: null,
    total_returns_received: 0, returns_milestone_reached: 0, returns_this_month: 0,
    portfolio_label: null, maturity_date: null, days_to_maturity: null, is_compounding: 0,
    growth_portfolio_label: null, start_amount: null, current_value: null, growth_amount: null,
    houses_supported: 0, landlord_rent_paid: null, days_as_supporter: null, years_as_supporter: null,
    is_anniversary_today: null, wallet_balance: null, wallet_idle_days: null, referrals_30d: 0,
  })),
);

/** Gentler than agents: at most one a day, 07:00-21:00 Kampala. */
export const FUNDER_NUDGE_PACING: NudgePacing = {
  cooldownMs: 20 * 60 * 60 * 1000,
  hours: { from: 7, to: 21 },
  recentLimit: 8,
};

export function canShowFunderNudge(history: NudgeHistory, now: Date = new Date()): boolean {
  return canShowNudgeWith(FUNDER_NUDGE_PACING, history, now);
}

export function recordFunderNudge(history: NudgeHistory, id: string, now: Date = new Date()): NudgeHistory {
  return recordNudgeWith(FUNDER_NUDGE_PACING, history, id, now);
}

export interface FunderPickOptions {
  now?: Date;
  exclude?: Iterable<string>;
  random?: () => number;
  formatMoney?: (amount: number) => string;
  templates?: FunderNudgeTemplate[];
}

/** Weighted-random pick among the nudges that fit right now; null when none fit. */
export function pickFunderNudge(stats: FunderNudgeStats, opts: FunderPickOptions = {}): RenderedFunderNudge | null {
  const values = buildFunderNudgeValues(stats, opts.now);
  const chosen = pickTemplate(opts.templates ?? FUNDER_NUDGES, values, opts);
  if (!chosen) return null;
  return renderNudge(chosen, values, {
    moneyKeys: MONEY_KEYS,
    dateKeys: DATE_KEYS,
    formatMoney: opts.formatMoney ?? formatDynamic,
  });
}
