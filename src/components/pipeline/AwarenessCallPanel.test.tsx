import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
// payment_channels: the live merchant codes the panel shows (null error + rows, or a failure to test the fallback)
let channelsResult: { data: unknown; error: unknown } = {
  data: [
    { provider: 'MTN', merchant_code: '090999', merchant_name: null, active: true, sort_order: 1 },
    { provider: 'Airtel', merchant_code: '4380111', merchant_name: null, active: true, sort_order: 2 },
  ],
  error: null,
};
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpcMock(...a),
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.order = () => Promise.resolve(channelsResult);
      return chain;
    },
  },
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

import { AwarenessCallPanel } from './AwarenessCallPanel';

type Args = Record<string, unknown>;

const request = {
  id: 'rr-1', status: 'service_center_review', tenant_id: 'tenant-1', tenant_name: 'Adam Mariam', tenant_phone: '0700111222',
  landlord_name: 'Mr Okello', landlord_phone: '+256700333444', agent_id: 'agent-1', agent_name: 'Joan Agent', agent_phone: '0700555666',
};

const call = (over: Record<string, unknown>) => ({
  id: 'c-1', rent_request_id: 'rr-1', subject_type: 'tenant', subject_user_id: 'tenant-1', subject_phone: '0700111222',
  caller_id: 'u-1', caller_team: 'agent_ops', caller_name: 'Grace Namukasa', pipeline_stage: 'agent_ops_approved',
  dial_started_at: '2026-10-06T08:00:00Z', recorded_at: '2026-10-06T08:05:00Z', call_result: 'answered',
  aware_30m: 'heard', aware_merchant_codes: 'did_not_know', explained: 'partly', note: 'Wanted the codes in writing', ...over,
});

let stored: Record<string, unknown>[] = [];
let readError: string | null = null;
let saveError: string | null = null;

