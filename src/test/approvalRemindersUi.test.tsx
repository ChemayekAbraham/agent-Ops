import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Approval reminders (CFO 15 Nov 2026): the loan, facilitation and salary advance pop-ups offer only "Open …" and
 * "Later" (no approve, decline or disburse); the approvals queue is where loans are approved, declined and paid.
 * Server mocked.
 */

vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  tables: {} as Record<string, unknown[]>,
  updates: [] as { table: string; values: unknown; id: unknown }[],
  toast: { success: vi.fn(), error: vi.fn() },
  user: { id: 'me' },
}));

vi.mock('@/integrations/supabase/client', () => {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    const q = () => chain;
    let pending: unknown = null;
    Object.assign(chain, {
      select: q, in: q, neq: q, order: q, eq: (_c: string, v: unknown) => {
        if (pending) { mocks.updates.push({ table, values: pending, id: v }); return Promise.resolve({ error: null }); }
        return chain;
      },
      update: (values: unknown) => { pending = values; return chain; },
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: mocks.tables[table] ?? [], error: null }).then(r),
    });
    return chain;
  };
  return { supabase: { rpc: mocks.rpc, from } };
});
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@/hooks/useAuthenticatedPoll', () => ({
  hasUsableUserSession: () => Promise.resolve(true),
  useAuthenticatedAudience: () => true,
  useAuthenticatedPoll: (fn: () => void) => { useEffect(() => { fn(); }, [fn]); },
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));

import { StaffLoanApprovalGate } from '@/components/requisitions/StaffLoanApprovalGate';
import { FacilitationApprovalGate } from '@/components/requisitions/FacilitationApprovalGate';
import { SalaryAdvanceReminderGate } from '@/hr/pay/SalaryAdvanceReminderGate';
import { StaffApprovalsQueue } from '@/components/requisitions/StaffApprovalsQueue';

function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }
const renderAt = (ui: React.ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/cfo/dashboard']}>
      {ui}
      <Routes><Route path="*" element={<Where />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);
/** The dialog's own close button is hidden by CSS ([&>button]:hidden), which jsdom does not apply. */
const visibleButtons = () => screen.getAllByRole('button').map((b) => b.textContent?.trim()).filter((n) => n !== 'Close');
const NO_ACTIONS = /^(Approve|Decline|Disburse|Delete|Pay)/;

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.tables = {};
  mocks.updates = [];
  vi.clearAllMocks();
  if (typeof document !== 'undefined' && !document.elementFromPoint) document.elementFromPoint = () => null;
});
afterEach(cleanup);

const loanPrompt = { prompt_id: 'p1', kind: 'cfo', requisition_id: 'r1', requisition_code: 'SRQ-00479', borrower_name: 'MEDDY MUKUNGU',
  amount: 500000, months: 3, reason: 'School fees', snooze_count: 288, submitted_at: '2026-11-11T08:00:00Z' };

