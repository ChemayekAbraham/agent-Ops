import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), storage: { from: () => ({ upload: vi.fn(), getPublicUrl: () => ({ data: { publicUrl: 'https://x.test/e.webp' } }) }) } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'agent-1' }, roles: ['agent'] }) }));

import { RenewalChoiceDialog } from '../RenewalDialog';

const TARGET = { prevId: 'prev-1', tenantName: 'Grace Nakato', currentRent: 300000, currentDays: 30 };
const ALLOWED = [7, 14, 30, 60, 90, 120];

// The server's answers, as fixtures: the dialog must show them and never work them out.
const adviceFor = (days: number) => ({
  prev_request_id: 'prev-1', current_days: 30, chosen_days: days, allowed_days: ALLOWED, current_rent: 300000, on_time_pct: 92, fully_repaid: true,
  longest_missed_streak: 0, band: 'A', suggested_step_pct: 20, avg_daily_paid: 14000, affordability_rent: 380000, access_limit: 900000,
  suggested_max_rent: days === 60 ? 420000 : 360000,
  reasons: ['92% of due days were paid on time.', 'That is band A.', `The Rent Access Limit is UGX 900,000.`, 'Suggested maximum rent. This is advice only.'],
  computed_at: '2026-10-14T10:00:00Z',
});
const previewFor = (rent: number, days: number) => ({
  prev_request_id: 'prev-1', current_rent: 300000, current_days: 30, new_rent: rent, new_days: days, access_fee: 1, request_fee: 20000,
  total_repayment: rent + 100000, daily_repayment: 12345, repayment_frequency: 'daily', changed: rent !== 300000 || days !== 30,
  explanation_required: rent !== 300000 || days !== 30, min_explanation_length: 10, reason_codes: ['landlord_raised', 'moved_house', 'tenant_requested_lower', 'other'],
});

// jsdom lacks the pointer-capture and scroll APIs Radix Select calls when it opens.
beforeAll(() => {
  const proto = window.HTMLElement.prototype as any;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (name: string, args: any) => {
    if (name === 'get_renewal_advice') return { data: adviceFor(args.p_new_days ?? 30), error: null };
    if (name === 'preview_renewal_amount') return { data: previewFor(args.p_new_rent, args.p_new_days ?? 30), error: null };
    return { data: null, error: { message: 'unexpected ' + name } };
  });
});

const setup = () => {
  const onDone = vi.fn();
  render(<RenewalChoiceDialog target={TARGET} onDone={onDone} />);
  return onDone;
};
const rentBox = () => screen.getByLabelText('New rent (UGX)') as HTMLInputElement;
const typeRent = (v: string) => fireEvent.change(rentBox(), { target: { value: v } });
const text = (re: RegExp) => screen.findByText(re);

