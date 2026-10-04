import type { TenantLeaf } from '@/hooks/useTenantLocationBreakdown';

export type TimeWindowKey = 'all' | '24h' | '7d' | '30d' | '90d' | 'custom';

export type RentBandKey =
  | 'any'
  | 'lt500k'
  | '500k_1m'
  | '1m_3m'
  | '3m_10m'
  | 'gte10m';

export type LinkBandKey = 'any' | 'linked' | 'pending';
export type PhotosBandKey = 'any' | 'with' | 'without';
export type OutstandingKey = 'any' | 'paid_up' | 'partial' | 'overdue' | 'defaulted';
export type VerificationKey = 'any' | 'verified' | 'pending' | 'missing';
export type FundingSourceKey = 'any' | 'supporter' | 'platform';

export type LeafSortKey =
  | 'name_asc'
  | 'rent_desc'
  | 'rent_asc'
  | 'funded_desc'
  | 'funded_amount_desc';

export interface TenantOpsFilters {
  timeWindow: TimeWindowKey;
  customFrom?: string | null; // ISO date
  customUntil?: string | null;
  rentBand: RentBandKey;
  linkBand: LinkBandKey;
  photosBand: PhotosBandKey;
  outstanding: OutstandingKey;
  verification: VerificationKey;
  fundingSource: FundingSourceKey;
  sort: LeafSortKey;
}

export const DEFAULT_FILTERS: TenantOpsFilters = {
  timeWindow: 'all',
  rentBand: 'any',
  linkBand: 'any',
  photosBand: 'any',
  outstanding: 'any',
  verification: 'any',
  fundingSource: 'any',
  sort: 'name_asc',
};

export function timeWindowToISO(
  key: TimeWindowKey,
  custom?: { from?: string | null; until?: string | null },
): { fundedSince: string | null; fundedUntil: string | null } {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  switch (key) {
    case '24h': return { fundedSince: new Date(now - 24 * hour).toISOString(), fundedUntil: null };
    case '7d':  return { fundedSince: new Date(now - 7 * day).toISOString(),  fundedUntil: null };
    case '30d': return { fundedSince: new Date(now - 30 * day).toISOString(), fundedUntil: null };
    case '90d': return { fundedSince: new Date(now - 90 * day).toISOString(), fundedUntil: null };
    case 'custom':
      return {
        fundedSince: custom?.from ?? null,
        fundedUntil: custom?.until ?? null,
      };
    default: return { fundedSince: null, fundedUntil: null };
  }
}

export const RENT_BANDS: { key: RentBandKey; label: string; min: number; max: number | null }[] = [
  { key: 'any',     label: 'Any rent',     min: 0,        max: null },
  { key: 'lt500k',  label: '< 500K',        min: 0,        max: 500_000 },
  { key: '500k_1m', label: '500K–1M',       min: 500_000,  max: 1_000_000 },
  { key: '1m_3m',   label: '1M–3M',         min: 1_000_000, max: 3_000_000 },
  { key: '3m_10m',  label: '3M–10M',        min: 3_000_000, max: 10_000_000 },
  { key: 'gte10m',  label: '10M+',          min: 10_000_000, max: null },
];

export function isFiltersActive(f: TenantOpsFilters): boolean {
  return (
    f.timeWindow !== 'all' ||
    f.rentBand !== 'any' ||
    f.linkBand !== 'any' ||
    f.photosBand !== 'any' ||
    f.outstanding !== 'any' ||
    f.verification !== 'any' ||
    f.fundingSource !== 'any'
  );
}

/** Applies the client-side portion (rent band / link / photos / sort) to a list. */
export function applyLeafFilters(rows: TenantLeaf[], f: TenantOpsFilters): TenantLeaf[] {
  const band = RENT_BANDS.find((b) => b.key === f.rentBand) ?? RENT_BANDS[0];
  let out = rows.filter((r) => {
    const rent = Number(r.rent_amount ?? 0);
    if (band.key !== 'any') {
      if (rent < band.min) return false;
      if (band.max !== null && rent >= band.max) return false;
    }
    if (f.linkBand === 'linked'  && !r.landlord_id) return false;
    if (f.linkBand === 'pending' &&  r.landlord_id) return false;
    const hasPhotos = (r.house_image_urls ?? []).some(Boolean);
    if (f.photosBand === 'with'    && !hasPhotos) return false;
    if (f.photosBand === 'without' &&  hasPhotos) return false;
    if (f.outstanding   !== 'any' && (r.outstanding_status   ?? null) !== f.outstanding)   return false;
    if (f.verification  !== 'any' && (r.verification_status  ?? null) !== f.verification)  return false;
    if (f.fundingSource !== 'any' && (r.funding_source       ?? null) !== f.fundingSource) return false;
    return true;
  });
  out = [...out].sort((a, b) => {
    switch (f.sort) {
      case 'rent_desc':         return Number(b.rent_amount ?? 0) - Number(a.rent_amount ?? 0);
      case 'rent_asc':          return Number(a.rent_amount ?? 0) - Number(b.rent_amount ?? 0);
      case 'funded_desc':       return (b.landlord_funded_at ?? '').localeCompare(a.landlord_funded_at ?? '');
      case 'funded_amount_desc':return Number(b.landlord_funded_amount ?? 0) - Number(a.landlord_funded_amount ?? 0);
      default:                  return (a.tenant_name ?? '').localeCompare(b.tenant_name ?? '');
    }
  });
  return out;
}

