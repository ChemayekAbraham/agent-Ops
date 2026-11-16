import { describe, expect, it } from 'vitest';
import { parseReadyToRenew, sortReadyToRenew } from '../readyToRenew';

/** One row exactly as ready_to_renew returns it (E128). */
const row = (over: Record<string, unknown> = {}) => ({
  last_request_id: '6f1c2a9e-0000-4000-8000-000000000001', ref: 'RR-1042',
  tenant: { id: 't-1', name: 'Grace Nakato', phone: '0700000001' },
  agent: { id: 'a-1', name: 'Agent One', phone: '0700000002' },
  last_rent: 300000, last_days: 30, repaid: 420000, total: 420000,
  completed_on: '2026-11-01', tenant_asked: false,
  ...over,
});

describe('parseReadyToRenew (the exact E128 row)', () => {
  it('reads every field; last_request_id is the previous request', () => {
    expect(parseReadyToRenew([row()])).toEqual([{
      prevId: '6f1c2a9e-0000-4000-8000-000000000001', ref: 'RR-1042',
      tenantId: 't-1', tenantName: 'Grace Nakato', tenantPhone: '0700000001',
      agentId: 'a-1', agentName: 'Agent One',
      lastRent: 300000, lastDays: 30, repaid: 420000, total: 420000,
      completedOn: '2026-11-01', tenantAsked: false,
    }]);
  });

  it('no fallbacks: other id keys and a string tenant are not read; a row without last_request_id is skipped', () => {
    const rows = parseReadyToRenew([
      { ...row(), last_request_id: undefined, prev_request_id: 'x', request_id: 'y', id: 'z' },
      row({ last_request_id: 'kept', tenant: 'Peter' }),
      null,
    ])!;
    expect(rows.map((r) => r.prevId)).toEqual(['kept']);
    expect(rows[0]).toMatchObject({ tenantName: 'Tenant', tenantId: null });
  });

  it('an array only: anything else is null; [] is []', () => {
    expect(parseReadyToRenew([])).toEqual([]);
    expect(parseReadyToRenew(null)).toBeNull();
    expect(parseReadyToRenew({ rows: [row()] })).toBeNull();
    expect(parseReadyToRenew(JSON.stringify([row()]))).toBeNull();
  });

  it('puts tenant-asked rows first, then newest completed first', () => {
    const rows = parseReadyToRenew([
      row({ last_request_id: 'old', completed_on: '2026-09-01' }),
      row({ last_request_id: 'asked-old', completed_on: '2026-08-01', tenant_asked: true }),
      row({ last_request_id: 'new', completed_on: '2026-11-10' }),
      row({ last_request_id: 'asked-new', completed_on: '2026-10-01', tenant_asked: true }),
    ])!;
    expect(rows.map((r) => r.prevId)).toEqual(['asked-new', 'asked-old', 'new', 'old']);
    expect(sortReadyToRenew([])).toEqual([]);
  });
});
