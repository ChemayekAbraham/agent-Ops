import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));

import { MyAwarenessCallsCard } from './MyAwarenessCallsCard';

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};
const calls = (fn: string) => rpcMock.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Record<string, unknown>);

const summary = { totals: { calls: 8, answered: 6, answered_pct: 75, people_called: 7, people_reached: 5, rent_plans_called: 6 } };
const logRow = (over: Record<string, unknown>) => ({
  id: 'c-1', rent_request_id: 'rr-1', plan_code: 'rr-1', subject_type: 'tenant', subject_name: 'Adam Mariam', subject_phone: '0700111222',
  pipeline_stage: 'agent_ops_approved', current_status: 'agent_ops_approved', call_result: 'answered', note: null, day: '2026-10-07',
  dial_started_at: '2026-10-07T08:00:00Z', recorded_at: '2026-10-07T08:02:00Z', ...over,
});
let sumError: string | null = null;
let logRows: Record<string, unknown>[] = [];

describe('MyAwarenessCallsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sumError = null;
    logRows = [logRow({}), logRow({ id: 'c-2', subject_type: 'landlord', subject_name: 'Mr Okello', call_result: 'no_answer' })];
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'my_awareness_calls_summary') return Promise.resolve(sumError ? { data: null, error: { message: sumError } } : { data: summary, error: null });
      if (fn === 'my_awareness_calls_log') return Promise.resolve({ data: { total: logRows.length, limit: 5, offset: 0, rows: logRows }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('shows this week\'s calls, the answered share, people reached and the recent list', async () => {
    render(<MyAwarenessCallsCard />, { wrapper });
    const stats = await screen.findByTestId('my-awareness-stats');
    await waitFor(() => expect(within(stats).getByText('8')).toBeInTheDocument());
    expect(within(stats).getByText('75.0%')).toBeInTheDocument();
    expect(within(stats).getByText('5')).toBeInTheDocument();
    const recent = await screen.findByTestId('my-awareness-recent');
    expect(within(recent).getByText('Adam Mariam')).toBeInTheDocument();
    expect(within(recent).getByText('Mr Okello')).toBeInTheDocument();
    expect(within(recent).getByText('No answer')).toBeInTheDocument();
  });

  it('asks for Monday to today and the last five calls only', async () => {
    render(<MyAwarenessCallsCard />, { wrapper });
    await screen.findByTestId('my-awareness-stats');
    const s = calls('my_awareness_calls_summary')[0];
    expect(s.p_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.p_to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${s.p_from}T12:00:00Z`).getUTCDay()).toBe(1);
    expect(calls('my_awareness_calls_log')[0]).toMatchObject({ p_limit: 5, p_offset: 0 });
  });

  it('says so quietly when there are no calls this week', async () => {
    logRows = [];
    render(<MyAwarenessCallsCard />, { wrapper });
    expect(await screen.findByTestId('my-awareness-empty')).toHaveTextContent('You have not recorded an awareness call this week.');
  });

  it('hides for someone who may not use the log, and offers Retry for any other failure', async () => {
    sumError = 'not authorized';
    const { container, unmount } = render(<MyAwarenessCallsCard />, { wrapper });
    await waitFor(() => expect(container.querySelector('[data-testid="my-awareness-calls"]')).toBeNull());
    unmount();

    sumError = 'connection reset';
    const user = userEvent.setup();
    render(<MyAwarenessCallsCard />, { wrapper });
    expect(await screen.findByTestId('my-awareness-error')).toHaveTextContent('Could not load your calls');
    sumError = null;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('my-awareness-stats')).toBeInTheDocument();
  });

  it('never uses the words loan, lender, ROI or interest', async () => {
    const { container } = render(<MyAwarenessCallsCard />, { wrapper });
    await screen.findByTestId('my-awareness-recent');
    expect(container.textContent).not.toMatch(/\b(loan|lender|ROI|interest)\b/i);
  });
});
