/**
 * FinOps cash deposit: depositor name captured in parts, submitted as one string.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const invokeSpy = vi.fn(async () => ({ data: { sms_sent: true, depositor_name: 'x', depositor_phone: '0700000000' }, error: null }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: (...a: any[]) => invokeSpy(...(a as [])) } },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { StartCashDepositDialog } from '@/components/financial-ops/StartCashDepositDialog';

const setup = () =>
  render(<StartCashDepositDialog open onOpenChange={() => {}} />);

const fill = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const next = () => fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

describe('StartCashDepositDialog — depositor name', () => {
  beforeEach(() => invokeSpy.mockClear());

  it('sends the concatenated depositor name', async () => {
    setup();
    fill(/First name/i, 'Nankambo');
    fill(/Other names/i, 'Grace');
    fill(/Last name/i, 'Sharimah');
    fill(/Depositor phone number/i, '0771234567');
    next();
    fill(/Cash amount/i, '50000');
    next();
    fill(/Depositor email address/i, 'depositor@example.com');
    next();
    fireEvent.click(screen.getByRole('button', { name: /Send code by SMS/i }));
    await waitFor(() => expect(invokeSpy).toHaveBeenCalled());
    const body = (invokeSpy.mock.calls[0] as any)[1].body;
    expect(body.cash_owner_name).toBe('Nankambo Grace Sharimah');
  });

  it('blocks submission when the last name is blank', () => {
    setup();
    fill(/First name/i, 'Nankambo');
    fill(/Depositor phone number/i, '0771234567');
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    expect(screen.getByText(/Please type the last name/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Who is depositing/i })).toBeTruthy();
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});
