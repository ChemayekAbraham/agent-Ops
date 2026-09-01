import { describe, expect, it } from 'vitest';
import {
  buildMostCalled,
  buildOutcomeTrend,
  buildRoleShare,
  computeKpis,
  deriveOutcome,
  formatCallStamp,
  formatTalkTime,
  labelTemperatures,
  resolvePrimaryAudience,
  type CalleeRole,
  type CallRecord,
} from '@/lib/callCentre';

let seq = 0;

/** Answered-by-default call; override to shape each case. */
function call(over: Partial<CallRecord> = {}): CallRecord {
  seq += 1;
  return {
    id: `c-${seq}`,
    calleeId: 'p-1',
    calleeName: 'Aisha Nakato',
    calleePhone: '+256700000000',
    calleeAvatarUrl: null,
    calleeRole: 'tenant',
    location: 'Kampala',
    status: 'completed',
    hangupCause: 'NORMAL_CLEARING',
    durationSeconds: 120,
    calledAt: '2026-08-20T09:00:00.000Z',
    staffId: null,
    staffName: 'Sarah N.',
    summary: null,
    ...over,
  };
}

describe('deriveOutcome', () => {
  it('reads a normal completed call as answered', () => {
    expect(deriveOutcome(call())).toBe('answered');
  });

  it('treats any talk time as answered even when the status is vague', () => {
    // A provider that reports a terminal status we do not recognise but real
    // talk time definitely connected.
    expect(deriveOutcome(call({ status: 'weird_terminal_state', durationSeconds: 42 }))).toBe('answered');
  });

  it('maps an actively refused call to rejected', () => {
    expect(deriveOutcome(call({ hangupCause: 'CALL_REJECTED', durationSeconds: 0 }))).toBe('rejected');
    expect(deriveOutcome(call({ hangupCause: 'USER_BUSY', durationSeconds: 0 }))).toBe('rejected');
  });

  it('maps an unreachable handset to not_reachable', () => {
    expect(deriveOutcome(call({ status: 'no_answer', hangupCause: 'NO_ANSWER', durationSeconds: 0 }))).toBe('not_reachable');
    expect(deriveOutcome(call({ status: 'failed', hangupCause: 'SUBSCRIBER_ABSENT', durationSeconds: 0 }))).toBe('not_reachable');
  });

  it('reports in-flight calls as in_progress rather than guessing', () => {
    for (const status of ['initiating', 'queued', 'ringing', 'ringing_staff', 'bridged']) {
      expect(deriveOutcome(call({ status, durationSeconds: null }))).toBe('in_progress');
    }
  });

  it('degrades an unknown hangup cause to not_reachable, never to answered', () => {
    // The safe direction: a call we cannot prove connected must not inflate the
    // answered count or the talk-time average.
    expect(deriveOutcome(call({ hangupCause: 'SOMETHING_NEW', durationSeconds: 0 }))).toBe('not_reachable');
    expect(deriveOutcome(call({ hangupCause: null, durationSeconds: 0 }))).toBe('not_reachable');
  });

  it('reads a swept stale row as not_reachable, not as an answered call', () => {
    // crm_sweep_stale_calls() writes this when no provider callback ever
    // arrived. A stranded row is no evidence the customer was reached.
    expect(
      deriveOutcome(call({ status: 'expired', hangupCause: 'CALLBACK_TIMEOUT', durationSeconds: 0 })),
    ).toBe('not_reachable');
    // The status alone is enough, even without the cause.
    expect(deriveOutcome(call({ status: 'expired', hangupCause: null, durationSeconds: 0 }))).toBe('not_reachable');
  });

  it('still trusts real talk time on a swept row', () => {
    // If the provider had already recorded a duration before the row stranded,
    // that conversation genuinely happened and must not be erased by the sweep.
    expect(
      deriveOutcome(call({ status: 'expired', hangupCause: 'CALLBACK_TIMEOUT', durationSeconds: 95 })),
    ).toBe('answered');
  });

  it('keeps a swept row out of the answered count and the talk-time average', () => {
    const kpis = computeKpis([
      call({ id: 'ok', durationSeconds: 120 }),
      call({ id: 'swept', status: 'expired', hangupCause: 'CALLBACK_TIMEOUT', durationSeconds: 0 }),
    ]);
    expect(kpis.answered).toBe(1);
    expect(kpis.notReachable).toBe(1);
    // 120/1, not 120/2 — a swept row must not drag the average toward zero.
    expect(kpis.averageTalkSeconds).toBe(120);
  });

  it('is case- and whitespace-insensitive about provider strings', () => {
    expect(deriveOutcome(call({ hangupCause: ' call_rejected ', durationSeconds: 0 }))).toBe('rejected');
  });

  it('does not count a completed-but-silent call as answered', () => {
    expect(deriveOutcome(call({ status: 'completed', hangupCause: null, durationSeconds: 0 }))).toBe('not_reachable');
  });
});

