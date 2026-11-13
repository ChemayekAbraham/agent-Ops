import { describe, it, expect, vi } from 'vitest';

// The test environment has no Supabase URL; these helpers never touch the client.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import {
  ROLE_INTRO, SCHOOLS_ROLES, agentAttention, canWorkAsSchoolAgent, isSchoolsRole, roleFromQuery,
} from '@/lib/welileSchoolsHome';

describe('canWorkAsSchoolAgent', () => {
  it('is true for agents and Welile Schools ops', () => {
    expect(canWorkAsSchoolAgent(['tenant', 'agent'])).toBe(true);
    expect(canWorkAsSchoolAgent(['agent_ops'])).toBe(true);
  });
  it('is false for everyone else, and when signed out', () => {
    expect(canWorkAsSchoolAgent(['tenant', 'supporter'])).toBe(false);
    expect(canWorkAsSchoolAgent([])).toBe(false);
    expect(canWorkAsSchoolAgent(null)).toBe(false);
  });
});

describe('roles and the funnel', () => {
  it('offers three separate homes in switcher order', () => {
    expect(SCHOOLS_ROLES).toEqual(['parent', 'school', 'agent']);
  });
  it('has an intro with three points for every role', () => {
    SCHOOLS_ROLES.forEach((r) => expect(ROLE_INTRO[r].points).toHaveLength(3));
  });
  it('accepts only known roles', () => {
    expect(isSchoolsRole('school')).toBe(true);
    expect(isSchoolsRole('admin')).toBe(false);
    expect(isSchoolsRole(null)).toBe(false);
  });
  it('reads a role from a link so the funnel can be skipped', () => {
    expect(roleFromQuery('?role=parent')).toBe('parent');
    expect(roleFromQuery('?role=landlord')).toBeNull();
    expect(roleFromQuery('')).toBeNull();
  });
  it('never uses the word loan or interest in what visitors read', () => {
    const copy = JSON.stringify(ROLE_INTRO).toLowerCase();
    expect(copy).not.toMatch(/\bloan|\binterest\b/);
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
