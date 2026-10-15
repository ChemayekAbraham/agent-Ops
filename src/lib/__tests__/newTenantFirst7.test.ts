import { describe, expect, it } from 'vitest';
import {
  addDays,
  agentOnTrack,
  clampRange,
  daysBetween,
  filterFirst7Rows,
  first7ErrorMessage,
  hasFirst7Params,
  kampalaDateTime,
  kampalaStamp,
  kampalaToday,
  normalizePayment,
  normalizeRow,
  normalizeSummary,
  paymentMethodLabel,
  presetOf,
  presetRange,
  readFirst7Params,
  sortFirst7Rows,
  writeFirst7Params,
  type First7Row,
} from '../newTenantFirst7';

const TODAY = '2026-10-15';
const AGENT = '3f2c9a4e-1b7d-4c55-9a0e-6d1f2b8c7e10';

const row = (over: Partial<First7Row> = {}): First7Row => ({
  rent_request_id: 'rr-1', tenant_id: 't-1', tenant_name: 'Amina', tenant_phone: '0772000111', agent_id: 'a-1', agent_name: 'Joy',
  landlord_paid_on: '2026-10-10', day1: '2026-10-11', frequency: 'daily', daily_due: 10000, total_repayment: 300000,
  day_paid: [10000, 0, 5000, 0, 0, 0, 0], day_due: [10000, 10000, 10000, 10000, 10000, 10000, 10000],
  day_state: ['paid', 'missed', 'part', 'missed', 'missed', 'future', 'future'],
  paid_7d: 15000, expected_to_date: 50000, first_paid_day: 1, row_status: 'behind', ...over,
});

describe('Kampala dates and presets', () => {
  it('reads the Kampala day, not the UTC day (21:30 UTC is already tomorrow in Kampala)', () => {
    expect(kampalaToday(new Date('2026-10-14T21:30:00Z'))).toBe('2026-10-15');
    expect(kampalaToday(new Date('2026-10-14T20:30:00Z'))).toBe('2026-10-14');
  });
  it('adds days across month ends and counts days between', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
  });
  it('Yesterday is the default; the other presets run up to today', () => {
    expect(presetRange('yesterday', TODAY)).toEqual({ from: '2026-10-14', to: '2026-10-14' });
    expect(presetRange('last7', TODAY)).toEqual({ from: '2026-10-09', to: TODAY });
    expect(presetRange('last30', TODAY)).toEqual({ from: '2026-09-16', to: TODAY });
  });
  it('names the preset a range is, or custom', () => {
    expect(presetOf('2026-10-14', '2026-10-14', TODAY)).toBe('yesterday');
    expect(presetOf('2026-10-09', TODAY, TODAY)).toBe('last7');
    expect(presetOf('2026-09-16', TODAY, TODAY)).toBe('last30');
    expect(presetOf('2026-10-01', '2026-10-05', TODAY)).toBe('custom');
  });
  it('keeps a custom range to 31 days, not after today and start not after end', () => {
    expect(clampRange('2026-08-01', TODAY, TODAY, 'to')).toEqual({ from: '2026-09-15', to: TODAY });
    expect(clampRange('2026-08-01', TODAY, TODAY, 'from')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(clampRange('2026-10-12', '2026-10-05', TODAY, 'from')).toEqual({ from: '2026-10-12', to: '2026-10-12' });
    expect(clampRange('2026-10-12', '2026-10-05', TODAY, 'to')).toEqual({ from: '2026-10-05', to: '2026-10-05' });
    expect(clampRange('2026-10-20', '2026-10-25', TODAY, 'to')).toEqual({ from: TODAY, to: TODAY });
    expect(daysBetween(...(Object.values(clampRange('2026-01-01', TODAY, TODAY, 'to')) as [string, string]))).toBe(30);
  });
});

