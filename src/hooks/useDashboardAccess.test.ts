import { describe, it, expect } from 'vitest';
import { normalizeOverview, summarizeByDashboard } from './useDashboardAccess';
import { DASHBOARD_ACCESS_KEYS } from '@/lib/dashboardAccessKeys';

const raw = {
  generated_at: '2026-10-21T12:00:00Z',
  keys: DASHBOARD_ACCESS_KEYS.map((d) => d.key),
  grants: [
    { grant_id: 'g1', user_id: 'u1', full_name: 'Ann', phone: '+2567', dashboard: 'cfo', granted_at: '2026-10-01', granted_by: 'a1', granted_by_name: 'Boss' },
    { grant_id: 'g2', user_id: 'u2', full_name: 'Ben', phone: null, dashboard: 'cmo', granted_at: null, granted_by: null, granted_by_name: null },
  ],
  missing: [
    { user_id: 'u3', full_name: 'Cy', phone: null, roles: ['manager', 'operations'], dashboard: 'company-ops' },
    { user_id: 'u4', full_name: 'Di', phone: null, roles: ['cmo'], dashboard: 'cmo' },
  ],
};

describe('useDashboardAccess data shaping', () => {
  it('normalizes the server overview into camelCase rows', () => {
    const o = normalizeOverview(raw);
    expect(o.grants[0]).toEqual({
      grantId: 'g1', userId: 'u1', fullName: 'Ann', phone: '+2567', dashboard: 'cfo',
      grantedAt: '2026-10-01', grantedBy: 'a1', grantedByName: 'Boss',
    });
    expect(o.missing[0].roles).toEqual(['manager', 'operations']);
  });

  it('tolerates an empty or malformed answer', () => {
    const o = normalizeOverview(null);
    expect(o.grants).toEqual([]);
    expect(o.missing).toEqual([]);
  });

  it('groups by dashboard in canonical key order, including empty dashboards', () => {
    const s = summarizeByDashboard(normalizeOverview(raw));
    expect(s.map((d) => d.key)).toEqual(DASHBOARD_ACCESS_KEYS.map((d) => d.key));
    const cmo = s.find((d) => d.key === 'cmo')!;
    expect(cmo.label).toBe('CMO Dashboard');
    expect(cmo.grants.map((g) => g.userId)).toEqual(['u2']);
    expect(cmo.missing.map((m) => m.userId)).toEqual(['u4']);
    expect(s.find((d) => d.key === 'kyc')!.grants).toEqual([]);
  });

  it('client key list matches the server list (dashboard_access_keys)', () => {
    expect(DASHBOARD_ACCESS_KEYS.map((d) => d.key).sort()).toEqual([
      'agent-ops', 'agents-space', 'ceo', 'cfo', 'cmo', 'company-ops', 'coo', 'crm', 'cto',
      'director', 'financial-ops', 'hr', 'kyc', 'landlord-ops', 'partner-ops', 'platform-users', 'rd', 'tenant-ops',
    ]);
  });
});
