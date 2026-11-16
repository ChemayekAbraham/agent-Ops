import { describe, expect, it } from 'vitest';
import { parseReadyToRenew, sortReadyToRenew } from '../readyToRenew';

describe('parseReadyToRenew', () => {
  it('reads object-shaped tenant/agent and prev_request_id', () => {
    const rows = parseReadyToRenew([
      {
        prev_request_id: 'rr-1',
        tenant: { id: 't-1', name: 'Grace Nakato', phone: '0700000001' },
        agent: { id: 'a-1', name: 'Agent One', phone: '0700000002' },
        last_rent: 300000,
        last_days: 30,
        completed_on: '2026-11-01',
        tenant_asked: false,
      },
    ]);
    expect(rows).toEqual([
      {
        prevId: 'rr-1', tenantId: 't-1', tenantName: 'Grace Nakato', tenantPhone: '0700000001',
        agentId: 'a-1', agentName: 'Agent One', lastRent: 300000, lastDays: 30,
        completedOn: '2026-11-01', tenantAsked: false,
      },
    ]);
  });

  it('reads string tenant/agent names, numeric strings and the other id keys', () => {
    const rows = parseReadyToRenew([
      { last_request_id: 'rr-2', tenant: 'Peter', agent: 'Agent Two', last_rent: '150000', last_days: '14', tenant_asked: 'true', completed_on: '2026-11-05' },
      { request_id: 'rr-3', tenant: { full_name: 'Sarah', id: 't-3' }, last_rent: 1, last_days: 7, completed_on: '2026-11-04' },
      { id: 'rr-4', tenant: 'Moses', completed_on: '2026-11-03' },
      { prev_request_id: { id: 'rr-5' }, tenant: 'Obj Id', completed_on: '2026-11-02' },
      { last_request: { id: 'rr-6' }, tenant: 'Nested', completed_on: '2026-11-01' },
    ])!;
    expect(rows.map((r) => r.prevId)).toEqual(['rr-2', 'rr-3', 'rr-4', 'rr-5', 'rr-6']);
    expect(rows[0]).toMatchObject({ tenantName: 'Peter', tenantId: null, agentName: 'Agent Two', agentId: null, lastRent: 150000, lastDays: 14, tenantAsked: true });
    expect(rows[1]).toMatchObject({ tenantName: 'Sarah', tenantId: 't-3', agentId: null, tenantAsked: false });
  });

  it('prefers prev_request_id over a row id', () => {
    expect(parseReadyToRenew([{ id: 'row-id', prev_request_id: 'rr-prev', tenant: 'X' }])![0].prevId).toBe('rr-prev');
  });

  it('skips rows without a previous request id', () => {
    const rows = parseReadyToRenew([{ tenant: 'No id', last_rent: 1 }, null, 'x', { prev_request_id: 'rr-1', tenant: 'Kept' }]);
    expect(rows!.map((r) => r.tenantName)).toEqual(['Kept']);
  });

  it('accepts a wrapped or JSON-string list and returns null for anything else', () => {
    expect(parseReadyToRenew({ rows: [{ id: 'a', tenant: 'A' }] })!.length).toBe(1);
    expect(parseReadyToRenew(JSON.stringify([{ id: 'b', tenant: 'B' }]))!.length).toBe(1);
    expect(parseReadyToRenew([])).toEqual([]);
    expect(parseReadyToRenew(null)).toBeNull();
    expect(parseReadyToRenew({ ok: false })).toBeNull();
    expect(parseReadyToRenew('not json')).toBeNull();
  });

  it('puts tenant-asked rows first, then newest completed first', () => {
    const rows = parseReadyToRenew([
      { id: 'old', tenant: 'Old', completed_on: '2026-09-01' },
      { id: 'asked-old', tenant: 'Asked old', completed_on: '2026-08-01', tenant_asked: true },
      { id: 'new', tenant: 'New', completed_on: '2026-11-10' },
      { id: 'nodate', tenant: 'No date' },
      { id: 'asked-new', tenant: 'Asked new', completed_on: '2026-10-01', tenant_asked: true },
    ])!;
    expect(rows.map((r) => r.prevId)).toEqual(['asked-new', 'asked-old', 'new', 'old', 'nodate']);
    expect(sortReadyToRenew([])).toEqual([]);
  });
});
