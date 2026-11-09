import { describe, expect, it } from 'vitest';
import { readMonthlyPlans, saveMonthlyPlan, monthlyPlansKey, type MonthlyProjectPlan } from './monthlyProjectPlans';

const plan: MonthlyProjectPlan = { projectId: 'car', projectName: 'Welile Car', month: '2026-11', budget: 1000000, targets: 'Register 10 customers', updatedAt: '2026-11-09T09:08:00Z' };
describe('Monthly project planning', () => {
  it('keeps each month separate', () => {
    const records = saveMonthlyPlan([plan], { ...plan, month: '2026-12', budget: 2000000 });
    expect(records.map((p) => p.budget)).toEqual([1000000, 2000000]);
  });
  it('keeps each project separate', () => {
    expect(saveMonthlyPlan([plan], { ...plan, projectId: 'ai' })).toHaveLength(2);
  });
  it('updates the same project and month without duplicating it', () => {
    expect(saveMonthlyPlan([plan], { ...plan, budget: 0, targets: 'Finish curriculum' })).toEqual([{ ...plan, budget: 0, targets: 'Finish curriculum' }]);
  });
  it('restores recorded budgets and targets', () => {
    expect(readMonthlyPlans(JSON.stringify([plan]))).toEqual([plan]);
  });
  it('rejects invalid budget amounts', () => {
    for (const budget of [-1, 0.5, Infinity]) expect(() => saveMonthlyPlan([], { ...plan, budget })).toThrow();
  });
  it('ignores corrupt saved records', () => {
    expect(readMonthlyPlans('invalid')).toEqual([]);
    expect(readMonthlyPlans(JSON.stringify([{ ...plan, month: '2026-13' }]))).toEqual([]);
  });
  it('uses separate storage for each account', () => {
    expect(monthlyPlansKey('account-a')).not.toBe(monthlyPlansKey('account-b'));
  });
});