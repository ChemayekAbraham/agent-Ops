import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  enabledRoles: ['cfo'] as string[],
  toastSuccess: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => mocks.rpc(...args) },
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ enabledRoles: mocks.enabledRoles, roles: mocks.enabledRoles, user: { id: 'cfo-user' } }),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));

import { PartnerRateApprovalsPanel } from '../PartnerRateApprovalsPanel';

const row = (id: string, partner: string, code: string, extra: Record<string, unknown> = {}) => ({
  request_id: id, portfolio_id: `p-${id}`, portfolio_code: code, partner_id: `u-${id}`, partner_name: partner,
  investment_amount: 1_000_000, portfolio_status: 'active', source: 'new_portfolio',
  requested_rate: 20, rate_in_force: 10, standard_rate: 10, status: 'pending',
  requested_by: 'staff', requested_by_name: 'Ops Staff', requested_at: '2026-11-05T08:00:00Z',
  decided_by: null, decided_at: null, decision_note: null, applied_at: null, current_rate: 10, stage: 'pending',
  ...extra,
});
const ROWS = [
  row('r1', 'Alice Partner', 'WPF-001'),
  row('r2', 'Bob Partner', 'WPF-002', { source: 'rate_change', requested_rate: 18, rate_in_force: 15, current_rate: 15 }),
];

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return render(<PartnerRateApprovalsPanel />, { wrapper });
}

const listCalls = () => mocks.rpc.mock.calls.filter(([fn]) => fn === 'list_portfolio_rate_requests');
const decideCalls = () => mocks.rpc.mock.calls.filter(([fn]) => fn === 'cfo_decide_portfolio_rate_requests');

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.enabledRoles = ['cfo'];
  mocks.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'list_portfolio_rate_requests') return { data: ROWS, error: null };
    if (fn === 'cfo_decide_portfolio_rate_requests') {
      return { data: { decision: 'approved', decided: 1, skipped: 1, applies: 'next_cycle', requests: [] }, error: null };
    }
    return { data: null, error: null };
  });
});

describe('PartnerRateApprovalsPanel', () => {
  it('renders the pending queue from a single list call', async () => {
    renderPanel();
    expect(await screen.findByText('Alice Partner')).toBeInTheDocument();
    expect(screen.getByText('Bob Partner')).toBeInTheDocument();
    expect(screen.getByText('WPF-002')).toBeInTheDocument();
    expect(screen.getByText('New portfolio')).toBeInTheDocument();
    expect(screen.getByText('Rate change')).toBeInTheDocument();
    expect(listCalls()).toEqual([['list_portfolio_rate_requests', { p_status: 'pending', p_limit: 200 }]]);
  });

  it('approves the selected requests in one batch call and reports the counts', async () => {
    renderPanel();
    await screen.findByText('Alice Partner');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select WPF-001' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select WPF-002' }));
    fireEvent.click(screen.getByRole('button', { name: /Approve selected/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve requests' }));
    await waitFor(() => expect(decideCalls()).toHaveLength(1));
    expect(decideCalls()[0]).toEqual(['cfo_decide_portfolio_rate_requests', {
      p_request_ids: ['r1', 'r2'], p_decision: 'approve', p_note: null,
    }]);
    expect(await screen.findByRole('status')).toHaveTextContent(/1 approved, 1 skipped .*next cycle/);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('1 request(s) approved', expect.objectContaining({
      description: expect.stringContaining('next cycle'),
    }));
  });

  it('needs a reason before rejecting', async () => {
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'list_portfolio_rate_requests'
      ? { data: ROWS, error: null }
      : { data: { decision: 'rejected', decided: 2, skipped: 0 }, error: null }));
    renderPanel();
    await screen.findByText('Alice Partner');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rate requests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject selected' }));
    const reject = await screen.findByRole('button', { name: 'Reject requests' });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Rate above policy' } });
    expect(reject).toBeEnabled();
    fireEvent.click(reject);
    await waitFor(() => expect(decideCalls()).toHaveLength(1));
    expect(decideCalls()[0][1]).toEqual({ p_request_ids: ['r1', 'r2'], p_decision: 'reject', p_note: 'Rate above policy' });
  });

  it('shows a clear message when the session needs the authenticator step', async () => {
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'list_portfolio_rate_requests'
      ? { data: ROWS, error: null }
      : { data: null, error: { message: 'mfa_required: verify with your authenticator app to continue', code: '42501' } }));
    renderPanel();
    await screen.findByText('Alice Partner');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select WPF-001' }));
    fireEvent.click(screen.getByRole('button', { name: /Approve selected/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve requests' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Two-step verification needed/);
  });

  it('lets other roles read the queue but not decide', async () => {
    mocks.enabledRoles = ['coo'];
    renderPanel();
    await screen.findByText('Alice Partner');
    expect(screen.getByRole('button', { name: /Approve selected/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject selected' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select WPF-001' })).toBeDisabled();
    expect(screen.getByText('Only the CFO can approve or reject.')).toBeInTheDocument();
  });
});
