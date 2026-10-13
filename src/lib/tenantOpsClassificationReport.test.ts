import { describe, it, expect, vi, beforeEach } from 'vitest';

const rec = vi.hoisted(() => ({ texts: [] as string[], sheets: [] as { name: string; headers: string[]; rows: unknown[][] }[], saved: [] as string[] }));
vi.mock('jspdf', async (importOriginal) => {
  const mod = await importOriginal<typeof import('jspdf')>();
  const Base = mod.default as unknown as new (...a: unknown[]) => Record<string, (...args: unknown[]) => unknown>;
  class Recording extends Base {
    constructor(...a: unknown[]) {
      super(...a);
      const realText = this.text.bind(this);
      this.text = (...args: unknown[]) => { const t = args[0]; rec.texts.push(Array.isArray(t) ? t.join(' ') : String(t)); return realText(...args); };
    }
  }
  return { ...mod, default: Recording, jsPDF: Recording };
});
vi.mock('@/lib/pdfVault', () => ({ savePdfWithVault: (_d: unknown, name: string) => { rec.saved.push(name); } }));
vi.mock('@/lib/xlsxExport', () => ({
  downloadXlsxWorkbook: async (_name: string, sheets: { name: string; headers: string[]; rows: unknown[][] }[]) => { rec.sheets.push(...sheets); },
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { DETAIL_HEADERS, exportTenantClassificationXlsx, generateTenantClassificationPdf } from './tenantOpsClassificationReport';

const summary = {
  as_of: '2026-10-13', population: 59042, active: 868, waiting: 114, dormant: 309, dormant_renewal_in_progress: 19,
  inactive: 57751, inactive_never_requested: 53956, inactive_request_in_review: 3258,
  inactive_only_rejected_cancelled: 531, inactive_other: 6, needs_review: 27,
};
const row = (o: Record<string, unknown> = {}) => ({
  tenant_id: 't1', tenant_name: 'Nakato Ann', tenant_phone: '0700111222', district: 'Kampala', category: 'active', sub_label: null,
  needs_review: false, review_reasons: null, total_requests: 1, running_plans: 1, completed_plans: 0, outstanding_ugx: 50000,
  completed_on: null, days_since_completion: null, latest_status: 'repaying', latest_request_at: '2026-09-01T08:00:00Z',
  latest_agent_name: 'Agent One', total_rows: 1, ...o,
}) as never;

describe('tenant classification exports', () => {
  beforeEach(() => { rec.texts.length = 0; rec.sheets.length = 0; rec.saved.length = 0; });

  it('Excel: a Summary sheet with the counts and a Tenants sheet with every row and column', async () => {
    await exportTenantClassificationXlsx(summary, [
      row(),
      row({ tenant_id: 't2', tenant_name: 'Old Timer', category: 'dormant', sub_label: 'renewal_in_progress', completed_on: '2026-10-09', days_since_completion: 4, outstanding_ugx: 0, needs_review: true, review_reasons: 'More than one running Rent Plan' }),
    ], { filterText: 'All tenants', total: 2 });
    const [sum, det] = rec.sheets;
    expect(sum.name).toBe('Summary');
    expect(sum.rows.find((r) => r[0] === 'Active')).toEqual(['Active', 868, '1.5%']);
    expect(sum.rows.find((r) => r[0] === 'All tenants')).toEqual(['All tenants', 59042, '100.0%']);
    expect(det.name).toBe('Tenants');
    expect(det.headers).toEqual(DETAIL_HEADERS);
    expect(det.rows[0][3]).toBe('Active');
    expect(det.rows[0][8]).toBe(50000);
    expect(det.rows[1][4]).toBe('Renewal in progress');
    expect(det.rows[1][5]).toBe('Yes');
    expect(det.rows[1][8]).toBe('');
    expect(det.rows[1][9]).toBe('2026-10-09');
  });

  it('PDF: prints the counts, the filter and a note when rows were cut, and saves it by date', async () => {
    await generateTenantClassificationPdf(summary, [row()], { filterText: 'Dormant · Renewal in progress', total: 450 });
    const all = rec.texts.join('\n');
    expect(all).toContain('Tenant Classification Report');
    expect(all).toContain('Waiting for landlord payment');
    expect(all).toContain('Tenants: Dormant · Renewal in progress');
    expect(all).toContain('Showing the first 1 of 450');
    expect(rec.saved[0]).toMatch(/^tenant-classification-\d{4}-\d{2}-\d{2}\.pdf$/);
  });
});
