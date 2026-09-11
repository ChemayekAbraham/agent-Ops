import { describe, it, expect } from 'vitest';
import {
  MERCHANT_QUEUE_STATUSES,
  MERCHANT_TERMINAL_STATUSES,
  isMerchantQueueActionable,
  isMerchantQueueSettled,
  applyMerchantQueueFence,
} from '@/lib/merchantPayoutQueue';

const base = { id: 'w1', status: 'pending', processed_at: null, fin_ops_reference: null };

describe('Merchant payout queue fence', () => {
  it('lists a genuinely pending withdrawal', () => {
    expect(isMerchantQueueActionable(base)).toBe(true);
  });

  it('excludes every terminal status', () => {
    for (const status of MERCHANT_TERMINAL_STATUSES) {
      expect(isMerchantQueueActionable({ ...base, status })).toBe(false);
    }
  });

  it('excludes a row that still says pending but carries settlement evidence', () => {
    // This is exactly the Joshua Wanda / Sharif KC failure mode: cash left, the
    // ledger follow-up timed out, the status column stayed "pending".
    expect(isMerchantQueueActionable({ ...base, fin_ops_reference: 'TID153787197005' })).toBe(false);
    expect(isMerchantQueueActionable({ ...base, processed_at: '2026-08-12T11:28:44Z' })).toBe(false);
  });

  it('pending -> paid -> refetch keeps the row out of the queue', () => {
    let row: any = { ...base };
    expect(isMerchantQueueActionable(row)).toBe(true);

    // settlement
    row = { ...row, status: 'paid', processed_at: '2026-08-12T11:28:44Z', fin_ops_reference: 'TID153787197005' };
    expect(isMerchantQueueActionable(row)).toBe(false);

    // simulate three successive queue re-fetches / dashboard reloads
    for (let i = 0; i < 3; i++) {
      const refetched = { ...row };
      expect(isMerchantQueueActionable(refetched)).toBe(false);
      expect(isMerchantQueueSettled(refetched)).toBe(true);
    }
  });

  it('a duplicate confirmation / retry cannot requeue an already-paid row', () => {
    const paid = { ...base, status: 'paid', processed_at: '2026-08-12T11:28:44Z', fin_ops_reference: 'TID1' };
    // A retry that re-sends the same settlement payload, or a failed follow-up
    // write that only resets the status column, still yields a non-actionable row
    // because evidence outranks status.
    const retried = { ...paid, status: 'pending' };
    expect(isMerchantQueueActionable(retried)).toBe(false);
  });

  it('applies status + evidence filters to the query builder', () => {
    const calls: any[] = [];
    const stub: any = {
      in: (...a: any[]) => (calls.push(['in', ...a]), stub),
      is: (...a: any[]) => (calls.push(['is', ...a]), stub),
      not: (...a: any[]) => (calls.push(['not', ...a]), stub),
    };
    applyMerchantQueueFence(stub);
    expect(calls).toEqual([
      ['in', 'status', [...MERCHANT_QUEUE_STATUSES]],
      ['is', 'processed_at', null],
      ['is', 'fin_ops_reference', null],
      ['not', 'hidden_from_merchant_queue', 'is', true],
    ]);

  });
});
