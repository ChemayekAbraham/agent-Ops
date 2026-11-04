import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, roles: [] }) }));

import { deskChecklistOn } from '../deskFlag';
import { deskLiveFrom, isMissingDbObject } from '../deskLive';
import { STRIP_STAGES, stripMarks } from '../PipelineStrip';
import { defaultWaitHours, hoursLeft, timeLeftText, waitBlocked, waitReasonOptions, waitDeskForStage } from '../waitOn';
import { findGap, oldestTimeUp, topBlockers } from '../CommandAdditions';

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

  it('says Time up once the wait runs out', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    expect(timeLeftText(hoursLeft('2026-11-04T11:00:00Z', now))).toBe('Time up');
    expect(timeLeftText(hoursLeft('2026-11-04T18:00:00Z', now))).toBe('6 h left');
  });
});

describe('command centre additions', () => {
  const gaps = [
    { ord: 1, gap: 'Funded, landlord not paid', n: 4, ugx: 2_000_000, owner: 'CFO', next_step: 'Pay landlord' },
    { ord: 2, gap: 'Paid, no receipt after 24 h', n: 3, ugx: 900_000, owner: 'Agent', next_step: 'Upload receipt' },
  ];

  it('picks the two money-line rows out of the payment gaps', () => {
    expect(findGap(gaps, 'funded_not_paid')?.n).toBe(4);
    expect(findGap(gaps, 'receipts_missing')?.ugx).toBe(900_000);
    expect(findGap([], 'receipts_missing')).toBeNull();
  });

  it('ranks the top 3 blockers by UGX across gaps and waits', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    const waits = [
      { requestId: 'a', tenant: 'T1', reasonCode: 'NO_RECEIVER', ownerKind: 'landlord', setByName: 'S', setByStaffRef: null, expiresAt: '2026-11-04T10:00:00Z', setAt: null, ugx: 5_000_000, note: null, desk: 'cfo' as const },
      { requestId: 'b', tenant: 'T2', reasonCode: 'OTHER', ownerKind: 'agent', setByName: 'S', setByStaffRef: null, expiresAt: '2026-11-05T10:00:00Z', setAt: null, ugx: 100, note: null, desk: 'coo' as const },
    ];
    const top = topBlockers(gaps, waits, now);
    expect(top.map((b) => b.ugx)).toEqual([5_000_000, 2_000_000, 900_000]);
    expect(top[0].next).toMatch(/Time up/);
    expect(oldestTimeUp(waits, now)?.requestId).toBe('a');
  });
});
