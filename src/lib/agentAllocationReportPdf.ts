import { format } from 'date-fns';

export type AllocStatus = 'on_track' | 'slow' | 'behind' | 'default_risk' | 'completed';

export interface AllocTenantRow {
  request_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string;
  start_date: string | null;
  rent_given: number;
  daily: number;
  duration_days: number;
  paid: number;
  outstanding: number;
  pct_paid: number;
  last_payment: string | null;
  days_overdue: number;
  status: AllocStatus;
}

export interface AllocAgentBlock {
  agent_id: string;
  agent_name: string;
  agent_phone: string;
  tenants: AllocTenantRow[];
  totals: {
    allocated: number;
    repaid: number;
    outstanding: number;
    collection_rate: number;
    on_time_pct: number;
    default_pct: number;
  };
  status: 'excellent' | 'good' | 'watch' | 'critical';
}

const STATUS_LABEL: Record<AllocStatus, string> = {
  on_track: 'On Track',
  slow: 'Slow',
  behind: 'Behind',
  default_risk: 'Default Risk',
  completed: 'Completed',
};
const STATUS_COLOR: Record<AllocStatus, [number, number, number]> = {
  on_track: [22, 163, 74],
  slow: [202, 138, 4],
  behind: [234, 88, 12],
  default_risk: [220, 38, 38],
  completed: [37, 99, 235],
};
const AGENT_BADGE_LABEL: Record<AllocAgentBlock['status'], string> = {
  excellent: 'Excellent',
  good: 'Good',
  watch: 'Watch',
  critical: 'Critical',
};
const AGENT_BADGE_COLOR: Record<AllocAgentBlock['status'], [number, number, number]> = {
  excellent: [22, 163, 74],
  good: [37, 99, 235],
  watch: [202, 138, 4],
  critical: [220, 38, 38],
};

const fmtN = (n: number) => Math.round(n).toLocaleString();
const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const fmtDate = (s: string | null) => (s ? format(new Date(s), 'dd MMM yy') : '—');

