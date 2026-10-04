import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

// E2E test for the 10-minute cash-deposit receipt-code expiry.
// Part A (frontend): the code input stays enabled until the countdown hits
//   zero, then disables at exactly 600s and surfaces the auto-rejection notice.
// Part B (backend contract): the shared verification core (the exact decision
//   logic the verify-code edge function runs) reports `expired` once the
//   window passes, and the atomic claim refuses to credit — i.e. the deposit
//   is auto-rejected, never credited, after the timer runs out.

// ── Mocks ──────────────────────────────────────────────────────────────────
const supaState = vi.hoisted(() => ({
  invoke: vi.fn(async (_fn: string, _opts: any) => ({
    data: { ok: true, deposit_request_id: 'dep-1' },
    error: null,
  })),
}));
const toastState = vi.hoisted(() => ({
  error: vi.fn(), success: vi.fn(), info: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: supaState.invoke } },
}));
vi.mock('sonner', () => ({ toast: toastState }));

import CashWithFinancialOpsDeposit from '../CashWithFinancialOpsDeposit';
import {
  evaluateAttempt,
  VerificationStore,
  type VerificationRecord,
} from '../../../../supabase/functions/_shared/cash-verification-core';

const CODE_TTL_SECONDS = 600;

// Flush pending microtasks (resolves the mocked invoke + its setState chain).
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  supaState.invoke.mockClear();
  toastState.error.mockClear();
  toastState.success.mockClear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('Cash deposit 10-minute code expiry — end to end', () => {
  it('keeps the code input enabled until the countdown hits zero, then disables it exactly at 600s', async () => {
    render(<CashWithFinancialOpsDeposit open onOpenChange={() => {}} />);

    // Enter an amount and request the code.
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '50000' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send deposit request/i }));
    });
    await flush();

    // We are now on the code step; the input is present and enabled.
    const codeInput = screen.getByPlaceholderText('e.g. 1234');
    expect(codeInput).toBeEnabled();
    expect(screen.getByText(/the deposit is auto-rejected/i)).toBeInTheDocument();

    // Tick second-by-second (the countdown reschedules itself each render, so a
    // single big jump won't cascade). Stop 1 second before expiry — still enabled.
    for (let i = 0; i < CODE_TTL_SECONDS - 1; i++) {
      await act(async () => { vi.advanceTimersByTime(1000); });
    }
    expect(codeInput).toBeEnabled();

    // Cross the 2-minute boundary — input must disable exactly at zero.
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(codeInput).toBeDisabled();
    expect(
      screen.getByText(/this code expired\. the deposit was auto-rejected/i),
    ).toBeInTheDocument();
  });

  it('backend auto-rejects: an expired window yields `expired` and refuses to credit', () => {
    const now = Date.now();
    const rec: VerificationRecord = {
      status: 'awaiting_code',
      attempts: 0,
      max_attempts: 6,
      expires_at: new Date(now - 1).toISOString(), // window already passed
      code_hash: 'deadbeef',
    };

    // Even the correct hash cannot be accepted once the window has elapsed.
    const decision = evaluateAttempt(rec, 'deadbeef', now);
    expect(decision.kind).toBe('expired');

    // The atomic claim that guards crediting only allows awaiting_code → verified.
    // After expiry the sweep moves it to `expired`, so no credit can ever happen.
    const store = new VerificationStore();
    store.seed({ id: 'ver-1', status: 'awaiting_code' });
    // Expiry sweep closes the window.
    expect(store.claim('ver-1', 'awaiting_code', 'expired')).toBe(true);
    // A late verify attempt can no longer claim/credit it.
    expect(store.claim('ver-1', 'awaiting_code', 'verified')).toBe(false);
    expect(store.get('ver-1')?.status).toBe('expired');
  });

  it('boundary at exactly the expiry — the backend accepts when now === expires_at, then rejects 1ms later', () => {
    // The receipt window opened 10 minutes ago, so it expires *exactly* now.
    const expiresAtMs = Date.now();
    const rec: VerificationRecord = {
      status: 'awaiting_code',
      attempts: 0,
      max_attempts: 6,
      expires_at: new Date(expiresAtMs).toISOString(),
      code_hash: 'deadbeef',
    };

    // The backend uses a strict `expires_at < now` comparison, so the moment
    // the clock is *equal* to expires_at (i.e. entering the code at exactly
    // 2:00) the window is NOT yet expired — the correct code is accepted.
    const atBoundary = evaluateAttempt(rec, 'deadbeef', expiresAtMs);
    expect(atBoundary.kind).toBe('match');

    // One millisecond past the boundary the window has elapsed, so the same
    // correct code is now rejected as expired (auto-rejection).
    const justAfter = evaluateAttempt(rec, 'deadbeef', expiresAtMs + 1);
    expect(justAfter.kind).toBe('expired');

    // And one millisecond before the boundary it is, of course, still accepted.
    const justBefore = evaluateAttempt(rec, 'deadbeef', expiresAtMs - 1);
    expect(justBefore.kind).toBe('match');

    // Crediting still funnels through the atomic claim: the accepted boundary
    // attempt is the single transition awaiting_code → verified, and any later
    // (expired-sweep) claim cannot also credit it.
    const store = new VerificationStore();
    store.seed({ id: 'ver-boundary', status: 'awaiting_code' });
    expect(store.claim('ver-boundary', 'awaiting_code', 'verified')).toBe(true);
    expect(store.claim('ver-boundary', 'awaiting_code', 'expired')).toBe(false);
    expect(store.get('ver-boundary')?.status).toBe('verified');
  });
});
