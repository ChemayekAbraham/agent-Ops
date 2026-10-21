import { describe, expect, it } from 'vitest';
import { TIMING_BATCH_LIMIT, chunkIds, deskLabel, formatElapsed, formatKampala, missingReasonLabel, normalizeTiming, normalizeTimingBatch, timingIdsKey, timingRow } from './rentTiming';

const D = 86400;
// the server's answer for "3 days at Agent Ops, then 10 days at Tenant Ops" at as_of 2026-10-19T12:00:00Z
const ROW = {
  request_id: 'r1', state: 'at_desk', desk: 'tenant_ops',
  current: { desk: 'tenant_ops', entry: '2026-10-09T12:00:00+00:00', seconds: 10 * D, quality: 'confirmed', source: 'previous_desk_approval_stamp' },
  previous: { desk: 'agent_ops', start: '2026-10-06T12:00:00+00:00', end: '2026-10-09T12:00:00+00:00', seconds: 3 * D, quality: 'confirmed', source: 'created_at' },
  request_start: '2026-10-06T12:00:00+00:00', total_seconds: 13 * D, quality: 'confirmed', evidence: ['created_at', 'previous_desk_approval_stamp'], as_of: '2026-10-19T12:00:00+00:00',
};

describe('formatElapsed', () => {
  it('uses minutes under an hour, hours and minutes under a day, days and hours from a day', () => {
    expect(formatElapsed(0)).toBe('Under 1 min');
    expect(formatElapsed(59)).toBe('Under 1 min');
    expect(formatElapsed(60)).toBe('1 min');
    expect(formatElapsed(59 * 60 + 59)).toBe('59 min');
    expect(formatElapsed(3600)).toBe('1 h');
    expect(formatElapsed(5 * 3600 + 20 * 60)).toBe('5 h 20 min');
    expect(formatElapsed(D - 1)).toBe('23 h 59 min');
    expect(formatElapsed(D)).toBe('1 d');
    expect(formatElapsed(10 * D + 4 * 3600)).toBe('10 d 4 h');
    expect(formatElapsed(13 * D)).toBe('13 d');
  });
  it('counts nights and weekends as elapsed time (a Friday evening to Monday morning is 2 d 14 h, not a working-day figure)', () => {
    const fri = Date.UTC(2026, 9, 16, 18, 0, 0) / 1000;
    const mon = Date.UTC(2026, 9, 19, 8, 0, 0) / 1000;
    expect(formatElapsed(mon - fri)).toBe('2 d 14 h');
  });
  it('is "Not available" for a missing, negative or non-numeric value, never "0"', () => {
    for (const v of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatElapsed(v as number)).toBe('Not available');
  });
});

describe('Kampala dates', () => {
  it('shows a server timestamp in Kampala time, whatever the browser zone', () => {
    expect(formatKampala('2026-10-16T11:32:00Z')).toBe('16 Oct 2026, 14:32');
    expect(formatKampala('2026-10-16T22:30:00Z')).toBe('17 Oct 2026, 01:30');
    expect(formatKampala(null)).toBe('Not available');
    expect(formatKampala('nope')).toBe('Not available');
  });
});

