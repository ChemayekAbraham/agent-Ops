import { describe, it, expect } from 'vitest';
import { buildSchoolSignupLink, smartphoneFields, toIntlDigits, computeGateMovementSummary, eatDateKey, formatEatTime, roleLabel, roleGroup, type SchoolGateLogRow } from '@/lib/welileSchools';
import { computeSchoolKpis } from '@/components/executive/agent-ops-v2/WelileSchoolsOps';

describe('Welile Schools rules', () => {
  it('builds the sign-up link with agent, school and profile', () => {
    expect(buildSchoolSignupLink('a1', 's1', 'p1')).toBe('https://welileapp.com/auth?ref=a1&school=s1&profile=p1');
  });
  it('no smartphone queues a free smartphone as Requested', () => {
    expect(smartphoneFields(false)).toEqual({ has_smartphone: false, needs_free_smartphone: true, smartphone_status: 'Requested' });
  });
  it('has smartphone does not join the free smartphone queue', () => {
    expect(smartphoneFields(true).needs_free_smartphone).toBe(false);
  });
  it('normalises local numbers for WhatsApp', () => {
    expect(toIntlDigits('0700 000 000')).toBe('256700000000');
  });
  it('pending delivery counts Requested and Approved, not Delivered', () => {
    const k = computeSchoolKpis([], [
      { id: '1', school_id: 's', role: 'pupil', needs_free_smartphone: true, smartphone_status: 'Requested' },
      { id: '2', school_id: 's', role: 'parent', needs_free_smartphone: true, smartphone_status: 'Delivered' },
    ]);
    expect(k.phonesRequested).toBe(2);
    expect(k.phonesPending).toBe(1);
  });
});

describe('Gate movement summary', () => {
  const NOW = new Date('2026-10-24T12:00:00+03:00'); // noon EAT
  const log = (over: Partial<SchoolGateLogRow>): SchoolGateLogRow => ({
    id: over.id ?? crypto.randomUUID(), school_id: 's1', agent_id: 'a1',
    direction: 'in', person_name: 'Test Person', role_type: 'pupil',
    recorded_at: '2026-10-24T07:00:00+03:00', ...over,
  });

  it('visitor role maps to Visitor / Guest label and parent group', () => {
    expect(roleLabel('visitor')).toBe('Visitor / Guest');
    expect(roleGroup('visitor')).toBe('parent');
  });

  it('EAT helpers format in Africa/Kampala regardless of host timezone', () => {
    expect(eatDateKey('2026-10-24T05:30:00+03:00')).toBe('2026-10-24');
    expect(eatDateKey('2026-10-23T23:30:00+00:00')).toBe('2026-10-24'); // 02:30 EAT next day
    expect(formatEatTime('2026-10-24T07:05:00+03:00')).toBe('07:05');
  });

  it('counts today only, tracks IN/OUT and currently-inside per person', () => {
    const logs = [
      log({ id: '1', person_name: 'Amina', profile_id: 'p1', direction: 'in', recorded_at: '2026-10-24T07:00:00+03:00' }),
      log({ id: '2', person_name: 'Amina', profile_id: 'p1', direction: 'out', recorded_at: '2026-10-24T15:00:00+03:00' }),
      log({ id: '3', person_name: 'Brian', profile_id: 'p2', role_type: 'teacher', direction: 'in', recorded_at: '2026-10-24T08:00:00+03:00' }),
      log({ id: '4', person_name: 'Guest', role_type: 'visitor', direction: 'in', recorded_at: '2026-10-24T09:00:00+03:00' }),
      log({ id: '5', person_name: 'Old', direction: 'in', recorded_at: '2026-10-23T07:00:00+03:00' }),
    ];
    const s = computeGateMovementSummary(logs, NOW);
    expect(s.enteredToday).toBe(3);
    expect(s.exitedToday).toBe(1);
    expect(s.currentlyInside).toBe(2); // Brian + Guest; Amina left
    expect(s.byGroup.pupil).toEqual({ in: 1, out: 1, inside: 0 });
    expect(s.byGroup.staff).toEqual({ in: 1, out: 0, inside: 1 });
    expect(s.byGroup.visitor).toEqual({ in: 1, out: 0, inside: 1 });
    expect(s.todayLogs[0].id).toBe('2'); // newest first
    expect(s.personStatus['p1'].direction).toBe('out');
    expect(s.personStatus['brian'].direction).toBe('in');
    expect(s.personStatus['p2'].log.id).toBe('3');
  });

  it('computeSchoolKpis includes gate counters', () => {
    const logs = [
      log({ id: '1', person_name: 'Amina', profile_id: 'p1', direction: 'in', recorded_at: new Date().toISOString() }),
      log({ id: '2', person_name: 'Brian', profile_id: 'p2', direction: 'out', recorded_at: new Date().toISOString() }),
    ];
    const k = computeSchoolKpis([], [], logs);
    expect(k.enteredToday).toBe(1);
    expect(k.exitedToday).toBe(1);
    expect(k.currentlyInside).toBe(1);
    expect(k.gateLogsTotal).toBe(2);
  });
});
