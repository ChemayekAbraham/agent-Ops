import { describe, it, expect } from 'vitest';
import { defaultAwarenessSubjectForStage, telHref } from './awarenessCallLabels';

describe('defaultAwarenessSubjectForStage', () => {
  it('Landlord Ops (the tenant_ops_approved queue) starts with the landlord', () => {
    expect(defaultAwarenessSubjectForStage('tenant_ops_approved')).toBe('landlord');
  });

  it('Agent Ops (pending) and Tenant Ops (agent_ops_approved) start with the tenant, as does every other stage', () => {
    for (const stage of ['pending', 'agent_ops_approved', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved', 'service_center_review', '', null, undefined]) {
      expect(defaultAwarenessSubjectForStage(stage as string | null | undefined)).toBe('tenant');
    }
  });
});

describe('telHref', () => {
  it('keeps digits and a leading plus, and refuses a number that is too short', () => {
    expect(telHref('0700 111-222')).toBe('tel:0700111222');
    expect(telHref('+256 700 333 444')).toBe('tel:+256700333444');
    expect(telHref('123')).toBeNull();
    expect(telHref('')).toBeNull();
  });
});