describe('labelTemperatures', () => {
  it('warms a person up only after a call they actually answered', () => {
    const first = call({ id: 'a', calledAt: '2026-08-20T09:00:00Z', status: 'no_answer', hangupCause: 'NO_ANSWER', durationSeconds: 0 });
    const second = call({ id: 'b', calledAt: '2026-08-20T10:00:00Z', durationSeconds: 90 });
    const third = call({ id: 'c', calledAt: '2026-08-20T11:00:00Z', durationSeconds: 30 });

    const t = labelTemperatures([first, second, third]);
    // Unanswered attempts leave the next call just as cold.
    expect(t.get('a')).toBe('cold');
    expect(t.get('b')).toBe('cold');
    // Only after 'b' connected is the person warm.
    expect(t.get('c')).toBe('warm');
  });

  it('keeps repeated unanswered attempts cold', () => {
    const misses = [1, 2, 3].map((n) =>
      call({
        id: `m${n}`,
        calledAt: `2026-08-2${n}T09:00:00Z`,
        status: 'no_answer',
        hangupCause: 'NO_ANSWER',
        durationSeconds: 0,
      }),
    );
    const t = labelTemperatures(misses);
    expect([...t.values()]).toEqual(['cold', 'cold', 'cold']);
  });

  it('tracks each person independently', () => {
    const a1 = call({ id: 'a1', calleeId: 'p-1', calledAt: '2026-08-20T09:00:00Z' });
    const a2 = call({ id: 'a2', calleeId: 'p-1', calledAt: '2026-08-20T10:00:00Z' });
    const b1 = call({ id: 'b1', calleeId: 'p-2', calledAt: '2026-08-20T11:00:00Z' });

    const t = labelTemperatures([a1, a2, b1]);
    expect(t.get('a1')).toBe('cold');
    expect(t.get('a2')).toBe('warm');
    expect(t.get('b1')).toBe('cold');
  });

  it('does not depend on input order', () => {
    const early = call({ id: 'early', calledAt: '2026-08-20T09:00:00Z' });
    const late = call({ id: 'late', calledAt: '2026-08-20T12:00:00Z' });

    const forward = labelTemperatures([early, late]);
    const reversed = labelTemperatures([late, early]);
    expect(forward.get('early')).toBe('cold');
    expect(forward.get('late')).toBe('warm');
    expect(reversed.get('early')).toBe('cold');
    expect(reversed.get('late')).toBe('warm');
  });
});

