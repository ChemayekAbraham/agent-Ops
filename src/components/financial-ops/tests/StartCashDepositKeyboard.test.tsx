/**
 * Start Cash Deposit: keyboard navigation — Tab focus order, focus moving to
 * the first error, and step changes driven by keyboard only.
 * Backend is mocked; nothing is sent and no deposit is created.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: vi.fn(async () => ({ data: { sms_sent: true }, error: null })) } },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { StartCashDepositDialog } from '@/components/financial-ops/StartCashDepositDialog';

beforeAll(() => {
  // jsdom has no layout; the form scrolls the first error into view.
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

const setup = () => {
  const user = userEvent.setup();
  render(<StartCashDepositDialog open onOpenChange={() => {}} />);
  return user;
};
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const continueBtn = () => screen.getByRole('button', { name: /Continue/i });
const heading = (name: RegExp) => screen.getByRole('heading', { name });

/** Tab forward until `target` has focus; fails if it is never reached. */
const tabTo = async (user: ReturnType<typeof userEvent.setup>, target: HTMLElement, max = 30) => {
  for (let i = 0; i < max && document.activeElement !== target; i++) await user.tab();
  expect(document.activeElement).toBe(target);
};

/** Pressing Continue by keyboard (focus + Enter). */
const pressContinue = async (user: ReturnType<typeof userEvent.setup>) => {
  continueBtn().focus();
  await user.keyboard('{Enter}');
};

const typeInto = async (user: ReturnType<typeof userEvent.setup>, label: RegExp, value: string) => {
  const el = field(label);
  el.focus();
  await user.clear(el);
  await user.keyboard(value);
};

const completePerson = async (user: ReturnType<typeof userEvent.setup>) => {
  await typeInto(user, /^First name/i, 'Nakamya');
  await typeInto(user, /^Last name/i, 'Sharita');
  await typeInto(user, /Depositor phone number/i, '0704123456');
  await pressContinue(user);
  await waitFor(() => expect(field(/Cash amount/i)).toBeTruthy());
};

describe('StartCashDepositDialog — keyboard navigation', () => {
  it('tabs through step 1 fields in reading order, then reaches Continue', async () => {
    const user = setup();
    const first = field(/^First name/i);
    await tabTo(user, first);
    const order: Element[] = [first];
    for (let i = 0; i < 12 && document.activeElement !== continueBtn(); i++) {
      await user.tab();
      order.push(document.activeElement!);
    }
    const idx = (el: Element) => order.indexOf(el);
    const last = field(/^Last name/i);
    const phone = field(/Depositor phone number/i);
    expect(idx(last)).toBeGreaterThan(idx(first));
    expect(idx(phone)).toBeGreaterThan(idx(last));
    expect(idx(continueBtn())).toBeGreaterThan(idx(phone));
  });

  it('Shift+Tab walks backwards through the fields', async () => {
    const user = setup();
    const phone = field(/Depositor phone number/i);
    await tabTo(user, phone);
    const seen: Element[] = [];
    for (let i = 0; i < 6; i++) {
      await user.tab({ shift: true });
      seen.push(document.activeElement!);
    }
    expect(seen).toContain(field(/^Last name/i));
    expect(seen).toContain(field(/^First name/i));
    expect(seen.indexOf(field(/^Last name/i))).toBeLessThan(seen.indexOf(field(/^First name/i)));
  });

  it('Continue by keyboard with gaps moves focus to the first invalid field', async () => {
    const user = setup();
    await pressContinue(user);
    await waitFor(() => expect(document.activeElement).toBe(field(/^First name/i)));
    expect(heading(/Who is depositing/i)).toBeTruthy();
  });

  it('focuses the first invalid field even when earlier ones are filled', async () => {
    const user = setup();
    await typeInto(user, /^First name/i, 'Nakamya');
    await typeInto(user, /^Last name/i, 'Sharita');
    await pressContinue(user);
    await waitFor(() => expect(document.activeElement).toBe(field(/Depositor phone number/i)));
  });

  it('focuses the amount, then the email, on later steps', async () => {
    const user = setup();
    await completePerson(user);
    await pressContinue(user);
    await waitFor(() => expect(document.activeElement).toBe(field(/Cash amount/i)));
    await typeInto(user, /Cash amount/i, '250000');
    await pressContinue(user);
    await waitFor(() => expect(field(/email/i)).toBeTruthy());
    await pressContinue(user);
    await waitFor(() => expect(document.activeElement).toBe(field(/email/i)));
  });

  it('Enter on Continue advances a step and announces it; Back by keyboard returns', async () => {
    const user = setup();
    await completePerson(user);
    expect(screen.getByText(/Step 2 of 4/i)).toBeTruthy();
    const back = screen.getByRole('button', { name: /^Back/i });
    back.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByText(/Step 1 of 4/i)).toBeTruthy());
    expect(field(/^First name/i).value).toBe('Nakamya');
    expect(field(/Depositor phone number/i).value).toBe('0704123456');
  });

  it('Space also activates Continue', async () => {
    const user = setup();
    await typeInto(user, /^First name/i, 'Nakamya');
    await typeInto(user, /^Last name/i, 'Sharita');
    await typeInto(user, /Depositor phone number/i, '0704123456');
    continueBtn().focus();
    await user.keyboard(' ');
    await waitFor(() => expect(screen.getByText(/Step 2 of 4/i)).toBeTruthy());
  });

  it('keeps focus inside the dialog while tabbing', async () => {
    const user = setup();
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 25; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});
