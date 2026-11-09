/**
 * Partner Returns Phase 5, rendered data checks for the Claude data lines (gemini_tasks.md items 3, 5, 6).
 * Switch off: the public rate is 15 and a stored rate is the row's own, so the figures equal today's.
 * Null-rate display ("—") is Gemini's JSX and is not asserted; these tests only check that no
 * priced figure appears without a rate.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatUGX } from '@/lib/rentCalculations';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  policy: { newContractRate: 15 as number | null },
}));

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'ilike', 'in']) c[m] = () => c;
  c.single = async () => result;
  c.maybeSingle = async () => result;
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: (table: string) => chain(table === 'wallets' ? { data: { balance: 50_000_000 }, error: null } : { data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: { id: 'agent-1' } } }) },
    functions: { invoke: vi.fn() },
    storage: { from: vi.fn() },
  },
}));
vi.mock('@/hooks/usePartnerReturnPolicy', () => ({
  usePartnerReturnPolicy: () => ({
    newContractRate: mocks.policy.newContractRate,
    enabled: false,
    policy: null,
    cutoffAt: null,
    isLoading: false,
    fromNetwork: true,
  }),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import InvestorPortfolioPublic from '@/pages/InvestorPortfolioPublic';
import { NexaSalesHub } from '@/components/ai-chat/NexaSalesHub';
import { AgentInvestForPartnerDialog } from '@/components/agent/AgentInvestForPartnerDialog';

const ROW = {
  investment_amount: 1_000_000,
  roi_percentage: 20,
  roi_mode: 'monthly_payout',
  duration_months: 12,
  portfolio_code: 'WIP-1',
  created_at: '2026-10-01T00:00:00Z',
  next_roi_date: null,
  total_roi_earned: 0,
  agent_name: 'Agent A',
};

function renderPortfolio() {
  return render(
    <MemoryRouter initialEntries={['/p/tok']}>
      <Routes><Route path="/p/:token" element={<InvestorPortfolioPublic />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.policy.newContractRate = 15;
});

describe('InvestorPortfolioPublic expected monthly Returns', () => {
  it('prices at the stored rate (20% of 1,000,000 = 200,000), as today', async () => {
    mocks.rpc.mockResolvedValue({ data: [ROW], error: null });
    renderPortfolio();
    await screen.findByText('Support Details');
    expect(document.body.textContent).toContain(`Expected Monthly Return${formatUGX(200_000)}`);
  });

  it('a masked rate (null) gives no priced figure (not 15%, not 10%)', async () => {
    mocks.rpc.mockResolvedValue({ data: [{ ...ROW, roi_percentage: null }], error: null });
    renderPortfolio();
    await screen.findByText('Support Details');
    for (const guess of [100_000, 150_000, 200_000]) expect(screen.queryByText(formatUGX(guess))).toBeNull();
  });
});

describe('NexaSalesHub supporter projection', () => {
  it('uses the public rate: 15 (switch off) gives 15,000 a month on 100,000', () => {
    render(<NexaSalesHub onAsk={() => {}} />);
    expect(screen.getByText('UGX 15,000')).toBeTruthy();
    expect(screen.getByText('UGX 180,000')).toBeTruthy();
  });

  it('follows the policy: 10 after switch-on gives 10,000', () => {
    mocks.policy.newContractRate = 10;
    render(<NexaSalesHub onAsk={() => {}} />);
    expect(screen.getByText('UGX 10,000')).toBeTruthy();
    expect(screen.queryByText('UGX 15,000')).toBeNull();
  });

  it('an unknown rate prices nothing at a guessed rate', () => {
    mocks.policy.newContractRate = null;
    render(<NexaSalesHub onAsk={() => {}} />);
    for (const guess of ['UGX 10,000', 'UGX 15,000', 'UGX 120,000', 'UGX 180,000']) expect(screen.queryByText(guess)).toBeNull();
  });
});

describe('AgentInvestForPartnerDialog preview', () => {
  async function typeAmount(v: string) {
    render(<AgentInvestForPartnerDialog open onOpenChange={() => {}} />);
    const input = await screen.findByLabelText(/Funding Amount/i);
    fireEvent.change(input, { target: { value: v } });
  }

  it('switch off (public 15): 1,000,000 previews 150,000 a month and 1,800,000 over 12, as today', async () => {
    await typeAmount('1000000');
    await waitFor(() => expect(document.body.textContent).toContain(`Monthly: ${formatUGX(150_000)} ×12 months = ${formatUGX(1_800_000)}`));
  });

  it('after switch-on the preview follows the new-partner rate (10)', async () => {
    mocks.policy.newContractRate = 10;
    await typeAmount('1000000');
    await waitFor(() => expect(document.body.textContent).toContain(`Monthly: ${formatUGX(100_000)} ×12 months = ${formatUGX(1_200_000)}`));
  });
});
