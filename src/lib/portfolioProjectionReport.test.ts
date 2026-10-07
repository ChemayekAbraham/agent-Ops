import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { buildProjectionHtml, projectionRows, type ProjectionInput } from './portfolioProjectionReport';

const base: ProjectionInput = {
  portfolioCode: 'WPF-3542',
  accountName: 'My Rent Savings',
  investmentAmount: 1_000_000,
  roiPercentage: 15,
  roiMode: 'monthly_payout',
  totalRoiEarned: 450_000,
  status: 'active',
  createdAt: '2026-01-31T00:00:00Z',
  durationMonths: 12,
  payoutDay: null,
  nextRoiDate: '2026-10-28',
  maturityDate: '2027-01-31',
  ownerName: 'Piuslubega Ssenkali',
};

const NOW = new Date('2026-10-07T10:00:00Z');

describe('projection report', () => {
  it('payout accounts do not compound and repay the contribution at maturity', () => {
    const rows = projectionRows(base, 12);
    expect(rows[0].opening).toBe(1_000_000);
    expect(rows[11].opening).toBe(1_000_000);
    expect(rows[11].toDate).toBe(1_800_000);
    const html = buildProjectionHtml(base, NOW);
    expect(html).toContain('UGX 2,800,000'); // 1,000,000 + 1,800,000
    expect(html).toContain('Return paid to you each month');
  });

  it('compounding accounts add each return to the balance (about 5.35x over 12 months)', () => {
    const rows = projectionRows({ ...base, roiMode: 'monthly_compounding' }, 12);
    expect(rows[1].opening).toBe(1_150_000);
    expect(rows[11].closing).toBeGreaterThan(5_350_000);
    expect(rows[11].closing).toBeLessThan(5_351_000);
    expect(buildProjectionHtml({ ...base, roiMode: 'monthly_compounding' }, NOW))
      .toContain('Return added to your balance each month');
  });

  it('keeps the return day and clamps to month end', () => {
    const rows = projectionRows(base, 3);
    expect(rows.map((r) => r.date)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('uses the statement header and avoids investment wording', () => {
    const html = buildProjectionHtml(base, NOW);
    expect(html).toContain('class="bank-statement-header"');
    expect(html).toContain('PIUSLUBEGA SSENKALI');
    expect(html).toContain('W-PRJ-2026-1007');
    expect(html).not.toMatch(/invest|\bROI\b|\binterest\b|\bloan\b|\blender\b|\bcapital\b/i);
    expect(html).not.toMatch(/NaN|undefined|null/);
  });

  it('continues a long term on extra pages with correct numbering', () => {
    const html = buildProjectionHtml({ ...base, durationMonths: 36 }, NOW);
    const pages = (html.match(/class="report-page page-section"/g) ?? []).length;
    expect(pages).toBe(2);
    expect(html).toContain('PAGE 2 OF 2');
    expect(html).toContain('Please Note');
  });

  it('copes with a pending account that has no dates yet', () => {
    const html = buildProjectionHtml({ ...base, createdAt: '', maturityDate: null, nextRoiDate: null, ownerName: undefined }, NOW);
    expect(html).toContain('SUPPORTER');
    expect(html).not.toMatch(/NaN|Invalid Date/);
  });

  it('writes a sample when asked', () => {
    if (process.env.PROJ_OUT) {
      writeFileSync(process.env.PROJ_OUT, buildProjectionHtml({ ...base, roiMode: 'monthly_compounding' }, NOW), 'utf-8');
    }
  });
});