// ---------- Saved presets (localStorage) ----------

const PRESET_KEY = 'tenantOps.presets.v1';

export interface TenantOpsPreset {
  id: string;
  name: string;
  filters: TenantOpsFilters;
  createdAt: string;
}

export function loadPresets(): TenantOpsPreset[] {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch { return []; }
}

export function savePreset(name: string, filters: TenantOpsFilters): TenantOpsPreset[] {
  const current = loadPresets();
  const next: TenantOpsPreset = {
    id: `p_${Date.now().toString(36)}`,
    name: name.trim().slice(0, 40) || 'Untitled',
    filters,
    createdAt: new Date().toISOString(),
  };
  const updated = [next, ...current].slice(0, 5);
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
  return updated;
}

export function deletePreset(id: string): TenantOpsPreset[] {
  const updated = loadPresets().filter((p) => p.id !== id);
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
  return updated;
}

export function exportLeafToCSV(rows: TenantLeaf[]): string {
  const headers = [
    'tenant_name','tenant_phone','country','region','district','ward',
    'agent_name','landlord_name','rent_amount','landlord_funded_at',
    'landlord_funded_amount','landlord_payout_count',
    'outstanding_status','verification_status','funding_source',
  ];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.tenant_name, r.tenant_phone, r.country, r.region, r.district, r.ward,
      r.agent_name, r.landlord_name, r.rent_amount,
      r.landlord_funded_at, r.landlord_funded_amount, r.landlord_payout_count,
      r.outstanding_status, r.verification_status, r.funding_source,
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

export function downloadCSV(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fmtUGX = (n: number | null | undefined) =>
  n == null ? '' : `UGX ${Number(n).toLocaleString('en-UG')}`;
const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toISOString().slice(0, 10) : '';

export async function exportLeafToPDF(
  rows: TenantLeaf[],
  meta: { title?: string; subtitle?: string } = {},
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default ?? autoTableMod;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });

  const title = meta.title ?? 'Tenants whose Landlords were Funded';
  doc.setFontSize(14); doc.text(title, 14, 14);
  doc.setFontSize(9); doc.setTextColor(100);
  const sub = `${meta.subtitle ?? ''} · ${rows.length} tenants · generated ${new Date().toLocaleString('en-UG')}`;
  doc.text(sub.trim().replace(/^·\s*/, ''), 14, 20);

  const totalFunded = rows.reduce((s, r) => s + Number(r.landlord_funded_amount ?? 0), 0);
  const totalPayouts = rows.reduce((s, r) => s + Number(r.landlord_payout_count ?? 0), 0);
  doc.setTextColor(0);
  doc.text(`Total funded: ${fmtUGX(totalFunded)}   ·   Total payouts: ${totalPayouts}`, 14, 26);

  autoTable(doc, {
    startY: 30,
    head: [[
      'Tenant', 'Phone', 'Location', 'Landlord', 'Agent', 'Rent',
      'Funded on', 'Funded amount', 'Payouts', 'Verification', 'Outstanding', 'Source',
    ]],
    body: rows.map((r) => [
      r.tenant_name ?? '',
      r.tenant_phone ?? '',
      [r.ward, r.district, r.region].filter(Boolean).join(', '),
      r.landlord_name ?? '—',
      r.agent_name ?? '—',
      fmtUGX(r.rent_amount),
      fmtDate(r.landlord_funded_at),
      fmtUGX(r.landlord_funded_amount),
      r.landlord_payout_count ?? 0,
      r.verification_status ?? '—',
      r.outstanding_status ?? '—',
      r.funding_source ?? '—',
    ]),
    styles: { fontSize: 7, cellPadding: 1.5, overflow: 'linebreak' },
    headStyles: { fillColor: [88, 28, 135], textColor: 255 },
    alternateRowStyles: { fillColor: [248, 245, 252] },
    margin: { left: 8, right: 8 },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  doc.save(`tenants-funded-${stamp}.pdf`);
}