import { describe, it, expect } from 'vitest';
import { computeWithdrawableAvailable, resolveWithdrawCap } from '@/lib/withdrawAvailability';

describe('withdrawable availability (single source of truth)', () => {
  it('Test 1 — normal withdrawal: 500,000 available covers 325,987', () => {
    const available = computeWithdrawableAvailable({ withdrawable: 500_000, holdsAlreadyNetted: true });
    expect(available).toBe(500_000);
    expect(325_987 <= resolveWithdrawCap({ uiAvailable: available, ledgerAvailable: available })).toBe(true);
  });

  it('Test 2 — insufficient balance: 100,000 rejects 325,987', () => {
    const available = computeWithdrawableAvailable({ withdrawable: 100_000, holdsAlreadyNetted: true });
    expect(available).toBe(100_000);
    expect(325_987 <= resolveWithdrawCap({ uiAvailable: available, ledgerAvailable: available })).toBe(false);
  });

  it('Test 3 — float is never withdrawable', () => {
    expect(
      computeWithdrawableAvailable({ withdrawable: 0, floatBalance: 500_000, advanceBalance: 200_000 }),
    ).toBe(0);
  });

  it('Test 4 — pending hold reduces available', () => {
    expect(computeWithdrawableAvailable({ withdrawable: 500_000, pendingHolds: 200_000 })).toBe(300_000);
  });

  it('Test 5 — released hold returns the money to available', () => {
    expect(computeWithdrawableAvailable({ withdrawable: 500_000, pendingHolds: 0 })).toBe(500_000);
  });

  it('Test 6 — wallet UI and withdraw cap agree on the same figure', () => {
    const ui = 325_987;
    expect(resolveWithdrawCap({ uiAvailable: ui, ledgerAvailable: ui })).toBe(ui);
  });

  it('failed verification (unknown) must not collapse the cap to zero', () => {
    expect(resolveWithdrawCap({ uiAvailable: 325_987, ledgerAvailable: null })).toBe(325_987);
  });

  it('a drifted cache above the ledger cannot inflate the cap', () => {
    expect(resolveWithdrawCap({ uiAvailable: 900_000, ledgerAvailable: 325_987 })).toBe(325_987);
  });

  it('a real zero ledger balance still blocks the withdrawal', () => {
    expect(resolveWithdrawCap({ uiAvailable: 325_987, ledgerAvailable: 0 })).toBe(0);
  });
});
