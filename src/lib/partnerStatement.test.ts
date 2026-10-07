import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

import {
  buildPartnerStatementHtml,
  type StatementData,
  type StatementPortfolio,
} from './partnerStatement';

const portfolio = (over: Partial<StatementPortfolio> = {}): StatementPortfolio => ({
  id: '36b34488-0000-4000-8000-000000000001',
  code: 'WPF-3542',
  name: null,
  status: 'active',
  roi_mode: 'monthly_compounding',
  rate: 15,
  current_value: 66125,
  start_date: '2026-03-05',
  maturity_date: '2027-03-05',
  days_left: 170,
  next_roi_date: null,
  duration_months: 12,
  auto_reinvest: true,
  compounds: [
    { date: '2026-04-23', amount: 7500, reference: 'CMP-1' },
    { date: '2026-05-25', amount: 8625, reference: 'CMP-2' },
  ],
  renewals: [],
  changes: [],
  payouts: [],
  ...over,
});

const data = (portfolios: StatementPortfolio[], payouts = { count: 0, amount: 0 }): StatementData => ({
  generated_at: '2026-09-16T10:00:00Z',
  partner: { name: 'Piuslubega Ssenkali', phone: '+256 701 312 245', mobile_money: '0701355245' },
  payouts_total: payouts,
  portfolios,
});

describe('buildPartnerStatementHtml', () => {
  it('derives principal from current value less returns added, and totals the account', () => {
    const html = buildPartnerStatementHtml(data([portfolio()], { count: 2, amount: 15000 }));
    expect(html).toContain('UGX 50,000'); // 66,125 - 16,125 added returns
    expect(html).toContain('UGX 16,125'); // returns added
    expect(html).toContain('UGX 15,000'); // account-level payouts
    expect(html).toContain('UGX 66,125'); // closing value
    expect(html).not.toMatch(/NaN|undefined|null/);
  });

  it('numbers every page consistently and closes with the completion panel', () => {
    const many = Array.from({ length: 70 }, (_, i) =>
      portfolio({ id: `id-${String(i).padStart(8, '0')}`, code: `WPF-${i}` }));
    const html = buildPartnerStatementHtml(data(many));
    const pages = (html.match(/class="report-page"/g) ?? []).length;
    expect(pages).toBeGreaterThan(2);
    expect(html).toContain(`PAGE 1 OF ${pages}`);
    expect(html).toContain(`PAGE ${pages} OF ${pages}`);
    expect(html).toContain('Official Statement Completion Verification');
    // every portfolio is in the schedule and has its own ledger block
    expect((html.match(/class="portfolio-statement-entry"/g) ?? []).length).toBe(70);
  });

  it('shows self-support and payout portfolios in the supporter wording', () => {
    const html = buildPartnerStatementHtml(data([
      portfolio({ id: 'a', code: 'WSP-6312', roi_mode: null, compounds: [], current_value: 100000 }),
      portfolio({ id: 'b', code: 'WPF-1', roi_mode: 'monthly_payout', compounds: [], current_value: 50000 }),
    ]));
    expect(html).toContain('Self Support');
    expect(html).toContain('Return paid to you each month');
    expect(html).toContain('No Return has been added to this portfolio yet.');
    expect(html).not.toMatch(/\bloan\b|\blender\b|\binterest\b|\bROI\b/i);
  });

  it('escapes partner-controlled text', () => {
    const d = data([portfolio({ changes: [{ date: '2026-08-02', what: '<script>x</script>' }] })]);
    d.partner = { name: '<b>Eve</b>', phone: null, mobile_money: null };
    const html = buildPartnerStatementHtml(d);
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<b>Eve</b>');
  });
});