describe('computeKpis', () => {
  it('averages talk time over answered calls only', () => {
    const records = [
      call({ id: 'a', durationSeconds: 100 }),
      call({ id: 'b', durationSeconds: 200 }),
      // Zero-duration failures must stay out of the denominator.
      call({ id: 'c', status: 'no_answer', hangupCause: 'NO_ANSWER', durationSeconds: 0 }),
      call({ id: 'd', hangupCause: 'CALL_REJECTED', durationSeconds: 0 }),
    ];

    const kpis = computeKpis(records);
    expect(kpis.answered).toBe(2);
    expect(kpis.totalTalkSeconds).toBe(300);
    // 300/2 = 150, NOT 300/4 = 75.
    expect(kpis.averageTalkSeconds).toBe(150);
  });

  it('counts every outcome bucket and totals them to the call count', () => {
    const records = [
      call({ id: 'a', durationSeconds: 60 }),
      call({ id: 'b', hangupCause: 'CALL_REJECTED', durationSeconds: 0 }),
      call({ id: 'c', status: 'failed', hangupCause: 'SUBSCRIBER_ABSENT', durationSeconds: 0 }),
      call({ id: 'd', status: 'bridged', durationSeconds: null }),
    ];

    const k = computeKpis(records);
    expect(k.totalCalls).toBe(4);
    expect(k.answered).toBe(1);
    expect(k.rejected).toBe(1);
    expect(k.notReachable).toBe(1);
    expect(k.inProgress).toBe(1);
    expect(k.answered + k.rejected + k.notReachable + k.inProgress).toBe(k.totalCalls);
  });

  it('splits cold and warm so they sum to the total', () => {
    const records = [
      call({ id: 'a', calleeId: 'p-1', calledAt: '2026-08-20T09:00:00Z', durationSeconds: 60 }),
      call({ id: 'b', calleeId: 'p-1', calledAt: '2026-08-20T10:00:00Z', durationSeconds: 60 }),
      call({ id: 'c', calleeId: 'p-2', calledAt: '2026-08-20T11:00:00Z', durationSeconds: 60 }),
    ];
    const k = computeKpis(records);
    expect(k.coldCalls).toBe(2);
    expect(k.warmCalls).toBe(1);
    expect(k.coldCalls + k.warmCalls).toBe(k.totalCalls);
  });

  it('excludes in-flight calls from the answer rate denominator', () => {
    const records = [
      call({ id: 'a', durationSeconds: 60 }),
      call({ id: 'b', hangupCause: 'CALL_REJECTED', durationSeconds: 0 }),
      call({ id: 'c', status: 'bridged', durationSeconds: null }),
    ];
    // 1 answered of 2 settled = 50%, not 1 of 3.
    expect(computeKpis(records).answerRate).toBe(50);
  });

  it('reports no average and no rate for an empty set rather than zero', () => {
    const k = computeKpis([]);
    expect(k.totalCalls).toBe(0);
    expect(k.averageTalkSeconds).toBeNull();
    expect(k.answerRate).toBeNull();
  });

  it('reports no average when nothing was answered', () => {
    const k = computeKpis([call({ hangupCause: 'CALL_REJECTED', durationSeconds: 0 })]);
    expect(k.averageTalkSeconds).toBeNull();
    expect(k.answerRate).toBe(0);
  });
});

describe('buildOutcomeTrend', () => {
  const endDate = new Date('2026-08-20T12:00:00');

  it('emits every day in the window, including empty ones', () => {
    const trend = buildOutcomeTrend([call({ calledAt: '2026-08-20T09:00:00' })], { days: 5, endDate });
    // A chart that skips empty days compresses the axis and misreports trend.
    expect(trend).toHaveLength(5);
    expect(trend.filter((p) => p.answered === 0 && p.rejected === 0)).toHaveLength(4);
  });

  it('buckets answered and rejected into the right day', () => {
    const trend = buildOutcomeTrend(
      [
        call({ id: 'a', calledAt: '2026-08-19T09:00:00', durationSeconds: 60 }),
        call({ id: 'b', calledAt: '2026-08-20T09:00:00', durationSeconds: 60 }),
        call({ id: 'c', calledAt: '2026-08-20T10:00:00', hangupCause: 'CALL_REJECTED', durationSeconds: 0 }),
      ],
      { days: 2, endDate },
    );

    expect(trend[0]).toMatchObject({ answered: 1, rejected: 0 });
    expect(trend[1]).toMatchObject({ answered: 1, rejected: 1 });
  });

  it('ignores calls outside the window instead of folding them into the edge', () => {
    const trend = buildOutcomeTrend(
      [call({ calledAt: '2026-07-01T09:00:00', durationSeconds: 60 })],
      { days: 3, endDate },
    );
    expect(trend.every((p) => p.answered === 0 && p.rejected === 0)).toBe(true);
  });

  it('leaves not-reachable calls out of both series', () => {
    const trend = buildOutcomeTrend(
      [call({ calledAt: '2026-08-20T09:00:00', status: 'no_answer', hangupCause: 'NO_ANSWER', durationSeconds: 0 })],
      { days: 1, endDate },
    );
    expect(trend[0]).toMatchObject({ answered: 0, rejected: 0 });
  });

  it('survives an unparseable timestamp', () => {
    const trend = buildOutcomeTrend([call({ calledAt: 'not-a-date' })], { days: 2, endDate });
    expect(trend).toHaveLength(2);
  });

  it('anchors on the newest call when no end date is given', () => {
    const trend = buildOutcomeTrend([call({ calledAt: '2026-08-20T09:00:00', durationSeconds: 60 })], { days: 3 });
    // The newest call must land on the right edge, never off the chart.
    expect(trend[trend.length - 1].answered).toBe(1);
  });
});

