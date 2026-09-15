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
  y += 3;

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
