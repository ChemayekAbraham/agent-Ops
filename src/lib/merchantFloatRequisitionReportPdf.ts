import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';

const THEME_PRIMARY: [number, number, number] = [2, 132, 199]; // sky-600
const THEME_PRIMARY_DARK: [number, number, number] = [3, 105, 161]; // sky-700
const THEME_STRIPE: [number, number, number] = [235, 245, 252];

/** One existing merchant float requisition, read-only. */
export interface RequisitionReportRow {
  reference: string;
  createdAt: string | Date;
  requester: string;
  phone?: string;
  department?: string;
  purpose?: string;
  requestedAmount: number;
  approvedAmount?: number | null;
  status: string;
  approver?: string;
  approvedAt?: string | Date | null;
  remarks?: string;
}

export interface RequisitionReportSummaryRow {
  status: string;
  count: number;
  requested: number;
  approved: number;
}

export interface RequisitionReportFilters {
  from?: string;
  to?: string;
  status?: string;
  requester?: string;
  department?: string;
}

const fmtUGX = (n: number) =>
  `UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))}`;

const fmtDate = (d?: string | Date | null) => {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(dt.getTime()) ? '—' : format(dt, 'dd MMM yyyy, HH:mm');
};

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

/**
 * Branded CFO report of the merchant float requisitions already recorded in the
 * system. Purely a read-only rendering of existing records.
 */
export async function generateMerchantFloatRequisitionReportPdf(
  rows: RequisitionReportRow[],
  summary: RequisitionReportSummaryRow[],
  filters: RequisitionReportFilters = {},
  generatedAt: Date = new Date(),
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;
  const logo = await loadLogoBase64();

  // ── Header band ──
  doc.setFillColor(...THEME_PRIMARY);
  doc.rect(0, 0, pageWidth, 28, 'F');
  if (logo) {
    try { doc.addImage(logo, 'PNG', margin, 6, 16, 16); } catch { /* ignore */ }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('Merchant Float Requisition Report', logo ? margin + 20 : margin, 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated ${format(generatedAt, 'dd MMM yyyy, HH:mm')}`, logo ? margin + 20 : margin, 20);

  let y = 37;
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);

  const period =
    filters.from || filters.to
      ? `Period: ${filters.from || 'earliest'} – ${filters.to || 'latest'}`
      : 'Period: all recorded requisitions';
  doc.text(period, margin, y);
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const applied = [
    `Status: ${filters.status && filters.status !== 'all' ? filters.status : 'all'}`,
    `Requester: ${filters.requester?.trim() || 'all'}`,
    `Department / area: ${filters.department?.trim() || 'all'}`,
  ].join('   ·   ');
  doc.text(applied, margin, y);
  y += 6;

  const totalRequested = rows.reduce((s, r) => s + (Number(r.requestedAmount) || 0), 0);
  const totalApproved = rows.reduce((s, r) => s + (Number(r.approvedAmount) || 0), 0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(`${rows.length} requisition${rows.length === 1 ? '' : 's'}`, margin, y);
  doc.text(
    `Total requested: ${fmtUGX(totalRequested)}    Total approved: ${fmtUGX(totalApproved)}`,
    pageWidth - margin,
    y,
    { align: 'right' },
  );
  y += 6;

  // ── Summary by status ──
  doc.setTextColor(...THEME_PRIMARY_DARK);
  doc.setFontSize(11);
  doc.text('Summary by approval status', margin, y + 4);
  y += 6;
  doc.setDrawColor(...THEME_PRIMARY);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageWidth - margin, y);

  autoTable(doc, {
    head: [['Status', 'Requisitions', 'Amount Requested', 'Amount Approved']],
    body: summary.map((s) => [s.status, String(s.count), fmtUGX(s.requested), fmtUGX(s.approved)]),
    foot: [[
      'Total',
      String(summary.reduce((a, s) => a + s.count, 0)),
      fmtUGX(summary.reduce((a, s) => a + s.requested, 0)),
      fmtUGX(summary.reduce((a, s) => a + s.approved, 0)),
    ]],
    startY: y + 4,
    margin: { left: margin, right: margin },
    styles: { fontSize: 8.5, cellPadding: 2.2, valign: 'middle' },
    headStyles: { fillColor: THEME_PRIMARY_DARK, textColor: 255, fontSize: 8.5, fontStyle: 'bold' },
    footStyles: { fillColor: THEME_STRIPE, textColor: 15, fontStyle: 'bold', fontSize: 8.5 },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 45 },
      1: { cellWidth: 30, halign: 'center' },
      2: { cellWidth: 45, halign: 'right' },
      3: { cellWidth: 45, halign: 'right' },
    },
  });

  // ── Detailed requisition records ──
  const afterSummary = (doc as any).lastAutoTable?.finalY || y + 20;
  let dy = afterSummary + 10;
  doc.setTextColor(...THEME_PRIMARY_DARK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Requisition records', margin, dy);
  dy += 2;
  doc.setDrawColor(...THEME_PRIMARY);
  doc.line(margin, dy, pageWidth - margin, dy);
  dy += 4;

  autoTable(doc, {
    head: [[
      '#', 'Reference', 'Date & time', 'Requester', 'Dept / area', 'Purpose',
      'Requested', 'Approved', 'Status', 'Approver', 'Approved on', 'Remarks',
    ]],
    body: rows.map((r, i) => [
      String(i + 1),
      r.reference,
      fmtDate(r.createdAt),
      r.phone ? `${r.requester}\n${r.phone}` : r.requester,
      r.department || '—',
      r.purpose || '—',
      fmtUGX(Number(r.requestedAmount) || 0),
      r.approvedAmount != null ? fmtUGX(Number(r.approvedAmount)) : '—',
      r.status,
      r.approver || '—',
      fmtDate(r.approvedAt),
      r.remarks || '—',
    ]),
    startY: dy,
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 7, cellPadding: 1.8, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: THEME_PRIMARY, textColor: 255, fontSize: 7, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 7, halign: 'right' },
      1: { cellWidth: 22 },
      2: { cellWidth: 26 },
      3: { cellWidth: 32 },
      4: { cellWidth: 22 },
      5: { cellWidth: 'auto' },
      6: { cellWidth: 24, halign: 'right', fontStyle: 'bold' },
      7: { cellWidth: 24, halign: 'right' },
      8: { cellWidth: 17 },
      9: { cellWidth: 26 },
      10: { cellWidth: 26 },
      11: { cellWidth: 34 },
    },
  });

  // ── Footer ──
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const ph = doc.internal.pageSize.getHeight();
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text('Powered by Welile — confidential treasury report', margin, ph - 6);
    doc.text(`Page ${p} / ${pageCount}`, pageWidth - margin, ph - 6, { align: 'right' });
  }

  return doc.output('blob');
}
