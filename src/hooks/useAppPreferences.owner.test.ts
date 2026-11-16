import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/authenticatedRequests', () => ({ getSessionCheckedUser: async () => ({ data: { user: null } }) }));
vi.mock('@/lib/routingPrefsServer', () => ({ fetchServerRoutingPrefs: async () => null, saveServerRoutingPrefs: async () => {} }));

import { getPreferredDefaultRole, isAgentAutoDefaultDisabled, readOwnedRoutingPrefs } from './useAppPreferences';

const save = (prefs: object) => localStorage.setItem('welile_app_preferences', JSON.stringify(prefs));

describe('routing prefs belong to one account', () => {
  beforeEach(() => localStorage.clear());

  it("honours this account's own home screen", () => {
    save({ defaultRole: 'landlord', disableAgentAutoDefault: true, routingOwner: 'me' });
    expect(getPreferredDefaultRole('me')).toBe('landlord');
    expect(isAgentAutoDefaultDisabled('me')).toBe(true);
  });

  it("ignores another account's choice on a shared phone", () => {
    save({ defaultRole: 'supporter', disableAgentAutoDefault: true, routingOwner: 'previous-user' });
    expect(getPreferredDefaultRole('new-tenant')).toBe('auto');
    expect(isAgentAutoDefaultDisabled('new-tenant')).toBe(false);
    expect(readOwnedRoutingPrefs('new-tenant')).toBeNull();
  });

  it('ignores a choice saved before owners were recorded', () => {
    save({ defaultRole: 'supporter' });
    expect(getPreferredDefaultRole('anyone')).toBe('auto');
  });

  it('returns auto when nobody is signed in', () => {
    save({ defaultRole: 'supporter', routingOwner: 'me' });
    expect(getPreferredDefaultRole(null)).toBe('auto');
  });
});
