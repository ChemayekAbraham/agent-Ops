import { formatUGX } from '@/lib/rentCalculations';

export interface PromissoryNoteReportRow {
  partner_name?: string | null;
  amount?: number | null;
  status?: string | null;
  created_at?: string | null;
  recorded_on?: string | null;
  fulfilment_due_on?: string | null;
  phone_number?: string | null;
  whatsapp_number?: string | null;
  email?: string | null;
  contribution_type?: string | null;
  total_collected?: number | null;
}

export interface PromissoryNoteReportMeta {
  generatedByName?: string | null;
  generatedByEmail?: string | null;
}

function fmtDate(d?: string | null): string {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Promissory Notes report — every recorded note with the date it was taken,
 * the promised fulfilment date, the partner name and their contact details.
 */
export async function downloadPromissoryNotesReportPdf(
  rows: PromissoryNoteReportRow[],
  meta: PromissoryNoteReportMeta = {},
): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;

  // Header band
  doc.setFillColor(146, 52, 234);
  doc.rect(0, 0, pageWidth, 20, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('WELILE', margin, 9);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text('Promissory Notes Report', margin, 15);
  doc.setFontSize(8);
  doc.text(`Generated: ${new Date().toLocaleString('en-GB')}`, pageWidth - margin, 9, { align: 'right' });
  if (meta.generatedByName) {
    doc.text(
      `By: ${meta.generatedByName}${meta.generatedByEmail ? ` (${meta.generatedByEmail})` : ''}`,
      pageWidth - margin,
      15,
      { align: 'right' },
    );
  }

  doc.setTextColor(0, 0, 0);

  const sorted = [...rows].sort((a, b) => {
    const av = new Date(a.recorded_on || a.created_at || 0).getTime();
    const bv = new Date(b.recorded_on || b.created_at || 0).getTime();
    return av - bv;
  });

  const totalPromised = sorted.reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalCollected = sorted.reduce((s, r) => s + Number(r.total_collected || 0), 0);

  autoTable(doc, {
    startY: 26,
    head: [['Notes recorded', 'Total promised', 'Collected so far']],
    body: [[String(sorted.length), formatUGX(totalPromised), formatUGX(totalCollected)]],
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: [243, 238, 252], textColor: [60, 30, 100], fontStyle: 'bold' },
    margin: { left: margin, right: margin },
  });

  const afterSummary = (doc as any).lastAutoTable?.finalY ?? 34;

  autoTable(doc, {
    startY: afterSummary + 6,
    head: [['#', 'Partner', 'Date taken', 'Promised on', 'Type', 'Amount', 'Collected', 'Status', 'Phone', 'WhatsApp', 'Email']],
    body: sorted.map((r, i) => [
      String(i + 1),
      r.partner_name || '—',
      fmtDate(r.recorded_on || r.created_at),
      fmtDate(r.fulfilment_due_on),
      r.contribution_type === 'monthly' ? 'Monthly' : 'Once-off',
      formatUGX(Number(r.amount || 0)),
      formatUGX(Number(r.total_collected || 0)),
      r.status || 'pending',
      r.phone_number || '—',
      r.whatsapp_number || '—',
      r.email || '—',
    ]),
    foot: [[
      '', 'TOTAL', '', '', '',
      formatUGX(totalPromised),
      formatUGX(totalCollected),
      '', '', '', '',
    ]],
    theme: 'striped',
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: [146, 52, 234], textColor: [255, 255, 255], fontStyle: 'bold' },
    footStyles: { fillColor: [243, 238, 252], textColor: [60, 30, 100], fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 8 },
      1: { cellWidth: 38 },
      2: { cellWidth: 24 },
      3: { cellWidth: 24 },
      4: { cellWidth: 18 },
      5: { cellWidth: 26, halign: 'right' },
      6: { cellWidth: 26, halign: 'right' },
      7: { cellWidth: 20 },
      8: { cellWidth: 26 },
      9: { cellWidth: 26 },
      10: { cellWidth: 'auto' },
    },
    margin: { left: margin, right: margin },
    didDrawPage: () => {
      const page = (doc as any).internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(120, 120, 120);
      doc.text(`Page ${page}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
      doc.text('Welile — Promissory Notes Report', margin, pageHeight - 6);
      doc.setTextColor(0, 0, 0);
    },
  });

  doc.save(`Promissory_Notes_Report_${new Date().toISOString().slice(0, 10)}.pdf`);
}
