import { describe, expect, it } from 'vitest';
import { countPromissoryQueue, promissoryFilterCount } from './promissoryQueueCounts';
import { promissoryFulfilmentError } from './promissoryNoteDraft';

const today = new Date('2026-10-29T12:00:00Z');

describe('countPromissoryQueue', () => {
  it('counts pending and approved from the same notes the list shows', () => {
    const counts = countPromissoryQueue([
      { status: 'pending', fulfilment_due_on: '2026-11-01', amount: 100, total_collected: 0 },
      { status: 'pending', fulfilment_due_on: null, amount: 100, total_collected: 0 },
      { status: 'activated', fulfilment_due_on: '2026-10-01', amount: 100, total_collected: 40, outstanding: 60 },
      { status: 'fulfilled', fulfilment_due_on: '2026-09-01', amount: 100, total_collected: 100 },
      { status: 'cancelled', fulfilment_due_on: null },
    ], today);
    expect(counts.pending).toBe(2);
    expect(counts.approved).toBe(1);
    expect(counts.fulfilled).toBe(1);
    expect(counts.rejected).toBe(1);
    expect(counts.missingFulfilment).toBe(2);
    expect(counts.overdue).toBe(1);
    expect(promissoryFilterCount(counts, 'activated')).toBe(counts.approved);
    expect(promissoryFilterCount(counts, 'pending')).toBe(counts.pending);
  });

  it('does not count a covered note as pending or approved', () => {
    const counts = countPromissoryQueue([
      { status: 'fulfilled', fulfilment_due_on: null, amount: 100, total_collected: 100 },
    ]);
    expect(counts.pending).toBe(0);
    expect(counts.approved).toBe(0);
    expect(counts.fulfilled).toBe(1);
  });
});

describe('promissoryFulfilmentError', () => {
  it('requires a fulfil-by date on or after the recording date', () => {
    expect(promissoryFulfilmentError('2026-10-29', '')).toBe('Fulfil by date');
    expect(promissoryFulfilmentError('2026-10-29', '2026-10-28')).toMatch(/on or after/);
    expect(promissoryFulfilmentError('2026-10-29', '2026-11-15')).toBeNull();
  });
});
