// One-click export of tenant receivables by the approved Uganda location
// hierarchy (region -> district -> town/sub-county -> village) with the
// drill-down totals at every level. Read-only: it only calls the existing
// reporting RPC get_tenant_receivables_location_breakdown.

import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import type {
  TenantReceivablesLevel,
  TenantReceivablesLocationBreakdown,
  TenantReceivablesLocationRow,
} from '@/hooks/useReceivables';

type RpcFn = (
  fn: string,
  args: Record<string, unknown>
) => Promise<{ data: unknown; error: { message: string } | null }>;

const UNMAPPED = 'Unmapped';

export interface ReceivablesExportRow {
  level: TenantReceivablesLevel;
  region: string;
  district: string;
  town: string;
  village: string;
  outstanding: number;
  tenantCount: number;
  itemCount: number;
  scheduledAmount: number;
  projectedAmount: number;
  fullyMapped: boolean;
}

export interface ReceivablesExportData {
  asAt: string;
  total: number;
  tenantCount: number;
  itemCount: number;
  unmappedAmount: number;
  rows: ReceivablesExportRow[];
  source: string;
}

async function fetchLevel(args: {
  level: TenantReceivablesLevel;
  region?: string | null;
  districtId?: number | null;
  subcountyId?: number | null;
  productKey?: string | null;
}): Promise<TenantReceivablesLocationBreakdown> {
  const { data, error } = await (supabase.rpc as unknown as RpcFn)(
    'get_tenant_receivables_location_breakdown',
    {
      p_level: args.level,
      p_region: args.region ?? null,
      p_district_id: args.districtId ?? null,
      p_subcounty_id: args.subcountyId ?? null,
      p_product_key: args.productKey ?? null,
    }
  );
  if (error) throw new Error(error.message);
  return data as TenantReceivablesLocationBreakdown;
}

/** Walk the whole hierarchy, collecting a flat row per level entry. */
export async function collectReceivablesByLocation(
  productKey: string | null = null,
  onProgress?: (label: string) => void
): Promise<ReceivablesExportData> {
  const rows: ReceivablesExportRow[] = [];
  onProgress?.('Regions…');
  const regions = await fetchLevel({ level: 'region', productKey });

  const push = (
    level: TenantReceivablesLevel,
    r: TenantReceivablesLocationRow,
    ctx: { region?: string; district?: string; town?: string }
  ) => {
    rows.push({
      level,
      region: ctx.region ?? (level === 'region' ? r.label : ''),
      district: ctx.district ?? (level === 'district' ? r.label : ''),
      town: ctx.town ?? (level === 'subcounty' ? r.label : ''),
      village: level === 'village' ? r.label : '',
      outstanding: Number(r.outstanding) || 0,
      tenantCount: Number(r.tenant_count) || 0,
      itemCount: Number(r.item_count) || 0,
      scheduledAmount: Number(r.scheduled_amount) || 0,
      projectedAmount: Number(r.projected_amount) || 0,
      fullyMapped: !!r.fully_mapped,
    });
  };

  for (const regionRow of regions.rows ?? []) {
    push('region', regionRow, { region: regionRow.label });
    if (regionRow.label === UNMAPPED) continue;
    onProgress?.(`${regionRow.label} — districts…`);
    const districts = await fetchLevel({
      level: 'district',
      region: regionRow.label,
      productKey,
    });
    for (const districtRow of districts.rows ?? []) {
      push('district', districtRow, {
        region: regionRow.label,
        district: districtRow.label,
      });
      if (districtRow.label === UNMAPPED || districtRow.district_id == null) continue;
      const towns = await fetchLevel({
        level: 'subcounty',
        region: regionRow.label,
        districtId: districtRow.district_id,
        productKey,
      });
      for (const townRow of towns.rows ?? []) {
        push('subcounty', townRow, {
          region: regionRow.label,
          district: districtRow.label,
          town: townRow.label,
        });
        if (townRow.label === UNMAPPED || townRow.subcounty_id == null) continue;
        const villages = await fetchLevel({
          level: 'village',
          region: regionRow.label,
          districtId: districtRow.district_id,
          subcountyId: townRow.subcounty_id,
          productKey,
        });
        for (const villageRow of villages.rows ?? []) {
          push('village', villageRow, {
            region: regionRow.label,
            district: districtRow.label,
            town: townRow.label,
          });
        }
      }
    }
  }

  return {
    asAt: regions.as_at,
    total: Number(regions.total) || 0,
    tenantCount: Number(regions.tenant_count) || 0,
    itemCount: Number(regions.item_count) || 0,
    unmappedAmount: Number(regions.unmapped_amount) || 0,
    rows,
    source: regions.source,
  };
}

const LEVEL_LABEL: Record<TenantReceivablesLevel, string> = {
  region: 'Region',
  district: 'District',
  subcounty: 'Town / sub-county',
  village: 'Village',
};

