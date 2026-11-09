import { describe, expect, it } from 'vitest';
import { recordVouchFigures, VOUCH_FIGURES_UNAVAILABLE } from '../recordVouchFigures';

const trust = (borrowing_limit_ugx: number | null, score: number | null) => ({ borrowing_limit_ugx, score, tier: 'standard' });

describe('recordVouchFigures (Partner Returns 4b, interim fail-closed)', () => {
  it('passes real figures through unchanged', () => {
    expect(recordVouchFigures(trust(750_000, 62.4))).toEqual({ ok: true, limit: 750_000, score: 62.4, tier: 'standard' });
  });

  it('allows a real zero limit (the person has no vouch yet), which is a figure, not a mask', () => {
    expect(recordVouchFigures(trust(0, 40))).toEqual({ ok: true, limit: 0, score: 40, tier: 'standard' });
  });

  it.each([
    ['masked limit', trust(null, 55)],
    ['masked score', trust(500_000, null)],
    ['both masked', trust(null, null)],
    ['NaN limit', trust(Number.NaN, 55)],
    ['negative limit', trust(-1, 55)],
    ['infinite score', trust(500_000, Number.POSITIVE_INFINITY)],
    ['undefined limit', { score: 55, tier: 'standard' } as never],
  ])('refuses to record with a %s', (_label, t) => {
    expect(recordVouchFigures(t)).toEqual({ ok: false, error: VOUCH_FIGURES_UNAVAILABLE });
  });

  it('the refusal copy says nothing was saved and uses no forbidden terms', () => {
    expect(VOUCH_FIGURES_UNAVAILABLE).toMatch(/Nothing was saved/);
    expect(VOUCH_FIGURES_UNAVAILABLE).not.toMatch(/\b(loan|lender|ROI|interest)\b/i);
  });
});
