import { describe, it, expect } from 'vitest';
import { effectiveRoles, landingWithoutRoles, FALLBACK_ROUTE, NO_ROLES_ROUTE } from './roleFallback';

describe('roleFallback', () => {
  it('loaded roles are used as-is', () => {
    expect(effectiveRoles(['tenant', 'agent'], true)).toEqual(['tenant', 'agent']);
    expect(effectiveRoles(['tenant'], false)).toEqual(['tenant']);
  });

  it('roles not loaded → act as agent', () => {
    expect(effectiveRoles([], false)).toEqual(['agent']);
    expect(landingWithoutRoles(false)).toBe(FALLBACK_ROUTE);
    expect(FALLBACK_ROUTE).toBe('/dashboard/agent');
  });

  it('roles loaded and empty (restricted) → no fallback, role picker', () => {
    expect(effectiveRoles([], true)).toEqual([]);
    expect(landingWithoutRoles(true)).toBe(NO_ROLES_ROUTE);
    expect(NO_ROLES_ROUTE).toBe('/select-role');
  });
});
