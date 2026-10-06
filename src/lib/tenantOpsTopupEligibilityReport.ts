import welileLogoUrl from '@/assets/welile-logo.png';
import { savePdfWithVault } from '@/lib/pdfVault';
import { downloadXlsxWorkbook } from '@/lib/xlsxExport';
import { TOPUP_TIER_LABELS, type TopupEligibilityRow } from '@/hooks/useTenantTopupEligibility';

/**
 * Professional PDF + Excel exports for the Tenant Top-Up Eligibility tab
 * (`TopUpEligibilityTab` in `src/pages/tenant-ops/TenantOperationsWorkspace.tsx`).
 *
 * Presentation only — every figure here is derived by summing/counting the
 * `TopupEligibilityRow[]` the caller already has in memory. No RPC calls, no
 * re-derivation of eligibility, no threshold math. The tier classification
 * (`tier_key`) and every money figure come straight from
 * `get_tenant_topup_eligibility`.
 */

const PRIMARY: [number, number, number] = [79, 70, 229]; // indigo-600
const PRIMARY_DARK: [number, number, number] = [55, 48, 163]; // indigo-800
const STRIPE: [number, number, number] = [239, 241, 254];

const fmtUGX = (n: number) =>
  `UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))}`;

const TIER_ORDER = [
  'within_cycle',
  'within_one_month',
  'within_two_months',
  'same_amount_only',
  'beyond_two_months',
  'not_eligible',
] as const;

async function loadLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Tier counts/totals reduced client-side from the rows already in memory. */
function buildTierBreakdown(rows: TopupEligibilityRow[]) {
  const total = rows.length;
  return TIER_ORDER.map((key) => {
    const inTier = rows.filter((r) => r.tier_key === key);
    const count = inTier.length;
    const totalAccessible = inTier.reduce((s, r) => s + (Number(r.max_accessible_rent) || 0), 0);
    return {
      key,
      label: TOPUP_TIER_LABELS[key] || key,
      count,
      pct: total > 0 ? (count / total) * 100 : 0,
      totalAccessible,
    };
  });
}

function detailRow(r: TopupEligibilityRow): (string | number)[] {
  const cycle = `${r.term_start || '—'} → ${r.term_end || '—'}`;
  const nextLevel =
    r.amount_to_qualifying > 0
      ? fmtUGX(r.amount_to_qualifying)
      : r.amount_to_same_amount > 0
        ? fmtUGX(r.amount_to_same_amount)
        : 'Met';
  return [
    r.tenant_name || '—',
    r.tenant_phone || '—',
    r.agent_name || '—',
    fmtUGX(r.rent_amount),
    cycle,
    fmtUGX(r.total_amount),
    fmtUGX(r.amount_repaid),
    fmtUGX(r.outstanding),
    `${Number(r.pct_covered || 0).toFixed(1)}%`,
    TOPUP_TIER_LABELS[r.tier_key] || r.tier_key,
    fmtUGX(r.max_accessible_rent),
    nextLevel,
  ];
}

const DETAIL_HEADERS = [
  'Tenant', 'Phone', 'Agent', 'Current rent', 'Cycle', 'Total expected (full cycle)',
  'Total collected (all time)', 'Outstanding (whole plan)', '% covered (all time)', 'Eligibility', 'Max accessible', 'To next level',
];

/**
 * Branded, management-ready PDF report. Follows the house pattern from
 * `src/lib/cfoWeeklyReportPdf.ts` (header band, section()/table() helpers,
 * autoTable detail grid, page footer) with a wider landscape layout since
 * the detail table carries 12 columns.
 */