describe('RenewalChoiceDialog', () => {
  it('shows the current rent, the server suggestion with its reasons, and starts on the current rent and days', async () => {
    setup();
    expect(await text(/Suggested up to UGX\s360,000/)).toBeInTheDocument();
    expect(screen.getByText('92% of due days were paid on time.')).toBeInTheDocument();
    // the closing "advice only" line is shown once, in the card heading, not repeated in the list
    expect(screen.queryByText('Suggested maximum rent. This is advice only.')).not.toBeInTheDocument();
    expect(rentBox().value).toBe('300,000');
    expect(screen.getByText(/Current rent/)).toBeInTheDocument();
    expect(await text(/UGX\s12,345/)).toBeInTheDocument(); // the server's daily payment
    expect(await text(/Within suggestion/)).toBeInTheDocument();
    expect(screen.queryByText(/Why is the rent or number of days changing/)).not.toBeInTheDocument();
  });

  it('same rent and days: Continue goes straight through, no reason asked for', async () => {
    const onDone = setup();
    await text(/Within suggestion/);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toMatchObject({ newRent: 300000, newDays: 30, changed: false, reasonCode: null, dailyRepayment: 12345 });
  });

  it('a lower rent shows the blue hint and asks for a reason', async () => {
    setup();
    await text(/Within suggestion/);
    typeRent('250000');
    expect(await text(/Lower than current rent/)).toBeInTheDocument();
    expect(screen.getByText(/Why is the rent or number of days changing/)).toBeInTheDocument();
  });

  it('a higher rent within the suggestion shows the green hint', async () => {
    setup();
    await text(/Within suggestion/);
    typeRent('350000');
    expect(await text(/Within suggestion/)).toBeInTheDocument();
    expect(screen.queryByText(/Above suggestion/)).not.toBeInTheDocument();
  });

  it('above the suggestion shows the amber hint with the amount and percent, and the button stays enabled', async () => {
    setup();
    await text(/Within suggestion/);
    typeRent('400000');
    expect(await text(/Above suggestion by UGX\s40,000 \(11%\)\. Reviewers will see this\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('a changed rent without a reason or explanation is stopped with a message, and nothing is sent on', async () => {
    const onDone = setup();
    await text(/Within suggestion/);
    typeRent('400000');
    await text(/Above suggestion/);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Pick a reason/);
    await userEvent.click(screen.getByRole('button', { name: 'Landlord raised rent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 10 characters/);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shows the explanation counter and accepts the choice once reason and explanation are in', async () => {
    const onDone = setup();
    await text(/Within suggestion/);
    typeRent('400000');
    await text(/Above suggestion/);
    await userEvent.click(screen.getByRole('button', { name: 'Landlord raised rent' }));
    await userEvent.type(screen.getByLabelText('Explain the change'), 'The landlord raised it.');
    expect(screen.getByText(/23\/10 characters minimum/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toMatchObject({ newRent: 400000, changed: true, reasonCode: 'landlord_raised', explanation: 'The landlord raised it.' });
  });

  it('a rent far above the suggestion still goes through (the suggestion never blocks)', async () => {
    const onDone = setup();
    await text(/Within suggestion/);
    typeRent('5000000');
    await text(/Above suggestion by UGX\s4,640,000/);
    await userEvent.click(screen.getByRole('button', { name: 'Other' }));
    await userEvent.type(screen.getByLabelText('Explain the change'), 'New house with a much higher rent.');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toMatchObject({ newRent: 5000000, changed: true, reasonCode: 'other' });
  });

  it('fetches the advice and the amount fresh at the moment of continuing', async () => {
    setup();
    await text(/Within suggestion/);
    rpcMock.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(rpcMock.mock.calls.map((c) => c[0]).sort()).toEqual(['get_renewal_advice', 'preview_renewal_amount']));
  });

  it('refuses a rent of 0', async () => {
    const onDone = setup();
    await text(/Within suggestion/);
    typeRent('0');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/above UGX 0/);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('offers only the day counts the server returned, and changing the days re-runs the advice and the preview', async () => {
    setup();
    await text(/Within suggestion/);
    await userEvent.click(screen.getByRole('combobox', { name: 'Number of days' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['7 days', '14 days', '30 days (current)', '60 days', '90 days', '120 days']);
    rpcMock.mockClear();
    await userEvent.click(screen.getByRole('option', { name: '60 days' }));
    expect(await text(/Suggested up to UGX\s420,000/)).toBeInTheDocument();
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('get_renewal_advice', { p_prev_request_id: 'prev-1', p_new_days: 60 });
      expect(rpcMock).toHaveBeenCalledWith('preview_renewal_amount', { p_prev_request_id: 'prev-1', p_new_rent: 300000, p_new_days: 60 });
    });
    // days changed with the rent unchanged: a reason is needed
    expect(screen.getByText(/Why is the rent or number of days changing/)).toBeInTheDocument();
  });

  it('says so, in words, when the suggestion cannot be loaded, and still lets the agent continue', async () => {
    rpcMock.mockImplementation(async (name: string, args: any) =>
      name === 'get_renewal_advice' ? { data: null, error: { message: 'boom' } } : { data: previewFor(args.p_new_rent, args.p_new_days ?? 30), error: null });
    setup();
    expect(await text(/suggestion could not be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('uses the regulatory wording and none of the banned words', async () => {
    const { container } = render(<RenewalChoiceDialog target={TARGET} onDone={vi.fn()} />);
    await screen.findAllByText(/Within suggestion/);
    expect(document.body.textContent).not.toMatch(/\b(loan|lender|interest|ROI)\b/i);
    expect(container).toBeTruthy();
  });
});
