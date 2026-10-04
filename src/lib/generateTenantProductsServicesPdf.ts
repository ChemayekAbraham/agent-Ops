import jsPDF from 'jspdf';
import { format } from 'date-fns';

export interface TpsPeriod {
  from: string;
  to: string;
  days: number;
  timezone: string;
  previous_from: string;
  previous_to: string;
}

export interface TpsMetrics {
  new_tenants: number;
  total_tenants: number;
  applications: number;
  accepted: number;
  rejected: number;
  active_tenants: number;
  collected: number;
  payments: number;
  payables: number;
  payable_tenants: number;
}

export interface TpsReport {
  period: TpsPeriod;
  current: TpsMetrics;
  previous: TpsMetrics;
  outstanding_payables: number;
  outstanding_payables_count: number;
  tenant_register_total: number;
  series: Array<{
    day: string;
    new_tenants: number;
    applications: number;
    accepted: number;
    rejected: number;
    paid_tenants: number;
    collected: number;
    payables: number;
  }>;
  application_status: Array<{ status: string; n: number }>;
  districts: Array<{ district: string; paying_tenants: number; collected: number }>;
  generated_at: string;
}

export interface TpsTenantRow {
  tenant_name: string;
  tenant_phone: string | null;
  district: string | null;
  agent_name: string | null;
  application_status: string | null;
  paid_in_period: number;
  payments_in_period: number;
  payables_in_period: number;
  outstanding: number;
  is_new_in_period: boolean;
}

/** Percentage change that never renders NaN / Infinity. */
export function pctChange(current: number, previous: number): number | null {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p === 0) return c === 0 ? 0 : null; // null = "new" (no comparable base)
  return ((c - p) / p) * 100;
}

export function pctLabel(current: number, previous: number): string {
  const v = pctChange(current, previous);
  if (v === null) return 'new';
  const s = v > 0 ? '+' : '';
  return `${s}${v.toFixed(1)}%`;
}

