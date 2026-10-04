import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';

const THEME_PRIMARY: [number, number, number] = [108, 33, 196];
const THEME_STRIPE: [number, number, number] = [243, 238, 252];
const POSITIVE: [number, number, number] = [5, 150, 105];
const NEGATIVE: [number, number, number] = [220, 38, 38];

export interface LedgerTrailPdfRow {
  date: string | Date;
  movement: string;
  isOut: boolean;
  amount: number;
  party?: string;
  reference?: string;
  classification?: string;
  description?: string;
}

export interface LedgerTrailPdfMeta {
  /** Preformatted display strings, identical to what the dashboard UI shows. */
  categoryText?: string;
  dateRangeText?: string;
  searchText?: string;
}

const fmtUGX = (n: number) =>
  new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', maximumFractionDigits: 0 }).format(n);

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
 * Branded PDF of the ledger-derived CFO Actions Trail, reflecting the filters
 * currently applied in the UI.
 */
export async function generateCfoLedgerTrailPdf(
  rows: LedgerTrailPdfRow[],
  meta: LedgerTrailPdfMeta = {},
  generatedAt: Date = new Date(),
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;

  const logo = await loadLogoBase64();

  // Header band
  doc.setFillColor(...THEME_PRIMARY);
  doc.rect(0, 0, pageWidth, 30, 'F');
  if (logo) {
    try { doc.addImage(logo, 'PNG', margin, 7, 16, 16); } catch { /* ignore */ }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('CFO Actions Trail', logo ? margin + 20 : margin, 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated ${format(generatedAt, 'dd MMM yyyy, HH:mm')}`, logo ? margin + 20 : margin, 21);

  // Filter summary
  let y = 40;
  doc.setTextColor(15, 23, 42);

  // Always print the three active filters so the file is self-describing.
  // These strings come preformatted from the UI so they match it exactly.
  const filterLines: [string, string][] = [
    ['Category Filter', meta.categoryText || 'All Movements'],
    ['Date Range', meta.dateRangeText || 'All dates'],
    ['Search Terms', meta.searchText || 'None'],
  ];
  doc.setFontSize(9);
  for (const [label, value] of filterLines) {
    doc.setFont('helvetica', 'bold');
    doc.text(`${label}:`, margin, y);
    doc.setFont('helvetica', 'normal');
    doc.text(value, margin + 30, y);
    y += 5;
  }
  y += 1;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);

  const totalIn = rows.filter((r) => !r.isOut).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const totalOut = rows.filter((r) => r.isOut).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  doc.text(`${rows.length} movement${rows.length === 1 ? '' : 's'}`, margin, y);
  doc.setTextColor(...POSITIVE);
  doc.text(`In: ${fmtUGX(totalIn)}`, pageWidth - margin - 50, y, { align: 'right' });
  doc.setTextColor(...NEGATIVE);
  doc.text(`Out: ${fmtUGX(totalOut)}`, pageWidth - margin, y, { align: 'right' });
  y += 4;

  const head = [['#', 'Date', 'Movement', 'Party', 'Reference', 'Amount']];
  const body = rows.map((r, i) => [
    String(i + 1),
    typeof r.date === 'string' ? r.date : format(r.date, 'dd MMM yyyy HH:mm'),
    r.movement || '—',
    r.party || '—',
    r.reference || '—',
    `${r.isOut ? '-' : '+'}${fmtUGX(Number(r.amount) || 0)}`,
  ]);

  autoTable(doc, {
    head,
    body,
    startY: y + 4,
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: THEME_PRIMARY, textColor: 255, fontSize: 8, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 30 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 34 },
      4: { cellWidth: 30 },
      5: { halign: 'right', fontStyle: 'bold', cellWidth: 32 },
    },
    didParseCell: (data: any) => {
      if (data.section === 'body' && data.column.index === 5) {
        const r = rows[data.row.index];
        data.cell.styles.textColor = r?.isOut ? NEGATIVE : POSITIVE;
      }
    },
  });

  // Footer
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
