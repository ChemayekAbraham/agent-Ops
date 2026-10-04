import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';

const THEME_PRIMARY: [number, number, number] = [2, 132, 199]; // sky-600
const THEME_PRIMARY_DARK: [number, number, number] = [3, 105, 161]; // sky-700
const THEME_STRIPE: [number, number, number] = [235, 245, 252];

/** One existing expense record, read-only. */
export interface ExpenseReportRow {
  reference: string;
  date: string | Date;
  categoryLabel: string;
  description?: string;
  amount: number;
  status: string;
  payee?: string;
  account?: string;
}

export interface ExpenseReportSummaryRow {
  categoryLabel: string;
  count: number;
  amount: number;
}

export interface ExpenseReportFilters {
  from?: string;
  to?: string;
  category?: string;
  status?: string;
  search?: string;
  /** Human-readable reporting period, e.g. "September 2026". */
  periodLabel?: string;
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
 * Branded CFO report of the expenses already recorded in the system.
 * Purely a read-only rendering of existing records.
 */
export async function generateExpenseReportPdf(
  rows: ExpenseReportRow[],
  summary: ExpenseReportSummaryRow[],
  filters: ExpenseReportFilters = {},
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
  doc.text(
    filters.periodLabel ? `Expense Report — ${filters.periodLabel}` : 'Expense Report',
    logo ? margin + 20 : margin,
    13,
  );
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated ${format(generatedAt, 'dd MMM yyyy, HH:mm')}`, logo ? margin + 20 : margin, 20);

  let y = 37;
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  const period =
    filters.from || filters.to
      ? `Period: ${filters.periodLabel ? `${filters.periodLabel} (` : ''}${filters.from || 'earliest'} – ${filters.to || 'latest'}${filters.periodLabel ? ')' : ''}`
      : 'Period: all recorded expenses';
  doc.text(period, margin, y);
  y += 5;


  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text([
    `Category: ${filters.category && filters.category !== 'all' ? filters.category : 'all'}`,
    `Status: ${filters.status && filters.status !== 'all' ? filters.status : 'all'}`,
    `Search: ${filters.search?.trim() || 'none'}`,
  ].join('   ·   '), margin, y);
  y += 6;

  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(`${rows.length} expense record${rows.length === 1 ? '' : 's'}`, margin, y);
  doc.text(`Total expenses: ${fmtUGX(total)}`, pageWidth - margin, y, { align: 'right' });
  y += 6;

  // ── Summary by category ──
  doc.setTextColor(...THEME_PRIMARY_DARK);
  doc.setFontSize(11);
  doc.text('Summary by expense category', margin, y + 4);
  y += 6;
  doc.setDrawColor(...THEME_PRIMARY);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageWidth - margin, y);

  autoTable(doc, {
    head: [['Expense category', 'Records', 'Amount', '% of total']],
    body: summary.map((s) => [
      s.categoryLabel,
      String(s.count),
      fmtUGX(s.amount),
      total > 0 ? `${((s.amount / total) * 100).toFixed(1)}%` : '—',
    ]),
    foot: [[
      'Total',
      String(summary.reduce((a, s) => a + s.count, 0)),
      fmtUGX(summary.reduce((a, s) => a + s.amount, 0)),
      total > 0 ? '100.0%' : '—',
    ]],
    startY: y + 4,
    margin: { left: margin, right: margin },
    styles: { fontSize: 8.5, cellPadding: 2.2, valign: 'middle' },
    headStyles: { fillColor: THEME_PRIMARY_DARK, textColor: 255, fontSize: 8.5, fontStyle: 'bold' },
    footStyles: { fillColor: THEME_STRIPE, textColor: 15, fontStyle: 'bold', fontSize: 8.5 },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 70 },
      1: { cellWidth: 25, halign: 'center' },
      2: { cellWidth: 45, halign: 'right' },
      3: { cellWidth: 25, halign: 'right' },
    },
  });

  // ── Detailed expense records ──
  const afterSummary = (doc as any).lastAutoTable?.finalY || y + 20;
  let dy = afterSummary + 10;
  doc.setTextColor(...THEME_PRIMARY_DARK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Expense records', margin, dy);
  dy += 2;
  doc.setDrawColor(...THEME_PRIMARY);
  doc.line(margin, dy, pageWidth - margin, dy);
  dy += 4;

  autoTable(doc, {
    head: [['#', 'Reference', 'Date & time', 'Category', 'Details / purpose', 'Payee', 'Account', 'Status', 'Amount']],
    body: rows.map((r, i) => [
      String(i + 1),
      r.reference,
      fmtDate(r.date),
      r.categoryLabel,
      r.description || '—',
      r.payee || '—',
      r.account || '—',
      r.status,
      fmtUGX(Number(r.amount) || 0),
    ]),
    startY: dy,
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 7, cellPadding: 1.8, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: THEME_PRIMARY, textColor: 255, fontSize: 7, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 7, halign: 'right' },
      1: { cellWidth: 24 },
      2: { cellWidth: 26 },
      3: { cellWidth: 38 },
      4: { cellWidth: 'auto' },
      5: { cellWidth: 32 },
      6: { cellWidth: 24 },
      7: { cellWidth: 18 },
      8: { cellWidth: 26, halign: 'right', fontStyle: 'bold' },
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
