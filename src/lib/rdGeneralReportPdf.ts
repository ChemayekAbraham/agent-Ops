import { format } from 'date-fns';

const PRIMARY: [number, number, number] = [108, 33, 196];
const STRIPE: [number, number, number] = [243, 238, 252];

export interface RdReportProject {
  name: string; tagline: string; stage: string; progress: number; objective: string;
  progressItems: string[]; metrics: { value: string; label: string }[];
  challenges: string[]; nextSteps: string[];
  week: { last: string[]; today: string[]; next: string[] };
  updates: { date: string; text: string }[];
}
export interface RdReportData {
  summary: { value: string; label: string }[];
  ideas: { name: string; customers: number; cashIn: number; cashOut: number }[];
  projects: RdReportProject[];
  canvases: { title: string; owner: string; date: string; summary: string; canvas: Record<string, string> }[];
  canvasTitles: Record<string, string>;
}

const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-US')}`;

/** One PDF holding everything shown on the R&D page. */
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

  let y = heading('Overall Summary', 36);
  table(['Measure', 'Value'], d.summary.map((s) => [s.label, s.value]), y);

  y = heading('Business Ideas: Cash Position', lastY() + 10);
  const t = d.ideas.reduce((a, r) => ({ c: a.c + r.customers, i: a.i + r.cashIn, o: a.o + r.cashOut }), { c: 0, i: 0, o: 0 });
  table(['Business idea', 'Customers', 'Cash in', 'Cash out', 'Net position'],
    d.ideas.map((r) => [r.name, r.customers.toLocaleString('en-US'), ugx(r.cashIn), ugx(r.cashOut), ugx(r.cashIn - r.cashOut)]), y,
    { foot: [['Total', t.c.toLocaleString('en-US'), ugx(t.i), ugx(t.o), ugx(t.i - t.o)]], footStyles: { fillColor: [230, 230, 240], textColor: 20, fontStyle: 'bold' } });

  y = heading('Project Progress', lastY() + 10);
  table(['Project', 'Stage', 'Progress'], d.projects.map((p) => [p.name, p.stage, `${p.progress}%`]), y);

  for (const p of d.projects) {
    y = heading(`${p.name} — ${p.tagline}`, lastY() + 10);
    const list = (a: string[]) => (a.length ? a.map((x) => `• ${x}`).join('\n') : '—');
    table(['Section', 'Details'], [
      ['Stage / progress', `${p.stage} · ${p.progress}%`],
      ['Objective', p.objective],
      ['Current progress', list(p.progressItems)],
      ['Key metrics', p.metrics.map((x) => `${x.label}: ${x.value}`).join('\n')],
      ['Challenges', list(p.challenges)],
      ['Next steps', list(p.nextSteps)],
      ['Last 7 days', list(p.week.last)],
      ['Today', list(p.week.today)],
      ['Next 7 days', list(p.week.next)],
      ['Updates', p.updates.filter((u) => u.text.trim()).map((u) => `${u.date}: ${u.text}`).join('\n') || 'No updates recorded'],
    ], y, { columnStyles: { 0: { cellWidth: 38, fontStyle: 'bold' } } });
  }

  y = heading('Idea Canvas Board', lastY() + 10);
  if (!d.canvases.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text('No saved ideas.', mg, y + 4);
  }
  for (const c of d.canvases) {
    y = heading(c.title, (d.canvases.indexOf(c) === 0 ? y : lastY() + 8) + 3);
    table(['Field', 'Details'], [
      ['Owner', c.owner || '—'], ['Date', c.date || '—'], ['Summary', c.summary || '—'],
      ...Object.entries(d.canvasTitles).map(([k, title]) => [title, c.canvas?.[k] || '—']),
    ], y, { columnStyles: { 0: { cellWidth: 45, fontStyle: 'bold' } } });
  }

  const n = (doc as any).internal.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120);
    doc.text('Welile Technologies Ltd — R&D Department', mg, 291);
    doc.text(`Page ${i} / ${n}`, W - mg, 291, { align: 'right' });
  }
  doc.save(`rd-general-report-${format(at, 'yyyy-MM-dd')}.pdf`);
}
