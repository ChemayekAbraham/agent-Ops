import jsPDF from 'jspdf';
import { format } from 'date-fns';
import type { RentBandSummary, RentTrendPoint, TenantRentRow } from './rentAnalysis';

export interface RentAnalysisPdfInput {
  /** Reporting period actually applied to receipt figures. */
  periodStart: Date;
  periodEnd: Date;
  /** Day the schedule position (arrears / outstanding) was read on. */
  positionDay: Date;
  generatedAt: Date;
  /** What population the report covers, spelled out for the reader. */
  scopeLines: string[];
  summaries: RentBandSummary[];
  /** Tenant detail for the selected category, already filtered and sorted. */
  rows: TenantRentRow[];
  selectedLabel: string;
  /** Headline figures for exactly the filtered population. */
  headline: RentBandSummary;
  behaviour: { onSchedule: number; ahead: number; arrears: number };
  /** Rent-category distribution as shown on screen. */
  distribution: { key: string; label: string; tenants: number; arrears: number; totalRent: number }[];
  /** Daily receipts for the filtered population over the selected period. */
  trend: RentTrendPoint[];
}

const COL = {
  ink: [15, 23, 42] as [number, number, number],
  muted: [100, 116, 139] as [number, number, number],
  border: [225, 227, 232] as [number, number, number],
  zebra: [248, 249, 252] as [number, number, number],
  red: [220, 38, 38] as [number, number, number],
};

const num = (value: number) => Math.round(value || 0).toLocaleString();
const pct = (value: number) => `${(value || 0).toFixed(1)}%`;

