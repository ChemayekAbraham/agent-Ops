import jsPDF from 'jspdf';
import { format } from 'date-fns';

export interface DailyTrackerRow {
  date: string;
  agentName: string;
  tenantName: string;
  property: string;
  expected: number;
  collected: number;
  balance: number;
  status: 'paid' | 'partial' | 'missed';
  paymentMethod: string;
  remarks: string;
  missedDays?: number;
}

export interface DailyAgentSummaryRow {
  name: string;
  tenantCount: number;
  paidCount: number;
  expected: number;
  collected: number;
  balance: number;
  rate: number;
  status: 'good' | 'at_risk';
}

export interface DailyCollectionReportInput {
  day: Date;
  kpis: {
    onboardedToday: number;
    onboardedDelta: number;
    tenantsPaid: number;
    tenantsPaidDelta: number;
    collectionToday: number;
    collectionDelta: number;
    collectionMonth: number;
    totalRentPaidAllTime: number;
    totalOutstandingAllTenants: number;
  };
  rows: DailyTrackerRow[];
  totals: { expected: number; collected: number; outstanding: number };
  agentSummary: DailyAgentSummaryRow[];
  donut: { collected: number; outstanding: number; collectedPct: number };
  monthly: { date: string; value: number }[];
  top?: { name: string; rate: number };
  bottom?: { name: string; rate: number };
  /** When > 0, renders a "Missed (Nd)" column in the tracker table */
  missedWindow?: number;
}

const COLORS = {
  blue: [37, 99, 235] as [number, number, number],
  green: [22, 163, 74] as [number, number, number],
  red: [220, 38, 38] as [number, number, number],
  amber: [245, 158, 11] as [number, number, number],
  purple: [124, 58, 237] as [number, number, number],
  slate: [15, 23, 42] as [number, number, number],
  muted: [100, 116, 139] as [number, number, number],
  border: [225, 227, 232] as [number, number, number],
  zebra: [248, 249, 252] as [number, number, number],
  headerBg: [20, 33, 72] as [number, number, number],
};

const num = (n: number) => Math.round(n).toLocaleString();
const ugx = (n: number) => num(n);