describe('buildRoleShare', () => {
  it('counts distinct people, not calls', () => {
    const share = buildRoleShare([
      call({ id: 'a', calleeId: 'p-1', calleeRole: 'tenant' }),
      call({ id: 'b', calleeId: 'p-1', calleeRole: 'tenant' }),
      call({ id: 'c', calleeId: 'p-1', calleeRole: 'tenant' }),
      call({ id: 'd', calleeId: 'p-2', calleeRole: 'agent' }),
    ]);

    const tenants = share.find((s) => s.role === 'tenant')!;
    const agents = share.find((s) => s.role === 'agent')!;
    // One tenant rung three times is still one person → 50/50, not 75/25.
    expect(tenants.people).toBe(1);
    expect(tenants.calls).toBe(3);
    expect(tenants.percent).toBe(50);
    expect(agents.percent).toBe(50);
  });

  it('drops empty buckets so no zero-width slice is rendered', () => {
    const share = buildRoleShare([call({ calleeRole: 'partner' })]);
    expect(share).toHaveLength(1);
    expect(share[0].role).toBe('partner');
  });

  it('sums to 100 percent across the populated buckets', () => {
    const roles: CalleeRole[] = ['tenant', 'agent', 'partner', 'landlord', 'employee'];
    const share = buildRoleShare(
      roles.map((role, i) => call({ id: `r${i}`, calleeId: `p-${i}`, calleeRole: role })),
    );
    expect(share).toHaveLength(5);
    expect(Math.round(share.reduce((a, s) => a + s.percent, 0))).toBe(100);
  });

  it('orders slices biggest first', () => {
    const share = buildRoleShare([
      call({ id: 'a', calleeId: 'p-1', calleeRole: 'agent' }),
      call({ id: 'b', calleeId: 'p-2', calleeRole: 'tenant' }),
      call({ id: 'c', calleeId: 'p-3', calleeRole: 'tenant' }),
    ]);
    expect(share.map((s) => s.role)).toEqual(['tenant', 'agent']);
  });

  it('returns nothing for an empty set', () => {
    expect(buildRoleShare([])).toEqual([]);
  });
});

describe('buildMostCalled', () => {
  it('ranks by call count and keeps the newest outcome', () => {
    const rows = buildMostCalled([
      call({ id: 'a', calleeId: 'p-1', calledAt: '2026-08-20T09:00:00', durationSeconds: 60 }),
      call({ id: 'b', calleeId: 'p-1', calledAt: '2026-08-20T15:00:00', hangupCause: 'CALL_REJECTED', durationSeconds: 0 }),
      call({ id: 'c', calleeId: 'p-2', calledAt: '2026-08-20T10:00:00', durationSeconds: 60 }),
    ]);

    expect(rows[0].calleeId).toBe('p-1');
    expect(rows[0].calls).toBe(2);
    expect(rows[0].answered).toBe(1);
    // The latest attempt is what a follow-up acts on.
    expect(rows[0].lastOutcome).toBe('rejected');
  });

  it('scopes to one local day when asked', () => {
    const rows = buildMostCalled(
      [
        call({ id: 'a', calleeId: 'p-1', calledAt: '2026-08-20T09:00:00' }),
        call({ id: 'b', calleeId: 'p-2', calledAt: '2026-08-19T09:00:00' }),
      ],
      { onDate: new Date('2026-08-20T23:00:00') },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].calleeId).toBe('p-1');
  });

  it('honours the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      call({ id: `x${i}`, calleeId: `p-${i}`, calledAt: '2026-08-20T09:00:00' }),
    );
    expect(buildMostCalled(many, { limit: 3 })).toHaveLength(3);
  });
});

