import { formatUGX } from '@/lib/rentCalculations';
import welileLogoUrl from '@/assets/welile-logo.png';

export interface ProxyPayoutPdfRow {
  name: string;
  phone: string;
  destinationLabel: string;
  destinationValue: string;
  amount: number;
  status: string;
  date: string; // ISO
}

export interface ProxyPayoutPdfInput {
  agentName?: string;
  rows: ProxyPayoutPdfRow[];
  generatedAt?: Date;
}

const THEME_PRIMARY: [number, number, number] = [146, 52, 234];
const THEME_STRIPE: [number, number, number] = [245, 240, 252];

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

export async function generateProxyRecentPayoutsPdf(input: ProxyPayoutPdfInput): Promise<Blob> {
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
  doc.text('Recent Proxy Payouts', logoBase64 ? margin + 20 : margin, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(
    `${COMPANY_NAME}  |  ${COMPANY_CONTACT}`,
    logoBase64 ? margin + 20 : margin,
    18,
  );
  const meta = [
    input.agentName ? `Agent: ${input.agentName}` : null,
    `Records: ${input.rows.length}`,
    `Generated: ${generatedAt.toLocaleString('en-GB')}`,
  ].filter(Boolean).join('   ·   ');
  doc.text(meta, pageWidth - margin, 18, { align: 'right' });

  const total = input.rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  doc.setTextColor(60, 60, 60);
  doc.setFontSize(9);
  doc.text(`Total listed: ${formatUGX(total)}`, margin, 33);

  autoTable(doc, {
    startY: 37,
    margin: { left: margin, right: margin },
    head: [['#', 'Partner', 'Phone', 'Destination type', 'Destination details', 'Amount', 'Status', 'Date']],
    body: input.rows.map((r, i) => [
      String(i + 1),
      r.name || '—',
      r.phone || '—',
      r.destinationLabel || '—',
      r.destinationValue || 'Not recorded',
      formatUGX(Number(r.amount) || 0),
      statusLabel(r.status),
      fmtDate(r.date),
    ]),
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak', textColor: [40, 40, 40] },
    headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 10, halign: 'right' },
      1: { cellWidth: 45 },
      2: { cellWidth: 32 },
      3: { cellWidth: 28 },
      5: { cellWidth: 32, halign: 'right' },
      6: { cellWidth: 26 },
      7: { cellWidth: 26 },
    },
    didDrawPage: () => {
      const h = doc.internal.pageSize.getHeight();
      doc.setFontSize(7.5);
      doc.setTextColor(130, 130, 130);
      doc.text(
        'Confidential — recipient details shown in full for reconciliation purposes.',
        margin,
        h - 6,
      );
      doc.text(
        `Page ${doc.getNumberOfPages()}`,
        pageWidth - margin,
        h - 6,
        { align: 'right' },
      );
    },
  });

  return doc.output('blob');
}
