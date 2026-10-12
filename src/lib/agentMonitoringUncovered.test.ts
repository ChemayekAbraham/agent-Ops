import { describe, it, expect } from 'vitest';
import {
  agentOptions,
  daysBetweenYmd,
  describePayout,
  filterUncovered,
  formatPipelineStatus,
  paginate,
  sortUncovered,
  summarisePayouts,
  summariseUncovered,
  type UncoveredPlanRow,
} from './agentMonitoringUncovered';

const row = (over: Partial<UncoveredPlanRow> = {}): UncoveredPlanRow => ({
  id: 'p1', bucket: 'tenant_paying_no_landlord', tenantId: 't1', tenantName: 'Amina Nakato', tenantPhone: '+256701234567',
  agentId: 'a1', agentName: 'Agent One', fundedAmount: 400_000, totalRepayment: 520_000, repaid: 100_000, stillOwed: 420_000,
  fundedOn: '2026-10-01', daysSinceFunding: 11, payout: { kind: 'none', paidAmount: 0, allocatedAmount: 0 }, pipelineStatus: 'repaying',
  ...over,
});
const ugx = (n: number) => `UGX ${n.toLocaleString('en-US')}`;

describe('summarisePayouts', () => {
  it('reads no rows as none', () => {
    expect(summarisePayouts([], []).kind).toBe('none');
  });
  it('reads an in-flight payout as pending', () => {
    for (const status of ['otp_verified', 'pending_finops_disbursement', 'pending_merchant_payout', 'disbursing', 'escalated']) {
      expect(summarisePayouts([{ status, amount: 1 }], []).kind).toBe('pending');
    }
  });
  it('reads only failed payouts as failed, but a failed plus a pending one as pending', () => {
    expect(summarisePayouts([{ status: 'failed', amount: 1 }, { status: 'failed', amount: 1 }], []).kind).toBe('failed');
    expect(summarisePayouts([{ status: 'failed', amount: 1 }, { status: 'pending_merchant_payout', amount: 1 }], []).kind).toBe('pending');
  });
  it('reads a partly paid float allocation as part-paid with the amount', () => {
    const s = summarisePayouts([], [{ status: 'partially_paid', allocated_amount: 400_000, paid_out_amount: 150_000 }]);
    expect(s).toEqual({ kind: 'part_paid', paidAmount: 150_000, allocatedAmount: 400_000 });
    expect(describePayout(s, ugx)).toBe('Part-paid UGX 150,000 of UGX 400,000');
  });
  it('flags a fully paid float with no payout record instead of showing no payout', () => {
    const s = summarisePayouts([], [{ status: 'fully_paid', allocated_amount: 225_000, paid_out_amount: 225_000 }]);
    expect(s.kind).toBe('paid_unrecorded');
    expect(describePayout(s, ugx)).toBe('Float paid UGX 225,000, no payout record');
  });
  it('ignores cancelled allocations', () => {
    expect(summarisePayouts([], [{ status: 'cancelled', allocated_amount: 100, paid_out_amount: 0 }]).kind).toBe('none');
  });
});

describe('daysBetweenYmd', () => {
  it('counts whole Kampala days and never goes negative', () => {
    expect(daysBetweenYmd('2026-10-01', '2026-10-12')).toBe(11);
    expect(daysBetweenYmd('2026-10-12', '2026-10-12')).toBe(0);
    expect(daysBetweenYmd('2026-10-13', '2026-10-12')).toBe(0);
    expect(daysBetweenYmd(null, '2026-10-12')).toBeNull();
  });
});

describe('filter, sort, paginate, summarise', () => {
  const rows = [
    row({ id: 'a', tenantName: 'Zed', repaid: 50_000, stillOwed: 470_000, daysSinceFunding: 3, agentId: 'a1', agentName: 'Agent One', tenantPhone: '+256700000001' }),
    row({ id: 'b', tenantName: 'Ben', repaid: 300_000, stillOwed: 220_000, daysSinceFunding: 30, agentId: 'a2', agentName: 'Agent Two', tenantPhone: '0702 555 666' }),
    row({ id: 'c', tenantName: 'Cara', repaid: 300_000, stillOwed: 220_000, daysSinceFunding: null, agentId: 'a2', agentName: 'Agent Two', tenantPhone: null }),
  ];
  it('searches tenant, agent and phone digits', () => {
    expect(filterUncovered(rows, { search: 'zed', agentId: 'all' }).map((r) => r.id)).toEqual(['a']);
    expect(filterUncovered(rows, { search: 'agent two', agentId: 'all' }).map((r) => r.id)).toEqual(['b', 'c']);
    expect(filterUncovered(rows, { search: '0702 555', agentId: 'all' }).map((r) => r.id)).toEqual(['b']);
    expect(filterUncovered(rows, { search: '', agentId: 'a2' }).map((r) => r.id)).toEqual(['b', 'c']);
  });
  it('sorts by repaid (ties by name), days and name', () => {
    expect(sortUncovered(rows, 'repaid_desc').map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(sortUncovered(rows, 'repaid_asc').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sortUncovered(rows, 'days_desc').map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(sortUncovered(rows, 'name_asc').map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
  it('paginates and clamps the page', () => {
    const many = Array.from({ length: 53 }, (_, i) => i);
    expect(paginate(many, 1, 25).items).toHaveLength(25);
    expect(paginate(many, 3, 25).items).toHaveLength(3);
    expect(paginate(many, 99, 25).page).toBe(3);
    expect(paginate([], 1, 25)).toMatchObject({ pageCount: 1, total: 0, items: [] });
  });
  it('summarises plans, repaid, owed, funded and the longest wait', () => {
    expect(summariseUncovered(rows)).toEqual({ plans: 3, totalFunded: 1_200_000, totalRepaid: 650_000, totalOwed: 910_000, longestDays: 30 });
    expect(summariseUncovered([]).longestDays).toBeNull();
  });
  it('lists agents busiest first', () => {
    expect(agentOptions(rows)).toEqual([{ id: 'a2', name: 'Agent Two', count: 2 }, { id: 'a1', name: 'Agent One', count: 1 }]);
  });
  it('formats pipeline status as words', () => {
    expect(formatPipelineStatus('repaying')).toBe('Repaying');
    expect(formatPipelineStatus('agent_ops_approved')).toBe('Agent Ops Approved');
  });
});