export async function generateTopupEligibilityPdf(
  rows: TopupEligibilityRow[],
  meta: { generatedByUserId?: string } = {},
): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pw = doc.internal.pageSize.getWidth();
  const margin = 12;
  const logo = await loadLogoBase64();

  // ── Header band ──
  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pw, 26, 'F');
  if (logo) {
    try { doc.addImage(logo, 'PNG', margin, 5, 15, 15); } catch { /* ignore */ }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('Tenant Top-Up Eligibility Report', logo ? margin + 19 : margin, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(`Generated ${new Date().toLocaleString('en-GB')}`, logo ? margin + 19 : margin, 18);

  let y = 34;
  doc.setTextColor(15, 23, 42);

  const total = rows.length;
  const eligible = rows.filter((r) => r.eligible).length;
  const eligiblePct = total > 0 ? Math.round((eligible / total) * 100) : 0;
  const totalAccessible = rows.reduce((s, r) => s + (Number(r.max_accessible_rent) || 0), 0);
  const totalOutstanding = rows.reduce((s, r) => s + (Number(r.outstanding) || 0), 0);
  const tierBreakdown = buildTierBreakdown(rows);

  // ── Executive summary ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...PRIMARY_DARK);
  doc.text('Executive Summary', margin, y);
  y += 2;
  doc.setDrawColor(...PRIMARY);
  doc.line(margin, y, pw - margin, y);
  y += 5;

  doc.setTextColor(30, 30, 30);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const summaryLines = doc.splitTextToSize(
    [
      `${eligible.toLocaleString()} of ${total.toLocaleString()} tenants (${eligiblePct}%) are currently eligible for a top-up, worth ${fmtUGX(totalAccessible)} in total accessible headroom.`,
      `Outstanding balances across these tenants (whole Rent Plan, all time) total ${fmtUGX(totalOutstanding)}.`,
    ].join(' '),
    pw - margin * 2,
  );
  doc.text(summaryLines, margin, y);
  y += summaryLines.length * 4.4 + 4;

  const section = (title: string, startY: number) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...PRIMARY_DARK);
    doc.text(title, margin, startY);
    doc.setDrawColor(...PRIMARY);
    doc.line(margin, startY + 2, pw - margin, startY + 2);
    doc.setTextColor(15, 23, 42);
    return startY + 6;
  };

  const table = (head: string[][], body: (string | number)[][], startY: number, foot?: (string | number)[][]) => {
    autoTable(doc, {
      head, body, foot, startY,
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak', valign: 'middle' },
      headStyles: { fillColor: PRIMARY_DARK, textColor: 255, fontSize: 8, fontStyle: 'bold' },
      footStyles: { fillColor: STRIPE, textColor: 15, fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: STRIPE },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
    });
    return ((doc as any).lastAutoTable?.finalY || startY) + 8;
  };

  // ── Tier breakdown ──
  y = section('Eligibility Tier Breakdown', y);
  y = table(
    [['Tier', 'Tenants', '% of total', 'Total accessible']],
    tierBreakdown.map((t) => [t.label, String(t.count), `${t.pct.toFixed(1)}%`, fmtUGX(t.totalAccessible)]),
    y,
    [['Total', String(total), '100.0%', fmtUGX(totalAccessible)]],
  );

  // ── Detail table (all 12 on-screen columns) ──
  y = section('Tenant Detail', y);
  autoTable(doc, {
    head: [DETAIL_HEADERS],
    body: rows.map(detailRow),
    startY: y,
    margin: { left: margin, right: margin },
    styles: { fontSize: 7, cellPadding: 1.6, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: PRIMARY, textColor: 255, fontSize: 7, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles: {
      3: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' },
      7: { halign: 'right' }, 8: { halign: 'right' }, 10: { halign: 'right' }, 11: { halign: 'right' },
    },
  });

  // ── Footer on every page ──
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const ph = doc.internal.pageSize.getHeight();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text('Powered by Welile — Tenant Operations Workspace', margin, ph - 6);
    doc.text(`Page ${p} / ${pageCount}`, pw - margin, ph - 6, { align: 'right' });
  }

  savePdfWithVault(doc, `tenant-topup-eligibility-${new Date().toISOString().slice(0, 10)}.pdf`, {
    label: 'Tenant Top-Up Eligibility Report',
    category: 'tenant-ops',
    userId: meta?.generatedByUserId,
  });
}

/**
 * Excel export via the existing `downloadXlsxWorkbook` helper — no bespoke
 * spreadsheet-writing here. 'Summary' mirrors the PDF's tier breakdown,
 * 'Details' carries every row with all 12 on-screen columns.
 */
export async function exportTopupEligibilityXlsx(rows: TopupEligibilityRow[]): Promise<void> {
  const total = rows.length;
  const eligible = rows.filter((r) => r.eligible).length;
  const totalAccessible = rows.reduce((s, r) => s + (Number(r.max_accessible_rent) || 0), 0);
  const tierBreakdown = buildTierBreakdown(rows);

  await downloadXlsxWorkbook(`tenant-topup-eligibility-${new Date().toISOString().slice(0, 10)}.xlsx`, [
    {
      name: 'Summary',
      headers: ['Tier', 'Tenants', '% of total', 'Total accessible (UGX)'],
      rows: [
        ...tierBreakdown.map((t) => [t.label, t.count, Number(t.pct.toFixed(1)), Math.round(t.totalAccessible)]),
        ['Total', total, 100, Math.round(totalAccessible)],
        ['Eligible (any level)', eligible, total > 0 ? Number(((eligible / total) * 100).toFixed(1)) : 0, ''],
      ],
    },
    {
      name: 'Details',
      headers: DETAIL_HEADERS,
      rows: rows.map((r) => {
        const cycle = `${r.term_start || '—'} → ${r.term_end || '—'}`;
        const nextLevel =
          r.amount_to_qualifying > 0
            ? Math.round(r.amount_to_qualifying)
            : r.amount_to_same_amount > 0
              ? Math.round(r.amount_to_same_amount)
              : 'Met';
        return [
          r.tenant_name || '—',
          r.tenant_phone || '—',
          r.agent_name || '—',
          Math.round(r.rent_amount || 0),
          cycle,
          Math.round(r.total_amount || 0),
          Math.round(r.amount_repaid || 0),
          Math.round(r.outstanding || 0),
          Number((r.pct_covered || 0).toFixed(1)),
          TOPUP_TIER_LABELS[r.tier_key] || r.tier_key,
          Math.round(r.max_accessible_rent || 0),
          nextLevel,
        ];
      }),
    },
  ]);
}
