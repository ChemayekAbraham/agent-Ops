import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Salary Advances: the CFO's step is "Pay to wallet", confirmed before money moves (API mocked). */

vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
  listAdvances: vi.fn(),
  decideAdvance: vi.fn(),
  payAdvanceToWallet: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/hr/pay/api/advances', () => ({
  listAdvances: mocks.listAdvances,
  decideAdvance: mocks.decideAdvance,
  payAdvanceToWallet: mocks.payAdvanceToWallet,
  requestAdvance: vi.fn(),
  cancelAdvance: vi.fn(),
  updateAdvance: vi.fn(),
}));
vi.mock('@/hr/pay/api/workflow', () => ({ myPayrollAuthority: vi.fn(() => Promise.resolve({ preparer: false, approver: false, releaser: true })) }));
vi.mock('@/hr/pay/api/compensation', () => ({ listStaffForPayroll: vi.fn(() => Promise.resolve([])) }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
const fakeSupabase = vi.hoisted(() => {
  const chain: Record<string, unknown> = {};
  const q = () => chain;
  Object.assign(chain, { select: q, eq: q, in: q, order: q, limit: q, maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r) });
  return { from: () => chain, rpc: () => Promise.resolve({ data: null, error: null }),
    auth: { getUser: () => Promise.resolve({ data: { user: null } }), getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }), removeChannel: () => {} };
});
vi.mock('@/integrations/supabase/client', () => ({ supabase: fakeSupabase }));

import Advances from '@/hr/pay/Advances';

const row = (status: string) => ({
  id: 'a1', staff_id: 's1', staff_ref: 'WEL-01', staff_name: 'MEDDY MUKUNGU', principal: 200000, currency: 'UGX',
  purpose: 'To clear some arrears', recovery_mode: 'fixed', recovery_value: 100000, recovery_months: 2, first_recovery_on: '2026-12-10',
  status, decision_note: null, requested_at: '2026-11-12T11:41:18Z', hr_approved_at: '2026-11-12T11:44:58Z', approved_at: '2026-11-12T14:50:46Z',
  disbursed_at: null, recovered: 0, outstanding: 200000,
});
const renderPage = () => render(<MemoryRouter><Advances embedded /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  if (typeof document !== 'undefined' && !document.elementFromPoint) document.elementFromPoint = () => null;
});
afterEach(cleanup);

describe('Salary Advances: Pay to wallet', () => {
  it('a CEO-approved advance offers "Pay to wallet"; nothing is paid until the CFO confirms; then the server pays it', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mocks.listAdvances.mockResolvedValue([row('ceo_approved')]);
    mocks.payAdvanceToWallet.mockResolvedValue({ advance_id: 'a1', amount: 200000, paid_to: 'MEDDY MUKUNGU', reference: 'SALADV-ABCDEF1234',
      ledger_group_id: 'g1', status: 'approved', replayed: false });
    renderPage();
    const btn = (await screen.findAllByRole('button', { name: /Pay to wallet/ }))[0];
    expect(screen.queryByText(/Record Disbursement/)).toBeNull();
    await user.click(btn);
    expect(await screen.findByText(/will be credited to MEDDY MUKUNGU's Welile/)).toBeInTheDocument();
    expect(mocks.payAdvanceToWallet).not.toHaveBeenCalled();
    expect(mocks.decideAdvance).not.toHaveBeenCalled();              // the old status-only step is not used
    await user.click(screen.getByRole('button', { name: /Pay UGX 200,000/ }));
    await waitFor(() => expect(mocks.payAdvanceToWallet).toHaveBeenCalledWith('a1'));
    expect(mocks.toast.success).toHaveBeenCalledWith(expect.stringMatching(/Paid to the staff member's wallet/), expect.objectContaining({ description: expect.stringMatching(/SALADV-ABCDEF1234/) }));
  });

  it('a refusal is shown and the dialog stays open; earlier approval steps still use the normal approve action', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mocks.listAdvances.mockResolvedValue([row('ceo_approved')]);
    mocks.payAdvanceToWallet.mockRejectedValue(new Error('You cannot pay out your own advance. Another release-authority holder must do it.'));
    const page = renderPage();
    await user.click((await screen.findAllByRole('button', { name: /Pay to wallet/ }))[0]);
    await user.click(await screen.findByRole('button', { name: /Pay UGX 200,000/ }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringMatching(/your own advance/)));
    expect(screen.getByRole('button', { name: /Pay UGX 200,000/ })).toBeInTheDocument();
    page.unmount();
    mocks.listAdvances.mockResolvedValue([row('hr_approved')]);
    renderPage();
    await screen.findAllByText('MEDDY MUKUNGU');
    expect(screen.queryByRole('button', { name: /Pay to wallet/ })).toBeNull();
  });
});
