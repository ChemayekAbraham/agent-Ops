// @vitest-environment node
/**
 * Balance-sheet heading for A24 Special Advances Receivable (Phase 4), and the existing A20-A23 headings it must not
 * disturb. Classification only: figures are summed as given, nothing is dropped.
 */
import { describe, expect, it } from 'vitest';
import { classifyAssets, FLAGGED_LABEL, type PositionLine } from '@/components/cfo/balanceSheetClassification';

const line = (code: string, label: string, value: number): PositionLine =>
  ({ label, value, source: `general_ledger trial balance — account ${code}` });
const groupOf = (lines: PositionLine[], label: string) => {
  const r = classifyAssets(lines);
  return [...r.groups, r.flagged].find((g) => g.lines.some((l) => l.label === label))!.label;
};

describe('balance-sheet classification: A24 Special Advances Receivable', () => {
  it('reports A24 under Other Assets, not as unclassified', () => {
    expect(groupOf([line('A24', 'Special Advances Receivable', 940_000)], 'Special Advances Receivable')).toBe('Other Assets');
  });

  it('keeps A20-A23 under their existing headings', () => {
    const lines = [
      line('A20', 'Agent Advance Registration Fees Receivable', 1),
      line('A21', 'Landlord Float Pool — Self-Support', 2),
      line('A22', 'Landlord Float Pool — Company-Managed', 3),
      line('A23', 'Receivable from Pius — Angel Pool share', 4),
    ];
    expect(lines.map((l) => groupOf(lines, l.label))).toEqual([
      'Receivables from Agent Products and Services',
      'Landlord Float Pool — Reserved Cash',
      'Landlord Float Pool — Reserved Cash',
      'Receivables from Partner Products and Services',
    ]);
  });

  it('an unknown account code is still flagged for review', () => {
    expect(groupOf([line('A99', 'Something new', 5)], 'Something new')).toBe(FLAGGED_LABEL);
  });

  it('nothing is dropped: the section total equals the sum of every line, with A24 in Other Assets', () => {
    const lines = [line('A1', 'Cash', 1_000), line('A20', 'Agent Advance Registration Fees Receivable', 50),
      line('A24', 'Special Advances Receivable', 940_000), line('A99', 'Something new', 7)];
    const r = classifyAssets(lines);
    expect(r.total).toBe(1_000 + 50 + 940_000 + 7);
    const other = r.groups.find((g) => g.label === 'Other Assets')!;
    expect(other).toMatchObject({ value: 940_000, unsourced: false });
    expect(r.flagged.value).toBe(7);
  });
});
