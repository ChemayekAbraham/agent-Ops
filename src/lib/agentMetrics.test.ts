import { describe, expect, it } from 'vitest';
import {
  CARD_IDS, dropCard, hasMetricsParams, mergeOrder, metricsPresetOf, metricsPresetRange, moveCard, normalizeAgents, normalizeTotals, orderKey, readMetricsParams,
  readOrder, validSort, writeMetricsParams, writeOrder, metricsErrorMessage, locationLabel, normalizePins, normalizeQuality, normalizeRisk, riskCsvRows, activityCsvRows, RISK_FLAG_LABEL,
} from './agentMetrics';

const TODAY = '2026-10-16';
const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

describe('metrics URL params', () => {
  it('reads valid params and keeps the end at or before today', () => {
    const sp = new URLSearchParams('metrics=1&mfrom=2026-10-01&mto=2026-12-31&mscope=linked&msort=net:asc');
    expect(readMetricsParams(sp, TODAY)).toEqual({ from: '2026-10-01', to: TODAY, scope: 'linked', sort: 'net:asc' });
  });
  it('falls back to the last 30 days on a bad or reversed range, and to defaults on a bad scope or sort', () => {
    const r = readMetricsParams(new URLSearchParams('mfrom=nope&mto=2026-10-01&mscope=x&msort=drop table'), TODAY);
    expect(r.to).toBe(TODAY);
    expect(r.scope).toBe('qualifying');
    expect(r.sort).toBe('houses_listed');
    expect(readMetricsParams(new URLSearchParams('mfrom=2026-10-10&mto=2026-10-01'), TODAY).from).toBe(metricsPresetRange('last30', TODAY).from);
  });
  it('writes only what differs from the defaults and keeps other parameters', () => {
    const next = writeMetricsParams(new URLSearchParams('tab=agent-ops&net=1&netfrom=2026-10-01'), { from: '2026-10-01', to: TODAY, scope: 'qualifying', sort: 'houses_listed' });
    expect(next.get('tab')).toBe('agent-ops');
    expect(next.get('metrics')).toBe('1');
    expect(next.has('mscope')).toBe(false);
    expect(next.has('msort')).toBe(false);
    expect(hasMetricsParams(next)).toBe(true);
    expect(hasMetricsParams(new URLSearchParams('net=1'))).toBe(false);
  });
  it('accepts only whitelisted sorts with an optional asc or desc', () => {
    expect(validSort('Net:ASC')).toBe('net:asc');
    expect(validSort('name')).toBe('name');
    expect(validSort('name:sideways')).toBe('name');
    expect(validSort('phone')).toBe('houses_listed');
    expect(validSort(null)).toBe('houses_listed');
  });
});