describe('staff loan reminder', () => {
  it('offers only "Open requisitions" and "Later": no approve, decline or disburse', async () => {
    mocks.rpc.mockImplementation((fn: string) => Promise.resolve(fn === 'staff_loan_pending_prompt' ? { data: [loanPrompt], error: null } : { data: null, error: null }));
    renderAt(<StaffLoanApprovalGate />);
    expect(await screen.findByText('Loan approved — waiting to be paid')).toBeInTheDocument();
    const names = visibleButtons();
    expect(names).toEqual(['Open requisitions', 'Later']);
    expect(names.some((n) => NO_ACTIONS.test(n ?? ''))).toBe(false);
    expect(screen.getByText(/Deferred 288 times/)).toBeInTheDocument();
    expect(screen.getByText(/next reminder appears in 4 hours/)).toBeInTheDocument();
  });

  it('"Later" puts it off on the server; "Open requisitions" puts it off and goes to the approvals queue', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const until = new Date(Date.now() + 4 * 3600_000).toISOString();
    mocks.rpc.mockImplementation((fn: string) => Promise.resolve(fn === 'staff_loan_pending_prompt'
      ? { data: [loanPrompt], error: null } : { data: { snooze_until: until }, error: null }));
    const a = renderAt(<StaffLoanApprovalGate />);
    await user.click(await screen.findByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByText('Loan approved — waiting to be paid')).toBeNull());
    expect(mocks.rpc).toHaveBeenCalledWith('staff_loan_prompt_snooze', { _prompt_id: 'p1' });
    expect(mocks.rpc).not.toHaveBeenCalledWith('staff_loan_disburse', expect.anything());
    a.unmount();

    renderAt(<StaffLoanApprovalGate />);
    await user.click(await screen.findByRole('button', { name: 'Open requisitions' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/requisitions/approvals'));
    expect(mocks.rpc).toHaveBeenCalledTimes(4);   // two fetches, two snoozes; nothing else
  });

  it('a failed "Later" keeps the reminder and says so', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mocks.rpc.mockImplementation((fn: string) => Promise.resolve(fn === 'staff_loan_pending_prompt'
      ? { data: [loanPrompt], error: null } : { data: null, error: { message: 'That approval prompt is not yours' } }));
    renderAt(<StaffLoanApprovalGate />);
    await user.click(await screen.findByRole('button', { name: 'Open requisitions' }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringMatching(/not yours/)));
    expect(screen.getByText('Loan approved — waiting to be paid')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/cfo/dashboard');
  });
});

describe('facilitation reminder', () => {
  it('offers only "Open requisitions" and "Later"', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mocks.rpc.mockImplementation((fn: string) => Promise.resolve(fn === 'pso_facilitation_pending_prompt'
      ? { data: [{ prompt_id: 'f1', requisition_id: 'r9', requisition_code: 'SRQ-00300', officer_name: 'OFFICER', title: 'Field visits',
        reason: 'Kampala', amount: 120000, snooze_count: 0, submitted_at: '2026-11-10T08:00:00Z', kind: 'disbursement' }], error: null }
      : { data: { snooze_until: new Date(Date.now() + 4 * 3600_000).toISOString() }, error: null }));
    renderAt(<FacilitationApprovalGate />);
    expect(await screen.findByText('Facilitation approved — waiting to be paid')).toBeInTheDocument();
    expect(visibleButtons()).toEqual(['Open requisitions', 'Later']);
    await user.click(screen.getByRole('button', { name: 'Open requisitions' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/requisitions/approvals'));
    expect(mocks.rpc).toHaveBeenCalledWith('pso_facilitation_prompt_snooze', { _prompt_id: 'f1' });
  });
});

describe('salary advance reminder', () => {
  it('reminds the holder of the next step; "Open advances" goes to Salary Advances; nothing is approved or paid', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mocks.rpc.mockImplementation((fn: string) => Promise.resolve(fn === 'hr_pay_advance_pending_prompt'
      ? { data: [{ advance_id: 'a1', status: 'requested', step: 'hr', staff_name: 'JOAN', staff_ref: 'WEL-09', principal: 300000,
        purpose: 'Rent', requested_at: '2026-11-14T08:00:00Z', snooze_count: 1, total_pending: 3 }], error: null }
      : { data: new Date(Date.now() + 4 * 3600_000).toISOString(), error: null }));
    renderAt(<SalaryAdvanceReminderGate />);
    expect(await screen.findByText('Salary advance needs HR approval')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 waiting on you')).toBeInTheDocument();
    expect(visibleButtons()).toEqual(['Open advances', 'Later']);
    await user.click(screen.getByRole('button', { name: 'Open advances' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/hr/pay/advances'));
    expect(mocks.rpc).toHaveBeenCalledWith('hr_pay_advance_prompt_snooze', { p_advance_id: 'a1' });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('shows nothing when nothing is waiting, or when the server cannot say', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const a = renderAt(<SalaryAdvanceReminderGate />);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    a.unmount();
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    renderAt(<SalaryAdvanceReminderGate />);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('approvals queue', () => {
  const reqs = [
    { id: 'r1', requisition_code: 'SRQ-00142', request_kind: 'staff_loan', stage: 'approved', amount: 400000, loan_months: 4, loan_monthly_rate: 0.03,
      reason: 'Personal', title: null, requester_id: 'u1', requester_name: null, wallet_credit_status: null, created_at: '2026-09-22T08:00:00Z' },
    { id: 'r2', requisition_code: 'SRQ-00490', request_kind: 'staff_loan', stage: 'hr', amount: 250000, loan_months: 2, loan_monthly_rate: 0.03,
      reason: 'Medical', title: null, requester_id: 'u2', requester_name: null, wallet_credit_status: null, created_at: '2026-11-13T08:00:00Z' },
    { id: 'r3', requisition_code: 'SRQ-00199', request_kind: 'staff_loan', stage: 'approved', amount: 100000, loan_months: 1, loan_monthly_rate: 0.03,
      reason: 'Already paid', title: null, requester_id: 'u1', requester_name: null, wallet_credit_status: 'credited', created_at: '2026-10-02T08:00:00Z' },
    { id: 'r4', requisition_code: 'SRQ-00300', request_kind: 'facilitation', stage: 'coo', amount: 120000, loan_months: null, loan_monthly_rate: null,
      reason: 'Kampala', title: 'Field visits', requester_id: 'u3', requester_name: 'OFFICER', wallet_credit_status: null, created_at: '2026-11-10T08:00:00Z' },
  ];
  beforeEach(() => {
    mocks.tables = {
      staff_requisitions: reqs,
      staff_loan_prompts: [{ requisition_id: 'r1', kind: 'cfo', approver_id: 'me' }, { requisition_id: 'r2', kind: 'hr', approver_id: 'hr1' }],
      pso_facilitation_prompts: [{ requisition_id: 'r4', kind: 'approval', approver_id: 'me' }],
      profiles: [{ id: 'u1', full_name: 'MEDDY MUKUNGU' }, { id: 'u2', full_name: 'AWANY JOSEPH' }, { id: 'hr1', full_name: 'BWAYO MARK' },
        { id: 'u3', full_name: 'OFFICER' }],
    };
  });

  it('lists what is waiting; the approver of each step can act; others see whom it waits on; paid loans are gone', async () => {
    renderAt(<StaffApprovalsQueue />);
    expect(await screen.findByText('SRQ-00142', { exact: false })).toBeInTheDocument();
    expect(screen.getAllByTestId('staff-approval-item')).toHaveLength(3);
    expect(screen.queryByText(/SRQ-00199/)).toBeNull();
    expect(screen.getByRole('button', { name: /^Pay UGX/ })).toBeInTheDocument();
    expect(screen.getByText('Waiting on BWAYO MARK.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();          // the facilitation is mine
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
  });

  it('paying asks first, then calls staff_loan_disburse only', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    renderAt(<StaffApprovalsQueue />);
    await user.click(await screen.findByRole('button', { name: /^Pay UGX/ }));
    expect(await screen.findByText(/will be credited to MEDDY MUKUNGU's Welile wallet now/)).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalled();
    const confirm = screen.getAllByRole('button', { name: /^Pay UGX/ }).at(-1)!;
    await user.click(confirm);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('staff_loan_disburse', { _requisition_id: 'r1' }));
    expect(mocks.toast.success).toHaveBeenCalledWith('Loan paid to the wallet');
  });

  it('approving and declining write the stage; a decline needs a reason', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderAt(<StaffApprovalsQueue />);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.updates).toContainEqual({ table: 'staff_requisitions', values: { stage: 'approved' }, id: 'r4' }));
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm decline' }));
    expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringMatching(/at least 10 characters/));
    await user.type(screen.getByPlaceholderText(/Why is this declined/), 'Budget for this month is used up');
    await user.click(screen.getByRole('button', { name: 'Confirm decline' }));
    await waitFor(() => expect(mocks.updates).toContainEqual({ table: 'staff_requisitions',
      values: { stage: 'rejected', rejection_reason: 'Budget for this month is used up' }, id: 'r4' }));
  });
});
