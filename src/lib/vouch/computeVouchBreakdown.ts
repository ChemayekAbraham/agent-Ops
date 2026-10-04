/**
 * Pure TS mirror of the vouch computation inside
 * `public.get_user_trust_profile` (Postgres RPC).
 *
 * The DB is the source of truth for production, but this helper lets us
 * (a) render deterministic UI without another round-trip, and
 * (b) lock the multipliers and caps behind unit tests so silent regressions
 *     to portfolio 1×, shares 2×, or any booster cap fail loudly in CI.
 *
 * If you change a formula here, mirror it in the SQL — and vice versa.
 */

export interface VouchInputs {
  portfolio_value_ugx: number;
  angel_shares_ugx: number;
  scores: {
    wallet: number; // 0..10
    network: number; // 0..15
    agent_performance: number; // 0..10
    verification: number; // 0..10
    behavior: number; // 0..5
  };
  agent_term_ugx: number;
  total_repaid_ugx: number;
  monthly_cashflow_ugx: number;
}

export interface VouchBreakdown {
  total_ugx: number;
  portfolio_component_ugx: number;
  angel_shares_ugx: number;
  shares_component_ugx: number;
  boosters_ugx: number;
  booster_breakdown: {
    wallet_activity: number;
    network_contribution: number;
    agent_performance: number;
    verification: number;
    movement_behavior: number;
    payment_history: number;
  };
}

export const VOUCH_MULTIPLIERS = {
  portfolio: 1,
  shares: 2,
} as const;

export const VOUCH_CAPS = {
  wallet_activity: 200_000,
  network_contribution: 150_000,
  agent_performance: 500_000,
  verification: 100_000,
  movement_behavior: 75_000,
} as const;

const nn = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

export function computeVouchBreakdown(input: VouchInputs): VouchBreakdown {
  const portfolio = nn(input.portfolio_value_ugx);
  const shares = nn(input.angel_shares_ugx);
  const s = input.scores;

  const portfolio_component_ugx = Math.round(portfolio * VOUCH_MULTIPLIERS.portfolio);
  const shares_component_ugx = Math.round(shares * VOUCH_MULTIPLIERS.shares);

  const wallet_activity = Math.min(VOUCH_CAPS.wallet_activity, Math.round(nn(s.wallet) * 20_000));
  const network_contribution = Math.min(
    VOUCH_CAPS.network_contribution,
    Math.round(nn(s.network) * 10_000),
  );
  const agent_performance =
    Math.min(VOUCH_CAPS.agent_performance, Math.round(nn(s.agent_performance) * 25_000)) +
    Math.round(nn(input.agent_term_ugx));
  const verification = Math.min(
    VOUCH_CAPS.verification,
    Math.round(nn(s.verification) * 10_000),
  );
  const movement_behavior = Math.min(
    VOUCH_CAPS.movement_behavior,
    Math.round(nn(s.behavior) * 15_000),
  );
  const payment_history = Math.round(
    0.3 * nn(input.total_repaid_ugx) + 0.25 * nn(input.monthly_cashflow_ugx),
  );

  const boosters_ugx =
    wallet_activity +
    network_contribution +
    agent_performance +
    verification +
    movement_behavior +
    payment_history;

  return {
    total_ugx: portfolio_component_ugx + shares_component_ugx + boosters_ugx,
    portfolio_component_ugx,
    angel_shares_ugx: shares,
    shares_component_ugx,
    boosters_ugx,
    booster_breakdown: {
      wallet_activity,
      network_contribution,
      agent_performance,
      verification,
      movement_behavior,
      payment_history,
    },
  };
}