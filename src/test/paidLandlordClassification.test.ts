import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Replay the exact guarded category replacements against the inspected live
// pre-migration definition; no second application classification is introduced.
const migration = readFileSync('supabase/migrations/20261028170025_d6d93abc-f16d-4747-abc1-aa0621c875fd.sql', 'utf8');
const array = migration.match(/FOREACH v_category IN ARRAY ARRAY\[([^\]]+)\]/);
const moved = [...(array?.[1] ?? '').matchAll(/'([^']+)'/g)].map(match => match[1]);
const replacement = migration.match(/v_map := replace\(v_map, format\('WHEN %L THEN %L', v_category, '([^']+)'\), format\('WHEN %L THEN %L', v_category, '([^']+)'\)\)/);

const before = new Map([
  ['rent_disbursement', 'landlord_float'],
  ['landlord_pool_deploy_company_managed', 'landlord_float'],
  ['landlord_pool_release_company_managed', 'landlord_float'],
  ['landlord_pool_release_self_support', 'landlord_float'],
  ['agent_landlord_payout', 'landlord'],
  ['landlord_receivable_obligation', 'landlord'],
  ['payroll_expense', 'budget'],
]);
const after = new Map(before);
for (const category of moved) {
  if (after.get(category) === replacement?.[1]) after.set(category, replacement?.[2] ?? 'missing');
}

describe('Money Out landlord classification migration', () => {
  it.each([
    'rent_disbursement',
    'landlord_pool_deploy_company_managed',
    'landlord_pool_release_company_managed',
    'landlord_pool_release_self_support',
  ])('classifies %s under the existing landlord products bucket', category => {
    expect(after.get(category)).toBe('landlord');
  });

  it('preserves existing landlord payments and operational expenses', () => {
    expect(after.get('agent_landlord_payout')).toBe('landlord');
    expect(after.get('landlord_receivable_obligation')).toBe('landlord');
    expect(after.get('payroll_expense')).toBe('budget');
  });

  it('combines the reconciled amounts and counts without changing the grand totals', () => {
    const reconciled = [
      { category: 'rent_disbursement', amount: 1_377_194_147, count: 3_242 },
      { category: 'agent_landlord_payout', amount: 74_226_000, count: 108 },
    ];
    const grouped = reconciled.filter(row => after.get(row.category) === 'landlord');
    expect(grouped.reduce((sum, row) => sum + row.amount, 0)).toBe(1_451_420_147);
    expect(grouped.reduce((sum, row) => sum + row.count, 0)).toBe(3_350);
    expect(grouped.reduce((sum, row) => sum + row.amount, 0)).toBe(reconciled.reduce((sum, row) => sum + row.amount, 0));
    expect(grouped.reduce((sum, row) => sum + row.count, 0)).toBe(reconciled.reduce((sum, row) => sum + row.count, 0));
  });
});