export async function generateAgentAllocationPdf(opts: {
  blocks: AllocAgentBlock[];
  periodLabel: string;
}): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 8;

  const drawHeaderBand = (title: string, subtitle: string) => {
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
  };

  // ============ PAGE 1: MASTER SUMMARY ============
  drawHeaderBand('Welile — Agent Allocations & Tenant Repayment', opts.periodLabel);

  const masterCols = [
    { k: 'rank',    w: 10,  align: 'center', label: '#' },
    { k: 'agent',   w: 55,  align: 'left',   label: 'Agent' },
    { k: 'phone',   w: 30,  align: 'left',   label: 'Phone' },
    { k: 'tenants', w: 18,  align: 'center', label: 'Tenants' },
    { k: 'alloc',   w: 30,  align: 'right',  label: 'Allocated' },
    { k: 'repaid',  w: 30,  align: 'right',  label: 'Repaid' },
    { k: 'out',     w: 30,  align: 'right',  label: 'Outstanding' },
    { k: 'rate',    w: 22,  align: 'right',  label: 'Coll. Rate' },
    { k: 'ontime',  w: 22,  align: 'right',  label: 'On-Time' },
    { k: 'def',     w: 22,  align: 'right',  label: 'Default' },
    { k: 'status',  w: 22,  align: 'center', label: 'Status' },
  ] as const;

  const tableX = margin;
  const tableW = masterCols.reduce((s, c) => s + c.w, 0);
  const rowH = 7;
  let y = 28;

  const drawMasterHeader = () => {
    pdf.setFillColor(37, 99, 235);
    pdf.rect(tableX, y, tableW, rowH, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    let x = tableX;
    masterCols.forEach(c => {
      const tx = c.align === 'right' ? x + c.w - 2 : c.align === 'center' ? x + c.w / 2 : x + 2;
      pdf.text(c.label, tx, y + 4.7, { align: c.align as any });
      x += c.w;
    });
    y += rowH;
  };
  drawMasterHeader();

  const drawCell = (text: string, x: number, w: number, align: string, color?: [number, number, number]) => {
    if (color) pdf.setTextColor(...color);
    else pdf.setTextColor(30, 41, 59);
    const tx = align === 'right' ? x + w - 2 : align === 'center' ? x + w / 2 : x + 2;
    pdf.text(text, tx, y + 4.7, { align: align as any });
  };

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);

  let masterTotals = { alloc: 0, repaid: 0, out: 0, tenants: 0 };

  opts.blocks.forEach((b, i) => {
    if (y + rowH > ph - 14) { pdf.addPage(); y = 12; drawMasterHeader(); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); }
    if (i % 2 === 0) {
      pdf.setFillColor(248, 250, 252);
      pdf.rect(tableX, y, tableW, rowH, 'F');
    }
    let x = tableX;
    const vals: { v: string; color?: [number, number, number] }[] = [
      { v: String(i + 1) },
      { v: b.agent_name.substring(0, 36) },
      { v: (b.agent_phone || '—').substring(0, 18) },
      { v: String(b.tenants.length) },
      { v: fmtN(b.totals.allocated) },
      { v: fmtN(b.totals.repaid) },
      { v: fmtN(b.totals.outstanding) },
      { v: fmtPct(b.totals.collection_rate) },
      { v: fmtPct(b.totals.on_time_pct) },
      { v: fmtPct(b.totals.default_pct) },
      { v: AGENT_BADGE_LABEL[b.status], color: AGENT_BADGE_COLOR[b.status] },
    ];
    masterCols.forEach((c, idx) => {
      const isStatus = c.k === 'status';
      if (isStatus) pdf.setFont('helvetica', 'bold');
      drawCell(vals[idx].v, x, c.w, c.align, vals[idx].color);
      if (isStatus) pdf.setFont('helvetica', 'normal');
      x += c.w;
    });
    y += rowH;
    masterTotals.alloc += b.totals.allocated;
    masterTotals.repaid += b.totals.repaid;
    masterTotals.out += b.totals.outstanding;
    masterTotals.tenants += b.tenants.length;
  });

  // Master totals row
  if (y + rowH > ph - 14) { pdf.addPage(); y = 12; drawMasterHeader(); }
  pdf.setFillColor(219, 234, 254);
  pdf.rect(tableX, y, tableW, rowH, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(30, 64, 175);
  let mx = tableX;
  const masterRate = masterTotals.alloc ? (masterTotals.repaid / masterTotals.alloc) * 100 : 0;
  const tVals = ['', 'TOTALS', '', String(masterTotals.tenants), fmtN(masterTotals.alloc), fmtN(masterTotals.repaid), fmtN(masterTotals.out), fmtPct(masterRate), '', '', ''];
  masterCols.forEach((c, idx) => { drawCell(tVals[idx], mx, c.w, c.align); mx += c.w; });

  // ============ PER-AGENT SECTIONS ============
  const tenantCols = [
    { k: 'idx',     w: 10,  align: 'center', label: '#' },
    { k: 'tenant',  w: 50,  align: 'left',   label: 'Tenant' },
    { k: 'phone',   w: 28,  align: 'left',   label: 'Phone' },
    { k: 'start',   w: 22,  align: 'center', label: 'Start' },
    { k: 'rent',    w: 26,  align: 'right',  label: 'Rent Given' },
    { k: 'daily',   w: 22,  align: 'right',  label: 'Daily' },
    { k: 'days',    w: 14,  align: 'right',  label: 'Days' },
    { k: 'paid',    w: 26,  align: 'right',  label: 'Paid' },
    { k: 'out',     w: 26,  align: 'right',  label: 'Outstanding' },
    { k: 'pct',     w: 18,  align: 'right',  label: '% Paid' },
    { k: 'last',    w: 22,  align: 'center', label: 'Last Pmt' },
    { k: 'overdue', w: 16,  align: 'right',  label: 'Overdue' },
    { k: 'status',  w: 24,  align: 'center', label: 'Status' },
  ] as const;
  const tenantTableW = tenantCols.reduce((s, c) => s + c.w, 0);

  const drawTenantHeader = () => {
    pdf.setFillColor(37, 99, 235);
    pdf.rect(tableX, y, tenantTableW, rowH, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7.5);
    let x = tableX;
    tenantCols.forEach(c => {
      const tx = c.align === 'right' ? x + c.w - 2 : c.align === 'center' ? x + c.w / 2 : x + 2;
      pdf.text(c.label, tx, y + 4.7, { align: c.align as any });
      x += c.w;
    });
    y += rowH;
  };

  opts.blocks.forEach((b) => {
    pdf.addPage();
    y = 12;
    // Agent header band
    pdf.setFillColor(15, 23, 42);
    pdf.rect(0, 0, pw, 18, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.text(b.agent_name, margin, 8);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text(
      `${b.agent_phone || '—'}  ·  ${b.tenants.length} tenants  ·  Allocated UGX ${fmtN(b.totals.allocated)}  ·  Repaid UGX ${fmtN(b.totals.repaid)}  ·  Rate ${fmtPct(b.totals.collection_rate)}  ·  ${AGENT_BADGE_LABEL[b.status]}`,
      margin,
      14,
    );
    y = 22;
    drawTenantHeader();
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);

    b.tenants.forEach((t, i) => {
      if (y + rowH > ph - 14) { pdf.addPage(); y = 12; drawTenantHeader(); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); }
      if (i % 2 === 0) { pdf.setFillColor(248, 250, 252); pdf.rect(tableX, y, tenantTableW, rowH, 'F'); }
      let x = tableX;
      const vals: { v: string; color?: [number, number, number] }[] = [
        { v: String(i + 1) },
        { v: t.tenant_name.substring(0, 32) },
        { v: (t.tenant_phone || '—').substring(0, 16) },
        { v: fmtDate(t.start_date) },
        { v: fmtN(t.rent_given) },
        { v: fmtN(t.daily) },
        { v: String(t.duration_days || 0) },
        { v: fmtN(t.paid) },
        { v: fmtN(t.outstanding) },
        { v: fmtPct(t.pct_paid) },
        { v: fmtDate(t.last_payment) },
        { v: t.days_overdue > 0 ? String(t.days_overdue) : '—', color: t.days_overdue > 7 ? [220, 38, 38] : undefined },
        { v: STATUS_LABEL[t.status], color: STATUS_COLOR[t.status] },
      ];
      tenantCols.forEach((c, idx) => {
        const isStatus = c.k === 'status';
        if (isStatus) pdf.setFont('helvetica', 'bold');
        drawCell(vals[idx].v, x, c.w, c.align, vals[idx].color);
        if (isStatus) pdf.setFont('helvetica', 'normal');
        x += c.w;
      });
      y += rowH;
    });
  });

  // Footer on all pages
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