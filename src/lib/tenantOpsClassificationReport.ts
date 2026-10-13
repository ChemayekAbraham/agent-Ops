import welileLogoUrl from '@/assets/welile-logo.png';
import { savePdfWithVault } from '@/lib/pdfVault';
import { downloadXlsxWorkbook } from '@/lib/xlsxExport';
import {
  CATEGORY_LABELS,
  categoryLabel,
  formatStatus,
  subLabelText,
  type TenantCategory,
  type TenantClassificationRow,
  type TenantClassificationSummary,
} from '@/lib/tenantClassification';

/**
 * PDF + Excel exports for the Tenant Classification tab. Presentation only: every figure and label is
 * taken as given from `tops_tenant_classification_summary` / `_list`. The PDF carries the card counts
 * and up to PDF_ROW_CAP rows of the current filter; the Excel file carries every row the caller read.
 */

const PRIMARY: [number, number, number] = [79, 70, 229];
const PRIMARY_DARK: [number, number, number] = [55, 48, 163];
const STRIPE: [number, number, number] = [239, 241, 254];

/** The PDF is a read-through, not a database dump: it stops here and says so. */
export const PDF_ROW_CAP = 400;

const fmtUGX = (n: unknown) =>
  `UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))}`;
const num = (n: number) => new Intl.NumberFormat('en-US').format(n);

/** Columns left out of the PDF to fit the page (phone, district, why, latest request date); the Excel file has them all. */
const PDF_SKIP = new Set([1, 2, 6, 12]);

export const DETAIL_HEADERS = [
  'Tenant', 'Phone', 'District', 'Category', 'Detail', 'Needs review', 'Why', 'Rent Plans running / done',
  'Outstanding', 'Completed on', 'Days since completion', 'Latest request', 'Latest request on', 'Agent',
];

