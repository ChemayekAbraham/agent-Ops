import { formatUGX } from '@/lib/rentCalculations';
import welileLogoUrl from '@/assets/welile-logo.png';

export interface PartnerWithdrawalPdfRow {
  partner: string;
  /** Portfolio the money was withdrawn for — partners withdraw per portfolio. */
  portfolio?: string;
  agent: string;
  payee: string;
  method: string;
  reference: string;
  amount: number;
  status: string;
  date: string; // ISO
  note?: string;
}

export interface PartnerWithdrawalsPdfInput {
  rows: PartnerWithdrawalPdfRow[];
  searchTerm?: string;
  generatedAt?: Date;
}

const THEME_PRIMARY: [number, number, number] = [12, 74, 110];
const THEME_STRIPE: [number, number, number] = [237, 245, 250];

const COMPANY_NAME = 'Welile Technologies Limited';
const COMPANY_CONTACT = 'info@welile.com  |  www.welile.com';

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso || '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const statusLabel = (s: string) =>
  (s || '—').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

async function loadLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
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

export async function generatePartnerWithdrawalsPdf(input: PartnerWithdrawalsPdfInput): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const generatedAt = input.generatedAt || new Date();
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;

  const logoBase64 = await loadLogoBase64();

  doc.setFillColor(...THEME_PRIMARY);
  doc.rect(0, 0, pageWidth, 26, 'F');
  if (logoBase64) {
    try { doc.addImage(logoBase64, 'PNG', margin, 5, 16, 16); } catch { /* ignore */ }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('Partner & Proxy Partner Withdrawals', logoBase64 ? margin + 20 : margin, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(`${COMPANY_NAME}  |  ${COMPANY_CONTACT}`, logoBase64 ? margin + 20 : margin, 18);
  const meta = [
    input.searchTerm ? `Search: "${input.searchTerm}"` : 'All records',
    `Records: ${input.rows.length}`,
    `Generated: ${generatedAt.toLocaleString('en-GB')}`,
  ].join('   ·   ');
  doc.text(meta, pageWidth - margin, 18, { align: 'right' });

  const total = input.rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const completed = input.rows.filter((r) => r.status === 'completed');
  const completedTotal = completed.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  doc.setTextColor(60, 60, 60);
  doc.setFontSize(9);
  doc.text(
    `Total listed: ${formatUGX(total)}   ·   Completed: ${completed.length} (${formatUGX(completedTotal)})   ·   Pending: ${input.rows.length - completed.length}`,
    margin,
    33,
  );

  autoTable(doc, {
    startY: 37,
    margin: { left: margin, right: margin },
    head: [['#', 'Partner', 'Portfolio', 'Agent', 'Payee', 'Method', 'Reference', 'Amount', 'Status', 'Date']],
    body: input.rows.map((r, i) => [
      String(i + 1),
      r.partner || '—',
      r.portfolio || '—',
      r.agent || '—',
      r.payee || '—',
      r.method || '—',
      r.reference || '—',
      formatUGX(Number(r.amount) || 0),
      statusLabel(r.status),
      fmtDate(r.date),
    ]),
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak', textColor: [40, 40, 40] },
    headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 9, halign: 'right' },
      1: { cellWidth: 40 },
      2: { cellWidth: 38 },
      3: { cellWidth: 36 },
      4: { cellWidth: 34 },
      5: { cellWidth: 22 },
      6: { cellWidth: 30 },
      7: { cellWidth: 27, halign: 'right' },
      8: { cellWidth: 20 },
      9: { cellWidth: 21 },
    },
    didDrawPage: () => {
      const h = doc.internal.pageSize.getHeight();
      doc.setFontSize(7.5);
      doc.setTextColor(130, 130, 130);
      doc.text('Confidential — partner payout reconciliation record.', margin, h - 6);
      doc.text(`Page ${doc.getNumberOfPages()}`, pageWidth - margin, h - 6, { align: 'right' });
    },
  });

  return doc.output('blob');
}