function csvCell(v: string | number): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Bulk export of every tenant's receivables across the whole location
// hierarchy in one file -- logged once here for both formats. Plain
// client-side insert so the audit_logs IP-capture trigger sees the real
// browser IP directly. Never blocks the actual download.
async function logReceivablesExport(format: 'csv' | 'pdf', data: ReceivablesExportData) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('audit_logs').insert({
      user_id: user?.id ?? null,
      action_type: 'receivables_by_location_exported',
      table_name: 'export',
      record_id: null,
      metadata: { format, row_count: data.rows.length, tenant_count: data.tenantCount, total: data.total },
    });
  } catch (e) {
    console.warn('[exportReceivablesByLocation] audit log insert failed:', e);
  }
}

export function downloadReceivablesCsv(data: ReceivablesExportData) {
  const header = [
    'Level',
    'Region',
    'District',
    'Town / sub-county',
    'Village',
    'Outstanding (UGX)',
    'Tenants',
    'Items',
    'Scheduled (UGX)',
    'Projected (UGX)',
    'Fully mapped',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const r of data.rows) {
    lines.push(
      [
        LEVEL_LABEL[r.level],
        r.region,
        r.district,
        r.town,
        r.village,
        r.outstanding,
        r.tenantCount,
        r.itemCount,
        r.scheduledAmount,
        r.projectedAmount,
        r.fullyMapped ? 'Yes' : 'No',
      ]
        .map(csvCell)
        .join(',')
    );
  }
  lines.push('');
  lines.push(['Total outstanding (UGX)', data.total].map(csvCell).join(','));
  lines.push(['Tenants', data.tenantCount].map(csvCell).join(','));
  lines.push(['Items', data.itemCount].map(csvCell).join(','));
  lines.push(['Unplaced (UGX)', data.unmappedAmount].map(csvCell).join(','));
  lines.push(['As at', data.asAt ?? ''].map(csvCell).join(','));
  lines.push(['Source', data.source ?? ''].map(csvCell).join(','));

  const stamp = format(new Date(), 'yyyy-MM-dd_HHmm');
  download(
    new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' }),
    `Welile_Receivables_by_Location_${stamp}.csv`
  );
  void logReceivablesExport('csv', data);
}

export async function downloadReceivablesPdf(data: ReceivablesExportData) {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 10;

  try {
    doc.addImage(welileLogoUrl, 'PNG', margin, 7, 14, 14);
  } catch {
    /* logo optional */
  }
  doc.setFontSize(14);
  doc.setTextColor(108, 33, 196);
  doc.text('Tenant receivables by location', margin + 18, 14);
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(
    `Region › District › Town / sub-county › Village · As at ${
      data.asAt ? format(new Date(data.asAt), 'dd MMM yyyy HH:mm') : format(new Date(), 'dd MMM yyyy HH:mm')
    }`,
    margin + 18,
    19
  );
  doc.text(
    `Total outstanding ${formatUGX(data.total)} · ${data.tenantCount} tenants · ${data.itemCount} items · Unplaced ${formatUGX(
      data.unmappedAmount
    )}`,
    margin + 18,
    23.5
  );

  autoTable(doc, {
    startY: 28,
    margin: { left: margin, right: margin },
    head: [
      [
        'Level',
        'Region',
        'District',
        'Town / sub-county',
        'Village',
        'Outstanding',
        'Tenants',
        'Items',
        'Scheduled',
        'Projected',
      ],
    ],
    body: data.rows.map((r) => [
      LEVEL_LABEL[r.level],
      r.region,
      r.district,
      r.town,
      r.village,
      formatUGX(r.outstanding),
      String(r.tenantCount),
      String(r.itemCount),
      formatUGX(r.scheduledAmount),
      formatUGX(r.projectedAmount),
    ]),
    styles: { fontSize: 7, cellPadding: 1.4 },
    headStyles: { fillColor: [108, 33, 196], textColor: 255, fontSize: 7 },
    alternateRowStyles: { fillColor: [243, 238, 252] },
    columnStyles: {
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right' },
      8: { halign: 'right' },
      9: { halign: 'right' },
    },
    didDrawPage: () => {
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.text(
        data.source ? `Source: ${data.source}` : 'Welile — read-only reporting extract',
        margin,
        doc.internal.pageSize.getHeight() - 6
      );
      doc.text(
        `Page ${doc.getNumberOfPages()}`,
        pageWidth - margin,
        doc.internal.pageSize.getHeight() - 6,
        { align: 'right' }
      );
    },
  });

  const stamp = format(new Date(), 'yyyy-MM-dd_HHmm');
  doc.save(`Welile_Receivables_by_Location_${stamp}.pdf`);
  void logReceivablesExport('pdf', data);
}
