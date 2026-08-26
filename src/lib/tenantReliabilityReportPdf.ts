import jsPDF from 'jspdf';
import { format } from 'date-fns';
import type { ReliabilityRow } from '@/hooks/useTenantRepaymentReliability';

/**
 * Repayment Reliability Score report.
 *
 * Layout, header, KPI cards, breakdown table and detail table mirror
 * `generateTenantOpsToolReportPdf` (the Tenant Ops report standard). Nothing is
 * recomputed here beyond simple aggregation of the rows handed in: every score,
 * band, coverage and outstanding figure is the server-computed value already
 * shown on screen.
 */

export interface ReliabilityReportMeta {
  band?: string | null;
  search?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  /** Total scored plans before the on-screen filters were applied. */
  totalScored?: number;
  outstandingTotal?: number;
  generatedBy?: string | null;
}

type Align = 'left' | 'right';

const ACCENT: [number, number, number] = [22, 132, 108];

const ugx = (n: any) => `UGX ${Math.round(Number(n || 0)).toLocaleString()}`;
const num = (n: any) => Math.round(Number(n || 0)).toLocaleString();
const txt = (s: any, fallback = '—') => {
  const v = (s ?? '').toString().trim();
  return v.length ? v : fallback;
};
const dt = (d: any) => {
  if (!d) return '—';
  try { return format(new Date(d), 'dd MMM yyyy'); } catch { return '—'; }
};
const sum = (rows: ReliabilityRow[], k: keyof ReliabilityRow) =>
  rows.reduce((s, r) => s + Number((r[k] as any) || 0), 0);
const avg = (rows: ReliabilityRow[], pick: (r: ReliabilityRow) => number) =>
  rows.length ? Math.round(rows.reduce((s, r) => s + pick(r), 0) / rows.length) : 0;

const BAND_LABEL: Record<ReliabilityRow['band'], string> = {
  excellent: 'Gold — pays daily (0–1 missed)',
  good: 'Reliable — 1–3 missed days',
  watch: 'Watch — 4–7 missed days',
  risk: 'At risk — 8+ missed days',
};
const BAND_ORDER: ReliabilityRow['band'][] = ['excellent', 'good', 'watch', 'risk'];
const BAND_RGB: Record<ReliabilityRow['band'], [number, number, number]> = {
  excellent: [16, 145, 105],
  good: [101, 163, 13],
  watch: [217, 119, 6],
  risk: [220, 38, 38],
};

const SCORE_BUCKETS = [
  { label: '0–39', test: (s: number) => s < 40 },
  { label: '40–59', test: (s: number) => s >= 40 && s < 60 },
  { label: '60–74', test: (s: number) => s >= 60 && s < 75 },
  { label: '75–89', test: (s: number) => s >= 75 && s < 90 },
  { label: '90–100', test: (s: number) => s >= 90 },
];

