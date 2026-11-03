import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/sessionCache', () => ({ setCachedRoles: () => {} }));
vi.mock('@/hooks/useAppPreferences', () => ({ getPreferredDefaultRole: () => 'auto' }));

import { splitDashboardRoles } from './roleManager';

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
