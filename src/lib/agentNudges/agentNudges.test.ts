import { describe, it, expect } from 'vitest';
import {
  NUDGES,
  NUDGE_VALUE_KEYS,
  buildNudgeValues,
  canShowNudge,
  isNudgeEligible,
  recordNudge,
  ordinal,
  pickNudge,
  placeholdersOf,
  renderNudge,
  type AgentNudgeStats,
} from './index';

const base: AgentNudgeStats = {
  first_name: 'Grace Namata',
  due_today_count: 6,
  expected_today: 60000,
  collected_today_count: 2,
  collected_today: 20000,
  uncollected_count: 4,
  uncollected_amount: 40000,
  missed_commission: 3200,
  earned_commission_today: 1600,
  top_tenant_name: 'Musa',
  top_tenant_amount: 15000,
  active_agents_today: 40,
  rank_today: 7,
  rank_yesterday: 12,
  gap_to_next_rank: 5000,
  streak_days: 4,
  tenants_total: 9,
  new_tenants_7d: 0,
  days_since_new_tenant: 10,
};

const ugx = (n: number) => `UGX ${n.toLocaleString('en-US')}`;
// 10:00 in Kampala (UTC+3)
const morning = new Date('2026-10-16T07:00:00Z');

describe('nudges.json', () => {
  it('has unique ids', () => {
    const ids = NUDGES.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only references known values', () => {
    for (const n of NUDGES) {
      for (const key of [...placeholdersOf(n), ...Object.keys(n.when ?? {})]) {
        expect(NUDGE_VALUE_KEYS.has(key), `${n.id} uses unknown {${key}}`).toBe(true);
      }
    }
  });

  it('uses only known rule operators and tones', () => {
    const ops = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'exists']);
    for (const n of NUDGES) {
      expect(['nudge', 'celebrate', 'info']).toContain(n.tone);
      for (const rule of Object.values(n.when ?? {})) {
        for (const op of Object.keys(rule)) expect(ops.has(op), `${n.id}: ${op}`).toBe(true);
      }
    }
  });

  it('follows the regulatory terminology', () => {
    for (const n of NUDGES) {
      const text = `${n.title} ${n.body}`;
      expect(text, n.id).not.toMatch(/\b(loans?|lenders?|interest|roi)\b/i);
      expect(text, `${n.id}: money renders its own currency`).not.toMatch(/(UGX|\$)\s*\{/);
    }
  });
});

describe('values', () => {
  it('derives rank fields and the first name', () => {
    const v = buildNudgeValues(base, morning);
    expect(v.first_name).toBe('Grace');
    expect(v.hour).toBe(10);
    expect(v.rank_ordinal).toBe('7th');
    expect(v.next_rank_ordinal).toBe('6th');
    expect(v.rank_climb).toBe(5);
    expect(v.top_percent).toBe(18);
    expect(v.coverage_pct).toBe(33);
  });

  it('leaves rank fields empty for an agent who has not collected today', () => {
    const v = buildNudgeValues({ ...base, rank_today: null, collected_today_count: 0 }, morning);
    expect(v.rank_ordinal).toBeNull();
    expect(v.rank_climb).toBeNull();
    expect(v.gap_to_next_rank).toBeNull();
  });

  it('tidies all-caps and all-lowercase names', () => {
    expect(buildNudgeValues({ ...base, first_name: 'SHAFEEQ ALI' }, morning).first_name).toBe('Shafeeq');
    expect(buildNudgeValues({ ...base, top_tenant_name: 'nakasagga juliet' }, morning).top_tenant_name).toBe('Nakasagga Juliet');
    expect(buildNudgeValues({ ...base, top_tenant_name: 'McDonald Okello' }, morning).top_tenant_name).toBe('McDonald Okello');
  });

  it('formats ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(
      ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th'],
    );
  });
});

describe('picking', () => {
  it('never renders a nudge with a missing value', () => {
    const empty: AgentNudgeStats = {
      ...base, first_name: null, top_tenant_name: null, top_tenant_amount: null,
      rank_today: null, rank_yesterday: null, gap_to_next_rank: null, days_since_new_tenant: null,
    };
    for (const stats of [base, empty]) {
      for (let h = 0; h < 24; h++) {
        const v = buildNudgeValues(stats, new Date(Date.UTC(2026, 9, 16, (h + 21) % 24)));
        for (const n of NUDGES.filter((t) => isNudgeEligible(t, v))) {
          const r = renderNudge(n, v, ugx);
          expect(`${r.title} ${r.body}`, n.id).not.toMatch(/\{|\bnull\b|undefined|NaN/);
        }
      }
    }
  });

  it('renders the missed-commission nudge', () => {
    const n = NUDGES.find((t) => t.id === 'collect-missed-commission-boss')!;
    const r = renderNudge(n, buildNudgeValues(base, morning), ugx);
    expect(r.body).toBe("You're missing out on UGX 3,200 in commission. Collect for your tenants, Boss 😎");
  });

  it('respects rules: #1 only for the leader, board-cleared only when nothing is left', () => {
    const leader = buildNudgeValues({ ...base, rank_today: 1, gap_to_next_rank: null }, morning);
    const seventh = buildNudgeValues(base, morning);
    const one = NUDGES.find((t) => t.id === 'rank-number-one')!;
    expect(isNudgeEligible(one, leader)).toBe(true);
    expect(isNudgeEligible(one, seventh)).toBe(false);

    const cleared = NUDGES.find((t) => t.id === 'win-board-cleared')!;
    expect(isNudgeEligible(cleared, seventh)).toBe(false);
    expect(isNudgeEligible(cleared, buildNudgeValues({ ...base, uncollected_count: 0 }, morning))).toBe(true);
  });

  it('skips excluded ids unless nothing else fits', () => {
    const only = [NUDGES.find((t) => t.id === 'collect-missed-commission-boss')!];
    expect(pickNudge(base, { templates: only, exclude: [only[0].id], formatMoney: ugx })?.id).toBe(only[0].id);

    const all = NUDGES.map((t) => t.id).filter((id) => id !== 'rank-did-you-know');
    expect(pickNudge(base, { now: morning, exclude: all, formatMoney: ugx })?.id).toBe('rank-did-you-know');
  });

  it('returns null when nothing fits', () => {
    expect(pickNudge(base, { templates: [] })).toBeNull();
  });
});

describe('pacing', () => {
  const at = (kampalaHour: number, minutes = 0) =>
    new Date(Date.UTC(2026, 9, 16, kampalaHour - 3, minutes));

  it('only shows in waking hours and after the cooldown', () => {
    const fresh = { lastShownAt: null, recent: [] };
    expect(canShowNudge(fresh, at(5, 59))).toBe(false);
    expect(canShowNudge(fresh, at(6))).toBe(true);
    expect(canShowNudge(fresh, at(21))).toBe(false);

    const shown = recordNudge(fresh, 'a', at(9));
    expect(canShowNudge(shown, at(11, 59))).toBe(false);
    expect(canShowNudge(shown, at(12))).toBe(true);
  });

  it('keeps the most recent ids, newest first, without duplicates', () => {
    let h = { lastShownAt: null as number | null, recent: [] as string[] };
    for (const id of ['a', 'b', 'c', 'a', 'd', 'e', 'f', 'g']) h = recordNudge(h, id, at(9));
    expect(h.recent).toEqual(['g', 'f', 'e', 'd', 'a', 'c']);
  });
});