export function generateDailyCollectionReportPdf(input: DailyCollectionReportInput): Blob {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();   // 297
  const pageHeight = doc.internal.pageSize.getHeight(); // 210
  const margin = 10;
  const contentWidth = pageWidth - margin * 2;
  let y = 10;

  // ===== Header =====
  doc.setFillColor(146, 52, 234);
  doc.rect(margin, y, contentWidth, 18, 'F');

  // Logo block
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(255, 255, 255);
  doc.text('WELILE', margin + 4, y + 8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(180, 188, 205);
  doc.text('TENANT PARTNERSHIPS', margin + 4, y + 13);

  // Title centered
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  doc.text('DAILY COLLECTION MONITORING DASHBOARD', pageWidth / 2, y + 8, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(200, 208, 225);
  doc.text('Track Daily Collections From Tenants', pageWidth / 2, y + 13.5, { align: 'center' });

  // Date chip right
  const chipW = 46;
  const chipX = pageWidth - margin - chipW - 2;
  doc.setFillColor(255, 255, 255);
  (doc as any).roundedRect(chipX, y + 3, chipW, 12, 1.5, 1.5, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text('Date', chipX + 4, y + 7);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text(format(input.day, 'dd MMM yyyy'), chipX + 4, y + 12);

  y += 22;

  // ===== KPI cards (5) =====
  const gap = 3;
  const cardW = (contentWidth - gap * 5) / 6;
  const cardH = 22;
  const drawKpi = (
    x: number,
    label: string,
    value: string,
    valueColor: [number, number, number],
    delta: { text: string; positive: boolean } | null,
    glyph: string,
    glyphColor: [number, number, number],
  ) => {
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.25);
    (doc as any).roundedRect(x, y, cardW, cardH, 2, 2, 'FD');
    // Label
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.8);
    doc.setTextColor(...glyphColor);
    doc.text(label.toUpperCase(), x + 4, y + 5);
    // Glyph circle
    doc.setFillColor(...glyphColor);
    doc.circle(x + cardW - 6, y + 6, 2.6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(255, 255, 255);
    doc.text(glyph, x + cardW - 6, y + 7.1, { align: 'center' });
    // Value
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...valueColor);
    doc.text(value, x + 4, y + 14);
    // Delta
    if (delta) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.8);
      doc.setTextColor(...(delta.positive ? COLORS.green : COLORS.red));
      doc.text(delta.text, x + 4, y + 19.5);
    }
  };

  const k = input.kpis;
  const fmtDeltaCount = (d: number) => ({ text: `${d > 0 ? '+' : ''}${d} vs yesterday`, positive: d >= 0 });
  const fmtDeltaCash = (d: number) => ({ text: `${d > 0 ? '+' : ''}${ugx(d)} vs yesterday`, positive: d >= 0 });

  drawKpi(margin + 0 * (cardW + gap), 'Total Tenants Onboarded (Today)', String(k.onboardedToday), COLORS.slate, fmtDeltaCount(k.onboardedDelta), 'P', COLORS.blue);
  drawKpi(margin + 1 * (cardW + gap), 'Tenants Paid For (Today)', String(k.tenantsPaid), COLORS.green, fmtDeltaCount(k.tenantsPaidDelta), 'V', COLORS.green);
  drawKpi(margin + 2 * (cardW + gap), 'Collection Today (UGX)', ugx(k.collectionToday), COLORS.blue, fmtDeltaCash(k.collectionDelta), '$', COLORS.blue);
  drawKpi(margin + 3 * (cardW + gap), 'Collection This Month (UGX)', ugx(k.collectionMonth), COLORS.amber, { text: 'MTD Collection', positive: true }, 'M', COLORS.amber);
  drawKpi(margin + 4 * (cardW + gap), 'Total Rent Paid (All Time)', ugx(k.totalRentPaidAllTime), COLORS.purple, { text: 'Total To Date', positive: true }, 'B', COLORS.purple);
  drawKpi(margin + 5 * (cardW + gap), 'Total Outstanding (All Tenants)', ugx(k.totalOutstandingAllTenants), COLORS.red, { text: 'Across active plans', positive: false }, '!', COLORS.red);

  y += cardH + 5;

  // ===== Tracker Table =====
  // Section title bar
  doc.setFillColor(...COLORS.headerBg);
  doc.rect(margin, y, contentWidth, 7, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text('TENANT DAILY COLLECTION TRACKER', margin + 3, y + 4.8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.text('All amounts in UGX', pageWidth - margin - 3, y + 4.8, { align: 'right' });
  y += 7;

  // Column widths (sum = contentWidth = 277). A "Missed (Nd)" column is
  // inserted before Method when input.missedWindow > 0.
  const showMissed = (input.missedWindow || 0) > 0;
  const missedW = 20;
  const fixedW = 8 + 22 + 28 + 32 + 40 + 22 + 22 + 22 + 18 + 22 + (showMissed ? missedW : 0);
  const colsT = [
    { label: '#',         w: 8,  align: 'left'  as const },
    { label: 'Date',      w: 22, align: 'left'  as const },
    { label: 'Agent',     w: 28, align: 'left'  as const },
    { label: 'Tenant',    w: 32, align: 'left'  as const },
    { label: 'Property',  w: 40, align: 'left'  as const },
    { label: 'Expected',  w: 22, align: 'right' as const },
    { label: 'Collected', w: 22, align: 'right' as const },
    { label: 'Balance',   w: 22, align: 'right' as const },
    { label: 'Status',    w: 18, align: 'left'  as const },
    ...(showMissed ? [{ label: `Missed (${input.missedWindow}d)`, w: missedW, align: 'right' as const }] : []),
    { label: 'Method',    w: 22, align: 'left'  as const },
    { label: 'Remarks',   w: contentWidth - fixedW, align: 'left' as const },
  ];
  // Dynamic indexes (account for the optional Missed column)
  const IDX_STATUS = 8;
  const IDX_MISSED = showMissed ? 9 : -1;
  const IDX_METHOD = showMissed ? 10 : 9;
  const IDX_REMARKS = showMissed ? 11 : 10;

  const colX = (idx: number) => margin + colsT.slice(0, idx).reduce((s, c) => s + c.w, 0);

  const drawTrackerHeader = () => {
    doc.setFillColor(241, 245, 249);
    doc.rect(margin, y, contentWidth, 6.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.slate);
    colsT.forEach((c, i) => {
      const tx = c.align === 'right' ? colX(i) + c.w - 1.5 : colX(i) + 1.5;
      doc.text(c.label, tx, y + 4.3, { align: c.align });
    });
    y += 6.5;
  };
  drawTrackerHeader();

  const rowH = 5.6;
  const bottomLimit = pageHeight - 14;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);

  input.rows.forEach((r, i) => {
    if (y + rowH > bottomLimit) {
      doc.addPage();
      y = 10;
      drawTrackerHeader();
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
    }
    if (i % 2 === 1) {
      doc.setFillColor(...COLORS.zebra);
      doc.rect(margin, y, contentWidth, rowH, 'F');
    }
    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.1);
    doc.line(margin, y + rowH, margin + contentWidth, y + rowH);
    const baseline = y + rowH - 1.8;
    doc.setTextColor(...COLORS.slate);
    const trunc = (s: string, n: number) => (s || '—').length > n ? (s || '—').slice(0, n - 1) + '…' : (s || '—');
    doc.text(String(i + 1), colX(0) + 1.5, baseline);
    doc.text(r.date, colX(1) + 1.5, baseline);
    doc.text(trunc(r.agentName, 18), colX(2) + 1.5, baseline);
    doc.setFont('helvetica', 'bold');
    doc.text(trunc(r.tenantName, 22), colX(3) + 1.5, baseline);
    doc.setFont('helvetica', 'normal');
    doc.text(trunc(r.property, 28), colX(4) + 1.5, baseline);
    doc.text(num(r.expected), colX(5) + colsT[5].w - 1.5, baseline, { align: 'right' });
    doc.text(num(r.collected), colX(6) + colsT[6].w - 1.5, baseline, { align: 'right' });
    if (r.balance > 0) doc.setTextColor(...COLORS.red);
    doc.text(num(r.balance), colX(7) + colsT[7].w - 1.5, baseline, { align: 'right' });
    // Status badge
    const sColor = r.status === 'paid' ? COLORS.green : r.status === 'partial' ? COLORS.amber : COLORS.red;
    const sLabel = r.status === 'paid' ? 'Paid' : r.status === 'partial' ? 'Partial' : 'Missed';
    doc.setFillColor(...sColor);
    (doc as any).roundedRect(colX(IDX_STATUS) + 1, y + 1.3, colsT[IDX_STATUS].w - 2, rowH - 2.6, 0.8, 0.8, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.text(sLabel, colX(IDX_STATUS) + colsT[IDX_STATUS].w / 2, baseline - 0.2, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.slate);
    if (showMissed) {
      const m = r.missedDays || 0;
      doc.setTextColor(...(m > 0 ? COLORS.red : COLORS.muted));
      doc.setFont('helvetica', 'bold');
      doc.text(`${m} / ${input.missedWindow}`, colX(IDX_MISSED) + colsT[IDX_MISSED].w - 1.5, baseline, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.slate);
    }
    doc.text(trunc(r.paymentMethod, 14), colX(IDX_METHOD) + 1.5, baseline);
    doc.setTextColor(...COLORS.muted);
    doc.text(trunc(r.remarks, 22), colX(IDX_REMARKS) + 1.5, baseline);
    y += rowH;
  });

  // Daily totals
  if (y + rowH + 1 > bottomLimit) { doc.addPage(); y = 10; drawTrackerHeader(); }
  doc.setFillColor(232, 240, 254);
  doc.rect(margin, y, contentWidth, rowH + 1, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...COLORS.blue);
  doc.text('DAILY TOTALS', colX(4) + colsT[4].w - 1.5, y + rowH - 1.4, { align: 'right' });
  doc.setTextColor(...COLORS.slate);
  doc.text(num(input.totals.expected), colX(5) + colsT[5].w - 1.5, y + rowH - 1.4, { align: 'right' });
  doc.text(num(input.totals.collected), colX(6) + colsT[6].w - 1.5, y + rowH - 1.4, { align: 'right' });
  doc.setTextColor(...COLORS.red);
  doc.text(num(input.totals.outstanding), colX(7) + colsT[7].w - 1.5, y + rowH - 1.4, { align: 'right' });
  y += rowH + 5;

  // ===== Bottom row: Agent summary (left) + Donut + Top/Bottom (right column) =====
  if (y + 65 > bottomLimit) { doc.addPage(); y = 10; }

  const bottomY = y;
  const leftW = contentWidth * 0.58;
  const rightW = contentWidth - leftW - 4;

  // ---- Agent Daily Collection Summary ----
  doc.setFillColor(22, 101, 52);
  doc.rect(margin, bottomY, leftW, 6.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  doc.text('AGENT DAILY COLLECTION SUMMARY', margin + 3, bottomY + 4.5);

  let ay = bottomY + 6.5;
  const aCols = [
    { label: 'Agent',         w: leftW * 0.22, align: 'left'  as const },
    { label: 'Onb.',          w: leftW * 0.08, align: 'right' as const },
    { label: 'Paid',          w: leftW * 0.08, align: 'right' as const },
    { label: 'Expected',      w: leftW * 0.13, align: 'right' as const },
    { label: 'Collected',     w: leftW * 0.13, align: 'right' as const },
    { label: 'Balance',       w: leftW * 0.13, align: 'right' as const },
    { label: 'Rate',          w: leftW * 0.08, align: 'right' as const },
    { label: 'Status',        w: leftW * 0.15, align: 'left'  as const },
  ];
  const aColX = (idx: number) => margin + aCols.slice(0, idx).reduce((s, c) => s + c.w, 0);
  const drawAgentHeader = () => {
    doc.setFillColor(241, 245, 249);
    doc.rect(margin, ay, leftW, 6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.8);
    doc.setTextColor(...COLORS.slate);
    aCols.forEach((c, i) => {
      const tx = c.align === 'right' ? aColX(i) + c.w - 1.5 : aColX(i) + 1.5;
      doc.text(c.label, tx, ay + 4, { align: c.align });
    });
    ay += 6;
  };
  drawAgentHeader();

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  const aRowH = 5.4;
  let aTotalExp = 0, aTotalCol = 0, aTotalBal = 0, aTotalOnb = 0, aTotalPaid = 0;
  input.agentSummary.forEach((a, i) => {
    if (i % 2 === 1) { doc.setFillColor(...COLORS.zebra); doc.rect(margin, ay, leftW, aRowH, 'F'); }
    const baseline = ay + aRowH - 1.7;
    doc.setTextColor(...COLORS.slate);
    doc.text((a.name || '—').slice(0, 18), aColX(0) + 1.5, baseline);
    doc.text(String(a.tenantCount), aColX(1) + aCols[1].w - 1.5, baseline, { align: 'right' });
    doc.text(String(a.paidCount), aColX(2) + aCols[2].w - 1.5, baseline, { align: 'right' });
    doc.text(num(a.expected), aColX(3) + aCols[3].w - 1.5, baseline, { align: 'right' });
    doc.text(num(a.collected), aColX(4) + aCols[4].w - 1.5, baseline, { align: 'right' });
    if (a.balance > 0) doc.setTextColor(...COLORS.red);
    doc.text(num(a.balance), aColX(5) + aCols[5].w - 1.5, baseline, { align: 'right' });
    doc.setTextColor(...COLORS.slate);
    doc.text(`${a.rate}%`, aColX(6) + aCols[6].w - 1.5, baseline, { align: 'right' });
    doc.setTextColor(...(a.status === 'good' ? COLORS.green : COLORS.amber));
    doc.setFont('helvetica', 'bold');
    doc.text(a.status === 'good' ? 'Good' : 'At Risk', aColX(7) + 1.5, baseline);
    doc.setFont('helvetica', 'normal');
    aTotalExp += a.expected; aTotalCol += a.collected; aTotalBal += a.balance;
    aTotalOnb += a.tenantCount; aTotalPaid += a.paidCount;
    ay += aRowH;
  });
  // Totals row
  doc.setFillColor(232, 240, 254);
  doc.rect(margin, ay, leftW, aRowH, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...COLORS.blue);
  const baseT = ay + aRowH - 1.7;
  doc.text('TOTAL', aColX(0) + 1.5, baseT);
  doc.setTextColor(...COLORS.slate);
  doc.text(String(aTotalOnb), aColX(1) + aCols[1].w - 1.5, baseT, { align: 'right' });
  doc.text(String(aTotalPaid), aColX(2) + aCols[2].w - 1.5, baseT, { align: 'right' });
  doc.text(num(aTotalExp), aColX(3) + aCols[3].w - 1.5, baseT, { align: 'right' });
  doc.text(num(aTotalCol), aColX(4) + aCols[4].w - 1.5, baseT, { align: 'right' });
  doc.setTextColor(...COLORS.red);
  doc.text(num(aTotalBal), aColX(5) + aCols[5].w - 1.5, baseT, { align: 'right' });
  const totalRate = aTotalExp > 0 ? Math.round((aTotalCol / aTotalExp) * 100) : 0;
  doc.setTextColor(...COLORS.slate);
  doc.text(`${totalRate}%`, aColX(6) + aCols[6].w - 1.5, baseT, { align: 'right' });
  ay += aRowH;

  // ---- Right column: Donut + Top/Bottom ----
  const rightX = margin + leftW + 4;
  // Donut header
  doc.setFillColor(30, 64, 175);
  doc.rect(rightX, bottomY, rightW, 6.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  doc.text('COLLECTION OVERVIEW (TODAY)', rightX + 3, bottomY + 4.5);

  // Donut: simulate via two arcs using filled circles + slice rectangle masking (jspdf has no arc)
  // Simpler: draw a colored pie using triangles approximation.
  const cx = rightX + 18;
  const cy = bottomY + 28;
  const radius = 14;
  const innerR = 7;
  const pct = Math.max(0, Math.min(100, input.donut.collectedPct));
  // Background full circle (red = outstanding)
  doc.setFillColor(...COLORS.red);
  doc.circle(cx, cy, radius, 'F');
  // Collected slice (green) drawn as triangles fan
  const segs = Math.max(1, Math.round((pct / 100) * 60));
  doc.setFillColor(...COLORS.green);
  for (let s = 0; s < segs; s++) {
    const a1 = -Math.PI / 2 + (s / 60) * Math.PI * 2;
    const a2 = -Math.PI / 2 + ((s + 1) / 60) * Math.PI * 2;
    const x1 = cx + Math.cos(a1) * radius;
    const y1 = cy + Math.sin(a1) * radius;
    const x2 = cx + Math.cos(a2) * radius;
    const y2 = cy + Math.sin(a2) * radius;
    (doc as any).triangle(cx, cy, x1, y1, x2, y2, 'F');
  }
  // Inner white hole
  doc.setFillColor(255, 255, 255);
  doc.circle(cx, cy, innerR, 'F');
  // Center label
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...COLORS.slate);
  doc.text(`${pct}%`, cx, cy + 0.5, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(5.5);
  doc.setTextColor(...COLORS.muted);
  doc.text('Collection Rate', cx, cy + 4, { align: 'center' });

  // Legend
  const lx = cx + 22;
  let ly = cy - 8;
  doc.setFillColor(...COLORS.green);
  doc.rect(lx, ly, 3, 3, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...COLORS.slate);
  doc.text(`Collected (${pct}%)`, lx + 4.5, ly + 2.5);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.text(`${ugx(input.donut.collected)} UGX`, lx + 4.5, ly + 6.5);
  ly += 12;
  doc.setFillColor(...COLORS.red);
  doc.rect(lx, ly, 3, 3, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...COLORS.slate);
  doc.text(`Outstanding (${100 - pct}%)`, lx + 4.5, ly + 2.5);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.text(`${ugx(input.donut.outstanding)} UGX`, lx + 4.5, ly + 6.5);

  // Top / Bottom agents row
  const tbY = bottomY + 50;
  const tbW = (rightW - 3) / 2;
  // Top
  doc.setFillColor(220, 252, 231);
  doc.setDrawColor(...COLORS.green);
  doc.setLineWidth(0.3);
  (doc as any).roundedRect(rightX, tbY, tbW, 22, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.8);
  doc.setTextColor(...COLORS.green);
  doc.text('TOP PERFORMER', rightX + 3, tbY + 5);
  doc.setFontSize(10);
  doc.setTextColor(...COLORS.slate);
  doc.text((input.top?.name || '—').slice(0, 16), rightX + 3, tbY + 11.5);
  doc.setFontSize(13);
  doc.setTextColor(...COLORS.green);
  doc.text(`${input.top?.rate ?? 0}%`, rightX + 3, tbY + 18);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.setTextColor(...COLORS.muted);
  doc.text('Collection Rate', rightX + 3, tbY + 21);
  // Bottom
  doc.setFillColor(254, 226, 226);
  doc.setDrawColor(...COLORS.red);
  (doc as any).roundedRect(rightX + tbW + 3, tbY, tbW, 22, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.8);
  doc.setTextColor(...COLORS.red);
  doc.text('NEEDS IMPROVEMENT', rightX + tbW + 6, tbY + 5);
  doc.setFontSize(10);
  doc.setTextColor(...COLORS.slate);
  doc.text((input.bottom?.name || '—').slice(0, 16), rightX + tbW + 6, tbY + 11.5);
  doc.setFontSize(13);
  doc.setTextColor(...COLORS.red);
  doc.text(`${input.bottom?.rate ?? 0}%`, rightX + tbW + 6, tbY + 18);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.setTextColor(...COLORS.muted);
  doc.text('Collection Rate', rightX + tbW + 6, tbY + 21);

  // ===== Monthly Trend (new page if needed) =====
  const trendTop = Math.max(ay, tbY + 22) + 6;
  let ty = trendTop;
  const trendH = 38;
  if (ty + trendH > bottomLimit) { doc.addPage(); ty = 10; }

  doc.setFillColor(146, 52, 234);
  doc.rect(margin, ty, contentWidth, 6.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  doc.text('MONTHLY COLLECTION TREND (THIS MONTH)', margin + 3, ty + 4.5);
  ty += 6.5;

  // Plot area
  const plotX = margin + 12;
  const plotY = ty + 3;
  const plotW = contentWidth - 16;
  const plotH = trendH - 8;
  doc.setFillColor(250, 245, 255);
  doc.rect(margin, ty, contentWidth, trendH, 'F');

  const series = input.monthly.length > 0 ? input.monthly : [{ date: '', value: 0 }];
  const maxV = Math.max(1, ...series.map(s => s.value));
  // Y-grid (4 lines)
  doc.setDrawColor(220, 220, 230);
  doc.setLineWidth(0.15);
  for (let i = 0; i <= 4; i++) {
    const yy = plotY + (plotH * i) / 4;
    doc.line(plotX, yy, plotX + plotW, yy);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5.5);
    doc.setTextColor(...COLORS.muted);
    const v = Math.round((maxV * (4 - i)) / 4);
    const lbl = v >= 1_000_000 ? `${(v / 1_000_000).toFixed(0)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(0)}K` : String(v);
    doc.text(lbl, plotX - 1, yy + 1.5, { align: 'right' });
  }
  // Line
  doc.setDrawColor(...COLORS.purple);
  doc.setLineWidth(0.6);
  for (let i = 0; i < series.length - 1; i++) {
    const x1 = plotX + (plotW * i) / Math.max(1, series.length - 1);
    const x2 = plotX + (plotW * (i + 1)) / Math.max(1, series.length - 1);
    const y1 = plotY + plotH - (plotH * series[i].value) / maxV;
    const y2 = plotY + plotH - (plotH * series[i + 1].value) / maxV;
    doc.line(x1, y1, x2, y2);
  }
  // X labels (every ~5)
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(5.5);
  doc.setTextColor(...COLORS.muted);
  const step = Math.max(1, Math.floor(series.length / 6));
  for (let i = 0; i < series.length; i += step) {
    const x = plotX + (plotW * i) / Math.max(1, series.length - 1);
    doc.text(series[i].date, x, plotY + plotH + 4, { align: 'center' });
  }
  // End label
  if (series.length > 0) {
    const last = series[series.length - 1];
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.purple);
    doc.text(`${ugx(last.value)} UGX`, plotX + plotW, plotY + 2, { align: 'right' });
  }

  // ===== Footer (page numbers) =====
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(150, 150, 158);
    doc.text(
      `Generated by Welile Technologies Ltd. • ${format(new Date(), 'PPpp')}`,
      margin,
      pageHeight - 5,
    );
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - margin, pageHeight - 5, { align: 'right' });
  }

  return doc.output('blob');
}