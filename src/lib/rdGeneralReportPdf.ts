import { format } from 'date-fns';

const PRIMARY: [number, number, number] = [108, 33, 196];
const STRIPE: [number, number, number] = [243, 238, 252];

export interface RdReportProject {
  name: string;
  updates: { date: string; text: string }[];
}
export interface RdReportData {
  projects: RdReportProject[];
}

/** Only explicitly recorded updates may supply report content. */
export function recordedRdProjects(projects: RdReportProject[]): RdReportProject[] {
  return projects.map((p) => ({
    name: p.name,
    updates: p.updates.filter((u) => u.text.trim()).map((u) => ({ date: u.date, text: u.text })),
  }));
}

/** One PDF holding recorded R&D updates, without preset claims or figures. */
export async function downloadRdGeneralReport(d: RdReportData, at = new Date()) {
  const { default: jsPDF } = await import('jspdf');
  const m: any = await import('jspdf-autotable');
  const autoTable = m.default || m;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const mg = 12;
  const lastY = () => (doc as any).lastAutoTable?.finalY ?? 40;
  const ensure = (y: number, need = 30) => { if (y + need > 280) { doc.addPage(); return 18; } return y; };
  const heading = (t: string, y: number) => {
    y = ensure(y);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...PRIMARY);
    doc.text(t, mg, y); doc.setTextColor(15, 23, 42);
    return y + 3;
  };
  const table = (head: string[], body: (string | number)[][], startY: number, opts: any = {}) =>
    autoTable(doc, {
      head: [head], body, startY, margin: { left: mg, right: mg },
      styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
      headStyles: { fillColor: PRIMARY, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: STRIPE }, ...opts,
    });

  doc.setFillColor(...PRIMARY); doc.rect(0, 0, W, 26, 'F');
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text('R&D General Report', mg, 13);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(`Generated ${format(at, 'dd MMM yyyy, HH:mm')}`, mg, 20);

  let y = 36;
  for (const p of recordedRdProjects(d.projects)) {
    y = heading(p.name, y);
    table(['Date', 'Recorded update'], p.updates.length
      ? p.updates.map((u) => [u.date || '—', u.text])
      : [['—', 'No updates recorded']], y,
      { columnStyles: { 0: { cellWidth: 30 } } });
    y = lastY() + 10;
  }

  const n = (doc as any).internal.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120);
    doc.text('Welile Technologies Ltd — R&D Department', mg, 291);
    doc.text(`Page ${i} / ${n}`, W - mg, 291, { align: 'right' });
  }
  doc.save(`rd-general-report-${format(at, 'yyyy-MM-dd')}.pdf`);
}
