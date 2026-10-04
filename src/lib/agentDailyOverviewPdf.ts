import jsPDF from 'jspdf';
import { format } from 'date-fns';

export interface AgentDailyOverviewRow {
  agentName: string;
  agentPhone: string;
  activeTenants: number;
  expectedToday: number;
  collectedToday: number;
  tenantsPaidToday: number;
  paymentsToday: number;
  principalPaid: number;
  outstanding: number;
}

export interface AgentDailyOverviewInput {
  reportDate: Date;
  /** Optional range end — when set (and different from reportDate) the report covers a period. */
  rangeEnd?: Date;
  /** Human label for the covered period, e.g. "Last 7 days". */
  periodLabel?: string;
  generatedAt: Date;
  rows: AgentDailyOverviewRow[];
}

const num = (n: number) => Math.round(n || 0).toLocaleString();
const COL = {
  ink: [15, 23, 42] as [number, number, number],
  muted: [100, 116, 139] as [number, number, number],
  border: [225, 227, 232] as [number, number, number],
  zebra: [248, 249, 252] as [number, number, number],
  head: [146, 52, 234] as [number, number, number],
  green: [22, 163, 74] as [number, number, number],
  red: [220, 38, 38] as [number, number, number],
  amber: [245, 158, 11] as [number, number, number],
  blue: [37, 99, 235] as [number, number, number],
};

type Status = { label: string; color: [number, number, number] };
const status = (rate: number): Status => {
  if (rate >= 95) return { label: 'Excellent', color: COL.green };
  if (rate >= 75) return { label: 'Good', color: [34, 139, 87] };
  if (rate >= 50) return { label: 'Moderate', color: COL.amber };
  if (rate >= 25) return { label: 'Low', color: [234, 88, 12] };
  return { label: 'Critical', color: COL.red };
};

