import { describe, it, expect } from 'vitest';
import {
  STATUS_BATCH_LIMIT, awarenessBadgeText, awarenessWeekRange, chunkIds, hasNoCallAtStage, idsFingerprint, uniqueSortedIds,
  type AwarenessCallStatus,
} from './awarenessCallStatus';

const status = (over: Partial<AwarenessCallStatus> = {}): AwarenessCallStatus => ({
  rent_request_id: 'rr-1', calls_total: 0, calls_at_current_stage: 0, answered_at_current_stage: 0, last_call_at: null, answered_person_types: [], ...over,
});

describe('awarenessBadgeText', () => {
  it('says "No call yet at this stage" when nothing was recorded at the current stage', () => {
    expect(awarenessBadgeText(status())).toMatchObject({ tone: 'none', label: 'No call yet at this stage' });
  });

  it('still says "No call yet at this stage" when only earlier stages were called, and mentions them in the tooltip', () => {
    const t = awarenessBadgeText(status({ calls_total: 2 }))!;
    expect(t.label).toBe('No call yet at this stage');
    expect(t.title).toContain('2 recorded at earlier stages');
  });

  it('says "Called N times" with the singular for one', () => {
    expect(awarenessBadgeText(status({ calls_total: 1, calls_at_current_stage: 1 }))?.label).toBe('Called 1 time');
    const many = awarenessBadgeText(status({ calls_total: 4, calls_at_current_stage: 3, answered_at_current_stage: 2, answered_person_types: ['agent', 'tenant'] }))!;
    expect(many.label).toBe('Called 3 times');
    expect(many.title).toContain('2 answered');
    expect(many.title).toContain('agent, tenant');
  });

  it('shows nothing when the status is unknown', () => {
    expect(awarenessBadgeText(undefined)).toBeNull();
    expect(awarenessBadgeText(null)).toBeNull();
  });

  it('never uses the words loan, lender, ROI or interest', () => {
    const all = [status(), status({ calls_total: 2 }), status({ calls_total: 3, calls_at_current_stage: 3, answered_person_types: ['tenant'] })]
      .map((s) => JSON.stringify(awarenessBadgeText(s))).join(' ');
    expect(all).not.toMatch(/\b(loan|lender|ROI|interest)\b/i);
  });
});

describe('hasNoCallAtStage', () => {
  it('is true only when the status is known and has no call at the stage', () => {
    expect(hasNoCallAtStage(status())).toBe(true);
    expect(hasNoCallAtStage(status({ calls_at_current_stage: 1 }))).toBe(false);
    expect(hasNoCallAtStage(undefined)).toBe(false);
  });
});

describe('batching helpers', () => {
  it('de-duplicates and sorts ids, dropping blanks', () => {
    expect(uniqueSortedIds(['b', 'a', 'b', '', null, undefined])).toEqual(['a', 'b']);
  });

  it('splits into chunks of at most 200', () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${String(i).padStart(3, '0')}`);
    const chunks = chunkIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(STATUS_BATCH_LIMIT).toBe(200);
    expect(chunkIds([])).toEqual([]);
  });

  it('gives the same fingerprint for the same list and a different one for another', () => {
    expect(idsFingerprint(['a', 'b'])).toBe(idsFingerprint(['a', 'b']));
    expect(idsFingerprint(['a', 'b'])).not.toBe(idsFingerprint(['a', 'c']));
    expect(idsFingerprint(['a', 'b'])).not.toBe(idsFingerprint(['a', 'b', 'c']));
  });
});

describe('awarenessWeekRange', () => {
  it('runs Monday to today', () => {
    expect(awarenessWeekRange('2026-10-07')).toEqual({ from: '2026-10-05', to: '2026-10-07' }); // Wednesday
    expect(awarenessWeekRange('2026-10-05')).toEqual({ from: '2026-10-05', to: '2026-10-05' }); // Monday
    expect(awarenessWeekRange('2026-10-11')).toEqual({ from: '2026-10-05', to: '2026-10-11' }); // Sunday
  });

  it('crosses a month end', () => {
    expect(awarenessWeekRange('2026-11-01')).toEqual({ from: '2026-10-26', to: '2026-11-01' });
  });
});
