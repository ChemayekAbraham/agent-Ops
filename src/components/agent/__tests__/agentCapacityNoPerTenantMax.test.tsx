/**
 * E134 (COO 17 Nov): no rent ceiling per tenant on the agent dashboard. The capacity cards show
 * the agent's total exposure and headroom (get_agent_rent_request_capacity) and say "blocked"
 * only when the database says so.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  exposure: {} as Record<string, unknown>,
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'agent-1', email: 'a@x.test', user_metadata: { full_name: 'Agent One' } } }) }));
vi.mock('@/lib/haptics', () => ({ hapticTap: () => {}, hapticSelection: () => {}, hapticSuccess: () => {} }));
vi.mock('html-to-image', () => ({ toPng: vi.fn(async () => 'data:image/png;base64,') }));

// A capacity snapshot from before E134 that still carries the old tier figures.
const CAP = {
  used: 42_000_000, active_count: 12, active_tenant_count: 12, paying_tenants_last_week: 9, unfunded_tenant_count: 0,
  response_rate: 0.35, responding_tenant_days: 29, expected_tenant_days: 84, paid_last_week: 1_400_000,
  paid_today: 150_000, paid_yesterday: 120_000, yesterday_response_pct: 0.3, today_response_pct: 0.35, effective_daily_pct: 0.35,
  daily_status: 'good', performance_pct: 0.6, daily_rating: 'Fair', tenants_due: 10, tenants_paid_today: 6, tenants_paid_yesterday: 5,
  coverage_today: 0.6, coverage_yesterday: 0.5, effective_coverage: 0.6, eligibility_unavailable: false, posting_exempt_today: false,
  can_post_rent_today: true, good_days_last_week: 1, unlimited_posting: false, is_new_agent: false, expected_daily: 400_000,
  daily_gate_count: 12, weekly_plan_count: 0, weekly_lapsed_count: 0, weekly_expected_week: 0, repayment_rate: 0.35,
  expected_weekly: 2_800_000, headroom: 58_000_000, pct: 42, tier: 'Bad',
  per_tenant_max: 1_000_000, // the old ceiling: must never show
};
vi.mock('@/hooks/useAgentCapacityMap', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useAgentCapacityMap')>()),
  useAgentCapacityMap: () => ({ data: new Map([['agent-1', CAP]]), isLoading: false }),
}));

import { AgentRentCapacitySelfCard } from '@/components/agent/AgentRentCapacitySelfCard';
import { AgentCapacityBreakdownPanel } from '@/components/agent/AgentCapacityBreakdownPanel';
import { AgentCapacityShareInline } from '@/components/agent/AgentCapacityShareInline';
import { parseAgentExposure } from '@/hooks/useAgentExposure';
import { classifyAgent } from '@/hooks/useAgentCapacityMap';

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exposure = {
    agent_exposure: 42_000_000, agent_cap: 100_000_000, agent_headroom: 58_000_000, blocked: false, reason: null,
    // E134 live: tenant_max = allowed_max = headroom. Never shown as a per-tenant limit.
    tenant_max: 58_000_000, allowed_max: 58_000_000,
  };
  mocks.rpc.mockImplementation(async (fn: string) => (
    fn === 'get_agent_rent_request_capacity' ? { data: mocks.exposure, error: null } : { data: null, error: null }
  ));
});

const wrap = (ui: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>,
);
const renderAll = () => wrap(
  <>
    <AgentRentCapacitySelfCard />
    <AgentCapacityBreakdownPanel />
    <AgentCapacityShareInline />
  </>,
);
const PER_TENANT = /per[\s-]?tenant|\/\s*tenant|Remaining slots|1,000,000/i;
const bodyText = () => document.body.textContent ?? '';

describe('E134: no rent ceiling per tenant on the agent dashboard', () => {
  it('no "Per-tenant max" / "per tenant" text renders, collapsed or open; the old figure is never shown', async () => {
    renderAll();
    await screen.findByTestId('exposure-used');
    expect(bodyText()).not.toMatch(PER_TENANT);
    fireEvent.click(screen.getByRole('button', { name: /My Rent-Request Capacity/ }));
    await screen.findAllByTestId('exposure-line');
    expect(bodyText()).not.toMatch(PER_TENANT);
    expect(screen.getByText(/it never limits a tenant’s rent/i)).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith('get_agent_rent_request_capacity', { p_agent_id: 'agent-1', p_tenant_id: null });
  });

  it('the exposure line still shows: exposure of the limit, and headroom, from the database', async () => {
    renderAll();
    expect(await screen.findByTestId('exposure-used')).toHaveTextContent(/42,000,000/);
    fireEvent.click(screen.getByRole('button', { name: /My Rent-Request Capacity/ }));
    const lines = await screen.findAllByTestId('exposure-line');
    expect(lines[0]).toHaveTextContent(/Exposure\s*UGX\s*42,000,000\s*\/\s*UGX\s*100,000,000/);
    expect(lines[1]).toHaveTextContent(/Exposure UGX\s*42,000,000 of UGX\s*100,000,000/);
    expect(screen.getAllByText(/58,000,000/).length).toBeGreaterThan(0);
  });

  it('the blocked text appears only when blocked', async () => {
    const first = renderAll();
    await screen.findByTestId('exposure-used');
    expect(screen.queryByTestId('exposure-blocked')).toBeNull();
    expect(bodyText()).not.toMatch(/can't post|cannot post|limit reached|Locked/i);
    expect(screen.getByText('You can post new Rent Plans.')).toBeInTheDocument();
    expect(screen.getAllByText('✓ Can post new Rent Plans').length).toBeGreaterThan(0);
    first.unmount();

    mocks.exposure = { agent_exposure: 100_000_000, agent_cap: 100_000_000, agent_headroom: 0, blocked: true, reason: null };
    renderAll();
    await waitFor(() => expect(screen.getAllByTestId('exposure-blocked').length).toBe(2)); // the card and the panel
    expect(screen.getAllByTestId('exposure-blocked')[0]).toHaveTextContent(
      /You can't post new Rent Plans right now: your tenants' outstanding balances \(UGX\s*100,000,000\) have reached the UGX\s*100,000,000 limit\./,
    );
    expect(screen.getAllByText(/Exposure limit reached/).length).toBeGreaterThan(0);
    expect(bodyText()).not.toMatch(PER_TENANT);
  });

  it('a blocked reply with the server’s own words shows them', async () => {
    mocks.exposure = { agent_exposure: 100_000_000, agent_cap: 100_000_000, agent_headroom: 0, blocked: true, reason: 'Exposure limit reached. Collect first.' };
    renderAll();
    await waitFor(() => expect(screen.getAllByTestId('exposure-blocked')[0]).toHaveTextContent('Exposure limit reached. Collect first.'));
  });
});

describe('the reply and the tier', () => {
  it('reads agent_exposure, agent_cap, agent_headroom, blocked; anything else is unknown', () => {
    expect(parseAgentExposure({ agent_exposure: '5000', agent_cap: 100_000_000, agent_headroom: 99_995_000, blocked: false }))
      .toEqual({ exposure: 5000, cap: 100_000_000, headroom: 99_995_000, blocked: false, reason: null });
    expect(parseAgentExposure({ agent_exposure: 5000, agent_cap: 10_000 })).toMatchObject({ headroom: 5000, blocked: false });
    expect(parseAgentExposure({ tenant_max: 1 })).toBeNull();
    expect(parseAgentExposure(null)).toBeNull();
  });

  it('the tier is a label only: no ceiling comes with it', () => {
    expect(classifyAgent(0, 0)).toEqual({ tier: 'Starter' });
    expect(classifyAgent(5, 0.8)).toEqual({ tier: 'Positive' });
    expect(classifyAgent(5, 0.05)).toEqual({ tier: 'Very Bad' });
  });
});
