import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// --- Hoisted shared state for mocks ---
const supaState = vi.hoisted(() => ({
  response: { data: [] as any[], error: null as any },
  calls: [] as any[],
}));
const walletState = vi.hoisted(() => ({
  sendMoney: vi.fn(async (_phone: string, _amount: number, _desc: string) => ({ error: null })),
  wallet: { balance: 500000, user_id: 'me' },
}));
const toastState = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => {
  const makeChain = (table: string) => {
    const filters: any = { table };
    const chain: any = {
      select: (s: string) => { filters.select = s; return chain; },
      in: (col: string, vals: any[]) => { filters.in = { col, vals }; return chain; },
      ilike: (col: string, val: string) => { filters.ilike = { col, val }; return chain; },
      limit: (n: number) => {
        filters.limit = n;
        supaState.calls.push(filters);
        return Promise.resolve(supaState.response);
      },
    };
    return chain;
  };
  return { supabase: { from: (t: string) => makeChain(t) } };
});

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => walletState }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));
vi.mock('@/hooks/useFirstTransactionCelebration', () => ({
  useFirstTransactionCelebration: () => ({
    triggerCelebration: vi.fn(),
    markCelebrated: vi.fn(),
  }),
}));
vi.mock('@/components/Confetti', () => ({
  useConfetti: () => ({ fireSuccess: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: toastState }));

import { SendMoneyDialog } from '../SendMoneyDialog';

const renderDialog = () =>
  render(<SendMoneyDialog open onOpenChange={() => {}} />);

beforeEach(() => {
  supaState.calls.length = 0;
  supaState.response = { data: [], error: null };
  walletState.sendMoney.mockClear();
  toastState.error.mockClear();
  toastState.success.mockClear();
  localStorage.clear();
});

describe('SendMoneyDialog', () => {
  it('toggles between phone and email lookup modes', async () => {
    const user = userEvent.setup();
    renderDialog();

    // Starts in phone mode.
    expect(screen.getByLabelText(/Recipient Phone Number/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Recipient Email/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /use email instead/i }));

    expect(screen.getByLabelText(/Recipient Email/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Recipient Phone Number/i)).not.toBeInTheDocument();

    // Toggle back.
    await user.click(screen.getByRole('button', { name: /use phone instead/i }));
    expect(screen.getByLabelText(/Recipient Phone Number/i)).toBeInTheDocument();
  });

  it('debounces the lookup query until the user stops typing', async () => {
    const user = userEvent.setup();
    supaState.response = {
      data: [
        { id: 'other', full_name: 'Jane Doe', phone: '+256783673998', email: 'jane@example.com' },
      ],
      error: null,
    };

    renderDialog();
    const input = screen.getByLabelText(/Recipient Phone Number/i);
    await user.type(input, '0783673998');

    // Right after typing, no supabase call has fired yet (debounce 400ms).
    expect(supaState.calls.length).toBe(0);

    // Wait past the debounce window for the lookup to fire.
    await waitFor(() => expect(supaState.calls.length).toBe(1), { timeout: 1500 });
    expect(supaState.calls[0]).toMatchObject({
      table: 'profiles',
      in: { col: 'phone', vals: expect.arrayContaining(['0783673998', '+256783673998']) },
    });

    await waitFor(() => expect(screen.getByText(/Sending to/i)).toBeInTheDocument());
  });

  it('blocks sending to yourself and disables the Send Money button', async () => {
    const user = userEvent.setup();
    // Profile returned matches the current user id ("me") → self.
    supaState.response = {
      data: [{ id: 'me', full_name: 'Me Self', phone: '+256700000001', email: 'me@example.com' }],
      error: null,
    };

    renderDialog();
    await user.type(screen.getByLabelText(/Recipient Phone Number/i), '0700000001');

    await waitFor(
      () =>
        expect(
          screen.getByText(/Sending blocked: this number is your own account/i)
        ).toBeInTheDocument(),
      { timeout: 2000 }
    );

    const sendBtn = screen.getByRole('button', { name: /^Send Money$/i });
    expect(sendBtn).toBeDisabled();
    expect(walletState.sendMoney).not.toHaveBeenCalled();
  });

  it('submits using the matched phone (not the raw input text)', async () => {
    const user = userEvent.setup();
    // User types 0783673998 but the matched profile stores +256783673998.
    const MATCHED_PHONE = '+256783673998';
    supaState.response = {
      data: [
        { id: 'other', full_name: 'Jane Doe', phone: MATCHED_PHONE, email: 'jane@example.com' },
      ],
      error: null,
    };

    renderDialog();
    await user.type(screen.getByLabelText(/Recipient Phone Number/i), '0783673998');

    await waitFor(() => expect(screen.getByText(/Jane Doe/)).toBeInTheDocument(), {
      timeout: 2000,
    });

    await user.type(screen.getByLabelText(/Amount/i), '1500');
    await user.type(screen.getByLabelText(/What's this payment for/i), 'food');

    await user.click(screen.getByRole('button', { name: /^Send Money$/i }));

    const confirmBtn = await screen.findByRole('button', { name: /Confirm & Send/i });
    await user.click(confirmBtn);

    await waitFor(() => expect(walletState.sendMoney).toHaveBeenCalledTimes(1));
    expect(walletState.sendMoney).toHaveBeenCalledWith(MATCHED_PHONE, 1500, 'food');
  });

  describe('Send button tooltip + aria-label mirror disabledReason', () => {
    const getSendBtn = () => screen.getByRole('button', { name: /Send Money/i });

    it('shows the "Verifying recipient" reason while the lookup is in flight', async () => {
      const user = userEvent.setup();
      // Keep supabase pending so the dialog stays in the "searching" state.
      let resolveLookup: ((v: any) => void) | null = null;
      supaState.response = new Promise((res) => {
        resolveLookup = res;
      }) as any;

      renderDialog();
      await user.type(screen.getByLabelText(/Recipient Phone Number/i), '0783673998');

      await waitFor(() => {
        const btn = getSendBtn();
        expect(btn).toBeDisabled();
        expect(btn).toHaveAttribute('title', 'Verifying recipient on Welile…');
        expect(btn).toHaveAttribute('aria-describedby', 'send-money-disabled-reason');
        const reason = document.getElementById('send-money-disabled-reason');
        expect(reason).not.toBeNull();
        expect(reason).toHaveTextContent('Verifying recipient on Welile…');
      });

      // Cleanup so the pending promise doesn't leak between tests.
      resolveLookup?.({ data: [], error: null });
    });

    it('shows the "No Welile user found" reason when the phone lookup returns empty', async () => {
      const user = userEvent.setup();
      supaState.response = { data: [], error: null };

      renderDialog();
      await user.type(screen.getByLabelText(/Recipient Phone Number/i), '0783673998');

      await waitFor(
        () => {
          const btn = getSendBtn();
          expect(btn).toBeDisabled();
          expect(btn).toHaveAttribute(
            'title',
            'No Welile user found for this phone number.'
          );
          expect(btn).toHaveAttribute('aria-describedby', 'send-money-disabled-reason');
          expect(document.getElementById('send-money-disabled-reason')).toHaveTextContent(
            'No Welile user found for this phone number.'
          );
        },
        { timeout: 2000 }
      );
    });

    it('shows the "your own account" reason when the matched profile is the current user', async () => {
      const user = userEvent.setup();
      supaState.response = {
        data: [
          { id: 'me', full_name: 'Me Self', phone: '+256700000001', email: 'me@example.com' },
        ],
        error: null,
      };

      renderDialog();
      await user.type(screen.getByLabelText(/Recipient Phone Number/i), '0700000001');

      await waitFor(
        () => {
          const btn = getSendBtn();
          expect(btn).toBeDisabled();
          expect(btn).toHaveAttribute(
            'title',
            "You can't send money to your own account."
          );
          expect(btn).toHaveAttribute('aria-describedby', 'send-money-disabled-reason');
          expect(document.getElementById('send-money-disabled-reason')).toHaveTextContent(
            "You can't send money to your own account."
          );
        },
        { timeout: 2000 }
      );
    });
  });
});
