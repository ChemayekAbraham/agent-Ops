import { describe, it, expect, vi, beforeEach } from 'vitest';

const sheets = vi.hoisted(() => ({ calls: [] as { name: string; sheets: { name: string; headers: string[]; rows: unknown[][] }[] }[] }));
vi.mock('@/lib/xlsxExport', () => ({
  downloadXlsxWorkbook: async (name: string, s: { name: string; headers: string[]; rows: unknown[][] }[]) => { sheets.calls.push({ name, sheets: s }); },
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { exportNoPaymentXlsx, summariseNoPayment } from './tenantOpsNoPaymentReport';

const t = (id: string, days: number, out = 100000, daily = 5000) => ({
  tenant_id: id, tenant_name: `T${id}`, tenant_account_number: '0700', agent_id: 'a1', agent_name: 'Agent One',
  date_of_last_payment: '2026-09-10', days_since_last_payment: days, expected_daily_payment: daily, outstanding_balance: out,
  total_amount_paid: 50000, progress_pct: 25, tenant_status: 'repaying',
});
const rep = (n: number) => ({
  as_of: '2026-10-13', min_days: n, total_min_days: 3, tenants: [t('A', n + 3), t('B', n + 22, 200000), t('C', n + 11)],
  agent_summary: [
    { agent_id: 'a1', label: 'Agent One', gte_min: 3, gte_min_10: 2, gte_min_20: 1 },
    { agent_id: null, label: 'Unassigned', gte_min: 1, gte_min_10: 0, gte_min_20: 0 },
  ],
});

describe('summariseNoPayment', () => {
  it('sums the per-agent counts and the listed amounts', () => {
    expect(summariseNoPayment(rep(20))).toEqual({ min: 4, min10: 2, min20: 1, outstanding: 400000, dailyAtRisk: 15000 });
  });
});

describe('exportNoPaymentXlsx', () => {
  beforeEach(() => { sheets.calls.length = 0; });

  it('titles every sheet with N and carries the same totals as the screen', async () => {
    await exportNoPaymentXlsx(rep(45) as never, 'Agent One');
    const { name, sheets: out } = sheets.calls[0];
    expect(name).toMatch(/^Welile_TenantOps_45_Plus_Days_No_Payment_/);
    const summary = out.find((s) => s.name === 'Summary')!;
    expect(summary.headers[0]).toBe('Tenants 45+ days without payment');
    expect(summary.rows.slice(0, 3)).toEqual([['45+ days', 4], ['55+ days', 2], ['65+ days', 1]]);
    expect(summary.rows).toContainEqual(['Agent filter', 'Agent One']);
    const agents = out.find((s) => s.name === 'Agents')!;
    expect(agents.headers).toEqual(['Agent', '45+ days', '55+ days', '65+ days']);
    expect(agents.rows.at(-1)).toEqual(['All agents', 4, 2, 1]);
    const tenants = out.find((s) => s.name === 'Tenants')!;
    expect(tenants.rows.map((r) => r[4])).toEqual([67, 56, 48]);
  });
});
