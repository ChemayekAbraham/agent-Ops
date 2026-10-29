import { describe, expect, it } from 'vitest';
import { V360_MODEL_A_EXAMPLE } from './contractEngine360';
import { V360_NEW_QUOTE_EXAMPLE_SENTENCE, v360CaptionLines } from './v360Captions';

describe('v360 captions', () => {
  it('keeps the Model A example at gross 142,772 and daily 4,760', () => {
    expect(V360_MODEL_A_EXAMPLE.principal).toBe(100000);
    expect(V360_MODEL_A_EXAMPLE.gross).toBe(142772);
    expect(V360_MODEL_A_EXAMPLE.daily).toBe(4760);
    expect(V360_NEW_QUOTE_EXAMPLE_SENTENCE).toContain('UGX 142,772');
    expect(V360_NEW_QUOTE_EXAMPLE_SENTENCE).toContain('UGX 4,760');
    expect(V360_NEW_QUOTE_EXAMPLE_SENTENCE).toContain('does not turn new-plan pricing on');
  });

  it('labels server summary fields without recomputing them', () => {
    const lines = v360CaptionLines({
      daily_rate: 4760,
      partner_monthly: 15000,
      partner_12_months: 180000,
      remaining_receivable: 360 * 4760,
      missed_days: 2,
      vacant_days: 1,
      maturity_on: '2027-10-31',
      buffer_drawn: 5000,
    });
    expect(lines.map((l) => l.label)).toEqual([
      'Daily rate',
      'Partner Returns 15%/mo × 12',
      'Remaining 360-day receivable',
      'Missed days',
      'Vacant days',
      'Maturity',
      'Buffer drawn',
    ]);
    expect(lines[0].value).toBe('UGX 4,760');
    expect(lines[1].value).toBe('UGX 15,000 a month, UGX 180,000 over 12 months');
    expect(lines[2].value).toBe('UGX 1,713,600');
    expect(lines[5].value).toBe('2027-10-31');
  });
});