export function generateRentAnalysisPdf(input: RentAnalysisPdfInput): Blob {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 10;
  const contentW = pageW - margin * 2;
  let y = 10;

  const newPageIfNeeded = (needed: number) => {
    if (y + needed <= pageH - 12) return;
    doc.addPage();
    y = 12;
  };

  // Header
  doc.setFillColor(...COL.ink);
  doc.rect(margin, y, contentW, 20, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(255, 255, 255);
  doc.text('WELILE — RENT ANALYSIS BY RENT CATEGORY', margin + 4, y + 8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(200, 208, 225);
  doc.text(
    `Reporting period ${format(input.periodStart, 'dd MMM yyyy')} - ${format(input.periodEnd, 'dd MMM yyyy')}  |  Schedule position as at ${format(input.positionDay, 'dd MMM yyyy')}`,
    margin + 4,
    y + 15,
  );
  doc.setFontSize(8);
  doc.text(`Generated ${format(input.generatedAt, 'dd MMM yyyy HH:mm')}`, pageW - margin - 4, y + 15, { align: 'right' });
  y += 25;

  // Scope
  doc.setTextColor(...COL.ink);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('POPULATION ANALYSED', margin, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...COL.muted);
  input.scopeLines.forEach((line) => {
    doc.text(line, margin, y);
    y += 4;
  });
  y += 4;

  // Summary cards — the same headline figures as the screen, for this filter
  const cards: { label: string; value: string; hint: string; danger?: boolean }[] = [
    { label: 'ACTIVE TENANTS', value: num(input.headline.tenantCount), hint: `${num(input.headline.dailyCount)} daily / ${num(input.headline.weeklyCount)} weekly` },
    { label: 'TOTAL MONTHLY RENT', value: num(input.headline.totalRent), hint: `avg ${num(input.headline.averageRent)} | median ${num(input.headline.medianRent)}` },
    { label: 'COLLECTED IN PERIOD', value: num(input.headline.paidInPeriod), hint: `${num(input.headline.paymentsInPeriod)} receipts` },
    { label: 'TENANTS IN ARREARS', value: num(input.headline.arrearsCount), hint: `${num(input.headline.arrearsAmount)} UGX outstanding to date`, danger: input.headline.arrearsCount > 0 },
    { label: 'PAID IN PERIOD', value: pct(input.headline.paymentRate), hint: `${num(input.headline.payingCount)} of ${num(input.headline.tenantCount)} tenants` },
    { label: 'OUTSTANDING BALANCES', value: num(input.headline.outstanding), hint: `adherence ${pct(input.headline.scheduleAdherence)}` },
  ];
  const cardW = (contentW - 5 * 3) / 6;
  cards.forEach((card, index) => {
    const x = margin + index * (cardW + 3);
    doc.setFillColor(248, 249, 252);
    doc.setDrawColor(...COL.border);
    doc.roundedRect(x, y, cardW, 17, 1.5, 1.5, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6);
    doc.setTextColor(...COL.muted);
    doc.text(card.label, x + 2.5, y + 4.5);
    doc.setFontSize(11);
    if (card.danger) doc.setTextColor(...COL.red);
    else doc.setTextColor(...COL.ink);
    doc.text(card.value, x + 2.5, y + 10.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(...COL.muted);
    doc.text(card.hint.slice(0, 46), x + 2.5, y + 14.5);
  });
  y += 22;

  // Charts — distribution and daily collections, both for this exact filter
  const chartH = 34;
  const chartW = (contentW - 4) / 2;
  const drawChartFrame = (x: number, title: string) => {
    doc.setDrawColor(...COL.border);
    doc.roundedRect(x, y, chartW, chartH + 10, 1.5, 1.5, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...COL.ink);
    doc.text(title, x + 3, y + 5);
  };

  newPageIfNeeded(chartH + 16);
  drawChartFrame(margin, 'TENANTS BY RENT CATEGORY');
  const distMax = Math.max(1, ...input.distribution.map((item) => item.tenants));
  const distSlot = (chartW - 8) / Math.max(1, input.distribution.length);
  input.distribution.forEach((item, index) => {
    const barW = Math.min(14, distSlot - 4);
    const x = margin + 4 + index * distSlot + (distSlot - barW) / 2;
    const h = (item.tenants / distMax) * chartH;
    const base = y + 7 + chartH;
    doc.setFillColor(59, 130, 246);
    doc.rect(x, base - h, barW, h, 'F');
    if (item.arrears > 0) {
      const ah = (item.arrears / distMax) * chartH;
      doc.setFillColor(...COL.red);
      doc.rect(x + barW - 3, base - ah, 3, ah, 'F');
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(5.5);
    doc.setTextColor(...COL.ink);
    doc.text(num(item.tenants), x + barW / 2, base - h - 1, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COL.muted);
    doc.text(item.label.replace(/,000/g, 'k').slice(0, 16), x + barW / 2, base + 3.5, { align: 'center' });
  });

  drawChartFrame(margin + chartW + 4, 'COLLECTED PER DAY IN THE PERIOD');
  const trendMax = Math.max(1, ...input.trend.map((point) => point.amount));
  const trendSlot = (chartW - 8) / Math.max(1, input.trend.length);
  input.trend.forEach((point, index) => {
    const x = margin + chartW + 8 + index * trendSlot;
    const h = (point.amount / trendMax) * chartH;
    const base = y + 7 + chartH;
    doc.setFillColor(59, 130, 246);
    doc.rect(x, base - h, Math.max(0.8, trendSlot - 0.8), h, 'F');
    const step = Math.ceil(input.trend.length / 8);
    if (index % step === 0) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(5.5);
      doc.setTextColor(...COL.muted);
      doc.text(format(new Date(`${point.day}T00:00:00`), 'dd MMM'), x, base + 3.5);
    }
  });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(5.5);
  doc.setTextColor(...COL.muted);
  doc.text(`Peak day ${num(trendMax)} UGX`, margin + chartW * 2 + 1, y + 5, { align: 'right' });
  y += chartH + 15;

  // Payment behaviour line
  newPageIfNeeded(8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...COL.muted);
  doc.text(
    `Payment behaviour: ${num(input.behaviour.onSchedule)} on schedule | ${num(input.behaviour.ahead)} ahead of schedule | ${num(input.behaviour.arrears)} in arrears | average gap between receipts ${input.headline.averageGapDays === null ? 'not enough receipts' : `${input.headline.averageGapDays.toFixed(1)} days`}.`,
    margin,
    y,
  );
  y += 7;

  // Category table
  const headers = ['Rent category', 'Tenants', 'Total rent', 'Avg rent', 'In arrears', 'Arrears UGX', 'Paid in period', 'Receipts', 'Paying %', 'Adherence', 'Avg gap', 'Outstanding'];
  const widths = [46, 16, 26, 22, 18, 26, 26, 16, 18, 18, 16, 29];
  const drawHeader = () => {
    doc.setFillColor(...COL.ink);
    doc.rect(margin, y, contentW, 7, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(255, 255, 255);
    let x = margin + 2;
    headers.forEach((header, index) => {
      const right = index > 0;
      doc.text(header, right ? x + widths[index] - 4 : x, y + 4.6, { align: right ? 'right' : 'left' });
      x += widths[index];
    });
    y += 7;
  };
  drawHeader();

  doc.setTextColor(...COL.ink);
  input.summaries.forEach((summary, rowIndex) => {
    newPageIfNeeded(8);
    if (y === 12) drawHeader();
    if (rowIndex % 2 === 1) {
      doc.setFillColor(...COL.zebra);
      doc.rect(margin, y, contentW, 7, 'F');
    }
    const cells = [
      summary.band.label,
      num(summary.tenantCount),
      num(summary.totalRent),
      num(summary.averageRent),
      num(summary.arrearsCount),
      num(summary.arrearsAmount),
      num(summary.paidInPeriod),
      num(summary.paymentsInPeriod),
      pct(summary.paymentRate),
      pct(summary.scheduleAdherence),
      summary.averageGapDays === null ? '-' : `${summary.averageGapDays.toFixed(1)}d`,
      num(summary.outstanding),
    ];
    let x = margin + 2;
    doc.setFontSize(7.5);
    cells.forEach((cell, index) => {
      doc.setFont('helvetica', index === 0 ? 'bold' : 'normal');
      if (index === 5 && summary.arrearsAmount > 0) doc.setTextColor(...COL.red);
      else doc.setTextColor(...COL.ink);
      const right = index > 0;
      doc.text(cell, right ? x + widths[index] - 4 : x, y + 4.6, { align: right ? 'right' : 'left' });
      x += widths[index];
    });
    doc.setDrawColor(...COL.border);
    doc.line(margin, y + 7, margin + contentW, y + 7);
    y += 7;
  });

  // Totals
  const totals = input.summaries.reduce(
    (acc, summary) => {
      acc.tenants += summary.tenantCount;
      acc.rent += summary.totalRent;
      acc.arrearsCount += summary.arrearsCount;
      acc.arrears += summary.arrearsAmount;
      acc.paid += summary.paidInPeriod;
      acc.receipts += summary.paymentsInPeriod;
      acc.paying += summary.payingCount;
      acc.outstanding += summary.outstanding;
      return acc;
    },
    { tenants: 0, rent: 0, arrearsCount: 0, arrears: 0, paid: 0, receipts: 0, paying: 0, outstanding: 0 },
  );
  newPageIfNeeded(10);
  doc.setFillColor(238, 241, 247);
  doc.rect(margin, y, contentW, 7.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...COL.ink);
  const totalCells = [
    'TOTAL',
    num(totals.tenants),
    num(totals.rent),
    totals.tenants ? num(totals.rent / totals.tenants) : '0',
    num(totals.arrearsCount),
    num(totals.arrears),
    num(totals.paid),
    num(totals.receipts),
    totals.tenants ? pct((totals.paying / totals.tenants) * 100) : '0.0%',
    '',
    '',
    num(totals.outstanding),
  ];
  let tx = margin + 2;
  totalCells.forEach((cell, index) => {
    const right = index > 0;
    doc.text(cell, right ? tx + widths[index] - 4 : tx, y + 5, { align: right ? 'right' : 'left' });
    tx += widths[index];
  });
  y += 13;

  // Tenant detail
  if (input.rows.length > 0) {
    newPageIfNeeded(20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...COL.ink);
    doc.text(`TENANT DETAIL — ${input.selectedLabel} (${input.rows.length})`, margin, y);
    y += 5;

    const dHeaders = ['Tenant', 'Phone', 'Agent', 'Rent', 'Per period', 'Arrears', 'Paid in period', 'Receipts', 'Last payment', 'Outstanding'];
    const dWidths = [50, 26, 46, 24, 24, 26, 28, 16, 26, 11];
    const drawDetailHeader = () => {
      doc.setFillColor(...COL.ink);
      doc.rect(margin, y, contentW, 7, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(255, 255, 255);
      let x = margin + 2;
      dHeaders.forEach((header, index) => {
        const right = index > 2;
        doc.text(header, right ? x + dWidths[index] - 4 : x, y + 4.6, { align: right ? 'right' : 'left' });
        x += dWidths[index];
      });
      y += 7;
    };
    drawDetailHeader();

    input.rows.forEach((row, rowIndex) => {
      if (y + 6.5 > pageH - 12) {
        doc.addPage();
        y = 12;
        drawDetailHeader();
      }
      if (rowIndex % 2 === 1) {
        doc.setFillColor(...COL.zebra);
        doc.rect(margin, y, contentW, 6.5, 'F');
      }
      const cells = [
        row.tenantName.slice(0, 32),
        row.tenantPhone || '-',
        row.agentName.slice(0, 30),
        num(row.rent),
        num(row.schedule.periodAmount),
        num(row.schedule.arrears),
        num(row.paidInPeriod),
        num(row.paymentsInPeriod),
        row.lastPaymentAt ? format(new Date(row.lastPaymentAt), 'dd MMM') : '-',
        num(row.schedule.outstandingPlan),
      ];
      let x = margin + 2;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      cells.forEach((cell, index) => {
        if (index === 5 && row.schedule.arrears > 0) doc.setTextColor(...COL.red);
        else doc.setTextColor(...COL.ink);
        const right = index > 2;
        doc.text(cell, right ? x + dWidths[index] - 4 : x, y + 4.3, { align: right ? 'right' : 'left' });
        x += dWidths[index];
      });
      y += 6.5;
    });
  }

  // Footer
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...COL.muted);
    doc.text(
      'Active Rent Plans only. Arrears, ahead cover and outstanding balances read from each plan\'s own schedule; receipts from recorded agent collections and tenant payments.',
      margin,
      pageH - 6,
    );
    doc.text(`Page ${page} of ${pages}`, pageW - margin, pageH - 6, { align: 'right' });
  }

  return doc.output('blob');
}
