import { describe, it, expect, vi, beforeEach } from 'vitest';

const rec = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock('jspdf', async (importOriginal) => {
  const mod = await importOriginal<typeof import('jspdf')>();
  const Base = mod.default as unknown as new (...a: unknown[]) => Record<string, (...args: unknown[]) => unknown>;
  class Recording extends Base {
    constructor(...a: unknown[]) {
      super(...a);
      const realText = this.text.bind(this);
      this.text = (...args: unknown[]) => {
        const t = args[0];
        rec.texts.push(Array.isArray(t) ? t.join(' ') : String(t));
        return realText(...args);
      };
    }
  }
  return { ...mod, default: Recording, jsPDF: Recording };
});

import { generateNoPaymentPdfForDays, generateWeeklyPerformancePdf } from './tenantOpsWeeklyPerformancePdf';
import type { TenantOpsWeeklyHistoryRow, TenantOpsWeeklyPerformance } from '@/hooks/useTenantOpsWeeklyPerformance';

const m = {
  total_active_tenants: 789, paying_tenants: 409, non_paying_tenants: 380, new_tenants_added: 69,
  payment_rate_pct: 51.8, self_payment_tenants: 31, dormant_20_plus_count: 208, landlord_not_paid_count: 98,
};
const data = (changed: boolean): TenantOpsWeeklyPerformance => ({
  week_start: '2026-10-07', week_end: '2026-10-13', is_current_week_open: true, counting: 'amclock',
  counting_changed_this_week: changed,
  current: m,
  previous: { ...m, week_start: '2026-09-30', week_end: '2026-10-06', counting: 'old', landlord_not_paid_count: null },
  delta: {
    total_active_tenants: -44, paying_tenants: 47, non_paying_tenants: -91, new_tenants_added: 10, payment_rate_pct: 8.3,
    self_payment_tenants: 8, self_payment_increase_pct: 34.8, dormant_20_plus_count: 58, landlord_not_paid_count: null,
  },
});
const row = (week_start: string, changed: boolean): TenantOpsWeeklyHistoryRow => ({
  week_start, week_end: week_start, captured_at: '2026-10-14T00:10:00Z', counting_changed: changed,
  total_active_tenants: 1, paying_tenants: 1, non_paying_tenants: 0, new_tenants_added: 0, payment_rate_pct: 100,
  self_payment_tenants: 0, dormant_20_plus_count: 0,
});

describe('generateWeeklyPerformancePdf', () => {
  beforeEach(() => { rec.texts.length = 0; });

  it('prints the clock note, the landlord-not-paid line and the counting-changed marker', () => {
    generateWeeklyPerformancePdf(data(true), [row('2026-10-07', true), row('2026-09-30', false)]);
    const all = rec.texts.join('\n');
    expect(all).toContain('Counted from the day after the landlord was paid');
    expect(all).toContain('Landlord not paid yet: 98 plans (not counted as owing)');
    expect(all).toContain('Counting changed this week - earlier weeks used the old start date');
    expect(all).toContain('* Counting changed this week');
  });

  it('does not print the counting-changed marker for any other week', () => {
    generateWeeklyPerformancePdf(data(false), [row('2026-09-30', false)]);
    expect(rec.texts.join('\n')).not.toContain('Counting changed this week');
  });
});

const noPay = (n: number, tenants: unknown[]) => ({
  as_of: '2026-10-13', min_days: n, total_min_days: tenants.length, tenants,
  agent_summary: [{ agent_id: 'a1', label: 'Agent One', gte_min: 5, gte_min_10: 3, gte_min_20: 1 }],
}) as never;
const dormantTenant = { tenant_id: 't1', tenant_name: 'Nakato Ann', tenant_account_number: '0700', agent_id: 'a1', agent_name: 'Agent One', date_of_last_payment: '2026-09-01', days_since_last_payment: 42, expected_daily_payment: 10000, outstanding_balance: 200000, total_amount_paid: 100000, progress_pct: 33.3, tenant_status: 'repaying' };

describe('generateNoPaymentPdfForDays', () => {
  beforeEach(() => { rec.texts.length = 0; });

  it('titles the report, the cards and the bands with the chosen number', () => {
    generateNoPaymentPdfForDays(noPay(30, [dormantTenant]), null);
    const all = rec.texts.join('\n');
    expect(all).toContain('30+ Days No Payment');
    expect(all).toContain('30+ days');
    expect(all).toContain('40+ days');
    expect(all).toContain('50+ days');
    expect(all).toContain('between 30 and 39 days');
    expect(all).toContain('between 40 and 49 days');
    expect(all).not.toContain('20+ Days No Payment');
  });

  it('says so, with the number, when nobody is on the list', () => {
    generateNoPaymentPdfForDays(noPay(60, []), 'Agent One');
    const all = rec.texts.join('\n');
    expect(all).toContain('No tenants have gone 60+ days without payment.');
    expect(all).toContain('Filtered to Agent One');
  });
});
