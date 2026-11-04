import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, roles: [] }) }));

import { deskChecklistOn } from '../deskFlag';
import { deskLiveFrom, isMissingDbObject } from '../deskLive';
import { STRIP_STAGES, stripMarks } from '../PipelineStrip';
import { defaultWaitHours, isTimeUp, timeLeftText, toWaitingItem, waitBlocked, waitReasonOptions, waitDeskForStage } from '../waitOn';
import { findGap, oldestTimeUp, toPerson, topBlockers } from '../CommandAdditions';

afterEach(() => vi.unstubAllEnvs());

const DESKS = ['command', 'coo', 'service-centre', 'agent-ops', 'tenant-ops', 'landlord-ops', 'partner-ops', 'cfo', 'customer-care', 'ontology'];

describe('deskLive', () => {
  it('a missing row means live', () => {
    DESKS.forEach((d) => expect(deskLiveFrom([], d, true)).toBe(true));
    expect(deskLiveFrom(undefined, 'coo', true)).toBe(true);
    expect(deskLiveFrom(null, 'coo', true)).toBe(true);
  });

  it('a row with is_on=false turns only that desk off', () => {
    const rows = [{ key: 'desk_live:cfo', is_on: false }, { key: 'desk_live:coo', is_on: true }, { key: 'desk_live:agent-ops', is_on: null }];
    expect(deskLiveFrom(rows, 'cfo', true)).toBe(false);
    expect(deskLiveFrom(rows, 'coo', true)).toBe(true);
    expect(deskLiveFrom(rows, 'agent-ops', true)).toBe(true);
    expect(deskLiveFrom(rows, 'command', true)).toBe(true);
  });

  it('checklist off (VITE_DESK_CHECKLIST=false) turns every desk off', () => {
    vi.stubEnv('VITE_DESK_CHECKLIST', 'false');
    expect(deskChecklistOn('welileapp.com')).toBe(false);
    expect(deskChecklistOn('localhost')).toBe(false);
    DESKS.forEach((d) => expect(deskLiveFrom([], d, deskChecklistOn('welileapp.com'))).toBe(false));
  });

  it('deskChecklistOn is on for welileapp.com unless the variable says false', () => {
    vi.stubEnv('VITE_DESK_CHECKLIST', '');
    expect(deskChecklistOn('welileapp.com')).toBe(true);
    expect(deskChecklistOn('www.welileapp.com')).toBe(true);
    expect(deskChecklistOn('localhost')).toBe(true);
    expect(deskChecklistOn('id-preview--abc.lovable.app')).toBe(true);
    expect(deskChecklistOn('example.org')).toBe(false);
  });

  it('recognises "does not exist" errors', () => {
    expect(isMissingDbObject({ code: '42P01', message: 'relation "pipeline_switches" does not exist' })).toBe(true);
    expect(isMissingDbObject({ code: 'PGRST202', message: 'Could not find the function' })).toBe(true);
    expect(isMissingDbObject({ code: '42501', message: 'permission denied' })).toBe(false);
  });
});

describe('PipelineStrip marks', () => {
  it('lights each stage desk and the stage before it', () => {
    expect(stripMarks('service-centre')).toEqual({ mine: '0b', before: null });
    expect(stripMarks('agent-ops')).toEqual({ mine: '1', before: '0b' });
    expect(stripMarks('tenant-ops')).toEqual({ mine: '2', before: '1' });
    expect(stripMarks('landlord-ops')).toEqual({ mine: '3', before: '2' });
    // Partner Ops is retired, so Landlord Ops is what comes to the COO.
    expect(stripMarks('coo')).toEqual({ mine: '5', before: '3' });
    expect(stripMarks('cfo')).toEqual({ mine: '6', before: '5' });
  });

  it('desks off the pipeline highlight nothing', () => {
    expect(stripMarks('customer-care')).toEqual({ mine: null, before: null });
    expect(stripMarks('ontology')).toEqual({ mine: null, before: null });
    expect(stripMarks('command')).toEqual({ mine: null, before: null });
  });

  it('runs SC new → Landlord paid with Partner Ops retired', () => {
    expect(STRIP_STAGES.map((s) => s.ord)).toEqual(['0b', '1', '2', '3', '4', '5', '6', '7']);
    expect(STRIP_STAGES.filter((s) => s.retired).map((s) => s.label)).toEqual(['Partner Ops']);
  });
});

function waitRow(over: Partial<Parameters<typeof toWaitingItem>[0]> = {}): Parameters<typeof toWaitingItem>[0] {
  return {
    waiting_id: 'w1',
    rent_request_id: '11111111-2222-3333-4444-555555555555',
    req: '11111111',
    tenant: 'T1',
    reason_code: 'NO_RECEIVER',
    owner_kind: 'landlord',
    owner_name: 'L. Owner',
    note: null,
    set_by_name: 'Staff',
    set_by_staff_ref: 'WL-001',
    set_at: '2026-11-02T10:00:00Z',
    until_at: '2026-11-04T10:00:00Z',
    expired: false,
    hours_left: 5,
    ...over,
  };
}

