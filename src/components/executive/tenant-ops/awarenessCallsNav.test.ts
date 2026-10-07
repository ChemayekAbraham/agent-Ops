import { describe, it, expect } from 'vitest';
import { TENANT_OPS_NAV, TENANT_OPS_VIEW_KEYS, isTenantOpsViewKey, searchTenantOpsNav, tenantOpsGroupForView, tenantOpsLabelFor } from './tenantOpsNav';

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
