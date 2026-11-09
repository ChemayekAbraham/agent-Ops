/**
 * Partner Returns Phase 5, RenewPortfolioDialog handler (design v2 §6.1: "Renewal: prefill the stored
 * rate; call set_portfolio_renewal_rate only when edited").
 *
 * Switch-off parity: with the switch seen off the renewal writes roi_percentage in the same update as
 * today and never calls the RPC.
 */
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
  toast: vi.fn(),
  updates: [] as { table: string; payload: Record<string, unknown> }[],
  inserts: [] as { table: string; payload: Record<string, unknown> }[],
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    functions: { invoke: mocks.invoke },
    // withUserSession checks the session before the update (src/lib/authenticatedRequests).
    auth: { getSession: async () => ({ data: { session: { user: { id: 'staff-1' }, access_token: 'test-token', expires_at: null } }, error: null }), },
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => {
        mocks.updates.push({ table, payload });
        return { eq: async () => ({ error: null }) };
      },
      insert: async (payload: Record<string, unknown>) => {
        mocks.inserts.push({ table, payload });
        return { error: null };
      },
    }),
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'staff-1' } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

import { RenewPortfolioDialog } from '@/components/manager/RenewPortfolioDialog';

const portfolio = {
  id: 'pf1',
  portfolio_code: 'WPF-1',
  account_name: null,
  investment_amount: 1_000_000,
  roi_percentage: 15,
  status: 'matured',
  created_at: '2026-01-01T00:00:00Z',
  duration_months: 12,
  payout_day: null,
  investor_id: null,
};

let policyEnabled = false;
function route(renewalAnswer?: { rate_in_force: number; awaits_cfo: boolean }) {
  mocks.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'get_partner_return_policy') {
      return { data: { enabled: policyEnabled, new_contract_rate: policyEnabled ? 10 : 15 }, error: null };
    }
    if (fn === 'set_portfolio_renewal_rate') return { data: renewalAnswer ?? null, error: null };
    return { data: null, error: null };
  });
}

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return render(<RenewPortfolioDialog open onOpenChange={() => {}} portfolio={portfolio} onSuccess={() => {}} />, { wrapper: Wrapper });
}

const rateInput = () => screen.getByPlaceholderText('e.g. 20') as HTMLInputElement;
const renewalRpcCalls = () => mocks.rpc.mock.calls.filter(([fn]) => fn === 'set_portfolio_renewal_rate');
const policyRead = () => mocks.rpc.mock.calls.some(([fn]) => fn === 'get_partner_return_policy');

async function renew(rate?: string) {
  await waitFor(() => expect(rateInput().value).toBe('15'));       // prefill = the stored rate
  await waitFor(() => expect(policyRead()).toBe(true));
  // Let the policy answer land before the click.
  await new Promise((r) => setTimeout(r, 50));
  if (rate !== undefined) fireEvent.change(rateInput(), { target: { value: rate } });
  fireEvent.change(screen.getByPlaceholderText(/Partner requested renewal/), { target: { value: 'Partner asked for another cycle' } });
  fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));
  await waitFor(() => expect(mocks.updates.length).toBe(1));
  await waitFor(() => expect(mocks.inserts.length).toBe(2));
}

const portfolioUpdate = () => mocks.updates[0].payload;
const renewalRow = () => mocks.inserts.find((i) => i.table === 'portfolio_renewals')!.payload;
const auditRow = () => mocks.inserts.find((i) => i.table === 'audit_logs')!.payload as { metadata: Record<string, unknown> };

beforeEach(() => {
  localStorage.clear();
  mocks.rpc.mockReset();
  mocks.invoke.mockReset();
  mocks.toast.mockReset();
  mocks.updates.length = 0;
  mocks.inserts.length = 0;
});

describe('RenewPortfolioDialog: Returns rate on renewal', () => {
  it('switch seen off, edited: the rate is written in the update as today; no RPC (parity)', async () => {
    policyEnabled = false;
    route();
    renderDialog();
    await renew('18');
    expect(portfolioUpdate().roi_percentage).toBe(18);
    expect(renewalRpcCalls()).toHaveLength(0);
    expect(renewalRow().new_roi_percentage).toBe(18);
    expect(auditRow().metadata.new_roi).toBe(18);
    expect(auditRow().metadata).not.toHaveProperty('requested_roi');
  });

  it('switch seen off, not edited: the stored rate is written back as today', async () => {
    policyEnabled = false;
    route();
    renderDialog();
    await renew();
    expect(portfolioUpdate().roi_percentage).toBe(15);
    expect(renewalRpcCalls()).toHaveLength(0);
  });

  it('switch on, not edited: the renewal keeps its rate; no rate in the update, no RPC', async () => {
    policyEnabled = true;
    route();
    renderDialog();
    await renew();
    expect(portfolioUpdate()).not.toHaveProperty('roi_percentage');
    expect(renewalRpcCalls()).toHaveLength(0);
    expect(renewalRow().new_roi_percentage).toBe(15);
  });

  it('switch on, edited: set_portfolio_renewal_rate; the history records the rate in force', async () => {
    policyEnabled = true;
    route({ rate_in_force: 15, awaits_cfo: true });
    renderDialog();
    await renew('18');
    expect(renewalRpcCalls()).toEqual([['set_portfolio_renewal_rate', { p_portfolio_id: 'pf1', p_requested_rate: 18 }]]);
    expect(portfolioUpdate()).not.toHaveProperty('roi_percentage');
    expect(renewalRow().new_roi_percentage).toBe(15);
    expect(auditRow().metadata).toMatchObject({ new_roi: 15, requested_roi: 18, rate_awaits_cfo: true });
  });
});