describe('Wait on…', () => {
  const ok = { owner: 'agent' as const, reasonCode: 'TENANT_ID_MISSING', hours: 24, note: '' };

  it('defaults to 24 hours, 48 for NO_RECEIVER', () => {
    expect(defaultWaitHours('TENANT_ID_MISSING')).toBe(24);
    expect(defaultWaitHours('NO_RECEIVER')).toBe(48);
  });

  it('caps hours at 168 and needs a note of 10+ for OTHER', () => {
    expect(waitBlocked(ok)).toBeNull();
    expect(waitBlocked({ ...ok, hours: 169 })).toMatch(/168/);
    expect(waitBlocked({ ...ok, hours: 0 })).toMatch(/at least 1/);
    expect(waitBlocked({ ...ok, owner: '' })).toMatch(/who/);
    expect(waitBlocked({ ...ok, reasonCode: 'OTHER', note: 'short' })).toMatch(/10 characters/);
    expect(waitBlocked({ ...ok, reasonCode: 'OTHER', note: 'landlord travelling' })).toBeNull();
  });

  it('offers the desk-tagged codes plus the three every desk gets', () => {
    const all = [
      { code: 'LL_UNREACHABLE', desks: ['Landlord Ops'], meaning: 'x' },
      { code: 'AG_MISSING', desks: ['Agent Ops'], meaning: 'y' },
      { code: 'OTHER', desks: ['all'], meaning: 'Other' },
    ];
    expect(waitReasonOptions(all, 'Landlord Ops').map((r) => r.code)).toEqual(['LL_UNREACHABLE', 'OTHER', 'NO_RECEIVER', 'TENANT_ID_MISSING']);
  });

  it('has no p_desk for the retired Partner Ops stage', () => {
    expect(waitDeskForStage('partner_ops')).toBeNull();
    expect(waitDeskForStage('coo')).toBe('coo');
  });

  it('reads the pipeline_waiting_list row and trusts its expired flag', () => {
    const w = toWaitingItem(waitRow({ expired: true, hours_left: 2 }));
    expect(w.requestId).toBe('11111111-2222-3333-4444-555555555555');
    expect(w.req).toBe('11111111');
    expect(isTimeUp(w)).toBe(true);
    expect(isTimeUp(toWaitingItem(waitRow({ expired: false, hours_left: 6 })))).toBe(false);
    expect(timeLeftText(0)).toBe('Time up');
    expect(timeLeftText(6)).toBe('6 h left');
  });
});

describe('command centre additions', () => {
  const gaps = [
    { ord: '1', gap: 'Funded, landlord not yet paid', n: 4, ugx: 2_000_000, oldest_days: 3.5, owner: 'CFO', next_step: 'Pay landlord' },
    { ord: '2', gap: 'Paid, receipt missing over 24h', n: 3, ugx: 900_000, oldest_days: 2, owner: 'Agent', next_step: 'Upload receipt' },
    { ord: '3', gap: 'Something else', n: 1, ugx: 50_000, oldest_days: 1, owner: 'COO', next_step: 'Check' },
  ];

  it('picks the money-line rows by ord, not by label', () => {
    expect(findGap(gaps, 'funded_not_paid')).toMatchObject({ n: 4, ugx: 2_000_000, oldestDays: 3.5 });
    expect(findGap(gaps, 'receipts_missing')).toMatchObject({ n: 3, ugx: 900_000 });
    expect(findGap([{ ord: '1', gap: 'receipt', n: 9, ugx: 1 }], 'receipts_missing')).toBeNull();
    expect(findGap([], 'funded_not_paid')).toBeNull();
  });

  it('ranks gaps by UGX first; waiting items (no amount) fill the rest, time-up first', () => {
    const late = { ...toWaitingItem(waitRow({ waiting_id: 'a', expired: true, until_at: '2026-11-03T10:00:00Z' })), desk: 'cfo' as const };
    const later = { ...toWaitingItem(waitRow({ waiting_id: 'b', expired: true, until_at: '2026-11-04T09:00:00Z' })), desk: 'coo' as const };
    const fresh = { ...toWaitingItem(waitRow({ waiting_id: 'c', expired: false })), desk: 'coo' as const };

    expect(topBlockers(gaps, [fresh, late]).map((b) => b.ugx)).toEqual([2_000_000, 900_000, 50_000]);
    const mixed = topBlockers(gaps.slice(0, 1), [fresh, late]);
    expect(mixed.map((b) => b.key)).toEqual(['gap-1', 'wait-a', 'wait-c']);
    expect(mixed[1].next).toMatch(/Time up/);
    expect(oldestTimeUp([fresh, later, late])?.waitingId).toBe('a');
  });

  it('reads desk_sc_people rows', () => {
    const p = toPerson({ person_id: 'p1', name: 'Amina', phone: null, open_new: 7, open_batch: 2, oldest_new_days: 4.2, has_staff_id: false, has_desk_role: true });
    expect(p).toEqual({ key: 'p1', name: 'Amina', openNew: 7, oldestDays: 4.2, hasStaffId: false });
  });
});
