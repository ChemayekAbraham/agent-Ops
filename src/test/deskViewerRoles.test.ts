import { describe, expect, it } from 'vitest';
import { canViewDeskReads } from '@/lib/deskViewerRoles';

describe('canViewDeskReads', () => {
  it('skips desk reads for agents and tenants', () => {
    expect(canViewDeskReads(['agent', 'tenant', 'supporter'])).toBe(false);
    expect(canViewDeskReads([])).toBe(false);
  });
  it('allows desk staff roles', () => {
    expect(canViewDeskReads(['agent', 'coo'])).toBe(true);
    expect(canViewDeskReads(['agent_ops'])).toBe(true);
  });
});
