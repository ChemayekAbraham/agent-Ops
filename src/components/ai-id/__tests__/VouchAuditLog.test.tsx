import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VouchAuditLog } from '../VouchAuditLog';
import { computeVouchBreakdown } from '@/lib/vouch/computeVouchBreakdown';
import type { TrustProfile } from '@/hooks/useTrustProfile';
import { formatUGX } from '@/lib/rentCalculations';

function makeProfile(): TrustProfile {
  const vb = computeVouchBreakdown({
    portfolio_value_ugx: 1_000_000,
    angel_shares_ugx: 500_000,
    scores: { wallet: 10, network: 15, agent_performance: 10, verification: 10, behavior: 5 },
    agent_term_ugx: 200_000,
    total_repaid_ugx: 600_000,
    monthly_cashflow_ugx: 400_000,
  });

  return {
    ai_id: 'WLE-TEST-0001',
    user_id: 'u1',
    identity: {
      full_name: 'Test User', phone: null, email: null, national_id: null,
      national_id_present: false, avatar_url: null, verified: true,
      member_since: '2024-01-01', roles: ['user'], primary_role: 'user',
    },
    trust: {
      score: 700, tier: 'A', data_points: 10, borrowing_limit_ugx: vb.total_ugx,
      vouch_breakdown: vb,
      breakdown: {
        payment: 0, wallet: 10, network: 15, verification: 10,
        behavior: 5, landlord: 0, agent_performance: 10,
      },
      weights: {
        payment: 0, wallet: 0, network: 0, verification: 0,
        behavior: 0, landlord: 0, agent_performance: 0,
      },
    },
    agent_performance: {
      qualifying_tenants: 0, healthy_tenants: 0, healthy_ratio: 0,
      collection_rate: 0, monthly_book: 0, agent_term: 200_000, top_performing: false,
    },
    supporter_activity: {
      is_supporter: true, portfolio_value: 1_000_000, active_portfolios: 1,
      total_roi_earned: 0, roi_paid_30d: 0, roi_paid_180d: 0, roi_monthly_avg: 0,
      angel_shares_ugx: 500_000,
    },
    payment_history: {
      total_rent_plans: 0, total_repaid: 600_000, total_owing: 0,
      on_time_count: 0, late_count: 0, on_time_rate: 0,
    },
    wallet_activity: { balance: 0, total_received_180d: 0, total_sent_180d: 0, transaction_count_180d: 0 },
    cash_flow_capacity: { daily_avg: 0, weekly_avg: 0, monthly_avg: 400_000, window_days: 30 },
    network: {
      referrals: 0, sub_agents: 0, tenants_onboarded: 0, portfolio_value: 1_000_000,
    },
    behavior: { visits_total_60d: 0, always_share_location: false },
    landlord_activity: { total_listings: 0, verified_listings: 0, guaranteed_rent: false },
    permissions: { is_self: true, is_staff_view: false, can_see_pii: true },
    generated_at: new Date('2026-07-20T00:00:00Z').toISOString(),
  };
}

describe('VouchAuditLog', () => {
  it('returns null when the RPC did not include vouch_breakdown', () => {
    const p = makeProfile();
    p.trust.vouch_breakdown = undefined;
    const { container } = render(<VouchAuditLog profile={p} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders every vouch component with the exact UGX from computeVouchBreakdown', () => {
    const p = makeProfile();
    const vb = p.trust.vouch_breakdown!;
    render(<VouchAuditLog profile={p} />);
    fireEvent.click(screen.getByRole('button', { name: /vouch audit log/i }));

    // Primary components must be labelled with the "Primary" badge (uppercase-only badge text).
    expect(screen.getAllByText('Primary', { selector: 'span' }).length).toBe(2);

    // Each computed value must appear in the rendered log.
    // Normalise whitespace (formatUGX may emit non-breaking spaces) before matching.
    const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();
    const bodyText = normalise(document.body.textContent ?? '');
    const rendered = [
      vb.portfolio_component_ugx,
      vb.shares_component_ugx,
      vb.booster_breakdown.wallet_activity,
      vb.booster_breakdown.network_contribution,
      vb.booster_breakdown.agent_performance,
      vb.booster_breakdown.verification,
      vb.booster_breakdown.movement_behavior,
      vb.booster_breakdown.payment_history,
      vb.total_ugx,
    ];
    for (const v of rendered) {
      const needle = normalise(formatUGX(v));
      expect(bodyText).toContain(needle);
    }
  });
});