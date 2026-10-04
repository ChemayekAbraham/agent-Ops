import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';

/**
 * Audit-grade PDF export for the Landlord Ops → Agent Verification Requests
 * queue. Purely presentational: it renders whatever rows the panel currently
 * has in view (after tab / search / date filters) and never touches state.
 */
export interface VerificationQueuePdfRow {
  landlordName: string | null;
  landlordPhone: string | null;
  district: string | null;
  agentName: string | null;
  agentPhone: string | null;
  status: string;
  resubmitted: boolean;
  rejectionCount: number;
  createdAt: string;
  resolvedAt: string | null;
  comment: string | null;
}

export interface VerificationQueuePdfInput {
  tabLabel: string;
  from: string | null;
  to: string | null;
  search: string | null;
  rows: VerificationQueuePdfRow[];
  trend: { day: string; verified: number; rejected: number; created: number }[];
}

const PRIMARY: [number, number, number] = [180, 83, 9]; // amber-700
const fmtDate = (v?: string | null) => (v ? format(new Date(v), 'dd MMM yyyy HH:mm') : '—');

export function generateLandlordVerificationQueuePdf(input: VerificationQueuePdfInput): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 10;

  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pageWidth, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('Welile · Landlord Verification Requests', margin, 10);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(
    `${input.tabLabel} · generated ${format(new Date(), 'dd MMM yyyy HH:mm')}`,
    margin,
    16,
  );

  doc.setTextColor(40, 40, 40);
  let y = 29;
  const scope: string[] = [];
  if (input.from || input.to) {
    scope.push(`Date range: ${input.from ? format(new Date(input.from), 'dd MMM yyyy') : 'start'} – ${input.to ? format(new Date(input.to), 'dd MMM yyyy') : 'today'}`);
  }
  if (input.search) scope.push(`Search: "${input.search}"`);
  scope.push(`Rows: ${input.rows.length}`);
  doc.setFontSize(8.5);
  doc.text(scope.join('   |   '), margin, y);
  y += 6;

  // KPI band
  const verified = input.rows.filter((r) => r.status === 'verified').length;
  const rejected = input.rows.filter((r) => r.status === 'rejected').length;
  const pending = input.rows.filter((r) => r.status === 'pending').length;
  const cancelled = input.rows.filter((r) => r.status === 'cancelled').length;
  const resubmitted = input.rows.filter((r) => r.resubmitted).length;
  const districts = new Set(input.rows.map((r) => r.district).filter(Boolean)).size;
  const agents = new Set(input.rows.map((r) => r.agentName).filter(Boolean)).size;

  const kpis: [string, string][] = [
    ['Total in view', String(input.rows.length)],
    ['Pending', String(pending)],
    ['Verified', String(verified)],
    ['Rejected', String(rejected)],
    ['Cancelled', String(cancelled)],
    ['Resubmitted', String(resubmitted)],
    ['Districts', String(districts)],
    ['Agents', String(agents)],
  ];
  const cardW = (pageWidth - margin * 2 - 7 * 2) / 8;
  kpis.forEach(([label, value], i) => {
    const x = margin + i * (cardW + 2);
    doc.setFillColor(253, 246, 236);
    doc.setDrawColor(...PRIMARY);
    doc.roundedRect(x, y, cardW, 14, 1.5, 1.5, 'FD');
    doc.setFontSize(6.5);
    doc.setTextColor(120, 113, 108);
    doc.text(label.toUpperCase(), x + 2, y + 5);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 30, 30);
    doc.text(value, x + 2, y + 11.5);
    doc.setFont('helvetica', 'normal');
  });
  y += 20;

  // Trend table (daily activity — the chart shown on screen, in tabular form)
  if (input.trend.length > 0) {
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 30, 30);
    doc.text('Daily activity', margin, y);
    y += 2;
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Day', 'Requests created', 'Verified', 'Rejected']],
      body: input.trend.map((t) => [
        format(new Date(t.day), 'dd MMM'),
        String(t.created),
        String(t.verified),
        String(t.rejected),
      ]),
      styles: { fontSize: 7.5, cellPadding: 1.4 },
      headStyles: { fillColor: PRIMARY, textColor: 255, fontSize: 7.5 },
      theme: 'grid',
    });
    y = (doc as any).lastAutoTable.finalY + 7;
  }

  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'bold');
  doc.text('Detailed requests', margin, y);
  y += 2;

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Landlord', 'Phone', 'District', 'Agent', 'Agent phone', 'Status', 'Requested', 'Decided', 'Comment / reason']],
    body: input.rows.map((r) => [
      `${r.landlordName || 'Unnamed'}${r.resubmitted ? ` (resubmitted${r.rejectionCount > 1 ? ` ${r.rejectionCount}x` : ''})` : ''}`,
      r.landlordPhone || '—',
      r.district || '—',
      r.agentName || '—',
      r.agentPhone || '—',
      r.status,
      fmtDate(r.createdAt),
      fmtDate(r.resolvedAt),
      r.comment || '—',
    ]),
    styles: { fontSize: 7, cellPadding: 1.3, overflow: 'linebreak' },
    headStyles: { fillColor: PRIMARY, textColor: 255, fontSize: 7 },
    columnStyles: {
      0: { cellWidth: 36 },
      1: { cellWidth: 22 },
      2: { cellWidth: 22 },
      3: { cellWidth: 32 },
      4: { cellWidth: 22 },
      5: { cellWidth: 18 },
      6: { cellWidth: 26 },
      7: { cellWidth: 26 },
      8: { cellWidth: 'auto' },
    },
    theme: 'striped',
    didDrawPage: () => {
      const h = doc.internal.pageSize.getHeight();
      doc.setFontSize(7);
      doc.setTextColor(140, 140, 140);
      doc.text('Welile · Landlord Ops verification audit trail', margin, h - 5);
    },
  });

  return doc;
}
