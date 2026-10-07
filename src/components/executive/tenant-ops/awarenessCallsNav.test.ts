import { describe, it, expect } from 'vitest';
import {
  AWARENESS_CALLS_ROLES, TENANT_OPS_NAV, TENANT_OPS_VIEW_KEYS, canSeeTenantOpsNavEntry, isTenantOpsViewKey, searchTenantOpsNav,
  tenantOpsGroupForView, tenantOpsLabelFor, visibleTenantOpsNav,
} from './tenantOpsNav';

describe('Awareness Calls in the Tenant Ops Classic nav', () => {
  it('is a view the shell accepts, found by name and by its keywords, under Tenant Ops Tools', () => {
    expect(isTenantOpsViewKey('awareness-calls')).toBe(true);
    expect(TENANT_OPS_VIEW_KEYS.has('awareness-calls')).toBe(true);
    expect(tenantOpsLabelFor('awareness-calls')).toBe('Awareness Calls');
    expect(tenantOpsGroupForView('awareness-calls')).toBe('tools');
    expect(searchTenantOpsNav('awareness').map((r) => r.view)).toContain('awareness-calls');
    expect(searchTenantOpsNav('merchant codes').map((r) => r.view)).toContain('awareness-calls');
  });

  it('leaves every other destination where it was', () => {
    const keys = TENANT_OPS_NAV.flatMap((i) => [i.key, ...(i.children?.map((c) => c.key) ?? [])]);
    for (const k of ['home', 'pipeline', 'calling-hub', 'calling-center', 'collection-shortfall', 'tenant-operations-workspace', 'reports-hub']) {
      expect(keys).toContain(k);
    }
    expect(keys.filter((k) => k === 'awareness-calls')).toHaveLength(1);
  });
});

describe('Awareness Calls menu entry is hidden from people who cannot open it', () => {
  const keysFor = (roles: string[] | undefined) =>
    visibleTenantOpsNav(roles).flatMap((i) => [i.key, ...(i.children?.map((c) => c.key) ?? [])]);

  it('is for Tenant Ops, COO, CEO and super admin only', () => {
    expect([...AWARENESS_CALLS_ROLES].sort()).toEqual(['ceo', 'coo', 'super_admin', 'tenant_ops']);
    for (const role of AWARENESS_CALLS_ROLES) expect(keysFor([role])).toContain('awareness-calls');
    expect(keysFor(['tenant_ops', 'supporter'])).toContain('awareness-calls');
  });

  it('is left out for everyone else, but every other entry is still there', () => {
    for (const roles of [['agent_ops'], ['landlord_ops'], ['cfo'], ['manager'], ['supporter'], [], undefined]) {
      const keys = keysFor(roles as string[] | undefined);
      expect(keys).not.toContain('awareness-calls');
      for (const k of ['home', 'pipeline', 'calling-hub', 'calling-center', 'collection-shortfall', 'reports-hub']) expect(keys).toContain(k);
    }
  });

  it('is left out of the search for them too, and still found for the roles that can open it', () => {
    expect(searchTenantOpsNav('awareness', ['agent_ops']).map((r) => r.view)).not.toContain('awareness-calls');
    expect(searchTenantOpsNav('awareness', ['coo']).map((r) => r.view)).toContain('awareness-calls');
    // without roles the search behaves as before
    expect(searchTenantOpsNav('awareness').map((r) => r.view)).toContain('awareness-calls');
  });

  it('the view itself is still a valid destination (a direct link shows the page\'s "Not available" message)', () => {
    expect(isTenantOpsViewKey('awareness-calls')).toBe(true);
    expect(TENANT_OPS_VIEW_KEYS.has('awareness-calls')).toBe(true);
  });

  it('canSeeTenantOpsNavEntry: no restriction means everyone', () => {
    expect(canSeeTenantOpsNavEntry({}, [])).toBe(true);
    expect(canSeeTenantOpsNavEntry({ roles: ['coo'] }, ['coo'])).toBe(true);
    expect(canSeeTenantOpsNavEntry({ roles: ['coo'] }, ['cfo'])).toBe(false);
  });
});