describe('the URL (?f7from=&f7to=&f7freq=)', () => {
  it('defaults to yesterday, all frequencies, no filters', () => {
    expect(readFirst7Params(new URLSearchParams(), TODAY)).toEqual({ from: '2026-10-14', to: '2026-10-14', freq: 'all', q: '', card: 'all', day: null, agent: null });
  });
  it('reads every control back', () => {
    const sp = new URLSearchParams(`f7from=2026-10-01&f7to=2026-10-07&f7freq=weekly&f7q=joy&f7card=behind&f7day=3&f7agent=${AGENT}`);
    expect(readFirst7Params(sp, TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-07', freq: 'weekly', q: 'joy', card: 'behind', day: 3, agent: AGENT });
  });
  it('falls back to yesterday for a bad, reversed, future or over-31-day range, and ignores unknown values', () => {
    for (const q of ['f7from=nope&f7to=2026-10-02', 'f7from=2026-10-05&f7to=2026-10-02', 'f7from=2026-10-10&f7to=2026-10-30', 'f7from=2026-08-01&f7to=2026-10-14', 'f7from=2026-02-30&f7to=2026-03-02']) {
      expect(readFirst7Params(new URLSearchParams(q), TODAY)).toMatchObject({ from: '2026-10-14', to: '2026-10-14' });
    }
    expect(readFirst7Params(new URLSearchParams('f7freq=monthly&f7card=zzz&f7day=9&f7agent=not-a-uuid'), TODAY)).toMatchObject({ freq: 'all', card: 'all', day: null, agent: null });
  });
  it('accepts exactly 31 days', () => {
    expect(readFirst7Params(new URLSearchParams('f7from=2026-09-15&f7to=2026-10-15'), TODAY)).toMatchObject({ from: '2026-09-15', to: TODAY });
  });
  it('writes only what differs from the defaults, and keeps other parameters', () => {
    const base = new URLSearchParams('section=first7-tracker');
    const def = readFirst7Params(new URLSearchParams(), TODAY);
    expect(writeFirst7Params(base, def, TODAY).toString()).toBe('section=first7-tracker');
    const p = { ...def, from: '2026-10-09', to: TODAY, freq: 'daily' as const, q: 'joy', card: 'behind' as const, day: 2, agent: AGENT };
    const out = writeFirst7Params(base, p, TODAY);
    expect(out.get('section')).toBe('first7-tracker');
    expect(readFirst7Params(out, TODAY)).toEqual(p);
    expect(hasFirst7Params(out)).toBe(true);
    expect(hasFirst7Params(base)).toBe(false);
  });
});

describe('what the server sends', () => {
  it('turns numeric text and arrays into numbers and keeps the server states untouched', () => {
    const r = normalizeRow({
      rent_request_id: 'rr-9', landlord_paid_on: '2026-10-10', day1: '2026-10-11', frequency: 'weekly', daily_due: '10000.00', total_repayment: '300000',
      day_paid: ['0', 70000, null], day_due: [70000, 0], day_state: ['paid', 'not_due'], paid_7d: '70000', expected_to_date: '70000', first_paid_day: 1, row_status: 'on_track',
    });
    expect(r).toMatchObject({ frequency: 'weekly', daily_due: 10000, day_paid: [0, 70000, 0], day_due: [70000, 0], day_state: ['paid', 'not_due'], paid_7d: 70000, first_paid_day: 1, row_status: 'on_track', tenant_name: null });
    expect(normalizeRow({ rent_request_id: 'x', first_paid_day: null }).first_paid_day).toBeNull();
  });
  it('reads the summary, keeping a null percentage null', () => {
    const s = normalizeSummary({
      plans: 41, daily_plans: 36, weekly_plans: 5, status: { on_track: 20, behind: 15, not_started: 5, too_early: 1 }, day1: { started: 40, payers: 30, pct: 75.0 },
      per_day: [{ day: 1, started: 40, payers: 30, paid_amount: 900000, due_amount: 1000000, states: { paid: 28, part: 2, missed: 10, not_due: 0, future: 1 } }],
      collected: '4500000', expected: 6000000, collected_pct: 75,
    });
    expect(s.plans).toBe(41);
    expect(s.day1).toEqual({ started: 40, payers: 30, pct: 75 });
    expect(s.per_day[0].states.part).toBe(2);
    expect(s.collected).toBe(4500000);
    const empty = normalizeSummary({ plans: 0, day1: { started: 0, payers: 0, pct: null }, collected_pct: null, per_day: [] });
    expect(empty.day1.pct).toBeNull();
    expect(empty.collected_pct).toBeNull();
    expect(normalizeSummary(null).plans).toBe(0);
  });
  it('words the errors', () => {
    expect(first7ErrorMessage({ code: '42501', message: 'Not authorized' })).toBe('You do not have access to Agent Monitoring.');
    expect(first7ErrorMessage({ message: 'RANGE_TOO_LARGE: the range is at most 31 days' })).toBe('Pick a range of at most 31 days.');
    expect(first7ErrorMessage({ message: 'RANGE_INVALID: p_to is before p_from' })).toBe('The end date is before the start date.');
    expect(first7ErrorMessage(new Error('network down'))).toBe('network down');
    expect(first7ErrorMessage(null)).not.toBe('');
  });
});

describe('ordering and filtering the rows the server classified', () => {
  const rows = [
    row({ rent_request_id: 'ok', row_status: 'on_track', paid_7d: 50000, expected_to_date: 50000, tenant_name: 'Ok' }),
    row({ rent_request_id: 'early', row_status: 'too_early', paid_7d: 0, expected_to_date: 0, tenant_name: 'Early' }),
    row({ rent_request_id: 'ns', row_status: 'not_started', paid_7d: 0, expected_to_date: 30000, day_paid: [0, 0, 0, 0, 0, 0, 0], tenant_name: 'NotStarted' }),
    row({ rent_request_id: 'b-small', row_status: 'behind', paid_7d: 45000, expected_to_date: 50000, tenant_name: 'BSmall' }),
    row({ rent_request_id: 'b-big', row_status: 'behind', paid_7d: 10000, expected_to_date: 50000, tenant_name: 'BBig' }),
  ];
  it('puts behind first (largest gap first), then not started, on track, and too early last', () => {
    expect(sortFirst7Rows(rows).map((r) => r.rent_request_id)).toEqual(['b-big', 'b-small', 'ns', 'ok', 'early']);
  });
  it('does not change the list it is given', () => {
    const copy = [...rows];
    sortFirst7Rows(rows);
    expect(rows).toEqual(copy);
  });
  it('filters by the status card, by day 1 paid, by the paid-that-day bar and by agent / tenant / phone text', () => {
    expect(filterFirst7Rows(rows, { q: '', card: 'behind', day: null }).map((r) => r.rent_request_id).sort()).toEqual(['b-big', 'b-small']);
    expect(filterFirst7Rows(rows, { q: '', card: 'day1', day: null }).map((r) => r.rent_request_id)).not.toContain('ns');
    expect(filterFirst7Rows(rows, { q: '', card: 'all', day: 3 }).map((r) => r.rent_request_id)).not.toContain('ns');
    expect(filterFirst7Rows(rows, { q: '', card: 'all', day: 2 })).toEqual([]);
    expect(filterFirst7Rows(rows, { q: ' notstart ', card: 'all', day: null }).map((r) => r.rent_request_id)).toEqual(['ns']);
    expect(filterFirst7Rows(rows, { q: 'JOY', card: 'all', day: null })).toHaveLength(5);
    expect(filterFirst7Rows(rows, { q: '0772', card: 'all', day: null })).toHaveLength(5);
    expect(filterFirst7Rows(rows, { q: 'zzz', card: 'all', day: null })).toEqual([]);
  });
});

describe('one agent and the payments behind a plan', () => {
  const rows = [
    row({ rent_request_id: 'a', agent_id: AGENT, agent_name: 'Joy', row_status: 'on_track' }),
    row({ rent_request_id: 'b', agent_id: AGENT, agent_name: 'Joy', row_status: 'behind' }),
    row({ rent_request_id: 'c', agent_id: AGENT, agent_name: 'Joy', row_status: 'on_track' }),
    row({ rent_request_id: 'd', agent_id: AGENT, agent_name: 'Joy', row_status: 'too_early' }),
    row({ rent_request_id: 'e', agent_id: 'other', agent_name: 'Peter', row_status: 'on_track' }),
  ];
  it('counts the agent\'s on-track share from the server statuses, leaving out plans whose day 1 has not come', () => {
    expect(agentOnTrack(rows, AGENT)).toEqual({ agent_id: AGENT, agent_name: 'Joy', started: 3, on_track: 2, pct: 67 });
    expect(agentOnTrack(rows, 'other')).toMatchObject({ started: 1, on_track: 1, pct: 100 });
    expect(agentOnTrack([row({ agent_id: 'x', row_status: 'too_early' })], 'x').pct).toBeNull();
    expect(agentOnTrack(rows, 'nobody')).toMatchObject({ started: 0, pct: null, agent_name: null });
  });
  it('the agent filter keeps only that agent\'s Rent Plans', () => {
    expect(filterFirst7Rows(rows, { q: '', card: 'all', day: null, agent: AGENT }).map((r) => r.rent_request_id)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterFirst7Rows(rows, { q: '', card: 'on_track', day: null, agent: AGENT }).map((r) => r.rent_request_id)).toEqual(['a', 'c']);
  });
  it('names the payment method: self-pay by channel, then cash or wallet', () => {
    expect(paymentMethodLabel('in_app_wallet', 'tenant_deposit_auto')).toBe('Self-pay');
    expect(paymentMethodLabel('cash', 'agent_float')).toBe('Cash');
    expect(paymentMethodLabel('in_app_wallet', 'agent_float')).toBe('Wallet');
    expect(paymentMethodLabel('in_app_wallet', 'agent_liability_settlement')).toBe('Wallet');
    expect(paymentMethodLabel('mobile_money', null)).toBe('Mobile money');
    expect(paymentMethodLabel(null, null)).toBe('—');
  });
  it('turns a payment row into numbers and keeps the nulls', () => {
    expect(normalizePayment({ collection_id: 'c1', collected_at: '2026-10-12T07:15:00Z', collected_day: '2026-10-12', day_number: '1', amount: '10000.00', payment_method: 'cash', collection_channel: 'agent_float', agent_id: null, agent_name: null }))
      .toEqual({ collection_id: 'c1', collected_at: '2026-10-12T07:15:00Z', collected_day: '2026-10-12', day_number: 1, amount: 10000, payment_method: 'cash', collection_channel: 'agent_float', agent_id: null, agent_name: null });
  });
  it('writes Kampala time for the screen and the exports', () => {
    expect(kampalaStamp(new Date('2026-10-15T11:32:00Z'))).toBe('15 Oct 2026, 14:32 EAT');
    expect(kampalaStamp(new Date('2026-10-14T21:05:00Z'))).toBe('15 Oct 2026, 00:05 EAT');
    expect(kampalaDateTime('2026-10-12T07:15:00Z')).toBe('12 Oct, 10:15');
    expect(kampalaDateTime('nope')).toBe('');
  });
});