export const tpsUgx = (n: any) => `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;
const num = (n: any) => Math.round(Number(n) || 0).toLocaleString();

export function generateTenantProductsServicesPdf(opts: {
  report: TpsReport;
  rows: TpsTenantRow[];
  actor: string;
  exportType?: string;
}): Blob {
  const { report, rows, actor } = opts;
  const exportType = opts.exportType || 'PDF';
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const contentWidth = pageWidth - margin * 2;
  let y = 14;

  const brand: [number, number, number] = [88, 28, 135];
  const fmtDay = (d: string) => { try { return format(new Date(`${d}T00:00:00`), 'dd MMM yyyy'); } catch { return d; } };
  const periodLabel = report.period.from === report.period.to
    ? fmtDay(report.period.from)
    : `${fmtDay(report.period.from)} → ${fmtDay(report.period.to)}`;
  const prevLabel = report.period.previous_from === report.period.previous_to
    ? fmtDay(report.period.previous_from)
    : `${fmtDay(report.period.previous_from)} → ${fmtDay(report.period.previous_to)}`;

  const newPage = () => { doc.addPage(); y = 16; };
  const ensure = (h: number) => { if (y + h > pageHeight - 16) newPage(); };

  // ===== Header band =====
  doc.setFillColor(brand[0], brand[1], brand[2]);
  doc.rect(0, 0, pageWidth, 26, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('WELILE', margin, 10);
  doc.setFontSize(13);
  doc.text('TENANT PRODUCTS & SERVICES — DAILY REPORT', margin, 17.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(`Period: ${periodLabel}  ·  ${report.period.days} day(s)  ·  ${report.period.timezone}`, margin, 22.5);
  y = 34;

  doc.setTextColor(90, 90, 100);
  doc.setFontSize(7.5);
  doc.text(`Compared with: ${prevLabel}`, margin, y);
  doc.text(`Reported by: ${actor}`, pageWidth - margin, y, { align: 'right' });
  y += 6;

  // ===== Core mandatory block =====
  const core: Array<[string, string, string]> = [
    ['New Tenants Added', num(report.current.new_tenants), pctLabel(report.current.new_tenants, report.previous.new_tenants)],
    ['Active Tenants Today (paid rent in period)', num(report.current.active_tenants), pctLabel(report.current.active_tenants, report.previous.active_tenants)],
    ['Applications', num(report.current.applications), pctLabel(report.current.applications, report.previous.applications)],
    ['Accepted', num(report.current.accepted), pctLabel(report.current.accepted, report.previous.accepted)],
    ['Rejected', num(report.current.rejected), pctLabel(report.current.rejected, report.previous.rejected)],
    ['Total Rent Collected', tpsUgx(report.current.collected), pctLabel(report.current.collected, report.previous.collected)],
  ];

  doc.setDrawColor(225, 225, 235);
  doc.setFillColor(248, 246, 252);
  doc.roundedRect(margin, y, contentWidth, 8 + core.length * 6.4, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(brand[0], brand[1], brand[2]);
  doc.text('CORE DAILY METRICS', margin + 3, y + 5.5);
  let ry = y + 11.5;
  core.forEach(([label, value, change]) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(40, 40, 50);
    doc.text(label, margin + 3, ry);
    doc.setFont('helvetica', 'bold');
    doc.text(value, margin + contentWidth - 32, ry, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(110, 110, 120);
    doc.text(change, margin + contentWidth - 3, ry, { align: 'right' });
    ry += 6.4;
  });
  y = ry + 4;

  // ===== KPI comparison table =====
  const compRows: Array<[string, string, string, string]> = [
    ['New tenants', num(report.current.new_tenants), num(report.previous.new_tenants), pctLabel(report.current.new_tenants, report.previous.new_tenants)],
    ['Total tenants (register)', num(report.current.total_tenants), num(report.previous.total_tenants), pctLabel(report.current.total_tenants, report.previous.total_tenants)],
    ['Active / paying tenants', num(report.current.active_tenants), num(report.previous.active_tenants), pctLabel(report.current.active_tenants, report.previous.active_tenants)],
    ['Applications', num(report.current.applications), num(report.previous.applications), pctLabel(report.current.applications, report.previous.applications)],
    ['Accepted', num(report.current.accepted), num(report.previous.accepted), pctLabel(report.current.accepted, report.previous.accepted)],
    ['Rejected', num(report.current.rejected), num(report.previous.rejected), pctLabel(report.current.rejected, report.previous.rejected)],
    ['Receivables (rent collected)', tpsUgx(report.current.collected), tpsUgx(report.previous.collected), pctLabel(report.current.collected, report.previous.collected)],
    ['Payments recorded', num(report.current.payments), num(report.previous.payments), pctLabel(report.current.payments, report.previous.payments)],
    ['Landlord payables', tpsUgx(report.current.payables), tpsUgx(report.previous.payables), pctLabel(report.current.payables, report.previous.payables)],
    ['Houses / tenants payable', num(report.current.payable_tenants), num(report.previous.payable_tenants), pctLabel(report.current.payable_tenants, report.previous.payable_tenants)],
  ];

  const drawTable = (
    title: string,
    head: string[],
    widths: number[],
    body: (string | number)[][],
    aligns: ('left' | 'right')[] = [],
  ) => {
    ensure(16 + body.length * 5.2);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(brand[0], brand[1], brand[2]);
    doc.text(title, margin, y);
    y += 3;
    doc.setFillColor(brand[0], brand[1], brand[2]);
    doc.rect(margin, y, contentWidth, 6, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(7.5);
    let x = margin + 2;
    head.forEach((h, i) => {
      const align = aligns[i] === 'right' ? 'right' : 'left';
      doc.text(h, align === 'right' ? x + widths[i] - 4 : x, y + 4, { align });
      x += widths[i];
    });
    y += 6;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(35, 35, 45);
    body.forEach((r, idx) => {
      if (y + 5.2 > pageHeight - 16) {
        newPage();
        doc.setFillColor(brand[0], brand[1], brand[2]);
        doc.rect(margin, y, contentWidth, 6, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        let hx = margin + 2;
        head.forEach((h, i) => {
          const align = aligns[i] === 'right' ? 'right' : 'left';
          doc.text(h, align === 'right' ? hx + widths[i] - 4 : hx, y + 4, { align });
          hx += widths[i];
        });
        y += 6;
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(35, 35, 45);
      }
      if (idx % 2 === 1) {
        doc.setFillColor(248, 248, 252);
        doc.rect(margin, y, contentWidth, 5.2, 'F');
      }
      let cx = margin + 2;
      r.forEach((cell, i) => {
        const align = aligns[i] === 'right' ? 'right' : 'left';
        const text = String(cell ?? '');
        const maxChars = Math.floor(widths[i] / 1.55);
        const shown = text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
        doc.setFontSize(7.2);
        doc.text(shown, align === 'right' ? cx + widths[i] - 4 : cx, y + 3.6, { align });
        cx += widths[i];
      });
      y += 5.2;
    });
    y += 5;
  };

  drawTable(
    'KPI SUMMARY & PERIOD-ON-PERIOD CHANGE',
    ['Metric', 'This period', 'Previous', 'Change'],
    [78, 38, 38, contentWidth - 154],
    compRows as unknown as (string | number)[][],
    ['left', 'right', 'right', 'right'],
  );

  // ===== Financial summary =====
  const netPosition = (Number(report.current.collected) || 0) - (Number(report.current.payables) || 0);
  const avgPerPaying = report.current.active_tenants > 0
    ? (Number(report.current.collected) || 0) / report.current.active_tenants
    : 0;
  const prevAvgPerPaying = report.previous.active_tenants > 0
    ? (Number(report.previous.collected) || 0) / report.previous.active_tenants
    : 0;
  const acceptRate = report.current.applications > 0
    ? (report.current.accepted / report.current.applications) * 100 : 0;
  const rejectRate = report.current.applications > 0
    ? (report.current.rejected / report.current.applications) * 100 : 0;

  drawTable(
    'FINANCIAL SUMMARY — RECEIVABLES & PAYABLES',
    ['Item', 'Value', 'Previous', 'Change'],
    [78, 38, 38, contentWidth - 154],
    [
      ['Receivables — total rent collected', tpsUgx(report.current.collected), tpsUgx(report.previous.collected), pctLabel(report.current.collected, report.previous.collected)],
      ['Paying tenants', num(report.current.active_tenants), num(report.previous.active_tenants), pctLabel(report.current.active_tenants, report.previous.active_tenants)],
      ['Average collection per paying tenant', tpsUgx(avgPerPaying), tpsUgx(prevAvgPerPaying), pctLabel(avgPerPaying, prevAvgPerPaying)],
      ['Payables — landlord payouts raised', tpsUgx(report.current.payables), tpsUgx(report.previous.payables), pctLabel(report.current.payables, report.previous.payables)],
      ['Tenants / houses behind payables', num(report.current.payable_tenants), num(report.previous.payable_tenants), pctLabel(report.current.payable_tenants, report.previous.payable_tenants)],
      ['Net position (receivables − payables)', tpsUgx(netPosition), '—', '—'],
      ['Outstanding payables (not yet completed, all time)', tpsUgx(report.outstanding_payables), `${num(report.outstanding_payables_count)} payouts`, '—'],
      ['Acceptance rate', `${acceptRate.toFixed(1)}%`, '—', '—'],
      ['Rejection rate', `${rejectRate.toFixed(1)}%`, '—', '—'],
      ['Tenant register (all tenant accounts)', num(report.tenant_register_total), '—', '—'],
    ] as unknown as (string | number)[][],
    ['left', 'right', 'right', 'right'],
  );

  // ===== Daily trend (chart substitute: bar chart drawn natively) =====
  if (report.series.length > 1) {
    ensure(56);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(brand[0], brand[1], brand[2]);
    doc.text('DAILY RENT COLLECTED', margin, y);
    y += 4;
    const chartH = 32;
    const chartW = contentWidth;
    const max = Math.max(...report.series.map(s => Number(s.collected) || 0), 1);
    const barW = Math.max(1.2, Math.min(9, (chartW - 4) / report.series.length - 1.5));
    const step = (chartW - 4) / report.series.length;
    doc.setDrawColor(230, 230, 238);
    doc.rect(margin, y, chartW, chartH);
    report.series.forEach((s, i) => {
      const h = ((Number(s.collected) || 0) / max) * (chartH - 4);
      const x = margin + 2 + i * step;
      doc.setFillColor(brand[0], brand[1], brand[2]);
      doc.rect(x, y + chartH - h, barW, h, 'F');
    });
    y += chartH + 3;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(120, 120, 130);
    doc.text(fmtDay(report.series[0].day), margin, y);
    doc.text(`peak ${tpsUgx(max)}`, margin + contentWidth / 2, y, { align: 'center' });
    doc.text(fmtDay(report.series[report.series.length - 1].day), margin + contentWidth, y, { align: 'right' });
    y += 6;

    drawTable(
      'DAILY BREAKDOWN',
      ['Day', 'New', 'Apps', 'Acc', 'Rej', 'Paid tenants', 'Collected', 'Payables'],
      [30, 14, 14, 14, 14, 26, 38, contentWidth - 150],
      report.series.map(s => [
        fmtDay(s.day), num(s.new_tenants), num(s.applications), num(s.accepted), num(s.rejected),
        num(s.paid_tenants), tpsUgx(s.collected), tpsUgx(s.payables),
      ]),
      ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
    );
  }

  // ===== Application status distribution =====
  if (report.application_status.length) {
    drawTable(
      'APPLICATION STATUS DISTRIBUTION (applied in period)',
      ['Status', 'Applications', 'Share'],
      [80, 40, contentWidth - 120],
      report.application_status.map(a => [
        String(a.status || '—').replace(/_/g, ' '),
        num(a.n),
        `${report.current.applications > 0 ? ((Number(a.n) / report.current.applications) * 100).toFixed(1) : '0.0'}%`,
      ]),
      ['left', 'right', 'right'],
    );
  }

  // ===== District performance =====
  if (report.districts.length) {
    drawTable(
      'TOP DISTRICTS BY COLLECTIONS',
      ['District', 'Paying tenants', 'Collected'],
      [80, 40, contentWidth - 120],
      report.districts.map(d => [d.district || 'Unmapped', num(d.paying_tenants), tpsUgx(d.collected)]),
      ['left', 'right', 'right'],
    );
  }

  // ===== Tenant detail =====
  if (rows.length) {
    drawTable(
      `TENANT ACTIVITY DETAIL (${num(rows.length)} record${rows.length === 1 ? '' : 's'})`,
      ['Tenant', 'Phone', 'District', 'Agent', 'Status', 'Collected', 'Payables', 'Outstanding'],
      [34, 24, 22, 26, 22, 22, 20, contentWidth - 170],
      rows.map(r => [
        r.tenant_name || '—',
        r.tenant_phone || '—',
        r.district || '—',
        r.agent_name || '—',
        String(r.application_status || '—').replace(/_/g, ' '),
        tpsUgx(r.paid_in_period),
        tpsUgx(r.payables_in_period),
        tpsUgx(r.outstanding),
      ]),
      ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'right'],
    );
  }

  // ===== Audit footer on every page =====
  const pages = doc.getNumberOfPages();
  const generated = (() => {
    try { return format(new Date(report.generated_at), 'dd MMM yyyy HH:mm:ss'); } catch { return report.generated_at; }
  })();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    doc.setDrawColor(230, 230, 238);
    doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(120, 120, 130);
    doc.text(
      `Tenant Products & Services — Daily Report · Period ${periodLabel} · Generated ${generated} (${report.period.timezone}) · Reported by ${actor} · Export ${exportType} · Source: Welile production ledger, rent requests, agent collections & landlord payouts`,
      margin,
      pageHeight - 8,
      { maxWidth: contentWidth },
    );
    doc.text(`Page ${p} of ${pages}`, pageWidth - margin, pageHeight - 4, { align: 'right' });
  }

  return doc.output('blob');
}
