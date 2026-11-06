import { describe, it, expect } from 'vitest';
import { WH_FLOAT_STAGES, whStageForStatus } from '@/lib/welileHomesFloat';
import { resolveWhPlanStage } from '@/lib/welileHomesPlanStatus';

describe('Welile Homes float stage order', () => {
  it('runs Agent → Agent Ops → Tenant Ops → Landlord Ops → COO → CFO', () => {
    expect(WH_FLOAT_STAGES.map((s) => s.key)).toEqual(['agent', 'agent_ops', 'tenant_ops', 'landlord_ops', 'coo', 'cfo']);
  });
  it('sends Tenant Ops-approved requests to Landlord Ops, not the COO', () => {
    expect(whStageForStatus('tenant_ops_approved')).toBe('landlord_ops');
    expect(whStageForStatus('landlord_ops_approved')).toBe('coo');
  });
  it('lets the agent request again after a return', () => {
    expect(resolveWhPlanStage({ linkedRequestStatus: 'returned_to_agent', hasCollections: false })).toBe('request_returned');
  });
});
