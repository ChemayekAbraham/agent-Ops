import { describe, it, expect, vi } from 'vitest';

// The test environment has no Supabase URL; these helpers never touch the client.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { agentAttention, availableSchoolsRoles, resolveSchoolsRole } from '@/lib/welileSchoolsHome';

describe('availableSchoolsRoles', () => {
  it('gives agents and ops both views, agent first', () => {
    expect(availableSchoolsRoles(['tenant', 'agent'])).toEqual(['agent', 'parent']);
    expect(availableSchoolsRoles(['agent_ops'])).toEqual(['agent', 'parent']);
  });
  it('gives everyone else the parent view only', () => {
    expect(availableSchoolsRoles(['tenant', 'supporter'])).toEqual(['parent']);
    expect(availableSchoolsRoles([])).toEqual(['parent']);
  });
});

describe('resolveSchoolsRole', () => {
  it('keeps a remembered choice that is still allowed', () => {
    expect(resolveSchoolsRole(['agent', 'parent'], 'parent')).toBe('parent');
  });
  it('drops a remembered agent choice once the agent role is gone', () => {
    expect(resolveSchoolsRole(['parent'], 'agent')).toBe('parent');
  });
  it('defaults to the first available view', () => {
    expect(resolveSchoolsRole(['agent', 'parent'], null)).toBe('agent');
    expect(resolveSchoolsRole(['agent', 'parent'], 'nonsense')).toBe('agent');
  });
});

describe('agentAttention', () => {
  const base = { hasCurrentSchool: true, partnershipStatus: null, missingForSubmit: [] as string[], pendingUploads: 0 };

  it('asks for a school first when none is chosen', () => {
    expect(agentAttention({ ...base, hasCurrentSchool: false }).map((i) => i.kind)).toEqual(['pick_school']);
  });
  it('lists what the set-up still needs', () => {
    const [item] = agentAttention({ ...base, partnershipStatus: 'draft', missingForSubmit: ['bursar contact'] });
    expect(item.kind).toBe('finish_setup');
    expect(item.detail).toBe('Still missing: bursar contact');
  });
  it('flags changes requested as urgent', () => {
    expect(agentAttention({ ...base, partnershipStatus: 'changes_requested' })[0]).toMatchObject({ kind: 'changes_requested', tone: 'danger' });
  });
  it('is quiet for an approved school with nothing waiting', () => {
    expect(agentAttention({ ...base, partnershipStatus: 'approved' })).toEqual([]);
  });
  it('adds offline uploads after the school item', () => {
    expect(agentAttention({ ...base, partnershipStatus: 'submitted', pendingUploads: 3 }).map((i) => i.kind)).toEqual(['awaiting_approval', 'offline_queue']);
    expect(agentAttention({ ...base, partnershipStatus: 'approved', pendingUploads: 1 })[0].title).toBe('1 record waiting to upload');
  });
});