function install() {
  rpcMock.mockImplementation((fn: string, args: Args) => {
    if (fn === 'get_awareness_calls_for_request') {
      if (readError) return Promise.resolve({ data: null, error: { message: readError } });
      return Promise.resolve({ data: { rent_request_id: args.p_rent_request_id, total: stored.length, rows: stored }, error: null });
    }
    if (fn === 'record_awareness_call') {
      if (saveError) return Promise.resolve({ data: null, error: { message: saveError } });
      const row = call({ id: `c-${stored.length + 1}`, caller_team: 'service_centre', caller_name: 'Me', pipeline_stage: 'service_center_review',
        subject_type: args.p_subject_type, subject_phone: args.p_subject_phone, call_result: args.p_call_result, dial_started_at: args.p_dial_started_at,
        aware_30m: args.p_aware_30m, aware_merchant_codes: args.p_aware_merchant_codes, explained: args.p_explained, note: args.p_note });
      stored = [row, ...stored];
      return Promise.resolve({ data: { ...row, already_recorded: false }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};
const calls = (fn: string) => rpcMock.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Args);
const comeBack = () => act(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });

describe('AwarenessCallPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored = []; readError = null; saveError = null;
    channelsResult = {
      data: [
        { provider: 'MTN', merchant_code: '090999', merchant_name: null, active: true, sort_order: 1 },
        { provider: 'Airtel', merchant_code: '4380111', merchant_name: null, active: true, sort_order: 2 },
      ],
      error: null,
    };
    window.sessionStorage.clear();
    install();
    vi.spyOn(console, 'error').mockImplementation(() => {});   // jsdom cannot follow a tel: link
  });
  afterEach(() => vi.restoreAllMocks());

  it('reminds softly when no call has been saved, and offers call links with the phones already shown', async () => {
    render(<AwarenessCallPanel request={request} />, { wrapper });
    expect(await screen.findByTestId('awareness-reminder')).toHaveTextContent('No awareness call has been saved for this Rent Plan yet');
    expect(screen.getByTestId('awareness-reminder')).toHaveTextContent('You can still approve or reject as usual');
    expect(screen.getByRole('link', { name: /Call tenant 0700111222/ })).toHaveAttribute('href', 'tel:0700111222');
    expect(screen.getByRole('link', { name: /Call landlord \+256700333444/ })).toHaveAttribute('href', 'tel:+256700333444');
    expect(screen.getByRole('button', { name: /Record feedback/ })).toBeInTheDocument();
  });

  it('disables a call button when the person has no phone on file', async () => {
    render(<AwarenessCallPanel request={{ ...request, landlord_phone: '' }} />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    expect(screen.queryByRole('link', { name: /Call landlord/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Call landlord/ })).toBeDisabled();
  });

  it('remembers the dial time, opens the form on return, and saves the call then reads fresh data', async () => {
    const user = userEvent.setup();
    render(<AwarenessCallPanel request={request} />, { wrapper });
    await screen.findByTestId('awareness-reminder');

    fireEvent.click(screen.getByRole('link', { name: /Call tenant/ }));
    const keep = JSON.parse(window.sessionStorage.getItem('awareness-dial:rr-1')!);
    expect(keep).toMatchObject({ subject: 'tenant', phone: '0700111222' });
    expect(screen.getByTestId('awareness-dialling')).toHaveTextContent('Call to the tenant started');
    expect(screen.queryByRole('form', { name: /Record awareness call feedback/ })).not.toBeInTheDocument();

    comeBack();
    const form = await screen.findByRole('form', { name: /Record awareness call feedback/ });
    expect(within(form).getByText(/Call to the tenant/)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Save call' })).toBeDisabled();

    await user.click(within(form).getByRole('radio', { name: 'Answered' }));
    // the live merchant codes (payment_channels) are shown beside the question about them
    expect(await within(form).findByText('090999')).toBeInTheDocument();
    expect(within(form).getByText('4380111')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Save call' })).toBeDisabled();

    const q30 = within(form).getByRole('radiogroup', { name: /UGX 30,000,000/ });
    await user.click(within(q30).getByRole('radio', { name: 'Heard but unsure' }));
    const codes = within(form).getByRole('radiogroup', { name: /merchant codes/ });
    await user.click(within(codes).getByRole('radio', { name: 'Did not know' }));
    const explained = within(form).getByRole('radiogroup', { name: /explain it/ });
    await user.click(within(explained).getByRole('radio', { name: 'Partly explained' }));
    await user.type(within(form).getByLabelText(/Note/), '  Asked for the codes in writing  ');
    await user.click(within(form).getByRole('button', { name: 'Save call' }));

    await waitFor(() => expect(calls('record_awareness_call')).toHaveLength(1));
    expect(calls('record_awareness_call')[0]).toEqual({
      p_rent_request_id: 'rr-1', p_subject_type: 'tenant', p_subject_phone: '0700111222', p_dial_started_at: keep.dialStartedAt,
      p_call_result: 'answered', p_subject_user_id: 'tenant-1', p_aware_30m: 'heard', p_aware_merchant_codes: 'did_not_know',
      p_explained: 'partly', p_note: 'Asked for the codes in writing',
    });
    expect(toastSuccess).toHaveBeenCalledWith('Awareness call saved');
    // fresh data was read after the save, the form closed and the remembered call was cleared
    await waitFor(() => expect(calls('get_awareness_calls_for_request').length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByRole('form', { name: /Record awareness call feedback/ })).not.toBeInTheDocument());
    expect(window.sessionStorage.getItem('awareness-dial:rr-1')).toBeNull();
    expect(screen.queryByTestId('awareness-reminder')).not.toBeInTheDocument();
    expect(await screen.findByText('1 saved')).toBeInTheDocument();
  });

  it('keeps the form open after leaving the app and reloading (the dial is kept in sessionStorage)', async () => {
    window.sessionStorage.setItem('awareness-dial:rr-1', JSON.stringify({ subject: 'landlord', phone: '+256700333444', dialStartedAt: new Date(Date.now() - 5 * 60_000).toISOString() }));
    render(<AwarenessCallPanel request={request} />, { wrapper });
    const form = await screen.findByRole('form', { name: /Record awareness call feedback/ });
    expect(within(form).getByText(/Call to the landlord/)).toBeInTheDocument();
  });

  it('forgets a dial older than a day', async () => {
    window.sessionStorage.setItem('awareness-dial:rr-1', JSON.stringify({ subject: 'tenant', phone: '0700111222', dialStartedAt: new Date(Date.now() - 30 * 3_600_000).toISOString() }));
    render(<AwarenessCallPanel request={request} />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    expect(screen.queryByRole('form', { name: /Record awareness call feedback/ })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('awareness-dial:rr-1')).toBeNull();
  });

  it('records an unanswered call without the questions', async () => {
    const user = userEvent.setup();
    render(<AwarenessCallPanel request={request} />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    await user.click(screen.getByRole('button', { name: /Record feedback/ }));
    const form = await screen.findByRole('form', { name: /Record awareness call feedback/ });

    // no call button was tapped, so it asks who was called
    await user.click(within(form).getByRole('radio', { name: 'Landlord' }));
    await user.click(within(form).getByRole('radio', { name: 'Phone off' }));
    expect(within(form).queryByRole('radiogroup', { name: /UGX 30,000,000/ })).not.toBeInTheDocument();
    expect(within(form).queryByText('090999')).not.toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Save call' }));

    await waitFor(() => expect(calls('record_awareness_call')).toHaveLength(1));
    expect(calls('record_awareness_call')[0]).toMatchObject({
      p_subject_type: 'landlord', p_subject_phone: '+256700333444', p_call_result: 'phone_off', p_subject_user_id: null,
      p_aware_30m: null, p_aware_merchant_codes: null, p_explained: null, p_note: null,
    });
    expect(Number.isNaN(Date.parse(calls('record_awareness_call')[0].p_dial_started_at as string))).toBe(false);
  });

  it('shows the server message and keeps the form when saving fails', async () => {
    saveError = 'a call can be recorded up to 7 days after it was dialled';
    const user = userEvent.setup();
    render(<AwarenessCallPanel request={request} />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    await user.click(screen.getByRole('button', { name: /Record feedback/ }));
    const form = await screen.findByRole('form', { name: /Record awareness call feedback/ });
    await user.click(within(form).getByRole('radio', { name: 'Tenant' }));
    await user.click(within(form).getByRole('radio', { name: 'No answer' }));
    await user.click(within(form).getByRole('button', { name: 'Save call' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('up to 7 days');
    expect(toastError).toHaveBeenCalled();
    expect(screen.getByRole('form', { name: /Record awareness call feedback/ })).toBeInTheDocument();
  });

  it('lists earlier calls grouped by team, read-only', async () => {
    stored = [
      call({ id: 'c-3', caller_team: 'tenant_ops', caller_name: 'Peter Ssemwogerere', pipeline_stage: 'tenant_ops_approved', call_result: 'no_answer', aware_30m: null, aware_merchant_codes: null, explained: null, note: null }),
      call({ id: 'c-2', caller_team: 'agent_ops' }),
      call({ id: 'c-1', caller_team: 'service_centre', caller_name: 'Sarah Nakato', subject_type: 'landlord', pipeline_stage: 'service_center_review', explained: 'yes', aware_30m: 'knew', aware_merchant_codes: 'knew', note: null }),
    ];
    render(<AwarenessCallPanel request={request} />, { wrapper });
    const earlier = await screen.findByTestId('awareness-earlier');
    expect(within(earlier).getByText('Earlier stages said…')).toBeInTheDocument();
    // grouped in pipeline order: service centre, agent ops, tenant ops
    const teams = within(earlier).getAllByTestId(/awareness-team-/).map((n) => n.getAttribute('data-testid'));
    expect(teams).toEqual(['awareness-team-service_centre', 'awareness-team-agent_ops', 'awareness-team-tenant_ops']);
    const agentOps = within(earlier).getByTestId('awareness-team-agent_ops');
    expect(within(agentOps).getByText('Grace Namukasa', { exact: false })).toBeInTheDocument();
    expect(within(agentOps).getByText('Heard but unsure')).toBeInTheDocument();
    expect(within(agentOps).getByText(/Wanted the codes in writing/)).toBeInTheDocument();
    expect(within(agentOps).getByText('At stage: Agent ops approved')).toBeInTheDocument();
    expect(within(earlier).getByText('At stage: Service centre review')).toBeInTheDocument();
    expect(within(earlier).queryByRole('button')).not.toBeInTheDocument();
    expect(within(earlier).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('awareness-reminder')).not.toBeInTheDocument();
  });

  it('shows nothing at all to someone who may not read the log', async () => {
    readError = 'not authorized';
    const { container } = render(<AwarenessCallPanel request={request} />, { wrapper });
    await waitFor(() => expect(calls('get_awareness_calls_for_request')).toHaveLength(1));
    await waitFor(() => expect(container.querySelector('[data-testid="awareness-call-section"]')).toBeNull());
  });

  it('never uses the words loan, lender, ROI or interest', async () => {
    stored = [call({})];
    const { container } = render(<AwarenessCallPanel request={request} />, { wrapper });
    await screen.findByTestId('awareness-earlier');
    expect(container.textContent).not.toMatch(/\b(loan|lender|ROI|interest)\b/i);
  });

  it('puts the suggested person first and highlights that button (tenant by default)', async () => {
    render(<AwarenessCallPanel request={request} />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    const links = screen.getAllByRole('link').filter((l) => /^Call (tenant|landlord)/.test(l.getAttribute('aria-label') ?? ''));
    expect(links.map((l) => l.getAttribute('aria-label')?.split(' ')[1])).toEqual(['tenant', 'landlord']);
    expect(links[0]).toHaveAttribute('data-suggested', 'true');
    expect(links[1]).not.toHaveAttribute('data-suggested');
  });

  it('starts with "Call landlord" when the stage is Landlord Ops', async () => {
    render(<AwarenessCallPanel request={request} defaultSubject="landlord" />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    const links = screen.getAllByRole('link').filter((l) => /^Call (tenant|landlord)/.test(l.getAttribute('aria-label') ?? ''));
    expect(links.map((l) => l.getAttribute('aria-label')?.split(' ')[1])).toEqual(['landlord', 'tenant']);
    expect(links[0]).toHaveAttribute('data-suggested', 'true');
  });

  it('"Record feedback" starts with the stage\'s usual person already selected', async () => {
    const user = userEvent.setup();
    render(<AwarenessCallPanel request={request} defaultSubject="landlord" />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    await user.click(screen.getByRole('button', { name: /Record feedback/ }));
    const form = await screen.findByRole('form', { name: /Record awareness call feedback/ });
    expect(within(form).getByRole('radio', { name: 'Landlord' })).toHaveAttribute('aria-checked', 'true');
    expect(within(form).getByText(/Call to the landlord/)).toBeInTheDocument();
    // saving without touching the chooser records the landlord call
    await user.click(within(form).getByRole('radio', { name: 'No answer' }));
    await user.click(within(form).getByRole('button', { name: 'Save call' }));
    await waitFor(() => expect(calls('record_awareness_call')).toHaveLength(1));
    expect(calls('record_awareness_call')[0]).toMatchObject({ p_subject_type: 'landlord', p_subject_phone: '+256700333444' });
  });

  it('asks the three questions in the exact words of the plan', async () => {
    const user = userEvent.setup();
    render(<AwarenessCallPanel request={request} />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    await user.click(screen.getByRole('button', { name: /Record feedback/ }));
    const form = await screen.findByRole('form', { name: /Record awareness call feedback/ });
    await user.click(within(form).getByRole('radio', { name: 'Tenant' }));
    await user.click(within(form).getByRole('radio', { name: 'Answered' }));
    expect(within(form).getByText('Does this person know that a tenant who pays well can grow their access up to UGX 30,000,000?')).toBeInTheDocument();
    expect(within(form).getByText('Does this person know they can pay by themselves using the Welile merchant codes (self-payment)?')).toBeInTheDocument();
    expect(within(form).getByText('Did you explain it to them on this call?')).toBeInTheDocument();
  });

  it('earlier answers use the renamed labels', async () => {
    stored = [call({})];
    render(<AwarenessCallPanel request={request} />, { wrapper });
    const earlier = await screen.findByTestId('awareness-earlier');
    expect(within(earlier).getByText('Knew about 30M access')).toBeInTheDocument();
    expect(within(earlier).getByText('Knew about merchant-code self-payment')).toBeInTheDocument();
  });

  it('has a smaller "Call agent" button last, after tenant and landlord', async () => {
    render(<AwarenessCallPanel request={request} />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    const names = screen.getAllByRole('link').map((l) => l.getAttribute('aria-label') ?? '').filter((n) => /^Call (tenant|landlord|agent)/.test(n));
    expect(names.map((n) => n.split(' ')[1])).toEqual(['tenant', 'landlord', 'agent']);
    expect(screen.getByRole('link', { name: /Call agent 0700555666/ })).toHaveAttribute('href', 'tel:0700555666');
    expect(screen.getByRole('link', { name: /Call agent/ })).toHaveClass('h-9');
  });

  it('Landlord Ops order is landlord, tenant, agent', async () => {
    render(<AwarenessCallPanel request={request} defaultSubject="landlord" />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    const names = screen.getAllByRole('link').map((l) => l.getAttribute('aria-label') ?? '').filter((n) => /^Call (tenant|landlord|agent)/.test(n));
    expect(names.map((n) => n.split(' ')[1])).toEqual(['landlord', 'tenant', 'agent']);
  });

  it('disables "Call agent" when the request has no agent phone', async () => {
    render(<AwarenessCallPanel request={{ ...request, agent_phone: '' }} />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    expect(screen.getByRole('button', { name: /Call agent/ })).toBeDisabled();
  });

  it('records an agent call with the agent id, and a landlord call without a user id', async () => {
    const user = userEvent.setup();
    render(<AwarenessCallPanel request={request} />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    fireEvent.click(screen.getByRole('link', { name: /Call agent/ }));
    expect(JSON.parse(window.sessionStorage.getItem('awareness-dial:rr-1')!)).toMatchObject({ subject: 'agent', phone: '0700555666' });
    comeBack();
    const form = await screen.findByRole('form', { name: /Record awareness call feedback/ });
    expect(within(form).getByText(/Call to the agent/)).toBeInTheDocument();
    await user.click(within(form).getByRole('radio', { name: 'No answer' }));
    await user.click(within(form).getByRole('button', { name: 'Save call' }));
    await waitFor(() => expect(calls('record_awareness_call')).toHaveLength(1));
    expect(calls('record_awareness_call')[0]).toMatchObject({ p_subject_type: 'agent', p_subject_phone: '0700555666', p_subject_user_id: 'agent-1' });
  });

  it('passes no user id for an agent when the request has none', async () => {
    const user = userEvent.setup();
    render(<AwarenessCallPanel request={{ ...request, agent_id: null }} />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    await user.click(screen.getByRole('button', { name: /Record feedback/ }));
    const form = await screen.findByRole('form', { name: /Record awareness call feedback/ });
    await user.click(within(form).getByRole('radio', { name: 'Agent' }));
    await user.click(within(form).getByRole('radio', { name: 'Wrong number' }));
    await user.click(within(form).getByRole('button', { name: 'Save call' }));
    await waitFor(() => expect(calls('record_awareness_call')).toHaveLength(1));
    expect(calls('record_awareness_call')[0]).toMatchObject({ p_subject_type: 'agent', p_subject_user_id: null });
  });

  it('keeps the buttons and form when the earlier calls fail to load, and offers Retry', async () => {
    readError = 'connection reset';
    const user = userEvent.setup();
    render(<AwarenessCallPanel request={request} />, { wrapper });
    expect(await screen.findByTestId('awareness-load-error')).toHaveTextContent('Could not load earlier calls');
    expect(screen.getByRole('link', { name: /Call tenant/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Record feedback/ })).toBeInTheDocument();
    expect(screen.queryByTestId('awareness-reminder')).not.toBeInTheDocument();

    readError = null;
    stored = [call({})];
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('awareness-earlier')).toBeInTheDocument();
    expect(screen.queryByTestId('awareness-load-error')).not.toBeInTheDocument();
  });

  it('read-only: only the earlier stages, with no call buttons, reminder or form', async () => {
    stored = [call({})];
    render(<AwarenessCallPanel request={request} readOnly />, { wrapper });
    expect(await screen.findByTestId('awareness-earlier')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record feedback/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('awareness-reminder')).not.toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  });

  it('read-only with no calls says so quietly, and still hides for someone not authorized', async () => {
    const { unmount } = render(<AwarenessCallPanel request={request} readOnly />, { wrapper });
    expect(await screen.findByTestId('awareness-readonly-empty')).toHaveTextContent('No awareness calls were recorded at earlier stages.');
    expect(screen.queryByTestId('awareness-reminder')).not.toBeInTheDocument();
    unmount();
    readError = 'not authorized';
    const { container } = render(<AwarenessCallPanel request={request} readOnly />, { wrapper });
    await waitFor(() => expect(container.querySelector('[data-testid="awareness-call-section"]')).toBeNull());
  });

  it('adds the landlord checklist line only when asked', async () => {
    const { unmount } = render(<AwarenessCallPanel request={request} landlordChecklistNote />, { wrapper });
    expect(await screen.findByTestId('awareness-landlord-note')).toHaveTextContent('This is separate from the landlord verification call checklist below.');
    unmount();
    render(<AwarenessCallPanel request={request} />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    expect(screen.queryByTestId('awareness-landlord-note')).not.toBeInTheDocument();
  });

  it('falls back to the two long-standing merchant codes when the live read fails', async () => {
    channelsResult = { data: null, error: { message: 'boom' } };
    const user = userEvent.setup();
    render(<AwarenessCallPanel request={request} />, { wrapper });
    await screen.findByTestId('awareness-reminder');
    await user.click(screen.getByRole('button', { name: /Record feedback/ }));
    const form = await screen.findByRole('form', { name: /Record awareness call feedback/ });
    await user.click(within(form).getByRole('radio', { name: 'Tenant' }));
    await user.click(within(form).getByRole('radio', { name: 'Answered' }));
    expect(within(form).getByText('090777')).toBeInTheDocument();
    expect(within(form).getByText('4380664')).toBeInTheDocument();
  });

  it('with a batched status of zero calls it reads no history and shows the reminder; with calls it reads and lists them', async () => {
    const { unmount } = render(<AwarenessCallPanel request={request} knownCalls={{ calls_total: 0 }} />, { wrapper });
    expect(await screen.findByTestId('awareness-reminder')).toBeInTheDocument();
    expect(calls('get_awareness_calls_for_request')).toHaveLength(0);
    unmount();

    stored = [call({})];
    render(<AwarenessCallPanel request={request} knownCalls={{ calls_total: 1 }} />, { wrapper });
    expect(await screen.findByTestId('awareness-earlier')).toBeInTheDocument();
    expect(calls('get_awareness_calls_for_request')).toHaveLength(1);
  });

  it('while the batch is still loading it reads nothing and shows no reminder yet', async () => {
    render(<AwarenessCallPanel request={request} knownCalls={null} />, { wrapper });
    await screen.findByTestId('awareness-call-section');
    expect(calls('get_awareness_calls_for_request')).toHaveLength(0);
    expect(screen.queryByTestId('awareness-reminder')).not.toBeInTheDocument();
  });
});
