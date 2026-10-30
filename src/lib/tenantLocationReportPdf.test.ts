import { describe, expect, it, vi } from 'vitest';

const drawn = vi.hoisted(() => ({ texts: [] as string[] }));

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

vi.mock('jspdf', async (importOriginal) => {
  const mod = await importOriginal<typeof import('jspdf')>();
  const Base = mod.default as unknown as new (...args: unknown[]) => Record<string, (...a: unknown[]) => unknown>;
  class Recording extends Base {
    constructor(...args: unknown[]) {
      super(...args);
      const text = this.text.bind(this);
      this.text = (t: unknown, ...rest: unknown[]) => {
        drawn.texts.push(Array.isArray(t) ? t.join(' ') : String(t));
        return text(t, ...rest);
      };
    }
  }
  return { ...mod, default: Recording, jsPDF: Recording };
});

import { buildTenantLocationPdf, kampalaStamp, pdfText, statusWords, tenantLocationPdfFilename } from './tenantLocationReportPdf';
import { TlbTooManyTenantsError } from './tenantLocationSelection';
import { placeFromPath, type TlbMultiTenant } from '@/hooks/useTenantLocationsBrowser';

const kampala = placeFromPath({ region: 'Central', districtId: 7, districtName: 'Kampala' });
const kisenyi = placeFromPath({ region: 'Central', districtId: 7, districtName: 'Kampala', villageId: 9, villageName: 'Kisenyi' });

const row = (id: string, idx: number, active: boolean, status = 'funded'): TlbMultiTenant => ({
  tenant_id: id, tenant_name: `Tenant ${id}`, tenant_phone: '0700123456', agent_id: null, agent_name: 'Agent A',
  latest_status: status, is_active: active, depth: 2, region: 'Central', district_name: 'Kampala', county_name: null,
  subcounty_name: null, parish_name: null, village_name: null, legacy_location: null, matched_path_index: idx, total_count: 0,
});

const NOW = new Date('2026-10-30T11:05:00Z'); // 14:05 in Kampala

describe('tenant location PDF', () => {
  const rows = [row('a', 0, true), row('b', 0, false, 'rent_plan_rejected'), row('c', 1, true), row('d', 1, true)];

  it('summary totals equal the combined list totals', () => {
    drawn.texts.length = 0;
    const built = buildTenantLocationPdf({ places: [kampala, kisenyi], rows, total: rows.length, status: 'all', generatedBy: 'Ops Manager', now: NOW });
    expect(built.report.grand).toEqual({ total: 4, active: 3, inactive: 1 });
    expect(built.report.sections.reduce((n, s) => n + s.total, 0)).toBe(rows.length);
    const text = drawn.texts.join('\n');
    expect(text).toContain('Grand total');
    // grand row: total, active, inactive as drawn in the summary table
    expect(text).toMatch(/Grand total[\s\S]*\n4\n3\n1/);
    expect(built.pages).toBe(3); // summary + one section per place
  });

  it('shows the header facts: Kampala time, who made it, filter, confidentiality, Rent Plan wording', () => {
    drawn.texts.length = 0;
    buildTenantLocationPdf({ places: [kampala], rows: [row('a', 0, false, 'rent_plan_rejected')], total: 1, status: 'inactive', generatedBy: 'Ops Manager', now: NOW });
    const text = drawn.texts.join('\n');
    expect(text).toContain('Tenant Location Report');
    expect(text).toContain('30 Oct 2026, 14:05 EAT');
    expect(text).toContain('Ops Manager');
    expect(text).toContain('Inactive only');
    expect(text).toContain('Confidential: contains personal phone numbers');
    expect(text).toContain('rent plan rejected');
    expect(text).toMatch(/Page 1 of 2/);
    expect(text).not.toMatch(/\bloan\b/i);
    expect(text).not.toMatch(/[—–]/);
  });

  it('refuses more than 5000 tenants', () => {
    expect(() => buildTenantLocationPdf({ places: [kampala], rows: [], total: 5001, status: 'all', generatedBy: 'x', now: NOW })).toThrow(TlbTooManyTenantsError);
  });

  it('names the file by first place, place count and Kampala date', () => {
    expect(tenantLocationPdfFilename([kisenyi, kampala], NOW)).toBe('Welile_Tenants_Kisenyi_2-places_2026-10-30.pdf');
    // 22:30 UTC is already the next day in Kampala
    expect(tenantLocationPdfFilename([kampala], new Date('2026-10-30T22:30:00Z'))).toBe('Welile_Tenants_Kampala_1-places_2026-10-31.pdf');
  });

  it('cleans text for the PDF font and statuses for readers', () => {
    expect(pdfText('Nakawa — Ntinda “one”')).toBe('Nakawa - Ntinda "one"');
    expect(statusWords('rent_plan_rejected')).toBe('rent plan rejected');
    expect(statusWords(null)).toBe('-');
    expect(kampalaStamp(NOW)).toBe('30 Oct 2026, 14:05 EAT');
  });
});
