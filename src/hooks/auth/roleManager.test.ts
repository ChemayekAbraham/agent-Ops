import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/sessionCache', () => ({ setCachedRoles: () => {} }));
vi.mock('@/hooks/useAppPreferences', () => ({ getPreferredDefaultRole: () => 'auto' }));

import { splitDashboardRoles, chooseLandingRole } from './roleManager';

describe('chooseLandingRole', () => {
  const everyone = ['agent', 'tenant', 'supporter', 'landlord'] as const;
  const base = {
    userRoles: [...everyone],
    forcedDefault: null,
    preferred: 'auto',
    cashoutDefault: null,
    lastUsedRole: null,
    intendedRole: null,
  };

  it('lands a new tenant on the tenant dashboard even though they hold supporter', () => {
    expect(chooseLandingRole({ ...base, intendedRole: 'tenant' })).toBe('tenant');
  });

  it('falls back tenant-first, never supporter-first', () => {
    expect(chooseLandingRole(base)).toBe('tenant');
  });

  it("uses this account's own last role over the sign-up role", () => {
    expect(chooseLandingRole({ ...base, lastUsedRole: 'landlord', intendedRole: 'tenant' })).toBe('landlord');
  });

  it('respects an admin-forced role and a chosen home screen first', () => {
    expect(chooseLandingRole({ ...base, forcedDefault: 'supporter', preferred: 'landlord' })).toBe('supporter');
    expect(chooseLandingRole({ ...base, preferred: 'landlord', lastUsedRole: 'tenant' })).toBe('landlord');
  });

  it('sends merchant agents to the agent console over a stale last role', () => {
    expect(chooseLandingRole({ ...base, cashoutDefault: 'agent', lastUsedRole: 'supporter' })).toBe('agent');
  });

  it('skips a remembered role the account no longer holds', () => {
    expect(chooseLandingRole({ ...base, userRoles: ['agent', 'tenant'], lastUsedRole: 'supporter', intendedRole: 'tenant' })).toBe('tenant');
  });
});

describe('splitDashboardRoles', () => {
  it('keeps a synthetic agent on the client list and out of the enabled list', () => {
    const split = splitDashboardRoles([{ role: 'supporter', enabled: true }]);
    expect(split.clientRoles).toEqual(['agent', 'supporter']);
    expect(split.enabledRoles).toEqual(['supporter']);
  });

  it('does not treat a disabled agent row as enabled', () => {
    const split = splitDashboardRoles([
      { role: 'tenant', enabled: false },
      { role: 'agent', enabled: false },
      { role: 'supporter', enabled: true },
    ]);
    expect(split.clientRoles).toEqual(['agent', 'supporter']);
    expect(split.enabledRoles).toEqual(['supporter']);
  });

  it('keeps a real enabled agent in both lists once', () => {
    const split = splitDashboardRoles([
      { role: 'supporter', enabled: true },
      { role: 'agent', enabled: true },
    ]);
    expect(split.clientRoles).toEqual(['supporter', 'agent']);
    expect(split.enabledRoles).toEqual(['agent', 'supporter']);
  });

  it('returns nothing when every role is disabled', () => {
    const split = splitDashboardRoles([
      { role: 'agent', enabled: false },
      { role: 'supporter', enabled: false },
    ]);
    expect(split.clientRoles).toEqual([]);
    expect(split.enabledRoles).toEqual([]);
  });
});
