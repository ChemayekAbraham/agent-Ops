import { format } from 'date-fns';
import type { RdReportProject } from '@/lib/rdGeneralReportPdf';

const PRIMARY: [number, number, number] = [108, 33, 196];
const STRIPE: [number, number, number] = [243, 238, 252];

export interface RdPeriodReportData {
  periodLabel: string;
  rangeLabel?: string;
  projects: RdReportProject[];
}

/** Focused updates-only report for one report period; content comes only from recorded updates. */
export async function downloadRdPeriodReport(d: RdPeriodReportData, at = new Date()) {
  const { default: jsPDF } = await import('jspdf');
  const m: any = await import('jspdf-autotable');
  const autoTable = m.default || m;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const mg = 12;
  const lastY = () => (doc as any).lastAutoTable?.finalY ?? 46;
  const ensure = (y: number, need = 30) => { if (y + need > 280) { doc.addPage(); return 18; } return y; };

  doc.setFillColor(...PRIMARY); doc.rect(0, 0, W, 30, 'F');
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text('R&D Updates Report', mg, 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(`Period: ${d.periodLabel}${d.rangeLabel ? ` (${d.rangeLabel})` : ''}`, mg, 19);
  doc.text(`Generated ${format(at, 'dd MMM yyyy, HH:mm')}`, mg, 25);

  let y = 38;
  for (const p of d.projects) {
    y = ensure(y);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...PRIMARY);
    doc.text(p.name, mg, y); doc.setTextColor(15, 23, 42);
    y += 3;
    const rows = p.updates.filter((u) => u.text.trim());
    autoTable(doc, {
      head: [['Date', 'Recorded update']],
      body: rows.length ? rows.map((u) => [u.date || '—', u.text]) : [['—', 'No updates recorded in this period']],
      startY: y, margin: { left: mg, right: mg, bottom: 18 },
      styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
      headStyles: { fillColor: PRIMARY, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: STRIPE },
      columnStyles: { 0: { cellWidth: 30 } },
    });
    y = lastY() + 10;
  }

  const n = (doc as any).internal.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120);
    doc.text('Welile Technologies Ltd — R&D Department', mg, 291);
    doc.text(`Page ${i} / ${n}`, W - mg, 291, { align: 'right' });
  }
  doc.save(`rd-updates-report-${format(at, 'yyyy-MM-dd')}.pdf`);
}