function summaryRows(s: TenantClassificationSummary): [string, number, string][] {
  const pct = (n: number) => (s.population > 0 ? `${((n / s.population) * 100).toFixed(1)}%` : '0.0%');
  return [
    [CATEGORY_LABELS.active, s.active, pct(s.active)],
    [CATEGORY_LABELS.waiting, s.waiting, pct(s.waiting)],
    [CATEGORY_LABELS.dormant, s.dormant, pct(s.dormant)],
    ['   of which Renewal in progress', s.dormant_renewal_in_progress, pct(s.dormant_renewal_in_progress)],
    [CATEGORY_LABELS.inactive, s.inactive, pct(s.inactive)],
    ['   of which Never requested', s.inactive_never_requested, pct(s.inactive_never_requested)],
    ['   of which Request in review', s.inactive_request_in_review, pct(s.inactive_request_in_review)],
    ['   of which Only rejected or cancelled requests', s.inactive_only_rejected_cancelled, pct(s.inactive_only_rejected_cancelled)],
    ['   of which Other, check the Rent Plan', s.inactive_other, pct(s.inactive_other)],
    ['Needs review (flag, any category)', s.needs_review, pct(s.needs_review)],
  ];
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

function detailRow(r: TenantClassificationRow): (string | number)[] {
  return [
    r.tenant_name || '-',
    r.tenant_phone || '-',
    r.district || '-',
    categoryLabel(r.category),
    subLabelText(r.sub_label) ?? '',
    r.needs_review ? 'Yes' : '',
    r.review_reasons ?? '',
    `${r.running_plans} / ${r.completed_plans}`,
    r.category === 'active' || r.category === 'waiting' ? Math.round(Number(r.outstanding_ugx) || 0) : '',
    day(r.completed_on),
    r.days_since_completion ?? '',
    formatStatus(r.latest_status),
    day(r.latest_request_at),
    r.latest_agent_name || '',
  ];
}

async function loadLogoBase64(): Promise<string | null> {
  try {
    const blob = await (await fetch(welileLogoUrl)).blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export interface ClassificationExportMeta {
  /** Which slice of the list the rows are, e.g. "Dormant · Renewal in progress". */
  filterText: string;
  /** Rows matching the filter on the server (can be more than `rows`). */
  total: number;
  generatedByUserId?: string;
}

export async function generateTenantClassificationPdf(
  summary: TenantClassificationSummary,
  rows: TenantClassificationRow[],
  meta: ClassificationExportMeta,
): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pw = doc.internal.pageSize.getWidth();
  const margin = 12;
  const logo = await loadLogoBase64();

  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pw, 26, 'F');
  if (logo) {
    try { doc.addImage(logo, 'PNG', margin, 5, 15, 15); } catch { /* ignore */ }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('Tenant Classification Report', logo ? margin + 19 : margin, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(`As of ${summary.as_of}  |  Generated ${new Date().toLocaleString('en-GB')}`, logo ? margin + 19 : margin, 18);

  let y = 34;
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  const note = doc.splitTextToSize(
    'Counted from the day after the landlord was paid. Active = repaying a Rent Plan the landlord has been paid for. ' +
    'Waiting for landlord payment = Rent Plan funded, landlord not paid yet. Dormant = finished a Rent Plan, none running. ' +
    'Inactive = never had a Rent Plan running. Needs review is a flag on top of the category.',
    pw - margin * 2,
  );
  doc.text(note, margin, y);
  y += note.length * 4 + 3;

  autoTable(doc, {
    head: [['Category', 'Tenants', '% of all tenants']],
    body: summaryRows(summary).map(([label, n, pct]) => [label, num(n), pct]),
    foot: [['All tenants', num(summary.population), '100.0%']],
    startY: y,
    margin: { left: margin, right: margin },
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: PRIMARY_DARK, textColor: 255, fontSize: 8, fontStyle: 'bold' },
    footStyles: { fillColor: STRIPE, textColor: 15, fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
  });
  y = ((doc as any).lastAutoTable?.finalY || y) + 8;

  const shown = rows.slice(0, PDF_ROW_CAP);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...PRIMARY_DARK);
  doc.text(`Tenants: ${meta.filterText}`, margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(90, 90, 90);
  doc.text(
    shown.length < meta.total
      ? `Showing the first ${num(shown.length)} of ${num(meta.total)}. The Excel export carries more.`
      : `${num(meta.total)} tenant${meta.total === 1 ? '' : 's'}`,
    margin, y + 5,
  );
  y += 8;

  autoTable(doc, {
    head: [DETAIL_HEADERS.filter((_, i) => !PDF_SKIP.has(i))],
    body: shown.map((r) => detailRow(r).map((v, i) => (i === 8 && v !== '' ? fmtUGX(v) : v)).filter((_, i) => !PDF_SKIP.has(i))),
    startY: y,
    margin: { left: margin, right: margin },
    styles: { fontSize: 7, cellPadding: 1.6, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: PRIMARY, textColor: 255, fontSize: 7, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles: { 5: { halign: 'right' }, 7: { halign: 'right' } },
  });

  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const ph = doc.internal.pageSize.getHeight();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text('Powered by Welile - Tenant Operations Workspace', margin, ph - 6);
    doc.text(`Page ${p} / ${pageCount}`, pw - margin, ph - 6, { align: 'right' });
  }

  savePdfWithVault(doc, `tenant-classification-${new Date().toISOString().slice(0, 10)}.pdf`, {
    label: 'Tenant Classification Report',
    category: 'tenant-ops',
    userId: meta.generatedByUserId,
  });
}

export async function exportTenantClassificationXlsx(
  summary: TenantClassificationSummary,
  rows: TenantClassificationRow[],
  meta: ClassificationExportMeta,
): Promise<void> {
  await downloadXlsxWorkbook(`tenant-classification-${new Date().toISOString().slice(0, 10)}.xlsx`, [
    {
      name: 'Summary',
      headers: ['Category', 'Tenants', '% of all tenants'],
      rows: [
        ...summaryRows(summary).map(([label, n, pct]) => [label.trim(), n, pct]),
        ['All tenants', summary.population, '100.0%'],
        ['As of', summary.as_of, ''],
        ['Rows below', meta.filterText, `${rows.length} of ${meta.total}`],
      ],
    },
    { name: 'Tenants', headers: DETAIL_HEADERS, rows: rows.map(detailRow) },
  ]);
}

export const CATEGORY_ORDER: TenantCategory[] = ['active', 'waiting', 'dormant', 'inactive'];
