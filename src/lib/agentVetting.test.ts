import { describe, expect, it } from 'vitest';
import {
  agentNotVettedReason,
  canEditVetting,
  isLocationFresh,
  parseAgentVetting,
  parseVettingQueue,
  vettingChecklist,
  vettingProgress,
} from './agentVetting';

const NOW = new Date('2026-10-27T10:00:00Z');

// The shape get_my_agent_vetting returned for a real agent in the rolled-back walkthrough.
const raw = (o: Record<string, unknown> = {}) => ({
  status: 'unverified',
  review_note: null,
  enforced: false,
  enforce_from: null,
  phone: { value: '+256771234567', verified_at: null },
  email: { value: 'agent@gmail.com', verified_at: null },
  residence: { region: 'Eastern', district: 'Jinja', sub_county: 'Jinja Central', parish: 'Central', village: 'Iganga Road', town: null, city: null, complete: true },
  gps: { lat: null, lng: null, accuracy_m: null, captured_at: null },
  national_id: { ok: true, source: 'own', nin_masked: 'CM0*******QTOE', has_front: true, has_back: true, can_use_parent: true },
  passport_photo: { path: null, check: null },
  next_of_kin: { name: 'Parent Agent', phone: '+256700000001', relationship: 'Parent agent', source: 'parent_agent' },
  parent_agent: { id: 'p1', name: 'Parent Agent', phone: '+256700000001' },
  gps_rules: { max_accuracy_m: 100, max_drift_m: 200, max_age_minutes: 10 },
  ...o,
});

describe('parseAgentVetting', () => {
  it('reads the RPC shape and keeps the masked NIN', () => {
    const v = parseAgentVetting(raw());
    expect(v.status).toBe('unverified');
    expect(v.national_id.nin_masked).toBe('CM0*******QTOE');
    expect(v.national_id.source).toBe('own');
    expect(v.parent_agent?.id).toBe('p1');
    expect(v.gps_rules.max_age_minutes).toBe(10);
  });

  it('survives an empty or broken payload', () => {
    const v = parseAgentVetting(null);
    expect(v.status).toBe('unverified');
    expect(v.parent_agent).toBeNull();
    expect(v.national_id.ok).toBe(false);
    expect(v.gps_rules).toEqual({ max_accuracy_m: 100, max_drift_m: 200, max_age_minutes: 10 });
  });

  it('treats unknown statuses as unverified', () => {
    expect(parseAgentVetting(raw({ status: 'approved' })).status).toBe('unverified');
  });
});

describe('isLocationFresh', () => {
  it('is fresh inside the window and stale after it', () => {
    const at = (min: number) =>
      parseAgentVetting(raw({ gps: { lat: 0.35, lng: 32.58, accuracy_m: 20, captured_at: new Date(NOW.getTime() - min * 60_000).toISOString() } }));
    expect(isLocationFresh(at(3), NOW)).toBe(true);
    expect(isLocationFresh(at(10), NOW)).toBe(true);
    expect(isLocationFresh(at(11), NOW)).toBe(false);
  });
  it('is not fresh with no reading', () => {
    expect(isLocationFresh(parseAgentVetting(raw()), NOW)).toBe(false);
  });
});

