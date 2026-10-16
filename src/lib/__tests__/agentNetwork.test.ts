import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN, buildRankedCsv, clearNetworkParams, hasNetworkParams, netPresetOf, netPresetRange, networkErrorMessage, networkRangeParams, networkStamp,
  normalizeNetworkOverview, readNetworkParams, writeNetworkParams, SMARTPHONE_KEYS,
} from '../agentNetwork';

describe('networkRangeParams', () => {
  const day = (s: string) => new Date(`${s}T00:00:00`);
  it('sends the calendar days the picker shows', () => {
    expect(networkRangeParams(day('2026-10-01'), day('2026-10-15'), '2026-10-15')).toEqual({ p_start: '2026-10-01', p_end: '2026-10-15' });
    expect(networkRangeParams(day('2026-10-14'), new Date('2026-10-14T23:59:59'), '2026-10-15')).toEqual({ p_start: '2026-10-14', p_end: '2026-10-14' });
  });
  it('never asks for a future Kampala day (the server refuses it) and never starts after the end', () => {
    expect(networkRangeParams(day('2026-10-10'), day('2026-10-20'), '2026-10-15')).toEqual({ p_start: '2026-10-10', p_end: '2026-10-15' });
    expect(networkRangeParams(day('2026-10-18'), day('2026-10-20'), '2026-10-15')).toEqual({ p_start: '2026-10-15', p_end: '2026-10-15' });
  });
});

describe('normalizeNetworkOverview', () => {
  it('reads a zero payload: every figure 0, every list empty', () => {
    const z = normalizeNetworkOverview({});
    expect(z.counts).toEqual({ agents: 0, with_service_centres: 0, with_bikes: 0, with_smartphone_plan: 0, with_smartphone_tenants: 0, with_subagents: 0, posted_requests: 0, approved_agents: 0 });
    expect(z.approved).toEqual({ agents: 0, requests: 0, amount: 0, receivables_outstanding: 0 });
    expect(z.bikes).toEqual({ agents: 0, leases: 0, amount_outstanding: 0 });
    expect(Object.values(z.smartphone_usage.totals).every((v) => v === 0)).toBe(true);
    expect(Object.keys(z.smartphone_usage.totals)).toEqual([...SMARTPHONE_KEYS]);
    expect(z.top_portfolios).toEqual([]);
    expect(z.top_collection_rate).toEqual([]);
    expect(z.default_rate_ascending).toEqual([]);
    expect(normalizeNetworkOverview(null).counts.agents).toBe(0);
    expect(normalizeNetworkOverview('x').approved.amount).toBe(0);
  });
  it('keeps every figure and the order exactly as returned (no sums, rates or sorting)', () => {
    const d = normalizeNetworkOverview({
      range: { start: '2026-09-16', end: '2026-10-15', min_expected: 50000 },
      counts: { agents: 770, with_service_centres: 53, with_bikes: 2, with_smartphone_plan: 34, with_smartphone_tenants: 240, with_subagents: 166, posted_requests: 254, approved_agents: 124 },
      approved: { agents: 73, requests: 348, amount: 197940001, receivables_outstanding: 232937315 },
      top_portfolios: [{ agent_id: 'a', name: 'B', phone: '+256700000001', portfolio: 5, plans: 9 }, { agent_id: 'b', name: 'A', phone: '', portfolio: 9, plans: 1 }],
      top_collection_rate: [{ agent_id: 'a', name: 'B', phone: null, collected: 1, expected: 1000, rate_pct: 315.6 }],
      default_rate_ascending: [{ agent_id: 'a', name: 'B', phone: 'x', outstanding: 10, defaulted: 5, default_rate_pct: 0.1, plans: 2 }],
    });
    expect(d.counts.agents).toBe(770);
    expect(d.approved.amount).toBe(197940001);
    expect(d.top_portfolios.map((r) => r.agent_id)).toEqual(['a', 'b']); // not re-sorted although b is larger
    expect(d.top_portfolios[1].phone).toBeNull();
    expect(d.top_collection_rate[0].rate_pct).toBe(315.6); // not 1 / 1000
    expect(d.default_rate_ascending[0].default_rate_pct).toBe(0.1); // not 5 / 10
    expect(d.range).toEqual({ start: '2026-09-16', end: '2026-10-15', min_expected: 50000 });
  });
  it('turns numeric text into numbers and names a missing agent', () => {
    const d = normalizeNetworkOverview({ counts: { agents: '12' }, top_portfolios: [{ agent_id: 'a', portfolio: '1500.00', plans: '3' }] });
    expect(d.counts.agents).toBe(12);
    expect(d.top_portfolios[0]).toMatchObject({ portfolio: 1500, plans: 3, name: 'Unnamed agent', phone: null });
  });
});

