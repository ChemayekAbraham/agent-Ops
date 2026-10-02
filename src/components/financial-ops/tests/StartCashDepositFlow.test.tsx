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

const onPersonStep = () => screen.getByText(/Who is depositing/i);
const onCashStep = () => screen.getByText(/How much cash/i);
const onEmailStep = () => screen.getByText(/Where should the code go/i);

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
    expect(screen.getByText(/at least 9 digits|phone/i, { selector: 'p,span,div' })).toBeTruthy();
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
    expect(screen.getByText(/amount/i, { selector: '[role="alert"], p, span' })).toBeTruthy();
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
    expect(screen.getByText(/email/i, { selector: '[role="alert"], p, span' })).toBeTruthy();
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
