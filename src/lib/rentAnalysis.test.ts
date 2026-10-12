import { describe, it, expect } from 'vitest';
import { buildTenantRows, type RentAnalysisPlan } from './rentAnalysis';
import { describePlanSchedule } from './agentMonitoringSchedule';

const plan = (id: string, over: Partial<RentAnalysisPlan> = {}): RentAnalysisPlan => ({
  id, tenant_id: `t-${id}`, agent_id: 'a1', status: 'repaying', rent_amount: 400_000, house_category: '1-bed',
  daily_repayment: 10_000, total_repayment: 300_000, amount_repaid: 0, repayment_frequency: 'daily',
  repayment_starts_on: '2026-08-01', created_at: '2026-07-30T08:00:00Z', ...over,
});
const base = {
  receipts: [],
  referenceDay: new Date(2026, 8, 10),
  nameFor: (id: string | null) => id ?? '',
  phoneFor: () => null,
};

describe('buildTenantRows', () => {
  it('keeps the original behaviour (schedule from the stored start) when no scheduleFor is given', () => {
    const rows = buildTenantRows({ ...base, plans: [plan('p1')] });
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule).toEqual(describePlanSchedule(plan('p1'), base.referenceDay));
  });

  it('uses the supplied schedule and leaves out plans it returns null for', () => {
    const custom = describePlanSchedule(plan('p1', { repayment_starts_on: '2026-09-06' }), base.referenceDay);
    const rows = buildTenantRows({
      ...base,
      plans: [plan('p1'), plan('p2')],
      scheduleFor: (p) => (p.id === 'p1' ? custom : null),
    });
    expect(rows.map((r) => r.planId)).toEqual(['p1']);
    expect(rows[0].schedule.scheduledToDate).toBe(custom.scheduledToDate);
    expect(rows[0].schedule.scheduledToDate).toBeLessThan(
      describePlanSchedule(plan('p1'), base.referenceDay).scheduledToDate,
    );
  });
});
