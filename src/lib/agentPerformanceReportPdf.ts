import { format } from 'date-fns';

export interface AgentPerfRow {
  rank: number;
  agent_name: string;
  tenants_paid: number;
  tenants_total: number;
  pct_paid: number;
  collected: number;
  payments: number;
  commission: number;
  interest: number;
  wallet_total: number;
  rate: number;
  status: 'critical' | 'low' | 'moderate' | 'good' | 'excellent';
  source_breakdown?: { agent_collections: number; repayments: number; merchant: number };
  daily_portfolio?: number;
  expected_weekly?: number;
  efficiency?: number;
  gap?: number;
  daily_collection?: number;
  daily_commission?: number;
  rent_paid_out?: number;
  conversion_pct?: number;
}

export interface AgentPerfTotals {
  collected: number;
  payments: number;
  commission: number;
  interest: number;
  wallet_total: number;
  tenants_paid: number;
  tenants_total: number;
  daily_portfolio?: number;
  expected_weekly?: number;
  gap?: number;
  daily_collection?: number;
  daily_commission?: number;
  rent_paid_out?: number;
}

const STATUS_LABEL: Record<AgentPerfRow['status'], string> = {
  critical: 'Critical',
  low: 'Low',
  moderate: 'Moderate',
  good: 'Good',
  excellent: 'Excellent',
};
const STATUS_COLOR: Record<AgentPerfRow['status'], [number, number, number]> = {
  critical: [220, 38, 38],
  low: [234, 88, 12],
  moderate: [202, 138, 4],
  good: [22, 163, 74],
  excellent: [16, 122, 87],
};

const fmtN = (n: number) => Math.round(n).toLocaleString();
const fmtPct = (n: number) => `${n.toFixed(1)}%`;

export async function generateAgentPerformancePdf(opts: {
  rows: AgentPerfRow[];
  totals: AgentPerfTotals;
  periodLabel: string;
  startDate: Date;
  endDate: Date;
}): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 8;

  // Header band
  pdf.setFillColor(146, 52, 234);
  pdf.rect(0, 0, pw, 22, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(14);
  pdf.text('Welile — Agent Performance & Wallet Earnings', margin, 10);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.text(opts.periodLabel, margin, 17);
  pdf.setFontSize(8);
  pdf.text(`Generated ${format(new Date(), 'dd MMM yyyy HH:mm')}`, pw - margin, 17, { align: 'right' });

  // Column layout (mm)
  const cols = [
    { k: 'rank',         w: 8,  align: 'center', label: '#' },
    { k: 'agent',        w: 50, align: 'left',   label: 'Agent' },
    { k: 'tenants',      w: 24, align: 'center', label: 'Tenants Paid' },
    { k: 'pct_paid',     w: 18, align: 'right',  label: '% Paid' },
    { k: 'collected',    w: 28, align: 'right',  label: 'Collected' },
    { k: 'payments',     w: 18, align: 'right',  label: 'Payments' },
    { k: 'commission',   w: 28, align: 'right',  label: '10% Commission' },
    { k: 'interest',     w: 26, align: 'right',  label: '0.5% Interest' },
    { k: 'wallet_total', w: 28, align: 'right',  label: 'Total Wallet' },
    { k: 'rate',         w: 18, align: 'right',  label: '% Rate' },
    { k: 'status',       w: 22, align: 'center', label: 'Status' },
  ] as const;

  const tableX = margin;
  const tableW = cols.reduce((s, c) => s + c.w, 0);
  const rowH = 7;
  let y = 28;

  const drawHeader = () => {
    pdf.setFillColor(37, 99, 235);
    pdf.rect(tableX, y, tableW, rowH, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    let x = tableX;
    cols.forEach(c => {
      const tx = c.align === 'right' ? x + c.w - 2 : c.align === 'center' ? x + c.w / 2 : x + 2;
      pdf.text(c.label, tx, y + 4.7, { align: c.align as any });
      x += c.w;
    });
    y += rowH;
  };

  drawHeader();

  const drawCell = (text: string, x: number, w: number, align: string, color?: [number, number, number]) => {
    if (color) pdf.setTextColor(...color);
    else pdf.setTextColor(30, 41, 59);
    const tx = align === 'right' ? x + w - 2 : align === 'center' ? x + w / 2 : x + 2;
    pdf.text(text, tx, y + 4.7, { align: align as any });
  };

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);

  opts.rows.forEach((r, i) => {
    if (y + rowH > ph - 14) {
      pdf.addPage();
      y = 12;
      drawHeader();
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
    }
    // Zebra
    if (i % 2 === 0) {
      pdf.setFillColor(248, 250, 252);
      pdf.rect(tableX, y, tableW, rowH, 'F');
    }
    let x = tableX;
    const values: { v: string; color?: [number, number, number] }[] = [
      { v: String(r.rank) },
      { v: r.agent_name.substring(0, 32) },
      { v: `${r.tenants_paid}/${r.tenants_total}` },
      { v: fmtPct(r.pct_paid) },
      { v: fmtN(r.collected) },
      { v: String(r.payments) },
      { v: fmtN(r.commission) },
      { v: fmtN(r.interest) },
      { v: fmtN(r.wallet_total) },
      { v: fmtPct(r.rate) },
      { v: STATUS_LABEL[r.status], color: STATUS_COLOR[r.status] },
    ];
    cols.forEach((c, idx) => {
      const isStatus = c.k === 'status';
      if (isStatus) pdf.setFont('helvetica', 'bold');
      drawCell(values[idx].v, x, c.w, c.align, values[idx].color);
      if (isStatus) pdf.setFont('helvetica', 'normal');
      x += c.w;
    });
    y += rowH;
  });

  // Totals row
  if (y + rowH > ph - 14) { pdf.addPage(); y = 12; drawHeader(); }
  pdf.setFillColor(219, 234, 254);
  pdf.rect(tableX, y, tableW, rowH, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(30, 64, 175);
  let x = tableX;
  const tVals = [
    '', 'TOTALS',
    `${opts.totals.tenants_paid}/${opts.totals.tenants_total}`,
    opts.totals.tenants_total ? fmtPct((opts.totals.tenants_paid / opts.totals.tenants_total) * 100) : '0.0%',
    fmtN(opts.totals.collected),
    String(opts.totals.payments),
    fmtN(opts.totals.commission),
    fmtN(opts.totals.interest),
    fmtN(opts.totals.wallet_total),
    opts.totals.collected ? fmtPct((opts.totals.wallet_total / opts.totals.collected) * 100) : '0.0%',
    '',
  ];
  cols.forEach((c, idx) => {
    drawCell(tVals[idx], x, c.w, c.align);
    x += c.w;
  });
  y += rowH + 2;

  // Footer
  const pageCount = (pdf as any).internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    pdf.setPage(i);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(100, 116, 139);
    pdf.text(`Generated by Welile · ${format(new Date(), 'dd MMM yyyy HH:mm')}`, margin, ph - 5);
    pdf.text(`Page ${i} of ${pageCount}`, pw - margin, ph - 5, { align: 'right' });
  }

  return pdf.output('blob');
}
