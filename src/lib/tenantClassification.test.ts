import { describe, it, expect } from 'vitest';
import {
  CATEGORY_LABELS, SUB_LABELS_BY_CATEGORY, categoryLabel, completionText, filterDescription, formatStatus, subLabelText,
} from './tenantClassification';

describe('tenantClassification labels', () => {
  it('uses plain-language category names', () => {
    expect(CATEGORY_LABELS).toEqual({
      active: 'Active', waiting: 'Waiting for landlord payment', dormant: 'Dormant', inactive: 'Inactive',
    });
    expect(categoryLabel('waiting')).toBe('Waiting for landlord payment');
    expect(categoryLabel('something-new')).toBe('something-new');
  });

  it('names every sub-label and gives Active and Waiting none', () => {
    expect(subLabelText('renewal_in_progress')).toBe('Renewal in progress');
    expect(subLabelText('never_requested')).toBe('Never requested');
    expect(subLabelText('request_in_review')).toBe('Request in review');
    expect(subLabelText('only_rejected_cancelled')).toBe('Only rejected or cancelled requests');
    expect(subLabelText(null)).toBeNull();
    expect(SUB_LABELS_BY_CATEGORY.active).toEqual([]);
    expect(SUB_LABELS_BY_CATEGORY.waiting).toEqual([]);
    expect(SUB_LABELS_BY_CATEGORY.dormant).toEqual(['renewal_in_progress']);
    expect(SUB_LABELS_BY_CATEGORY.inactive).toHaveLength(4);
  });

  it('never uses the old regulatory words in user-facing copy', () => {
    const all = JSON.stringify([CATEGORY_LABELS, SUB_LABELS_BY_CATEGORY]).toLowerCase();
    expect(all).not.toMatch(/loan|lender|roi|interest/);
  });
});

describe('completionText', () => {
  it('shows when a Dormant tenant finished and how long ago', () => {
    expect(completionText({ completed_on: '2026-10-09', days_since_completion: 4 })).toBe('9 Oct 2026 (4 days ago)');
    expect(completionText({ completed_on: '2026-10-13', days_since_completion: 0 })).toBe('13 Oct 2026 (today)');
    expect(completionText({ completed_on: '2026-10-12', days_since_completion: 1 })).toBe('12 Oct 2026 (1 day ago)');
    expect(completionText({ completed_on: null, days_since_completion: null })).toBeNull();
  });
});

describe('filterDescription / formatStatus', () => {
  it('describes the slice on screen', () => {
    expect(filterDescription(null, null, false, '')).toBe('All tenants');
    expect(filterDescription('dormant', 'renewal_in_progress', true, ' Ann ')).toBe(
      'Dormant · Renewal in progress · Needs review only · Search "Ann"',
    );
  });
  it('makes a status readable', () => {
    expect(formatStatus('service_center_review')).toBe('Service center review');
    expect(formatStatus(null)).toBe('');
  });
});
