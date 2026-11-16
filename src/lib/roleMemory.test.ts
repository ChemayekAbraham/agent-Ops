import { beforeEach, describe, expect, it } from 'vitest';
import { getLastUsedRole, setLastUsedRole, lastRoleKey, LEGACY_LAST_ROLE_KEY } from './roleMemory';

describe('roleMemory — per-account last role', () => {
  beforeEach(() => localStorage.clear());

  it('keeps each account on a shared phone separate', () => {
    setLastUsedRole('agent-account', 'supporter');
    setLastUsedRole('tenant-account', 'tenant');
    expect(getLastUsedRole('agent-account')).toBe('supporter');
    expect(getLastUsedRole('tenant-account')).toBe('tenant');
  });

  it('gives a new account on the phone no remembered role', () => {
    setLastUsedRole('agent-account', 'supporter');
    expect(getLastUsedRole('brand-new-tenant')).toBeNull();
  });

  it('ignores the old shared key and removes it on the next write', () => {
    localStorage.setItem(LEGACY_LAST_ROLE_KEY, 'supporter');
    expect(getLastUsedRole('tenant-account')).toBeNull();
    setLastUsedRole('tenant-account', 'tenant');
    expect(localStorage.getItem(LEGACY_LAST_ROLE_KEY)).toBeNull();
    expect(localStorage.getItem(lastRoleKey('tenant-account'))).toBe('tenant');
  });

  it('does nothing without an account', () => {
    setLastUsedRole(null, 'agent');
    expect(getLastUsedRole(null)).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});
