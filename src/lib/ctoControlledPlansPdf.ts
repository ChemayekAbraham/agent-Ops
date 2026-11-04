import { format } from 'date-fns';
import {
  balanceOf,
  fmtUgx,
  pct,
  recoveredSplit,
  rollUpByAgent,
  type CtoControlledPlan,
  type CtoControlledSummary,
} from '@/lib/ctoControlledPlans';

type Align = 'left' | 'right' | 'center';
interface Col { label: string; w: number; align: Align }

const fmtN = (n: number) => Math.round(n).toLocaleString('en-US');
const fmtDate = (s: string | null) => (s ? format(new Date(s), 'dd MMM yy') : '—');

/**
 * "CTO-controlled Rent Plans: collections" PDF, in the layout of the other Welile reports (purple header band, landscape A4):
 * a summary page with the split of what came back, a per-agent table, then one row per Rent Plan.
 */
export async function generateCtoControlledPlansPdf(opts: {
  plans: CtoControlledPlan[];
  summary: CtoControlledSummary;
}): Promise<Blob> {
  const { plans, summary } = opts;
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 8;
  const rowH = 7;
  let y = 0;

  const band = (title: string, subtitle: string) => {
    pdf.setFillColor(146, 52, 234);
    pdf.rect(0, 0, pw, 22, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(14);
    pdf.text(title, margin, 10);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.text(subtitle, margin, 17);
    pdf.setFontSize(8);
    pdf.text(`Generated ${format(new Date(), 'dd MMM yyyy HH:mm')}`, pw - margin, 17, { align: 'right' });
    y = 28;
  };

  const heading = (text: string) => {
    if (y + 14 > ph - 12) { pdf.addPage(); y = 12; }
    pdf.setTextColor(30, 41, 59);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text(text, margin, y + 4);
    y += 8;
  };

  const drawTable = (cols: Col[], rows: string[][], opts2?: { highlight?: (i: number) => [number, number, number] | null; totalsRow?: string[] }) => {
    const tableW = cols.reduce((s, c) => s + c.w, 0);
    const header = () => {
      pdf.setFillColor(37, 99, 235);
      pdf.rect(margin, y, tableW, rowH, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      let x = margin;
      cols.forEach((c) => {
        const tx = c.align === 'right' ? x + c.w - 2 : c.align === 'center' ? x + c.w / 2 : x + 2;
        pdf.text(c.label, tx, y + 4.7, { align: c.align });
        x += c.w;
      });
      y += rowH;
    };
    const line = (cells: string[], fill: [number, number, number] | null, bold = false) => {
      if (fill) { pdf.setFillColor(...fill); pdf.rect(margin, y, tableW, rowH, 'F'); }
      pdf.setTextColor(30, 41, 59);
      pdf.setFont('helvetica', bold ? 'bold' : 'normal');
      pdf.setFontSize(8);
      let x = margin;
      cols.forEach((c, i) => {
        const tx = c.align === 'right' ? x + c.w - 2 : c.align === 'center' ? x + c.w / 2 : x + 2;
        const text = pdf.splitTextToSize(cells[i] ?? '', c.w - 3)[0] ?? '';
        pdf.text(text, tx, y + 4.7, { align: c.align });
        x += c.w;
      });
      y += rowH;
    };
    if (y + rowH * 2 > ph - 12) { pdf.addPage(); y = 12; }
    header();
    rows.forEach((cells, i) => {
      if (y + rowH > ph - 12) { pdf.addPage(); y = 12; header(); }
      line(cells, opts2?.highlight?.(i) ?? (i % 2 ? [248, 250, 252] : null));
    });
    if (opts2?.totalsRow) {
      if (y + rowH > ph - 12) { pdf.addPage(); y = 12; header(); }
      line(opts2.totalsRow, [226, 232, 240], true);
    }
    y += 6;
  };

  // ============ PAGE 1: SUMMARY AND THE SPLIT ============
  band('Welile — CTO-controlled Rent Plans: collections', `${summary.plansCount} Rent Plans · given ${fmtUgx(summary.given)} · due ${fmtUgx(summary.formulaDue)}`);

  heading('Summary');
  drawTable(
    [
      { label: 'Measure', w: 90, align: 'left' },
      { label: 'Amount', w: 50, align: 'right' },
      { label: 'Share', w: 40, align: 'right' },
    ],
    [
      ['Rent Plans controlled', fmtN(summary.plansCount), ''],
      ['Total given', fmtUgx(summary.given), ''],
      ['Total due (Rent Plan formula)', fmtUgx(summary.formulaDue), ''],
      ['Recovered', fmtUgx(summary.recovered), `${pct(summary.recovered, summary.formulaDue)}% of due`],
      ['Principal returned', fmtUgx(summary.principalBack), `${pct(summary.principalBack, summary.given)}% of given`],
      ['Still to come back', fmtUgx(Math.max(0, summary.formulaDue - summary.recovered)), `${pct(Math.max(0, summary.formulaDue - summary.recovered), summary.formulaDue)}% of due`],
    ],
  );

  heading('Where the recovered cash went');
  const split = recoveredSplit(summary);
  const splitTotal = split.reduce((s, x) => s + x.amount, 0);
  drawTable(
    [
      { label: 'Share of recovered', w: 90, align: 'left' },
      { label: 'Amount', w: 50, align: 'right' },
      { label: '% of recovered', w: 40, align: 'right' },
    ],
    split.map((x) => [x.label, fmtUgx(x.amount), `${pct(x.amount, splitTotal)}%`]),
    { totalsRow: ['Recovered cash', fmtUgx(splitTotal), '100%'] },
  );
  heading('Expected against earned (Returns)');
  drawTable(
    [
      { label: '', w: 90, align: 'left' },
      { label: 'Expected', w: 50, align: 'right' },
      { label: 'Earned so far', w: 50, align: 'right' },
    ],
    [
      ['Partner (15% of given, pro rata by days)', fmtUgx(summary.expectedPartner), fmtUgx(summary.partnerEarned)],
      ['Agent (10% of due)', fmtUgx(summary.expectedAgent), fmtUgx(summary.agentCommission)],
      ['Platform', '—', fmtUgx(summary.platformEarned)],
    ],
  );
  if (summary.anyMismatch) {
    pdf.setTextColor(185, 28, 28);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.text('Some Rent Plans have collections that do not add up to the amount repaid. See the plan table (flagged "counter").', margin, y + 3);
    y += 8;
  }

  // ============ PAGE 2: PER AGENT ============
  pdf.addPage();
  band('Welile — CTO-controlled Rent Plans: by agent', `${rollUpByAgent(plans).length} agents`);
  const agents = rollUpByAgent(plans);
  drawTable(
    [
      { label: 'Agent', w: 90, align: 'left' },
      { label: 'Plans', w: 20, align: 'center' },
      { label: 'Given', w: 45, align: 'right' },
      { label: 'Recovered', w: 45, align: 'right' },
      { label: 'Agent commission', w: 45, align: 'right' },
    ],
    agents.map((a) => [a.agentName, String(a.plans), fmtN(a.given), fmtN(a.recovered), fmtN(a.agentCommission)]),
    { totalsRow: ['Total', String(summary.plansCount), fmtN(summary.given), fmtN(summary.recovered), fmtN(summary.agentCommission)] },
  );

  // ============ PAGE 3+: PER PLAN ============
  pdf.addPage();
  band('Welile — CTO-controlled Rent Plans: each plan', 'Sorted by days overdue, then the biggest balance still due');
  const ordered = [...plans].sort((a, b) => b.daysOverdue - a.daysOverdue || balanceOf(b) - balanceOf(a));
  drawTable(
    [
      { label: 'Tenant', w: 40, align: 'left' },
      { label: 'Agent', w: 34, align: 'left' },
      { label: 'Funded', w: 19, align: 'left' },
      { label: 'Days', w: 11, align: 'center' },
      { label: 'Given', w: 22, align: 'right' },
      { label: 'Due', w: 22, align: 'right' },
      { label: 'Recovered', w: 22, align: 'right' },
      { label: '%', w: 11, align: 'right' },
      { label: 'Principal', w: 21, align: 'right' },
      { label: 'Partner', w: 17, align: 'right' },
      { label: 'Agent', w: 17, align: 'right' },
      { label: 'Platform', w: 17, align: 'right' },
      { label: 'Overdue', w: 14, align: 'center' },
      { label: 'Status', w: 18, align: 'center' },
    ],
    ordered.map((p) => [
      p.tenantName + (p.counterMismatch ? ' (counter)' : ''),
      p.agentName,
      fmtDate(p.fundedOn),
      String(p.durationDays),
      fmtN(p.given),
      fmtN(p.formulaDue),
      fmtN(p.recovered),
      `${pct(p.recovered, p.formulaDue)}`,
      fmtN(p.principalBack),
      fmtN(p.partnerEarned),
      fmtN(p.agentCommission),
      fmtN(p.platformEarned),
      p.daysOverdue > 0 ? String(p.daysOverdue) : '—',
      p.status,
    ]),
    {
      highlight: (i) => (ordered[i].daysOverdue > 0 ? [254, 226, 226] : ordered[i].collectionCount === 0 ? [254, 243, 199] : null),
      totalsRow: [
        'Total', '', '', '', fmtN(summary.given), fmtN(summary.formulaDue), fmtN(summary.recovered), `${pct(summary.recovered, summary.formulaDue)}`,
        fmtN(summary.principalBack), fmtN(summary.partnerEarned), fmtN(summary.agentCommission), fmtN(summary.platformEarned), '', '',
      ],
    },
  );

  return pdf.output('blob');
}