describe('formatting', () => {
  it('renders talk time as m:ss and h:mm:ss', () => {
    expect(formatTalkTime(0)).toBe('0:00');
    expect(formatTalkTime(9)).toBe('0:09');
    expect(formatTalkTime(214)).toBe('3:34');
    expect(formatTalkTime(3661)).toBe('1:01:01');
  });

  it('renders unusable talk time as an em dash rather than 0:00', () => {
    // "no data" must not read as "a zero-second call".
    expect(formatTalkTime(null)).toBe('—');
    expect(formatTalkTime(undefined)).toBe('—');
    expect(formatTalkTime(Number.NaN)).toBe('—');
    expect(formatTalkTime(-5)).toBe('—');
  });

  it('renders a bad timestamp as an em dash', () => {
    expect(formatCallStamp(null)).toBe('—');
    expect(formatCallStamp('nonsense')).toBe('—');
    expect(formatCallStamp('2026-08-20T09:00:00Z')).toMatch(/20 Aug/);
  });
});

/* ------------------------------------------------------------------ *
 * Africa's Talking status / hangup-cause mapping
 * ------------------------------------------------------------------ */

describe("Africa's Talking outcome mapping", () => {
  const at = (status: string, hangupCause: string | null, durationSeconds = 0) =>
    deriveOutcome({ status, hangupCause, durationSeconds });

  it('treats a completed call with talk time as answered', () => {
    expect(at('Completed', 'NORMAL_CLEARING', 96)).toBe('answered');
  });

  it('never counts a zero-duration NORMAL_CLEARING as answered', () => {
    // Clearing with no talk time never reached anyone; inflating the answer
    // rate is the one thing this function must not do.
    expect(at('completed', 'NORMAL_CLEARING', 0)).toBe('not_reachable');
  });

  it.each(['USER_BUSY', 'CALL_REJECTED'])('maps %s to rejected', (cause) => {
    expect(at('completed', cause)).toBe('rejected');
  });

  it.each([
    'NO_ANSWER',
    'NO_USER_RESPONSE',
    'UNALLOCATED_NUMBER',
    'SUBSCRIBER_ABSENT',
    'NETWORK_OUT_OF_ORDER',
    'RECOVERY_ON_TIMER_EXPIRE',
    'ORIGINATOR_CANCEL',
  ])('maps %s to not reachable', (cause) => {
    expect(at('completed', cause)).toBe('not_reachable');
  });

  it('degrades an unknown cause to not reachable, never answered', () => {
    expect(at('completed', 'SOME_NEW_AT_CAUSE')).toBe('not_reachable');
  });

  it('reads the live bridge states as in progress', () => {
    expect(at('ringing_staff', null)).toBe('in_progress');
    expect(at('bridged', null)).toBe('in_progress');
  });
});

/* ------------------------------------------------------------------ *
 * Audience classification
 * ------------------------------------------------------------------ */

describe('resolvePrimaryAudience', () => {
  it('gives each single membership its own bucket', () => {
    expect(resolvePrimaryAudience({ tenant: true })).toBe('tenant');
    expect(resolvePrimaryAudience({ agent: true })).toBe('agent');
    expect(resolvePrimaryAudience({ landlord: true })).toBe('landlord');
    expect(resolvePrimaryAudience({ partner: true })).toBe('partner');
    expect(resolvePrimaryAudience({ employee: true })).toBe('employee');
  });

  it('applies employee > partner > landlord > agent > tenant', () => {
    expect(resolvePrimaryAudience({ tenant: true, agent: true })).toBe('agent');
    expect(resolvePrimaryAudience({ tenant: true, agent: true, landlord: true })).toBe('landlord');
    expect(resolvePrimaryAudience({ landlord: true, partner: true })).toBe('partner');
    expect(resolvePrimaryAudience({ partner: true, employee: true, tenant: true })).toBe('employee');
  });

  it('is deterministic for someone in every audience, so the doughnut cannot double-count', () => {
    expect(
      resolvePrimaryAudience({ tenant: true, agent: true, landlord: true, partner: true, employee: true }),
    ).toBe('employee');
  });

  it('falls back to the broadest bucket when nothing is flagged', () => {
    expect(resolvePrimaryAudience({})).toBe('tenant');
  });
});