export function generateAgentDailyOverviewPdf(input: AgentDailyOverviewInput): Blob {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 10;
  const contentW = pageW - margin * 2;
  let y = 10;

  const totals = input.rows.reduce(
    (a, r) => {
      a.tenants += r.activeTenants;
      a.expected += r.expectedToday;
      a.collected += r.collectedToday;
      a.paid += r.tenantsPaidToday;
      a.payments += r.paymentsToday;
      a.principal += r.principalPaid;
      a.outstanding += r.outstanding;
      return a;
    },
    { tenants: 0, expected: 0, collected: 0, paid: 0, payments: 0, principal: 0, outstanding: 0 },
  );
  const overallRate = totals.expected > 0 ? Math.round((totals.collected / totals.expected) * 100) : 0;

  const rangeEnd = input.rangeEnd || input.reportDate;
  const isRange =
    format(rangeEnd, 'yyyy-MM-dd') !== format(input.reportDate, 'yyyy-MM-dd');
  const dateHeading = isRange
    ? `${format(input.reportDate, 'dd MMM')} - ${format(rangeEnd, 'dd MMM yyyy')}`
    : format(input.reportDate, 'EEE, dd MMM yyyy');
  const periodSuffix = isRange ? ' (period)' : ' today';

  // ===== Header bar =====
  doc.setFillColor(...COL.ink);
  doc.rect(margin, y, contentW, 20, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(255, 255, 255);
  doc.text('WELILE — AGENT DAILY PERFORMANCE', margin + 4, y + 8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(200, 208, 225);
  doc.text(
    `One row per agent: expected vs collected, principal & outstanding${input.periodLabel ? ` - ${input.periodLabel}` : ''}`,
    margin + 4,
    y + 14,
  );
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(255, 255, 255);
  doc.text(dateHeading, pageW - margin - 4, y + 10, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(200, 208, 225);
  doc.text(`Generated ${format(input.generatedAt, 'dd MMM yyyy HH:mm')}`, pageW - margin - 4, y + 15, { align: 'right' });
  y += 24;

  // ===== Summary chips =====
  const chips: { label: string; value: string; color: [number, number, number] }[] = [
    { label: 'Agents', value: String(input.rows.length), color: COL.ink },
    { label: 'Active tenants', value: String(totals.tenants), color: COL.ink },
    { label: `Expected${periodSuffix} (UGX)`, value: num(totals.expected), color: COL.ink },
    { label: `Collected${periodSuffix} (UGX)`, value: num(totals.collected), color: COL.blue },
    { label: 'Collection rate', value: `${overallRate}%`, color: overallRate >= 75 ? COL.green : overallRate >= 50 ? COL.blue : COL.red },
    { label: 'Principal paid (UGX)', value: num(totals.principal), color: COL.ink },
    { label: 'Outstanding (UGX)', value: num(totals.outstanding), color: COL.red },
  ];
  const gap = 3;
  const chipW = (contentW - gap * (chips.length - 1)) / chips.length;
  const chipH = 18;
  chips.forEach((c, i) => {
    const x = margin + i * (chipW + gap);
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...COL.border);
    doc.setLineWidth(0.25);
    (doc as any).roundedRect(x, y, chipW, chipH, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(...COL.muted);
    doc.text(c.label.toUpperCase(), x + 3, y + 5);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...c.color);
    doc.text(c.value, x + 3, y + 13);
  });
  y += chipH + 5;

  // ===== Per-agent table =====
  doc.setFillColor(...COL.head);
  doc.rect(margin, y, contentW, 7, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text('PER-AGENT BREAKDOWN', margin + 3, y + 4.8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.text('All amounts in UGX', pageW - margin - 3, y + 4.8, { align: 'right' });
  y += 7;

  // Column widths: sum = contentW = 277
  const cols = [
    { label: '#', w: 8, align: 'left' as const },
    { label: 'Agent', w: 46, align: 'left' as const },
    { label: 'Phone', w: 26, align: 'left' as const },
    { label: 'Tenants', w: 16, align: 'right' as const },
    { label: 'Expected', w: 26, align: 'right' as const },
    { label: 'Collected', w: 26, align: 'right' as const },
    { label: 'Rate', w: 14, align: 'right' as const },
    { label: 'Paid', w: 14, align: 'right' as const },
    { label: 'Pmts', w: 14, align: 'right' as const },
    { label: 'Principal paid', w: 28, align: 'right' as const },
    { label: 'Outstanding', w: 28, align: 'right' as const },
    { label: 'Status', w: contentW - (8 + 46 + 26 + 16 + 26 + 26 + 14 + 14 + 14 + 28 + 28), align: 'center' as const },
  ];
  const colX = (i: number) => margin + cols.slice(0, i).reduce((s, c) => s + c.w, 0);

  const drawHeader = () => {
    doc.setFillColor(241, 245, 249);
    doc.rect(margin, y, contentW, 6.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...COL.ink);
    cols.forEach((c, i) => {
      const tx = c.align === 'right' ? colX(i) + c.w - 1.5 : c.align === 'center' ? colX(i) + c.w / 2 : colX(i) + 1.5;
      doc.text(c.label, tx, y + 4.3, { align: c.align });
    });
    y += 6.5;
  };
  drawHeader();

  const rowH = 5.8;
  const bottomLimit = pageH - 14;
  const trunc = (s: string, n: number) => (!s ? '—' : s.length > n ? s.slice(0, n - 1) + '…' : s);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  input.rows.forEach((r, i) => {
    if (y + rowH > bottomLimit) {
      doc.addPage();
      y = 10;
      drawHeader();
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
    }
    if (i % 2 === 1) {
      doc.setFillColor(...COL.zebra);
      doc.rect(margin, y, contentW, rowH, 'F');
    }
    doc.setDrawColor(...COL.border);
    doc.setLineWidth(0.1);
    doc.line(margin, y + rowH, margin + contentW, y + rowH);
    const b = y + rowH - 1.9;
    const rate = r.expectedToday > 0 ? Math.round((r.collectedToday / r.expectedToday) * 100) : 0;
    const st = status(rate);
    doc.setTextColor(...COL.ink);
    doc.text(String(i + 1), colX(0) + 1.5, b);
    doc.setFont('helvetica', 'bold');
    doc.text(trunc(r.agentName, 28), colX(1) + 1.5, b);
    doc.setFont('helvetica', 'normal');
    doc.text(trunc(r.agentPhone, 16), colX(2) + 1.5, b);
    doc.text(String(r.activeTenants), colX(3) + cols[3].w - 1.5, b, { align: 'right' });
    doc.text(num(r.expectedToday), colX(4) + cols[4].w - 1.5, b, { align: 'right' });
    if (r.collectedToday > 0) doc.setTextColor(...COL.green);
    doc.text(num(r.collectedToday), colX(5) + cols[5].w - 1.5, b, { align: 'right' });
    doc.setTextColor(...st.color);
    doc.setFont('helvetica', 'bold');
    doc.text(`${rate}%`, colX(6) + cols[6].w - 1.5, b, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COL.ink);
    doc.text(String(r.tenantsPaidToday), colX(7) + cols[7].w - 1.5, b, { align: 'right' });
    doc.text(String(r.paymentsToday), colX(8) + cols[8].w - 1.5, b, { align: 'right' });
    doc.text(num(r.principalPaid), colX(9) + cols[9].w - 1.5, b, { align: 'right' });
    if (r.outstanding > 0) doc.setTextColor(...COL.red);
    doc.text(num(r.outstanding), colX(10) + cols[10].w - 1.5, b, { align: 'right' });
    doc.setTextColor(...COL.ink);
    // Status pill
    doc.setFillColor(...st.color);
    (doc as any).roundedRect(colX(11) + 2, y + 1.4, cols[11].w - 4, rowH - 2.8, 0.8, 0.8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(255, 255, 255);
    doc.text(st.label, colX(11) + cols[11].w / 2, b - 0.3, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...COL.ink);
    y += rowH;
  });

  if (input.rows.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(...COL.muted);
    doc.text('No agents with active tenants for this date.', margin + 3, y + 6);
    y += 8;
  }

  // Totals row
  if (y + rowH + 1 > bottomLimit) {
    doc.addPage();
    y = 10;
    drawHeader();
  }
  doc.setFillColor(232, 240, 254);
  doc.rect(margin, y, contentW, rowH + 1, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  const tb = y + rowH - 1.4;
  doc.setTextColor(...COL.blue);
  doc.text('TOTAL', colX(1) + 1.5, tb);
  doc.setTextColor(...COL.ink);
  doc.text(String(totals.tenants), colX(3) + cols[3].w - 1.5, tb, { align: 'right' });
  doc.text(num(totals.expected), colX(4) + cols[4].w - 1.5, tb, { align: 'right' });
  doc.setTextColor(...COL.green);
  doc.text(num(totals.collected), colX(5) + cols[5].w - 1.5, tb, { align: 'right' });
  doc.setTextColor(...COL.ink);
  doc.text(`${overallRate}%`, colX(6) + cols[6].w - 1.5, tb, { align: 'right' });
  doc.text(String(totals.paid), colX(7) + cols[7].w - 1.5, tb, { align: 'right' });
  doc.text(String(totals.payments), colX(8) + cols[8].w - 1.5, tb, { align: 'right' });
  doc.text(num(totals.principal), colX(9) + cols[9].w - 1.5, tb, { align: 'right' });
  doc.setTextColor(...COL.red);
  doc.text(num(totals.outstanding), colX(10) + cols[10].w - 1.5, tb, { align: 'right' });
  y += rowH + 6;

  // Footer page numbers
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...COL.muted);
    doc.text(`Page ${p} of ${pageCount}  ·  Welile Receipts  ·  Confidential`, pageW / 2, pageH - 5, { align: 'center' });
  }

  return doc.output('blob');
}