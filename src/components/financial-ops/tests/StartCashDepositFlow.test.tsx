/**
 * Start Cash Deposit: step navigation and per-step validation messages.
 * The function call is mocked — nothing is sent and no deposit is created.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const invokeSpy = vi.fn(async () => ({ data: { sms_sent: true }, error: null }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: (...a: any[]) => invokeSpy(...(a as [])) } },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { StartCashDepositDialog } from '@/components/financial-ops/StartCashDepositDialog';

const setup = () => render(<StartCashDepositDialog open onOpenChange={() => {}} />);
const fill = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const btn = (name: RegExp) => screen.getByRole('button', { name });
const next = () => fireEvent.click(btn(/Continue/i));
const back = () => fireEvent.click(btn(/Back/i));

const onPersonStep = () => screen.getByRole("heading", { name: /Who is depositing/i });
const onCashStep = () => screen.getByRole("heading", { name: /How much cash/i });
const onEmailStep = () => screen.getByRole("heading", { name: /Where should the code go/i });

const completePerson = () => {
  fill(/First name/i, 'Nakamya');
  fill(/Last name/i, 'Sharita');
  fill(/Depositor phone number/i, '0704123456');
  next();
};

describe('StartCashDepositDialog — steps and errors', () => {
  beforeEach(() => invokeSpy.mockClear());

  it('starts on step 1 with no errors and Cancel instead of Back', () => {
    setup();
    onPersonStep();
    expect(screen.getByText(/Step 1 of 4/i)).toBeTruthy();
    expect(screen.queryByText(/Please type the first name/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Back/i })).toBeNull();
    btn(/Cancel/i);
  });

  it('step 1: Continue with empty fields shows every message and stays put', () => {
    setup();
    next();
    onPersonStep();
    expect(screen.getByText(/Please type the first name/i)).toBeTruthy();
    expect(screen.getByText(/Please type the last name/i)).toBeTruthy();
    expect(screen.getByText(/Please type the phone number/i)).toBeTruthy();
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('clears each field error as soon as that field is corrected (no blur needed)', () => {
    setup();
    next();
    onPersonStep();
    expect(screen.getByText(/Please type the first name/i)).toBeTruthy();
    expect(screen.getByText(/Please type the last name/i)).toBeTruthy();
    expect(screen.getByText(/Please type the phone number/i)).toBeTruthy();

    fill(/First name/i, 'Nakamya');
    expect(screen.queryByText(/Please type the first name/i)).toBeNull();
    expect(screen.getByText(/Please type the last name/i)).toBeTruthy();
    expect(screen.getByText(/Please type the phone number/i)).toBeTruthy();

    fill(/Last name/i, 'Sharita');
    expect(screen.queryByText(/Please type the last name/i)).toBeNull();

    fill(/Depositor phone number/i, '0704');
    expect(screen.getByText(/too short/i)).toBeTruthy();
    fill(/Depositor phone number/i, '0704123456');
    expect(screen.queryByText(/too short/i)).toBeNull();
    expect(screen.queryByText(/Please type the phone number/i)).toBeNull();

    next();
    onCashStep();
    next();
    onCashStep();
    expect(screen.getByText(/Please type the cash amount/i)).toBeTruthy();
    fill(/Cash amount/i, '250000');
    expect(screen.queryByText(/Please type the cash amount/i)).toBeNull();

    next();
    onEmailStep();
    next();
    onEmailStep();
    expect(screen.getByText(/Please type the email address/i)).toBeTruthy();
    fill(/Depositor email address/i, 'depositor@example.com');
    expect(screen.queryByText(/Please type the email address/i)).toBeNull();
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('step 1: a too-short phone number gets a plain-language message', () => {
    setup();
    fill(/First name/i, 'Nakamya');
    fill(/Last name/i, 'Sharita');
    fill(/Depositor phone number/i, '0704');
    next();
    onPersonStep();
    expect(screen.getByText(/too short/i)).toBeTruthy();
  });

  it('step 2: missing amount and too-small amount show messages and stay put', () => {
    setup();
    completePerson();
    onCashStep();
    next();
    onCashStep();
    expect(screen.getByText(/Please type the cash amount/i)).toBeTruthy();
    fill(/Cash amount/i, '100');
    next();
    onCashStep();
    expect(screen.getByText(/smallest amount is UGX 500/i)).toBeTruthy();
  });

  it('step 2: Operational Float is shown as the fixed purpose', () => {
    setup();
    completePerson();
    expect(screen.getAllByText(/Operational Float/i).length).toBeGreaterThan(0);
  });

  it('step 3: missing and malformed email show messages and stay put', () => {
    setup();
    completePerson();
    fill(/Cash amount/i, '250000');
    next();
    onEmailStep();
    next();
    onEmailStep();
    expect(screen.getByText(/Please type the email address/i)).toBeTruthy();
    fill(/Depositor email address/i, 'bad');
    next();
    onEmailStep();
    expect(screen.getByText(/does not look right/i)).toBeTruthy();
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('Back returns to the previous step and keeps what was typed', () => {
    setup();
    completePerson();
    fill(/Cash amount/i, '250000');
    next();
    onEmailStep();
    back();
    onCashStep();
    expect((screen.getByLabelText(/Cash amount/i) as HTMLInputElement).value).toMatch(/250/);
    back();
    onPersonStep();
    expect((screen.getByLabelText(/First name/i) as HTMLInputElement).value).toBe('Nakamya');
    expect((screen.getByLabelText(/Last name/i) as HTMLInputElement).value).toBe('Sharita');
  });

  it('a valid run reaches the Send step with a summary, without sending yet', () => {
    setup();
    completePerson();
    fill(/Cash amount/i, '250000');
    next();
    fill(/Depositor email address/i, 'depositor@example.com');
    next();
    expect(screen.getByText(/Step 4 of 4/i)).toBeTruthy();
    expect(screen.getByText(/Nakamya/)).toBeTruthy();
    expect(screen.getByText(/depositor@example\.com/)).toBeTruthy();
    btn(/Send code by SMS/i);
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});

describe('StartCashDepositDialog — accessibility of errors', () => {
  it('announces errors with role=alert and links each field to its message', () => {
    setup();
    next();
    const first = screen.getByLabelText(/First name/i);
    expect(first.getAttribute('aria-invalid')).toBe('true');
    const msgId = first.getAttribute('aria-describedby')!;
    const msg = document.getElementById(msgId)!;
    expect(msg.getAttribute('role')).toBe('alert');
    expect(msg.textContent).toMatch(/Please type the first name/i);
    const phone = screen.getByLabelText(/Depositor phone number/i);
    expect(phone.getAttribute('aria-required')).toBe('true');
    expect(document.getElementById(phone.getAttribute('aria-describedby')!)?.textContent)
      .toMatch(/Please type the phone number/i);
  });

  it('has no error link before anything is touched, and announces the step', () => {
    setup();
    expect(screen.getByLabelText(/First name/i).getAttribute('aria-describedby')).toBeNull();
    expect(screen.getByText(/Step 1 of 4/i).getAttribute('aria-live')).toBe('polite');
  });
});

/**
 * Loading state: the Send button is locked while the request is in flight, so a
 * slow connection can never start a second deposit.
 */