export function generateTenantReliabilityReportPdf(
  rows: ReliabilityRow[],
  meta: ReliabilityReportMeta,
): Blob {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 10;
  const contentWidth = pageWidth - margin * 2;
  let y = 14;

  const bottomLimit = pageHeight - 12;
  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  const ensure = (needed: number, onNewPage?: () => void) => {
    if (y + needed > bottomLimit) { doc.addPage(); y = 14; onNewPage?.(); }
  };

  // ─── Header ───
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(20, 40, 120);
  doc.text('WELILE', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 120);
  doc.text(format(new Date(), 'dd MMM yyyy, hh:mm a'), pageWidth - margin, y, { align: 'right' });

  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(19);
  doc.setTextColor(15, 23, 42);
  doc.text('Tenant Operations — Repayment Reliability Score', margin, y);

  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 120);
  doc.text(
    'Score per active rent plan: coverage 45 · missed-day discipline 25 · payment recency 20 · plan progress 10. '
    + 'Dates in this report use the rent plan start date.',
    margin, y,
  );

  y += 4.2;
  const filterBits: string[] = [
    `Period: ${meta.dateFrom ? dt(meta.dateFrom) : 'All time'} to ${meta.dateTo ? dt(meta.dateTo) : 'Today'}`,
    `Band: ${!meta.band || meta.band === 'all' ? 'All' : BAND_LABEL[meta.band as ReliabilityRow['band']] ?? meta.band}`,
  ];
  if (meta.search) filterBits.push(`Search: "${meta.search}"`);
  if (meta.generatedBy) filterBits.push(`Prepared by: ${meta.generatedBy}`);
  doc.setFont('helvetica', 'italic');
  doc.text(filterBits.join('   •   '), margin, y);

  if (typeof meta.totalScored === 'number' && meta.totalScored > rows.length) {
    y += 4.2;
    doc.setFont('helvetica', 'normal');
    doc.text(
      `Scope: ${rows.length.toLocaleString()} of ${meta.totalScored.toLocaleString()} scored active plans match these filters.`,
      margin, y,
    );
  }

  y += 4;
  doc.setDrawColor(225, 227, 232);
  doc.setLineWidth(0.3);
  doc.line(margin, y, pageWidth - margin, y);
  y += 6;

  const sectionHeading = (label: string, size = 10) => {
    ensure(16);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(15, 23, 42);
    doc.text(label, margin, y);
    y += 4;
  };

  // ─── KPI cards (mirrors the on-page KPI strip + score summary) ───
  const reliableCount = rows.filter(r => r.reliable).length;
  const cards: { label: string; value: string }[] = [
    { label: 'PLANS SCORED', value: num(rows.length) },
    { label: 'MARKED RELIABLE', value: `${num(reliableCount)} / ${num(rows.length)}` },
    { label: 'AVERAGE SCORE', value: `${avg(rows, r => r.score)}/100` },
    { label: 'AVG COVERAGE', value: `${avg(rows, r => r.coverage_pct)}%` },
    { label: 'AVG MISSED DAYS', value: num(avg(rows, r => r.missed_days)) },
    { label: 'RENT ON BOOK', value: ugx(sum(rows, 'rent_amount')) },
    { label: 'OUTSTANDING', value: ugx(sum(rows, 'outstanding')) },
    { label: 'DAILY DUE', value: ugx(sum(rows, 'daily')) },
  ];
  ensure(22);
  const cardGap = 2.5;
  const cardW = (contentWidth - cardGap * (cards.length - 1)) / cards.length;
  const cardH = 16;
  cards.forEach((c, i) => {
    const x = margin + i * (cardW + cardGap);
    doc.setFillColor(248, 249, 252);
    doc.setDrawColor(225, 227, 232);
    doc.setLineWidth(0.2);
    (doc as any).roundedRect(x, y, cardW, cardH, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6);
    doc.setTextColor(120, 122, 135);
    doc.text(c.label, x + 3, y + 5.5);
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text(clip(c.value, 18), x + 3, y + 12);
  });
  y += cardH + 6;

  // ─── Band breakdown table ───
  const bandRows = BAND_ORDER
    .map(b => ({ band: b, set: rows.filter(r => r.band === b) }))
    .filter(g => g.set.length > 0);

  if (bandRows.length) {
    sectionHeading('Reliability band breakdown');
    const bCols: { label: string; w: number; align: Align }[] = [
      { label: 'Band', w: 70, align: 'left' },
      { label: 'Plans', w: 22, align: 'right' },
      { label: 'Share', w: 22, align: 'right' },
      { label: 'Avg score', w: 26, align: 'right' },
      { label: 'Avg missed', w: 26, align: 'right' },
      { label: 'Avg coverage', w: 30, align: 'right' },
      { label: 'Outstanding (UGX)', w: 42, align: 'right' },
    ];
    const bWidth = bCols.reduce((s, c) => s + c.w, 0);
    const bHead = () => {
      doc.setFillColor(...ACCENT);
      doc.rect(margin, y, bWidth, 6, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(255, 255, 255);
      let x = margin;
      bCols.forEach(c => {
        doc.text(c.label, c.align === 'right' ? x + c.w - 1.5 : x + 1.5, y + 4, { align: c.align });
        x += c.w;
      });
      y += 6;
   
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
    };
    bHead();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    bandRows.forEach((g, i) => {
      ensure(6, bHead);
      if (i % 2 === 1) {
        doc.setFillColor(248, 249, 252);
        doc.rect(margin, y, bWidth, 5.2, 'F');
      }
      doc.setTextColor(30, 35, 50);
      const vals = [
        clip(BAND_LABEL[g.band], 40),
        num(g.set.length),
        `${rows.length ? Math.round((g.set.length / rows.length) * 100) : 0}%`,
        `${avg(g.set, r => r.score)}`,
        num(avg(g.set, r => r.missed_days)),
        `${avg(g.set, r => r.coverage_pct)}%`,
        num(sum(g.set, 'outstanding')),
      ];
      let x = margin;
      bCols.forEach((c, ci) => {
        doc.text(vals[ci], c.align === 'right' ? x + c.w - 1.5 : x + 1.5, y + 3.7, { align: c.align });
        x += c.w;
      });
      y += 5.2;
    });
    y += 6;
  }

  // ─── Charts: band mix + score distribution ───
  if (rows.length) {
    ensure(46);
    const chartGap = 8;
    const chartW = (contentWidth - chartGap) / 2;
    const chartH = 34;
    const chartTop = y;

    const drawFrame = (x: number, title: string) => {
      doc.setFillColor(252, 253, 255);
      doc.setDrawColor(225, 227, 232);
      doc.setLineWidth(0.2);
      (doc as any).roundedRect(x, chartTop, chartW, chartH + 10, 2, 2, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(15, 23, 42);
      doc.text(title, x + 3, chartTop + 5.5);
    };

    // Left: band mix (horizontal bars)
    drawFrame(margin, 'Band mix');
    let by = chartTop + 10;
    const labelW = 34;
    const barMax = chartW - labelW - 24;
    BAND_ORDER.forEach(b => {
      const count = rows.filter(r => r.band === b).length;
      const pct = rows.length ? count / rows.length : 0;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(90, 95, 110);
      doc.text(clip(BAND_LABEL[b].split(' — ')[0], 16), margin + 3, by + 3.4);
      doc.setFillColor(235, 237, 242);
      doc.rect(margin + labelW, by, barMax, 4, 'F');
      if (pct > 0) {
        doc.setFillColor(...BAND_RGB[b]);
        doc.rect(margin + labelW, by, Math.max(0.6, barMax * pct), 4, 'F');
      }
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(30, 35, 50);
      doc.text(
        `${num(count)} · ${Math.round(pct * 100)}%`,
        margin + chartW - 3, by + 3.4, { align: 'right' },
      );
      by += 6.5;
    });

    // Right: score distribution (vertical bars)
    const rx = margin + chartW + chartGap;
    drawFrame(rx, 'Score distribution');
    const buckets = SCORE_BUCKETS.map(b => ({ label: b.label, count: rows.filter(r => b.test(r.score)).length }));
    const maxCount = Math.max(1, ...buckets.map(b => b.count));
    const plotBottom = chartTop + chartH + 3;
    const plotH = chartH - 10;
    const slot = (chartW - 8) / buckets.length;
    buckets.forEach((b, i) => {
      const bw = slot * 0.55;
      const bx = rx + 4 + i * slot + (slot - bw) / 2;
      const bh = Math.max(0.6, (b.count / maxCount) * plotH);
      doc.setFillColor(22, 132, 108);
      doc.rect(bx, plotBottom - bh, bw, bh, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6);
      doc.setTextColor(30, 35, 50);
      doc.text(num(b.count), bx + bw / 2, plotBottom - bh - 1.2, { align: 'center' });
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(110, 110, 120);
      doc.text(b.label, bx + bw / 2, plotBottom + 4, { align: 'center' });
    });
    doc.setDrawColor(225, 227, 232);
    doc.setLineWidth(0.2);
    doc.line(rx + 3, plotBottom, rx + chartW - 3, plotBottom);

    y = chartTop + chartH + 16;
  }

  // ─── Agent rollup ───
  const agentGroups = new Map<string, ReliabilityRow[]>();
  rows.forEach(r => {
    const k = txt(r.agent_name, 'Unassigned');
    const cur = agentGroups.get(k) || [];
    cur.push(r);
    agentGroups.set(k, cur);
  });
  const agentRows = Array.from(agentGroups.entries()).sort((a, b) => b[1].length - a[1].length);

  if (agentRows.length) {
    sectionHeading('Reliability by agent');
    const aCols: { label: string; w: number; align: Align }[] = [
      { label: 'Agent', w: 62, align: 'left' },
      { label: 'Plans', w: 20, align: 'right' },
      { label: 'Reliable', w: 24, align: 'right' },
      { label: 'Avg score', w: 26, align: 'right' },
      { label: 'Avg missed', w: 26, align: 'right' },
      { label: 'At risk', w: 22, align: 'right' },
      { label: 'Outstanding (UGX)', w: 42, align: 'right' },
    ];
    const aWidth = aCols.reduce((s, c) => s + c.w, 0);
    const aHead = () => {
      doc.setFillColor(...ACCENT);
      doc.rect(margin, y, aWidth, 6, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(255, 255, 255);
      let x = margin;
      aCols.forEach(c => {
        doc.text(c.label, c.align === 'right' ? x + c.w - 1.5 : x + 1.5, y + 4, { align: c.align });
        x += c.w;
      });
      y += 6;
   
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
    };
    aHead();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    agentRows.slice(0, 25).forEach(([name, set], i) => {
      ensure(6, aHead);
      if (i % 2 === 1) {
        doc.setFillColor(248, 249, 252);
        doc.rect(margin, y, aWidth, 5.2, 'F');
      }
      doc.setTextColor(30, 35, 50);
      const vals = [
        clip(name, 36),
        num(set.length),
        num(set.filter(r => r.reliable).length),
        `${avg(set, r => r.score)}`,
        num(avg(set, r => r.missed_days)),
        num(set.filter(r => r.band === 'risk').length),
        num(sum(set, 'outstanding')),
      ];
      let x = margin;
      aCols.forEach((c, ci) => {
        doc.text(vals[ci], c.align === 'right' ? x + c.w - 1.5 : x + 1.5, y + 3.7, { align: c.align });
        x += c.w;
      });
      y += 5.2;
    });
    if (agentRows.length > 25) {
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(120, 122, 135);
      doc.text(`+ ${agentRows.length - 25} more agents (full detail in the record list below)`, margin, y + 3.5);
      y += 5.2;
    }
    y += 6;
  }

  // ─── Detail table ───
  sectionHeading(`Scored plans (${rows.length.toLocaleString()})`);
  const cols: { label: string; w: number; align?: Align; get: (r: ReliabilityRow) => string }[] = [
    { label: 'Tenant', w: 38, get: r => txt(r.tenant_name, 'Unnamed tenant') },
    { label: 'Phone', w: 27, get: r => txt(r.tenant_phone) },
    { label: 'Agent', w: 32, get: r => txt(r.agent_name, 'Unassigned') },
    { label: 'Score', w: 14, align: 'right', get: r => `${r.score}` },
    { label: 'Band', w: 18, get: r => r.band },
    { label: 'Reliable', w: 16, get: r => (r.reliable ? 'Yes' : 'No') },
    { label: 'Rent', w: 24, align: 'right', get: r => num(r.rent_amount) },
    { label: 'Daily', w: 18, align: 'right', get: r => num(r.daily) },
    { label: 'Repaid', w: 24, align: 'right', get: r => num(r.repaid) },
    { label: 'Outstanding', w: 24, align: 'right', get: r => num(r.outstanding) },
    { label: 'Coverage', w: 18, align: 'right', get: r => `${r.coverage_pct}%` },
    { label: 'Progress', w: 18, align: 'right', get: r => `${r.progress_pct}%` },
    { label: 'Paid/Exp', w: 20, align: 'right', get: r => `${r.paid_days}/${r.expected_days}` },
    { label: 'Missed', w: 15, align: 'right', get: r => num(r.missed_days) },
    { label: 'Gap', w: 13, align: 'right', get: r => `${r.longest_gap}d` },
    { label: 'Last paid', w: 22, get: r => (r.last_pay_date ? dt(r.last_pay_date) : 'never') },
    { label: 'Plan start', w: 22, get: r => dt(r.start_at) },
    { label: 'Status', w: 17, get: r => txt(r.status).replace(/_/g, ' ') },
  ];
  const scale = contentWidth / cols.reduce((s, c) => s + c.w, 0);
  const widths = cols.map(c => c.w * scale);
  const drawHead = () => {
    doc.setFillColor(...ACCENT);
    doc.rect(margin, y, contentWidth, 6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(255, 255, 255);
    let x = margin;
    cols.forEach((c, i) => {
      const align = c.align || 'left';
      doc.text(c.label, align === 'right' ? x + widths[i] - 1.5 : x + 1.5, y + 4, { align });
      x += widths[i];
    });
    y += 6;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
  };
  drawHead();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  rows.forEach((r, ri) => {
    ensure(5.6, drawHead);
    if (ri % 2 === 1) {
      doc.setFillColor(248, 249, 252);
      doc.rect(margin, y, contentWidth, 5, 'F');
    }
    doc.setTextColor(30, 35, 50);
    let x = margin;
    cols.forEach((c, i) => {
      const align = c.align || 'left';
      const maxChars = Math.max(4, Math.floor(widths[i] / 1.4));
      doc.text(clip(c.get(r), maxChars), align === 'right' ? x + widths[i] - 1.5 : x + 1.5, y + 3.5, { align });
      x += widths[i];
    });
    y += 5;
  });

  if (!rows.length) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(120, 122, 135);
    doc.text('No scored rent plans match these filters.', margin, y + 4);
    y += 8;
  }

  // ─── Footer ───
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(140, 142, 155);
    doc.text(
      `Welile — Tenant Operations · Repayment Reliability Score · generated ${format(new Date(), 'dd MMM yyyy HH:mm')}`,
      margin, pageHeight - 6,
    );
    doc.text(`Page ${p} of ${pages}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
  }

  return doc.output('blob');
}