describe('networkErrorMessage', () => {
  it('words the errors', () => {
    expect(networkErrorMessage({ message: 'not_authorized' })).toBe('You do not have access to the Agent Network figures.');
    expect(networkErrorMessage({ code: '42501', message: 'x' })).toBe('You do not have access to the Agent Network figures.');
    expect(networkErrorMessage({ message: 'auth_required' })).toBe('Your session expired. Sign in again and retry.');
    expect(networkErrorMessage({ message: 'RANGE_FUTURE: p_end is a future Kampala day' })).toBe('Pick a range that ends today or earlier.');
    expect(networkErrorMessage(new Error('boom'))).toBe('boom');
    expect(networkErrorMessage(null)).not.toBe('');
  });
});

describe('bikes and smartphone_usage', () => {
  it('reads both objects exactly as returned', () => {
    const d = normalizeNetworkOverview({
      bikes: { agents: 2, leases: 3, amount_outstanding: 2820000 },
      smartphone_usage: { as_of: '2026-10-15', from_day: '2026-09-16', to_day: '2026-10-15', tenants: 59117, recorded_smartphone: 58908, recorded_without: 209, confirmed_smartphone: 12, confirmed_feature_phone: 496, device_unknown: 58609, joined: 701, joined_recorded_smartphone: 642, checks: 105, checks_smartphone: 11, checks_feature_phone: 94, seen_on_phone: 6 },
    });
    expect(d.bikes).toEqual({ agents: 2, leases: 3, amount_outstanding: 2820000 });
    expect(d.smartphone_usage.from_day).toBe('2026-09-16');
    expect(d.smartphone_usage.totals).toMatchObject({ tenants: 59117, recorded_smartphone: 58908, confirmed_smartphone: 12, seen_on_phone: 6 });
  });
});

describe('the range presets and the URL', () => {
  const today = '2026-10-15';
  it('has the four presets in Kampala days, the end always today', () => {
    expect(netPresetRange('today', today)).toEqual({ from: today, to: today });
    expect(netPresetRange('month', today)).toEqual({ from: '2026-10-01', to: today });
    const l7 = netPresetRange('last7', today); const l30 = netPresetRange('last30', today);
    expect(l7.to).toBe(l30.to);
    expect(netPresetOf(l30.from, l30.to, l30.to)).toBe('last30');
    expect(netPresetOf('2026-10-01', '2026-10-02', today)).toBe('custom');
  });
  it('knows a link that is for the Agent Network and ignores the First 7 Days parameters', () => {
    expect(hasNetworkParams(new URLSearchParams('tab=agent-ops&net=1&netfrom=2026-10-01&netto=2026-10-15'))).toBe(true);
    expect(hasNetworkParams(new URLSearchParams('tab=agent-ops&f7from=2026-10-01&f7to=2026-10-02&f7freq=daily'))).toBe(false);
    expect(hasNetworkParams(new URLSearchParams('tab=agent-ops'))).toBe(false);
  });
  it('reads the range and the minimum back; a bad, reversed or future range falls back to the last 30 days', () => {
    expect(readNetworkParams(new URLSearchParams('net=1&netfrom=2026-10-01&netto=2026-10-10&netmin=100000'), today)).toEqual({ from: '2026-10-01', to: '2026-10-10', min: 100000 });
    const def = netPresetRange('last30', today);
    expect(readNetworkParams(new URLSearchParams('net=1'), today)).toEqual({ ...def, min: DEFAULT_MIN });
    expect(readNetworkParams(new URLSearchParams('netfrom=nope&netto=2026-10-10'), today)).toMatchObject(def);
    expect(readNetworkParams(new URLSearchParams('netfrom=2026-10-10&netto=2026-10-01'), today)).toMatchObject(def);
    expect(readNetworkParams(new URLSearchParams('netfrom=2026-10-10&netto=2026-12-31'), today)).toMatchObject({ from: '2026-10-10', to: today });
    expect(readNetworkParams(new URLSearchParams('netfrom=2026-10-01&netto=2026-10-10&netmin=777'), today).min).toBe(DEFAULT_MIN);
  });
  it('writes net, netfrom, netto (and netmin only when it is not the default) and leaves the other parameters, including f7*, alone', () => {
    const base = new URLSearchParams('tab=agent-ops&f7from=2026-10-01&f7freq=daily');
    const out = writeNetworkParams(base, { from: '2026-10-01', to: '2026-10-15', min: DEFAULT_MIN });
    expect(out.get('net')).toBe('1'); expect(out.get('netfrom')).toBe('2026-10-01'); expect(out.get('netto')).toBe('2026-10-15');
    expect(out.has('netmin')).toBe(false);
    expect(out.get('tab')).toBe('agent-ops'); expect(out.get('f7from')).toBe('2026-10-01'); expect(out.get('f7freq')).toBe('daily');
    expect(writeNetworkParams(base, { from: '2026-10-01', to: '2026-10-15', min: 500000 }).get('netmin')).toBe('500000');
    const cleared = clearNetworkParams(out);
    expect(hasNetworkParams(cleared)).toBe(false);
    expect(cleared.get('f7from')).toBe('2026-10-01');
  });
});