describe('timingRow: the compact three-column row', () => {
  it('3 days at Agent Ops then 10 days at Tenant Ops reads current 10 d, before 3 d, total 13 d', () => {
    const row = timingRow(normalizeTiming(ROW));
    expect(row.current).toMatchObject({ label: 'At Tenant Ops', value: '10 d', quality: 'confirmed' });
    expect(row.current.detail).toBe('Since 9 Oct 2026, 15:00');
    expect(row.previous).toMatchObject({ label: 'Before: Agent Ops', value: '3 d', quality: 'confirmed' });
    expect(row.total).toMatchObject({ label: 'Total in system', value: '13 d', quality: 'confirmed' });
    expect(row.note).toBeNull();
  });
  it('on a desk\'s own cards the first cell reads "On your desk"; elsewhere "At <desk>"', () => {
    expect(timingRow(normalizeTiming(ROW), { ownDesk: true }).current.label).toBe('On your desk');
    expect(timingRow(normalizeTiming(ROW)).current.label).toBe('At Tenant Ops');
    expect(timingRow(normalizeTiming({ ...ROW, state: 'correction', desk: 'agent' }), { ownDesk: true }).current.label).toBe('With the agent for correction');
  });
  it('a request waiting for the agent to correct says so and keeps the total running', () => {
    const row = timingRow(normalizeTiming({ ...ROW, state: 'correction', desk: 'agent', current: { ...ROW.current, desk: 'correction', seconds: 2 * D } }));
    expect(row.current.label).toBe('With the agent for correction');
    expect(row.current.value).toBe('2 d');
  });
  it('a processed request shows Funded and the frozen total; an ended one shows Ended', () => {
    const processed = timingRow(normalizeTiming({ ...ROW, state: 'processed', desk: undefined, current: undefined, processing_end: '2026-10-10T12:00:00Z', total_seconds: 4 * D }));
    expect(processed.current.value).toBe('Funded');
    expect(processed.total.value).toBe('4 d');
    expect(timingRow(normalizeTiming({ ...ROW, state: 'ended', current: undefined })).current.value).toBe('Ended');
  });
  it('a missing or estimated figure is labelled, never zero: unavailable current gives "Not available" with the reason', () => {
    const row = timingRow(normalizeTiming({ request_id: 'r2', state: 'at_desk', desk: 'agent_ops', request_start: '2026-10-01T00:00:00Z', total_seconds: 18 * D, quality: 'unavailable', missing_reason: 'service_center_verification_time_not_recorded' }));
    expect(row.current.value).toBe('Not available');
    expect(row.current.quality).toBe('unavailable');
    expect(row.note).toBe('The Service Centre verification time was not recorded.');
    expect(row.previous.value).toBe('None');
    const est = timingRow(normalizeTiming({ ...ROW, quality: 'estimated' }));
    expect(est.note).toMatch(/estimate/);
  });
  it('no timing at all (a request the server left out) reads Not available for all three cells', () => {
    const row = timingRow(undefined);
    expect([row.current.value, row.previous.value, row.total.value]).toEqual(['Not available', 'Not available', 'Not available']);
    expect(row.quality).toBe('unavailable');
  });
  it('two surfaces reading the same answer at the same as_of show exactly the same strings (consistent across dashboards)', () => {
    const batch = normalizeTimingBatch({ as_of: '2026-10-19T12:00:00+00:00', requested: 1, returned: 1, rows: [ROW] });
    const a = timingRow(batch.rows[0]);
    const b = timingRow(normalizeTiming(JSON.parse(JSON.stringify(ROW))));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(batch.rows[0].as_of).toBe('2026-10-19T12:00:00+00:00');
  });
});

describe('normalize', () => {
  it('an unknown state or quality falls back to unavailable, never to a made-up value', () => {
    const t = normalizeTiming({ request_id: 'x', state: 'weird', quality: 'great' });
    expect(t.state).toBe('unavailable');
    expect(t.quality).toBe('unavailable');
    expect(t.current).toBeNull();
    expect(t.total_seconds).toBeNull();
  });
  it('a current visit without a usable entry or seconds is dropped, not shown as 0', () => {
    expect(normalizeTiming({ ...ROW, current: { desk: 'tenant_ops', entry: null, seconds: 5 } }).current).toBeNull();
    expect(normalizeTiming({ ...ROW, current: { desk: 'tenant_ops', entry: '2026-10-09T12:00:00Z', seconds: null } }).current).toBeNull();
  });
  it('the batch keeps the single as_of and every row inherits it; counts default sensibly', () => {
    const b = normalizeTimingBatch({ as_of: '2026-10-19T12:00:00+00:00', rows: [{ request_id: 'a', state: 'ended' }, { request_id: 'b', state: 'ended' }] });
    expect(b.rows.map((r) => r.as_of)).toEqual(['2026-10-19T12:00:00+00:00', '2026-10-19T12:00:00+00:00']);
    expect(b.returned).toBe(2);
    expect(normalizeTimingBatch(null).rows).toEqual([]);
  });
  it('the payout wait is separate from the review total and its landlord time is labelled approximate', () => {
    const t = normalizeTiming({ ...ROW, state: 'processed', payout: { funded_at: '2026-10-09T00:00:00Z', landlord_paid_at: '2026-10-15T00:00:00Z', landlord_paid_quality: 'estimated', waiting_seconds: 6 * D, still_waiting: false } });
    expect(t.payout?.waiting_seconds).toBe(6 * D);
    expect(t.payout?.landlord_paid_quality).toBe('estimated');
    expect(t.total_seconds).toBe(13 * D);
  });
});

describe('labels and batching', () => {
  it('desk and reason labels', () => {
    expect(deskLabel('service_center')).toBe('Service Centre');
    expect(deskLabel('coo')).toBe('COO');
    expect(deskLabel(null)).toBe('None');
    expect(missingReasonLabel('processing_endpoint_not_recorded')).toMatch(/not recorded/);
    expect(missingReasonLabel(null)).toBeNull();
  });
  it('splits ids at the server limit of 200 and keys a set of ids by content, not order', () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    expect(chunkIds(ids).map((c) => c.length)).toEqual([200, 200, 50]);
    expect(TIMING_BATCH_LIMIT).toBe(200);
    expect(timingIdsKey(['b', 'a', 'a'])).toBe(timingIdsKey(['a', 'b']));
    expect(timingIdsKey(['a'])).not.toBe(timingIdsKey(['b']));
  });
});
