import { describe, it, expect } from 'vitest';
import { isNudgeEligible, placeholdersOf, renderNudge } from '@/lib/nudges/engine';
import {
  FUNDER_NUDGES,
  FUNDER_NUDGE_VALUE_KEYS,
  buildFunderNudgeValues,
  canShowFunderNudge,
  pickFunderNudge,
  recordFunderNudge,
  type FunderNudgeStats,
} from './index';

const base: FunderNudgeStats = {
  first_name: 'KABAHUMA Grace',
  active_portfolios: 3,
  total_principal: 37221702,
  next_payout_date: '2026-11-07',
  days_to_next_payout: 2,
  returns_last_amount: 675000,
  hours_since_last_returns: 4,
  total_returns_received: 13230702,
  returns_milestone_reached: 0,
  returns_this_month: 6192342,
  portfolio_label: 'WPF-6422',
  maturity_date: '2027-03-09',
  days_to_maturity: 20,
  is_compounding: 1,
  growth_portfolio_label: 'WPF-6422',
  start_amount: 24281000,
  current_value: 34071712,
  growth_amount: 9790712,
  houses_supported: 0,
  landlord_rent_paid: null,
  days_as_supporter: 230,
  years_as_supporter: 0,
  is_anniversary_today: 0,
  wallet_balance: 1623735,
  wallet_idle_days: 0,
  referrals_30d: 0,
};

const ugx = (n: number) => `UGX ${n.toLocaleString('en-US')}`;
// Monday 2026-10-26, 09:00 Kampala
const mondayMorning = new Date('2026-10-26T06:00:00Z');

describe('funder nudges.json', () => {
  it('has unique ids and no buttons', () => {
    const ids = FUNDER_NUDGES.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of FUNDER_NUDGES) expect(n, n.id).not.toHaveProperty('cta');
  });

  it('only references known values and operators', () => {
    const ops = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'exists']);
    for (const n of FUNDER_NUDGES) {
      expect(['nudge', 'celebrate', 'info']).toContain(n.tone);
      for (const key of [...placeholdersOf(n), ...Object.keys(n.when ?? {})]) {
        expect(FUNDER_NUDGE_VALUE_KEYS.has(key), `${n.id} uses unknown {${key}}`).toBe(true);
      }
      for (const rule of Object.values(n.when ?? {})) {
        for (const op of Object.keys(rule)) expect(ops.has(op), `${n.id}: ${op}`).toBe(true);
      }
    }
  });

  it('follows the wording rules and carries no tenant or agent data', () => {
    for (const n of FUNDER_NUDGES) {
      const text = `${n.title} ${n.body}`;
      expect(text, n.id).not.toMatch(/\b(loans?|lenders?|interest|roi|investors?|missing out|act now)\b/i);
      expect(text, n.id).not.toMatch(/\b(agents?|collected|repayments?)\b/i);
      expect(text, `${n.id}: money renders its own currency`).not.toMatch(/(UGX|\$)\s*\{/);
      expect(placeholdersOf(n).join(' '), n.id).not.toMatch(/tenant|agent|landlord_name/);
    }
  });
});

describe('values', () => {
  it('derives clock fields, tidies the name and labels years', () => {
    const v = buildFunderNudgeValues({ ...base, years_as_supporter: 2 }, mondayMorning);
    expect(v.first_name).toBe('Kabahuma');
    expect(v.hour).toBe(9);
    expect(v.day_of_week).toBe(1);
    expect(v.day_of_month).toBe(26);
    expect(v.years_as_supporter_label).toBe('2 years');
    expect(buildFunderNudgeValues({ ...base, years_as_supporter: 1 }).years_as_supporter_label).toBe('1 year');
    expect(buildFunderNudgeValues(base).years_as_supporter_label).toBeNull();
  });
});

describe('picking', () => {
  it('skips the homes nudge when no houses are on file', () => {
    const homes = FUNDER_NUDGES.find((t) => t.id === 'impact-families-housed')!;
    expect(isNudgeEligible(homes, buildFunderNudgeValues(base, mondayMorning))).toBe(false);
    expect(isNudgeEligible(homes, buildFunderNudgeValues({ ...base, houses_supported: 12 }, mondayMorning))).toBe(true);
  });

  it('never fires the landlord rent nudge while its source is null', () => {
    const rent = FUNDER_NUDGES.find((t) => t.id === 'impact-rent-paid')!;
    expect(isNudgeEligible(rent, buildFunderNudgeValues(base, mondayMorning))).toBe(false);
  });

  it('renders money and dates', () => {
    const v = buildFunderNudgeValues(base, mondayMorning);
    const payday = pickFunderNudge(base, {
      now: mondayMorning, formatMoney: ugx,
      templates: [FUNDER_NUDGES.find((t) => t.id === 'payout-credited')!],
    });
    expect(payday?.body).toBe('UGX 675,000 just landed in your wallet, Kabahuma. Enjoy it!');
    const soon = FUNDER_NUDGES.find((t) => t.id === 'payout-coming-soon')!;
    expect(renderNudge(soon, v, { dateKeys: new Set(['next_payout_date']) }).body)
      .toBe('Your next Returns are scheduled for 7 Nov, Kabahuma.');
  });

  it('never renders a nudge with a missing value', () => {
    const empty: FunderNudgeStats = {
      ...base, first_name: null, next_payout_date: null, days_to_next_payout: null,
      returns_last_amount: null, hours_since_last_returns: null, portfolio_label: null,
      maturity_date: null, days_to_maturity: null, is_compounding: 0, growth_portfolio_label: null,
      start_amount: null, current_value: null, growth_amount: null, wallet_balance: null,
      wallet_idle_days: null, days_as_supporter: null, years_as_supporter: null,
    };
    for (const stats of [base, empty]) {
      for (let h = 0; h < 24; h++) {
        const now = new Date(Date.UTC(2026, 9, 26, (h + 21) % 24));
        const r = pickFunderNudge(stats, { now, formatMoney: ugx, random: () => 0.5 });
        if (r) expect(`${r.title} ${r.body}`, r.id).not.toMatch(/\{|\bnull\b|undefined|NaN/);
      }
    }
  });
});

describe('pacing', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 26, h - 3));

  it('shows at most one a day, 07:00-21:00 Kampala', () => {
    const fresh = { lastShownAt: null, recent: [] };
    expect(canShowFunderNudge(fresh, at(6))).toBe(false);
    expect(canShowFunderNudge(fresh, at(7))).toBe(true);
    expect(canShowFunderNudge(fresh, at(21))).toBe(false);
    const shown = recordFunderNudge(fresh, 'a', at(8));
    expect(canShowFunderNudge(shown, at(20))).toBe(false);
    expect(canShowFunderNudge(shown, new Date(at(8).getTime() + 24 * 3600_000))).toBe(true);
  });
});
