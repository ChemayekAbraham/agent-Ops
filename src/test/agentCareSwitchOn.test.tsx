import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { selfSupportGross, selfSupportProxyFee } from '@/lib/selfSupportFee';

// Switch ON only inside this test: the real switch lives in production and is never touched.
const ON = { enabled: true, rate: 0.02, roundTo: 100 };
vi.mock('@/hooks/useSelfSupportFeePolicy', () => ({
  useSelfSupportFeePolicy: () => ({
    policy: ON,
    enabled: true,
    ratePct: 2,
    pay: (rent: number) => selfSupportGross(rent, ON),
    fee: (rent: number) => selfSupportProxyFee(rent, ON),
    isLoading: false,
  }),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(async () => ({
      data: [{
        line_id: 'l1', line_kind: 'tenant', principal: 306000, rent_amount: 300000,
        proxy_fee: 6000, proxy_fee_status: 'pending', subject_name: 'Test Tenant',
        daily_repayment: 0,
      }],
      error: null,
    })),
  },
}));

import { AgentCareNote } from '@/components/partner/AgentCareNote';
import { CommitmentLines } from '@/components/executive/pending-vetting/CommitmentLines';
import { itemAmount, toSelectionItem } from '@/components/funder-new/utils';

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
const digits = (t: string | null | undefined) => (t ?? '').replace(/\D/g, '');

describe('Agent Care with the switch on', () => {
  it('prices a 300,000 plan at 306,000 for the partner', () => {
    const plan = { rent_request_id: 'p', funding_amount: 300000 } as never;
    expect(itemAmount('ready', plan, (r) => selfSupportGross(r, ON))).toBe(306000);
    expect(toSelectionItem('ready', plan, (r) => selfSupportGross(r, ON)).amount).toBe(306000);
    expect(itemAmount('ready', plan)).toBe(300000); // sorting/filtering stays on rent
  });

  it('shows the Agent Care line and the 6,000 of 306,000 figure on tap', async () => {
    wrap(<AgentCareNote kind="tenant" rent={300000} />);
    expect(screen.getByText(/Cover fee included:/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/2%/);
    fireEvent.click(screen.getByRole('button', { name: /Cover fee amount/ }));
    const pop = await screen.findByText(/Cover fee:/);
    expect(digits(pop.textContent)).toContain('6000');
    expect(digits(pop.textContent)).toContain('306000');
  });

  it('approval line shows 300,000 to landlord float and 6,000 facilitation fee', async () => {
    wrap(<CommitmentLines portfolioId="x" />);
    const float = await screen.findByText(/To landlord float:/);
    expect(digits(float.textContent)).toBe('300000');
    const fee = screen.getByText(/Agent facilitation fee:/);
    expect(digits(fee.textContent)).toBe('6000');
    expect(fee.textContent).toMatch(/paid on approval/);
  });
});