describe('buildRankedCsv', () => {
  const d = normalizeNetworkOverview({
    range: { start: '2026-09-16', end: '2026-10-15', min_expected: 50000 },
    top_portfolios: [{ agent_id: 'a', name: 'IAN MUHWEZI', phone: '+256787725122', portfolio: 49482312, plans: 19 }, { agent_id: 'b', name: 'No Phone', phone: null, portfolio: 1, plans: 1 }],
    top_collection_rate: [{ agent_id: 'c', name: 'Thomas', phone: '+256744846540', collected: 11189195, expected: 3545467, rate_pct: 315.6 }],
    default_rate_ascending: [{ agent_id: 'd', name: 'Akampurira', phone: '+256743657091', outstanding: 9919721, defaulted: 0, default_rate_pct: 0, plans: 29 }],
  });
  const now = new Date('2026-10-15T11:32:00Z');
  it('has the title, the Kampala range, the minimum and the generated time above the header', () => {
    const c = buildRankedCsv('portfolios', d, now);
    expect(c.preamble).toEqual([
      ['Agent Network: Biggest portfolios'], ['Kampala days', '2026-09-16 to 2026-10-15'], ['Minimum (UGX)', '50000'], ['Generated (Kampala time)', '15 Oct 2026, 14:32 EAT'], ['Amounts', 'UGX'],
    ]);
    expect(networkStamp(now)).toBe('15 Oct 2026, 14:32 EAT');
    expect(c.filename).toBe('agent-network-portfolios-2026-09-16_2026-10-15.csv');
  });
  it('writes the rows exactly as returned, the phone as text, in the order returned', () => {
    expect(buildRankedCsv('portfolios', d, now).rows).toEqual([[1, 'IAN MUHWEZI', '+256787725122', 19, 49482312], [2, 'No Phone', '', 1, 1]]);
    expect(buildRankedCsv('collection', d, now).rows).toEqual([[1, 'Thomas', '+256744846540', 11189195, 3545467, 315.6]]);
    expect(buildRankedCsv('default', d, now).rows).toEqual([[1, 'Akampurira', '+256743657091', 29, 9919721, 0, 0]]);
    expect(buildRankedCsv('collection', d, now).headers).toEqual(['Rank', 'Agent', 'Phone', 'Collected (UGX)', 'Expected (UGX)', 'Rate (%)']);
  });
  it('is empty for a zero payload', () => {
    expect(buildRankedCsv('default', normalizeNetworkOverview({}), now).rows).toEqual([]);
  });
});
