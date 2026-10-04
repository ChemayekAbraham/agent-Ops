import { describe, it, expect } from 'vitest';
import {
  computeVouchBreakdown,
  VOUCH_CAPS,
  VOUCH_MULTIPLIERS,
  type VouchInputs,
} from '../computeVouchBreakdown';

const zeroScores = {
  wallet: 0,
  network: 0,
  agent_performance: 0,
  verification: 0,
  behavior: 0,
};

const baseInput: VouchInputs = {
  portfolio_value_ugx: 0,
  angel_shares_ugx: 0,
  scores: { ...zeroScores },
  agent_term_ugx: 0,
  total_repaid_ugx: 0,
  monthly_cashflow_ugx: 0,
};

describe('computeVouchBreakdown — multipliers', () => {
  it('vouches portfolio 1× as the primary component', () => {
    expect(VOUCH_MULTIPLIERS.portfolio).toBe(1);
    const out = computeVouchBreakdown({ ...baseInput, portfolio_value_ugx: 1_000_000 });
    expect(out.portfolio_component_ugx).toBe(1_000_000);
    expect(out.total_ugx).toBe(1_000_000);
  });

  it('vouches Welile shares 2× on top of portfolio', () => {
    expect(VOUCH_MULTIPLIERS.shares).toBe(2);
    const out = computeVouchBreakdown({
      ...baseInput,
      portfolio_value_ugx: 1_000_000,
      angel_shares_ugx: 400_000,
    });
    expect(out.shares_component_ugx).toBe(800_000);
    expect(out.angel_shares_ugx).toBe(400_000);
    // portfolio (1×1m) + shares (2×400k) + no boosters
    expect(out.total_ugx).toBe(1_800_000);
  });

  it('coerces negative / NaN inputs to 0 (never inflates vouch)', () => {
    const out = computeVouchBreakdown({
      ...baseInput,
      portfolio_value_ugx: -500_000,
      angel_shares_ugx: Number.NaN,
      total_repaid_ugx: -1,
      monthly_cashflow_ugx: Number.NEGATIVE_INFINITY,
    });
    expect(out.portfolio_component_ugx).toBe(0);
    expect(out.shares_component_ugx).toBe(0);
    expect(out.booster_breakdown.payment_history).toBe(0);
    expect(out.total_ugx).toBe(0);
  });
});

describe('computeVouchBreakdown — booster caps', () => {
  it('caps wallet activity at 200,000 (score × 20,000)', () => {
    const under = computeVouchBreakdown({
      ...baseInput,
      scores: { ...zeroScores, wallet: 5 },
    });
    expect(under.booster_breakdown.wallet_activity).toBe(100_000);
    const over = computeVouchBreakdown({
      ...baseInput,
      scores: { ...zeroScores, wallet: 10 },
    });
    expect(over.booster_breakdown.wallet_activity).toBe(VOUCH_CAPS.wallet_activity);
  });

  it('caps network contribution at 150,000 (score × 10,000)', () => {
    const out = computeVouchBreakdown({
      ...baseInput,
      scores: { ...zeroScores, network: 15 },
    });
    expect(out.booster_breakdown.network_contribution).toBe(VOUCH_CAPS.network_contribution);
  });

  it('caps agent performance score at 500,000 and then adds agent term on top', () => {
    const out = computeVouchBreakdown({
      ...baseInput,
      scores: { ...zeroScores, agent_performance: 10 },
      agent_term_ugx: 300_000,
    });
    // 10 × 25,000 = 250,000 (below cap) + 300,000 agent term
    expect(out.booster_breakdown.agent_performance).toBe(250_000 + 300_000);

    const capped = computeVouchBreakdown({
      ...baseInput,
      scores: { ...zeroScores, agent_performance: 50 }, // synthetic over-scale
      agent_term_ugx: 100_000,
    });
    expect(capped.booster_breakdown.agent_performance).toBe(
      VOUCH_CAPS.agent_performance + 100_000,
    );
  });

  it('caps verification at 100,000 and behaviour at 75,000', () => {
    const out = computeVouchBreakdown({
      ...baseInput,
      scores: { ...zeroScores, verification: 10, behavior: 5 },
    });
    expect(out.booster_breakdown.verification).toBe(VOUCH_CAPS.verification);
    expect(out.booster_breakdown.movement_behavior).toBe(VOUCH_CAPS.movement_behavior);
  });

  it('payment history = 0.30 × total repaid + 0.25 × monthly cash flow', () => {
    const out = computeVouchBreakdown({
      ...baseInput,
      total_repaid_ugx: 1_000_000,
      monthly_cashflow_ugx: 400_000,
    });
    expect(out.booster_breakdown.payment_history).toBe(300_000 + 100_000);
  });
});

describe('computeVouchBreakdown — end-to-end additive sum', () => {
  it('totals portfolio + 2× shares + every booster, primary components first', () => {
    const out = computeVouchBreakdown({
      portfolio_value_ugx: 1_000_000,
      angel_shares_ugx: 500_000,
      scores: {
        wallet: 10,
        network: 15,
        agent_performance: 10,
        verification: 10,
        behavior: 5,
      },
      agent_term_ugx: 200_000,
      total_repaid_ugx: 600_000,
      monthly_cashflow_ugx: 400_000,
    });

    expect(out.portfolio_component_ugx).toBe(1_000_000);
    expect(out.shares_component_ugx).toBe(1_000_000);

    const b = out.booster_breakdown;
    expect(b.wallet_activity).toBe(200_000);
    expect(b.network_contribution).toBe(150_000);
    expect(b.agent_performance).toBe(250_000 + 200_000);
    expect(b.verification).toBe(100_000);
    expect(b.movement_behavior).toBe(75_000);
    expect(b.payment_history).toBe(180_000 + 100_000);

    const expectedBoosters =
      b.wallet_activity +
      b.network_contribution +
      b.agent_performance +
      b.verification +
      b.movement_behavior +
      b.payment_history;
    expect(out.boosters_ugx).toBe(expectedBoosters);
    expect(out.total_ugx).toBe(
      out.portfolio_component_ugx + out.shares_component_ugx + expectedBoosters,
    );
  });
});