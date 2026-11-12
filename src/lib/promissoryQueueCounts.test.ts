import { describe, expect, it } from 'vitest';
import {
  countPromissoryQueue, isAwaitingPromissoryReview, promissoryFilterCount, promissoryReviewStatus,
} from './promissoryQueueCounts';
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

  // A partner opening the note link stores it as activated; that is not an approval, and without approval the
  // agent's commission never pays (Isaac Mwaka's notes, 12 Nov 2026).
  it('keeps a note that was opened from its link but never approved in Pending, not Approved', () => {
    const counts = countPromissoryQueue([
      { status: 'activated', approval_bonus_paid: false },
      { status: 'activated', approval_bonus_paid: true },
      { status: 'pending', approval_bonus_paid: false },
    ]);
    expect(counts.pending).toBe(2);
    expect(counts.approved).toBe(1);
  });

  it('keeps a note the partner already paid in full in Pending until it is approved', () => {
    const counts = countPromissoryQueue([
      { status: 'fulfilled', approval_bonus_paid: false, amount: 100, total_collected: 100 },
      { status: 'fulfilled', approval_bonus_paid: true, amount: 100, total_collected: 100 },
    ]);
    expect(counts.pending).toBe(1);
    expect(counts.fulfilled).toBe(1);
  });
});

describe('isAwaitingPromissoryReview', () => {
  it('is true for any note Partner Ops have not approved yet', () => {
    expect(isAwaitingPromissoryReview({ status: 'pending' })).toBe(true);
    expect(isAwaitingPromissoryReview({ status: 'pending', approval_bonus_paid: false })).toBe(true);
    expect(isAwaitingPromissoryReview({ status: 'activated', approval_bonus_paid: false })).toBe(true);
    expect(isAwaitingPromissoryReview({ status: 'fulfilled', approval_bonus_paid: false })).toBe(true);
  });

  it('is false for approved, rejected or defaulted notes, and for rows without the approval field', () => {
    expect(isAwaitingPromissoryReview({ status: 'activated', approval_bonus_paid: true })).toBe(false);
    expect(isAwaitingPromissoryReview({ status: 'fulfilled', approval_bonus_paid: true })).toBe(false);
    expect(isAwaitingPromissoryReview({ status: 'cancelled', approval_bonus_paid: false })).toBe(false);
    expect(isAwaitingPromissoryReview({ status: 'defaulted', approval_bonus_paid: false })).toBe(false);
    expect(isAwaitingPromissoryReview({ status: 'activated' })).toBe(false);
  });

  it('shows an unapproved note as pending and leaves every other status as stored', () => {
    expect(promissoryReviewStatus({ status: 'activated', approval_bonus_paid: false })).toBe('pending');
    expect(promissoryReviewStatus({ status: 'activated', approval_bonus_paid: true })).toBe('activated');
    expect(promissoryReviewStatus({ status: 'cancelled', approval_bonus_paid: false })).toBe('cancelled');
  });
});

describe('promissoryFulfilmentError', () => {
  it('requires a fulfil-by date on or after the recording date', () => {
    expect(promissoryFulfilmentError('2026-10-29', '')).toBe('Fulfil by date');
    expect(promissoryFulfilmentError('2026-10-29', '2026-10-28')).toMatch(/on or after/);
    expect(promissoryFulfilmentError('2026-10-29', '2026-11-15')).toBeNull();
    expect(promissoryFulfilmentError('2026-11-10', '2027-01-15', '2026-12-31')).toMatch(/on or before 31 Dec 2026/);
    expect(promissoryFulfilmentError('2026-11-10', '2026-12-31', '2026-12-31')).toBeNull();
    // A note recorded after the deadline is not limited.
    expect(promissoryFulfilmentError('2027-01-05', '2027-02-01', '2026-12-31')).toBeNull();
  });
});