describe('date presets', () => {
  it('works out the four presets and recognises them again', () => {
    expect(metricsPresetRange('today', TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(metricsPresetRange('month', TODAY)).toEqual({ from: '2026-10-01', to: TODAY });
    for (const id of ['today', 'last7', 'last30', 'month'] as const) {
      const r = metricsPresetRange(id, TODAY);
      expect(metricsPresetOf(r.from, r.to, TODAY)).toBe(id);
    }
    expect(metricsPresetOf('2026-10-02', '2026-10-05', TODAY)).toBe('custom');
  });
});

describe('card order', () => {
  it('completes a saved order: drops unknown and repeated ids and appends new cards', () => {
    expect(mergeOrder(['advances', 'bogus', 'advances', 'headline'])).toEqual(['advances', 'headline', ...CARD_IDS.filter((c) => c !== 'advances' && c !== 'headline')]);
    expect(mergeOrder('nonsense')).toEqual([...CARD_IDS]);
    expect(mergeOrder(null)).toEqual([...CARD_IDS]);
  });
  it('saves per user and reads back; a broken value reads as the default', () => {
    const s = store();
    writeOrder('u1', ['advances', ...CARD_IDS.filter((c) => c !== 'advances')], s);
    expect(orderKey('u1')).toBe('agentOpsMetricsOrder:u1');
    expect(readOrder('u1', s)[0]).toBe('advances');
    expect(readOrder('u2', s)).toEqual([...CARD_IDS]);
    s.setItem(orderKey('u3'), '{not json');
    expect(readOrder('u3', s)).toEqual([...CARD_IDS]);
  });
  it('moves a card up or down, never past the ends, and drops one onto another', () => {
    const o = [...CARD_IDS];
    expect(moveCard(o, 0, -1)).toBe(o);
    expect(moveCard(o, o.length - 1, 1)).toBe(o);
    expect(moveCard(o, 1, -1).slice(0, 2)).toEqual([o[1], o[0]]);
    expect(dropCard(o, 'advances', 'headline')[0]).toBe('advances');
    expect(dropCard(o, 'headline', 'headline')).toBe(o);
    expect(dropCard(o, 'headline', 'advances').indexOf('headline')).toBe(o.indexOf('advances'));
  });
});

describe('normalising what the server returns', () => {
  it('reads a totals row from an array or an object, a missing figure as 0', () => {
    const t = normalizeTotals([{ houses_listed: 292, listing_earned: '1752000', advances_outstanding: 59086790.98, basis: 'b' }]);
    expect(t.houses_listed).toBe(292);
    expect(t.listing_earned).toBe(1752000);
    expect(t.advances_outstanding).toBe(59086790.98);
    expect(t.houses_pending).toBe(0);
    expect(normalizeTotals({ houses_listed: 3 }).houses_listed).toBe(3);
    expect(normalizeTotals(null).houses_listed).toBe(0);
  });
  it('keeps the figures exactly as returned (net is the server\'s, not earned minus clawed back)', () => {
    const [a] = normalizeAgents([{ agent_id: 'a', name: '', phone: '', listing_earned: 100, clawed_back: 40, net: 70, total_matched: 9 }]);
    expect(a.net).toBe(70);
    expect(a.name).toBe('Unnamed agent');
    expect(a.phone).toBeNull();
    expect(a.total_matched).toBe(9);
  });
  it('drops pins without an id or a position', () => {
    expect(normalizePins([{ listing_id: 'x', latitude: 0.3, longitude: 32.5, verified: true }, { listing_id: '', latitude: 1, longitude: 1 }, { listing_id: 'y', latitude: 0, longitude: 0 }])).toHaveLength(1);
  });
  it('labels a location row at each level', () => {
    const l = { region: null, district: 'Wakiso', sub_county: 'Kira', houses_listed: 1, houses_verified: 1, houses_pending: 0, houses_with_gps: 1, agents: 1 };
    expect(locationLabel(l, 'region')).toBe('No region recorded');
    expect(locationLabel(l, 'district')).toBe('Wakiso');
    expect(locationLabel(l, 'sub_county')).toBe('Kira, Wakiso');
  });
  it('turns errors into one plain line', () => {
    expect(metricsErrorMessage({ code: '42501', message: 'not authorized' })).toMatch(/do not have access/);
    expect(metricsErrorMessage({ message: 'RANGE_INVALID: p_end is before p_start' })).toMatch(/end date/);
    expect(metricsErrorMessage(null)).not.toBe('');
  });
});

describe('the Risk card in the card order', () => {
  it('is in the default order after Advances', () => {
    expect(CARD_IDS).toContain('risk');
    expect(CARD_IDS.indexOf('risk')).toBe(CARD_IDS.indexOf('advances') + 1);
    expect([...CARD_IDS]).toEqual(['headline', 'listings', 'earnings', 'agents', 'locations', 'main-agents', 'advances', 'risk', 'activity']);
  });
  it('is appended to an order saved before it existed, and keeps the saved order', () => {
    const old = ['activity', 'advances', 'main-agents', 'locations', 'agents', 'earnings', 'listings', 'headline'];
    const merged = mergeOrder(old);
    expect(merged.slice(0, 8)).toEqual(old);
    expect(merged[8]).toBe('risk');
    expect(merged).toHaveLength(CARD_IDS.length);
    const s = store();
    s.setItem(orderKey('u9'), JSON.stringify(old));
    expect(readOrder('u9', s)[8]).toBe('risk');
  });
});

describe('quality and risk answers', () => {
  it('types the quality answer as returned (rates stay as sent, a missing figure reads as 0 or null)', () => {
    const q = normalizeQuality({
      network: { houses_listed: 307, houses_verified: 230, houses_pending: 74, houses_currently_rejected: 3, rejection_events: 36, occupied: 0, empty: 307, approval_rate: 74.9, avg_days_to_verify: null, earn_per_approved: 8043, waiting_total: 2031, oldest_waiting_days: 108 },
      agents: [{ agent_id: 'a', name: '', houses_listed: 2, approval_rate: 50, earn_per_approved: null }],
      waiting: [{ listing_id: 'l', agent_id: 'a', agent_name: 'G', phone: '', district: null, listed_at: '2026-06-30T05:18:54+00:00', days_waiting: 108 }],
    });
    expect(q.network.houses_currently_rejected).toBe(3);
    expect(q.network.approval_rate).toBe(74.9);
    expect(q.network.avg_days_to_verify).toBeNull();
    expect(q.network.listing_earned).toBe(0);
    expect(q.agents[0].name).toBe('Unnamed agent');
    expect(q.agents[0].earn_per_approved).toBeNull();
    expect(q.waiting[0].phone).toBeNull();
    expect(normalizeQuality(null).waiting).toEqual([]);
  });
  it('types the risk answer, keeps the flag and ratio the server decided, and falls back to ok for an unknown flag', () => {
    const r = normalizeRisk({
      summary: { owing_agents: 322, flag_high: 1, inactive_listers_count: 427 },
      advance_vs_earnings: [{ agent_id: 'a', name: 'A', advance_outstanding: '900000', listing_earned: 100000, ratio: 9, flag: 'high' }, { agent_id: 'b', name: 'B', flag: 'mystery', ratio: null }],
      inactive_listers: [{ agent_id: 'i', name: 'I', days_inactive: 30 }],
      main_agents_by_advance: [{ main_agent_id: 'm', name: 'M', team_advances_outstanding: 12891354.74 }],
    });
    expect(r.summary.owing_agents).toBe(322);
    expect(r.summary.flag_watch).toBe(0);
    expect(r.advance_vs_earnings[0]).toMatchObject({ ratio: 9, flag: 'high', advance_outstanding: 900000 });
    expect(r.advance_vs_earnings[1].flag).toBe('ok');
    expect(r.advance_vs_earnings[1].ratio).toBeNull();
    expect(r.main_agents_by_advance[0].team_advances_outstanding).toBe(12891354.74);
    expect(normalizeRisk(undefined).never_listed_subagents).toEqual([]);
  });
  it('builds CSV rows with the flag label and the values unchanged', () => {
    const r = normalizeRisk({
      advance_no_listing: [{ agent_id: 'a', name: 'A', phone: '+256700000001', advance_outstanding: 100, last_listing: '2026-08-01' }],
      advance_vs_earnings: [{ agent_id: 'b', name: 'B', advance_outstanding: 50, listing_earned: 10, ratio: 5, flag: 'high' }],
      inactive_listers: [{ agent_id: 'i', name: 'I', last_listing: '2026-09-16', days_inactive: 30, houses_listed_ever: 8 }],
      never_listed_subagents: [{ agent_id: 'n', name: 'N', main_agent_name: 'Main', linked_on: '2026-01-19' }],
    });
    const rows = riskCsvRows(r);
    expect(rows).toHaveLength(2);
    expect(rows[1][6]).toBe(RISK_FLAG_LABEL.high);
    expect(rows[1][5]).toBe(5);
    expect(activityCsvRows(r).map((x) => x[0])).toEqual(['Inactive lister', 'Never listed']);
  });
});
