/**
 * Start Cash Deposit: accessibility — required fields, error-message links,
 * and screen-reader announcements. Backend is mocked; nothing is sent.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: vi.fn(async () => ({ data: { sms_sent: true }, error: null })) } },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { StartCashDepositDialog } from '@/components/financial-ops/StartCashDepositDialog';

const setup = () => render(<StartCashDepositDialog open onOpenChange={() => {}} />);
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const fill = (label: RegExp, value: string) => fireEvent.change(field(label), { target: { value } });
const next = () => fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

/** The field must point at an alert whose text matches. */
const expectLinkedError = (label: RegExp, message: RegExp) => {
  const input = field(label);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  const ids = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  const linked = ids.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
  const err = linked.find((el) => message.test(el.textContent ?? ''));
  expect(err, `no linked error matching ${message} on ${label}`).toBeTruthy();
  expect(err!.closest('[role="alert"]') ?? (err!.getAttribute('role') === 'alert' ? err : null)).toBeTruthy();
};

const completePerson = () => {
  fill(/First name/i, 'Nakamya');
  fill(/Last name/i, 'Sharita');
  fill(/Depositor phone number/i, '0704123456');
  next();
};

describe('StartCashDepositDialog — accessibility', () => {
  it('marks required fields as required and leaves optional ones alone', () => {
    setup();
    for (const l of [/^First name/i, /^Last name/i, /Depositor phone number/i]) {
      const el = field(l);
      expect(el.required || el.getAttribute('aria-required') === 'true').toBe(true);
    }
    const other = field(/Other names/i);
    expect(other.required || other.getAttribute('aria-required') === 'true').toBe(false);
    completePerson();
    const amt = field(/Cash amount/i);
    expect(amt.required || amt.getAttribute('aria-required') === 'true').toBe(true);
    fill(/Cash amount/i, '250000');
    next();
    const email = field(/email/i);
    expect(email.required || email.getAttribute('aria-required') === 'true').toBe(true);
  });

  it('does not read the visual required star as part of the label', () => {
    setup();
    expect(screen.getByRole('textbox', { name: 'First name' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Last name' })).toBeTruthy();
  });

  it('starts with no errors flagged or announced', () => {
    setup();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(field(/^First name/i).getAttribute('aria-invalid')).not.toBe('true');
  });

  it('links each step-1 field to its own announced error', () => {
    setup();
    next();
    expectLinkedError(/^First name/i, /Please type the first name/i);
    expectLinkedError(/^Last name/i, /Please type the last name/i);
    expectLinkedError(/Depositor phone number/i, /phone number/i);
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(3);
    expect(document.activeElement).toBe(field(/^First name/i));
  });

  it('links amount and email errors on later steps', () => {
    setup();
    completePerson();
    next();
    expectLinkedError(/Cash amount/i, /Please type the cash amount/i);
    fill(/Cash amount/i, '250000');
    next();
    fill(/email/i, 'bad');
    next();
    expectLinkedError(/email/i, /does not look right/i);
  });

  it('removes the alert and invalid flag once the field is corrected', () => {
    setup();
    next();
    fill(/^First name/i, 'Nakamya');
    expect(field(/^First name/i).getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.queryByText(/Please type the first name/i)).toBeNull();
  });

  it('hides warning icons from screen readers', () => {
    setup();
    next();
    for (const a of screen.getAllByRole('alert')) {
      a.querySelectorAll('svg').forEach((svg) => expect(svg.getAttribute('aria-hidden')).toBe('true'));
    }
  });

  it('announces step changes with the step name and marks the current step', () => {
    setup();
    const status = screen.getByText(/Step 1 of 4/i);
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toMatch(/Who is depositing/i);
    const progress = screen.getByRole('list', { name: /Progress/i });
    const current = () => progress.querySelector('[aria-current="step"]')?.textContent ?? '';
    expect(current()).toMatch(/Person.*current step/i);
    completePerson();
    expect(screen.getByText(/Step 2 of 4/i).textContent).toMatch(/How much cash/i);
    expect(current()).toMatch(/Cash.*current step/i);
    expect(progress.textContent).toMatch(/Person\s*,\s*done/i);
    progress.querySelectorAll('li > span[aria-hidden="true"]').forEach((s) => expect(s.querySelector('svg')).toBeTruthy());
  });
});