describe('vettingChecklist', () => {
  it('lists the seven steps in screen order', () => {
    const steps = vettingChecklist(parseAgentVetting(raw()), NOW);
    expect(steps.map((s) => s.key)).toEqual(['phone', 'email', 'residence', 'location', 'national_id', 'passport_photo', 'next_of_kin']);
  });

  it('marks what is done and gives a hint for the rest', () => {
    const steps = vettingChecklist(parseAgentVetting(raw()), NOW);
    const by = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(by.residence.done).toBe(true);
    expect(by.residence.hint).toBeNull();
    expect(by.national_id.done).toBe(true);
    expect(by.next_of_kin.done).toBe(true);
    expect(by.phone.done).toBe(false);
    expect(by.phone.hint).toMatch(/code/);
    expect(by.passport_photo.done).toBe(false);
    expect(vettingProgress(steps)).toEqual({ done: 3, total: 7, complete: false });
  });

  it('asks for an email address when none is on file', () => {
    const steps = vettingChecklist(parseAgentVetting(raw({ email: { value: null, verified_at: null } })), NOW);
    expect(steps.find((s) => s.key === 'email')?.hint).toMatch(/Add your own email/);
  });

  it('passes the server reason through for the National ID', () => {
    const v = parseAgentVetting(raw({ national_id: { ok: false, reason: 'This National ID is already linked to another account.', linked_to: { first_name: 'Sarah', phone_masked: '****567' } } }));
    const id = vettingChecklist(v, NOW).find((s) => s.key === 'national_id');
    expect(id?.done).toBe(false);
    expect(id?.hint).toBe('This National ID is already linked to another account.');
    expect(v.national_id.linked_to).toEqual({ first_name: 'Sarah', phone_masked: '****567' });
  });

  it('tells the agent to recapture a stale location', () => {
    const v = parseAgentVetting(raw({ gps: { lat: 0.35, lng: 32.58, accuracy_m: 20, captured_at: '2026-10-27T09:00:00Z' } }));
    expect(vettingChecklist(v, NOW).find((s) => s.key === 'location')?.hint).toMatch(/too old/);
  });

  it('needs a next-of-kin phone with at least nine digits', () => {
    const v = parseAgentVetting(raw({ next_of_kin: { name: 'Mum', phone: '0772', relationship: 'Mother', source: 'custom' } }));
    expect(vettingChecklist(v, NOW).find((s) => s.key === 'next_of_kin')?.done).toBe(false);
  });

  it('is complete when every step is done', () => {
    const v = parseAgentVetting(raw({
      phone: { value: '+256771234567', verified_at: '2026-10-27T09:55:00Z' },
      email: { value: 'agent@gmail.com', verified_at: '2026-10-27T09:56:00Z' },
      gps: { lat: 0.35, lng: 32.58, accuracy_m: 20, captured_at: '2026-10-27T09:58:00Z' },
      passport_photo: { path: 'u1/selfie-1.jpg', check: { status: 'ok' } },
    }));
    expect(vettingProgress(vettingChecklist(v, NOW)).complete).toBe(true);
  });
});

describe('canEditVetting', () => {
  it('locks edits only while Agent Ops is reviewing', () => {
    expect(canEditVetting('unverified')).toBe(true);
    expect(canEditVetting('rejected')).toBe(true);
    expect(canEditVetting('verified')).toBe(true);
    expect(canEditVetting('submitted')).toBe(false);
  });
});

describe('agentNotVettedReason', () => {
  it('reads the rent_requests trigger error', () => {
    expect(agentNotVettedReason(new Error('AGENT_NOT_VETTED: Complete your agent verification to add tenants and post Rent Plan requests.')))
      .toBe('Complete your agent verification to add tenants and post Rent Plan requests.');
  });
  it('reads the register-tenant response body', () => {
    expect(agentNotVettedReason({ code: 'agent_not_vetted', error: 'Your agent verification is with Agent Ops.' }))
      .toBe('Your agent verification is with Agent Ops.');
  });
  it('ignores other errors', () => {
    expect(agentNotVettedReason(new Error('WEEKLY_ELIGIBILITY_BLOCKED: something'))).toBeNull();
    expect(agentNotVettedReason(null)).toBeNull();
  });
});

describe('parseVettingQueue', () => {
  it('reads rows and fills missing counts with zero', () => {
    const q = parseVettingQueue({
      total: 1,
      rows: [{ agent_id: 'a1', name: 'Agent One', status: 'submitted', in_scope: true, id_source: 'parent', submitted_at: '2026-10-27T09:00:00Z' }],
      counts: { submitted: 1, unverified: 959 },
    });
    expect(q.total).toBe(1);
    expect(q.rows[0]).toMatchObject({ agent_id: 'a1', status: 'submitted', id_source: 'parent', in_scope: true });
    expect(q.counts).toEqual({ unverified: 959, submitted: 1, verified: 0, rejected: 0 });
  });
});
