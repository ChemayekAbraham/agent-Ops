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
    expect(V360_NEW_QUOTE_EXAMPLE_SENTENCE).toContain('UGX 8,566');
    expect(V360_NEW_QUOTE_EXAMPLE_SENTENCE).toContain('UGX 2,855');
    expect(V360_NEW_QUOTE_EXAMPLE_SENTENCE).toContain('UGX 2,885');
    expect(V360_NEW_QUOTE_EXAMPLE_SENTENCE).toContain('UGX 999');
    expect(V360_NEW_QUOTE_EXAMPLE_SENTENCE).toContain('target 15%, not guaranteed');
    expect(V360_NEW_QUOTE_EXAMPLE_SENTENCE).not.toMatch(/[\u2013\u2014]/);
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
      'Partner Returns (target 15%, not guaranteed)',
      'Remaining 360-day receivable',
      'Missed days',
      'Vacant days',
      'Maturity',
      'Cover Pool drawn',
    ]);
    expect(lines[0].value).toBe('UGX 4,760');
    expect(lines[1].value).toBe('UGX 15,000 a month, UGX 180,000 over 12 months');
    expect(lines[2].value).toBe('UGX 1,713,600');
    expect(lines[5].value).toBe('2027-10-31');
  });

  it('labels waterfall figures only when the server sends them', () => {
    const labels = v360CaptionLines({
      daily_rate: 4760,
      partner_monthly: 15000,
      partner_12_months: 180000,
      remaining_receivable: 360 * 4760,
      missed_days: 0,
      vacant_days: 0,
      maturity_on: '2027-10-29',
      buffer_drawn: 0,
      agent_sub: 8566,
      agent_general: 2855,
      cover_pool: 2885,
      proxy_agent: 2000,
      welile: 9994,
      tithe: 999,
      welile_net: 8995,
    }).map((line) => line.value);
    expect(labels).toContain('UGX 8,566');
    expect(labels).toContain('UGX 2,000');
    expect(labels).toContain('UGX 999');
    expect(labels).toContain('UGX 8,995');
  });
});
