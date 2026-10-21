import { describe, it, expect } from 'vitest';
import { rdKeyMetrics } from '@/lib/rdGeneralReportPdf';

describe('R&D report key metrics', () => {
  it('totals customers, cash in and net position from the cash table', () => {
    const [c, i, n] = rdKeyMetrics([
      { name: 'A', customers: 40, cashIn: 20_000_000, cashOut: 40_000_000 },
      { name: 'B', customers: 30, cashIn: 1_670_000, cashOut: 5_547_000 },
    ]);
    expect(c).toBe('70');
    expect(i).toContain('21,670,000');
    expect(n).toContain('23,877,000');
    expect(n).toContain('-');
  });
});