describe('StartCashDepositDialog — sending state', () => {
  beforeEach(() => invokeSpy.mockClear());

  const reachSend = () => {
    setup();
    completePerson();
    fill(/Cash amount/i, '250000');
    next();
    fill(/Depositor email address/i, 'depositor@example.com');
    next();
  };

  const deferred = () => {
    let resolve!: (v: { data: any; error: any }) => void;
    const promise = new Promise<{ data: any; error: any }>((r) => { resolve = r; });
    return { promise, resolve };
  };

  it('locks Send with a loading state until the request finishes, keeping the entered values', async () => {
    reachSend();
    const d = deferred();
    invokeSpy.mockImplementationOnce(() => d.promise);

    fireEvent.click(btn(/Send code by SMS/i));
    expect(invokeSpy).toHaveBeenCalledTimes(1);

    const send = screen.getByRole('button', { name: /sending/i });
    expect(send.hasAttribute('disabled')).toBe(true);
    expect(send.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText(/keep this screen open/i)).toBeTruthy();
    expect(screen.getByText(/Sending the code\. Please wait\./i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Back/i }).hasAttribute('disabled')).toBe(true);
    screen.getAllByRole('button', { name: /^Edit$/i }).forEach((e) => expect(e.hasAttribute('disabled')).toBe(true));

    d.resolve({ data: { error: 'Network unreachable', message: 'Network unreachable' }, error: null });

    await screen.findByText(/The code was not sent/i);
    const again = screen.getByRole('button', { name: /Try again/i });
    expect(again.hasAttribute('disabled')).toBe(false);
    expect(again.getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByText(/keep this screen open/i)).toBeNull();
    // Nothing was lost — the summary still carries what was typed.
    expect(screen.getByText(/UGX 250,000/i)).toBeTruthy();
    expect(screen.getByText(/depositor@example\.com/i)).toBeTruthy();
  });

  it('a second press while sending cannot start a second deposit', async () => {
    reachSend();
    const d = deferred();
    invokeSpy.mockImplementationOnce(() => d.promise);

    fireEvent.click(btn(/Send code by SMS/i));
    fireEvent.click(screen.getByRole('button', { name: /sending/i }));
    expect(invokeSpy).toHaveBeenCalledTimes(1);

    d.resolve({ data: { sms_sent: true }, error: null });
    await screen.findByRole('button', { name: /Continue/i });
  });

  it('cannot be dismissed while a send is in flight', async () => {
    const onOpenChange = vi.fn();
    render(<StartCashDepositDialog open onOpenChange={onOpenChange} />);
    completePerson();
    fill(/Cash amount/i, '250000');
    next();
    fill(/Depositor email address/i, 'depositor@example.com');
    next();
    const d = deferred();
    invokeSpy.mockImplementationOnce(() => d.promise);
    fireEvent.click(btn(/Send code by SMS/i));

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();

    d.resolve({ data: { sms_sent: true }, error: null });
    await screen.findByRole('button', { name: /Continue/i });
  });

  it('Escape still closes the form when nothing is being sent', () => {
    const onOpenChange = vi.fn();
    render(<StartCashDepositDialog open onOpenChange={onOpenChange} />);
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
