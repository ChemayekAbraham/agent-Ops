import { describe, it, expect } from 'vitest';
import { FIGURE_LABELS, TAB_FIGURE_SOURCES, type FigureKey } from './tenantOpsFigureLabels';

const ALL_TIME: FigureKey[] = ['totalExpected', 'totalCollected', 'outstanding', 'arrears', 'paidPct', 'leftPct', 'portfolioPct', 'averageTenant'];
const PERIOD: FigureKey[] = ['periodExpected', 'periodCollected', 'periodShort', 'periodCovered', 'periodPaidAhead'];

describe('tenant ops figure labels', () => {
  it('every all-time figure says so in its name', () => {
    for (const k of ALL_TIME) expect(FIGURE_LABELS[k].label).toMatch(/all time|full cycle|whole plan|to date/i);
  });

  it('every period figure says "this period" and every figure has a one-line explanation', () => {
    for (const k of PERIOD) expect(FIGURE_LABELS[k].label).toMatch(/this period/i);
    for (const k of [...ALL_TIME, ...PERIOD]) {
      expect(FIGURE_LABELS[k].hint.length).toBeGreaterThan(20);
      expect(FIGURE_LABELS[k].hint.split('. ').length).toBeLessThanOrEqual(3);
    }
  });

  it('keeps the regulatory wording', () => {
    expect(JSON.stringify(FIGURE_LABELS)).not.toMatch(/\b(loan|lender|ROI|interest)\b/i);
    expect(FIGURE_LABELS.totalExpected.hint).toContain('Rent Plan');
  });

  it('documents a source and a scope for each figure', () => {
    expect(TAB_FIGURE_SOURCES.length).toBeGreaterThan(8);
    for (const f of TAB_FIGURE_SOURCES) {
      expect(f.source.length).toBeGreaterThan(10);
      expect(['all time', 'to date', 'period']).toContain(f.scope);
    }
  });
});
