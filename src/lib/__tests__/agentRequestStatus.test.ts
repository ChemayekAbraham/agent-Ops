import { describe, expect, it } from 'vitest';
import { agentEligibilityFrom, agentRequestStatus, agentRequestStatusLabel } from '@/lib/agentRequestStatus';

const st = (status: string, extra: Record<string, unknown> = {}) => agentRequestStatus({ status, ...extra });

describe('agent request status labels (current pipeline)', () => {
  it('service_center_review: At the Service Centre, next Agent Ops', () => {
    expect(st('service_center_review')).toMatchObject({ label: 'At the Service Centre', next: 'Next: Agent Ops', note: null });
  });

  it('pending: At Agent Ops, next Tenant Ops', () => {
    expect(st('pending')).toMatchObject({ label: 'At Agent Ops', next: 'Next: Tenant Ops' });
  });

  it('agent_ops_approved: At Tenant Ops, next Landlord Ops', () => {
    expect(st('agent_ops_approved')).toMatchObject({ label: 'At Tenant Ops', next: 'Next: Landlord Ops' });
  });

  it.each(['tenant_ops_approved', 'landlord_ops_approved', 'partner_ops_approved'])('%s: At the COO, next the funders\' board', (s) => {
    expect(st(s)).toMatchObject({ label: 'At the COO', next: "Next: funders' board", note: null });
    expect(agentRequestStatus({ status: s }, { eligible: true, reason: null }).label).toBe('At the COO');
  });

  it('at the COO but not eligible: Waiting at the COO with the reason', () => {
    const below = agentRequestStatus({ status: 'tenant_ops_approved' }, agentEligibilityFrom({ vetted: true }, { eligible: false, pct: 32 }));
    expect(below).toMatchObject({ label: 'Waiting at the COO', note: 'Your collection is 32%, below 50%', tone: 'waiting' });
    const unverified = agentRequestStatus({ status: 'partner_ops_approved' }, agentEligibilityFrom({ vetted: false }, null));
    expect(unverified).toMatchObject({ label: 'Waiting at the COO', note: 'You are not verified yet' });
    const both = agentEligibilityFrom({ vetted: false }, { eligible: false, pct: 40.5 });
    expect(both?.reason).toBe('Your collection is 40.5%, below 50% and you are not verified yet');
  });

  it('coo_approved: on the funders\' board, waiting for a funder (no CFO funding)', () => {
    const v = st('coo_approved');
    expect(v.label).toBe("On the funders' board — waiting for a funder");
    expect(v.next).toBe('Next: a funder selects, then the money comes to your landlord float');
    expect(`${v.label} ${v.next}`).not.toMatch(/CFO|Funds sent to landlord/);
  });

  it('funded: pay the landlord now, next the landlord confirms with the OTP', () => {
    expect(st('funded')).toMatchObject({ label: 'Funded — pay the landlord now', next: 'Next: landlord confirms with the OTP' });
  });

  it('repaying: Live — collect daily', () => {
    expect(st('repaying')).toMatchObject({ label: 'Live — collect daily', next: null });
    expect(st('disbursed').label).toBe('Live — collect daily');
  });

  it('completed: Completed (only once repaid in full)', () => {
    expect(st('completed', { amount_repaid: 420000, total_repayment: 420000 })).toMatchObject({ label: 'Completed', next: null });
    expect(st('completed').label).toBe('Completed');
    expect(st('completed', { amount_repaid: 100, total_repayment: 420000 }).label).toBe('Live — collect daily');
  });

  it('returned to the agent: Sent back to you — fix and resubmit, with the desk\'s note', () => {
    expect(st('rejected', { returned_at: '2026-11-16T09:00:00Z', rejected_reason: 'Wrong landlord phone' }))
      .toMatchObject({ label: 'Sent back to you — fix and resubmit', note: 'Wrong landlord phone', tone: 'returned' });
  });

  it('rejected (not returned): Rejected, with the reason', () => {
    expect(st('rejected', { returned_at: null, rejected_reason: 'Tenant already has a Rent Plan' }))
      .toMatchObject({ label: 'Rejected', note: 'Tenant already has a Rent Plan', tone: 'rejected' });
  });

  it('eligibility: nothing known gives null; eligible and verified gives no reason', () => {
    expect(agentEligibilityFrom(null, null)).toBeNull();
    expect(agentEligibilityFrom({ vetted: true }, { eligible: true, pct: 72 })).toEqual({ eligible: true, reason: null });
    expect(agentRequestStatusLabel('coo_approved')).not.toMatch(/CFO/);
  });
});
