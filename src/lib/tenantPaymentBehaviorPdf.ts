/**
 * PDF report for Tenant Ops -> Workspaces -> Tenant Operations Workspace -> Payment Behavior.
 * Presentation only: every figure comes from the tops_payment_behaviour_* RPC data the tab shows
 * (same filters, same period), nothing is recalculated here. Observed figures and estimates are
 * labelled apart. Style follows the other Tenant Ops reports (WELILE header, KPI cards, accent
 * table heads, zebra rows, page footer) with vector charts drawn directly.
 */
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format, parseISO } from 'date-fns';
import type {
  ChannelOnTime, DimensionRow, PaymentBehaviorReportData, PaymentBehaviorTrend, WarningFlag,
} from '@/hooks/tenantOpsWorkspace/usePaymentBehavior';

type RGB = [number, number, number];
const INK: RGB = [15, 23, 42];
const MUTED: RGB = [110, 110, 120];
const LINE: RGB = [225, 227, 232];
const PANEL: RGB = [248, 249, 252];
const PURPLE: RGB = [124, 58, 237];
const BLUE: RGB = [14, 116, 144];
const GREEN: RGB = [22, 163, 74];
const AMBER: RGB = [217, 119, 6];
const RED: RGB = [220, 38, 38];
const GREY: RGB = [120, 124, 135];

const ugx = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `UGX ${Math.round(Number(n)).toLocaleString('en-US')}`);
const num = (n: number | null | undefined) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US'));
const pct = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? '-' : `${Number(n).toFixed(d)}%`);
const day = (iso: string | null | undefined) => (iso ? format(parseISO(iso), 'dd MMM yyyy') : '-');
const dayShort = (iso: string) => format(parseISO(iso), 'dd MMM');
const pp = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n).toFixed(1)} pts`);

const GROUP_LABEL: Record<string, string> = {
  self_only: 'Pay themselves only', mixed: 'Pay themselves and via agents', agent_only: 'Paid for by agents only', no_payment: 'Billed, nothing paid',
};
const SEGMENT_LABEL: Record<string, string> = {
  self_reliant: 'Self-reliant (80%+ self-paid)', hybrid: 'Hybrid (20-80%)', agent_led_some_self: 'Agent-led, some self-pay (<20%)',
  agent_dependent: 'Agent-dependent (0% self-paid)', no_payment: 'No payment',
};
const SHIFT_LABEL: Record<string, string> = {
  moving_to_agents: 'Moving to agents', moving_to_self: 'Moving to self-pay', new_self_adopter: 'New self-payers',
};
const FLAG_LABEL: Record<WarningFlag, string> = {
  silent: 'Gone quiet', slipping: 'Slipping', behind: 'Behind', moving_to_agent: 'Moving to agents', refused_attempt: 'Self-pay refused',
};
const LAG_LABEL: Record<string, string> = {
  ahead: 'Ahead of due day', same_day: 'On due day', late_1_3: '1-3 days late', late_4_7: '4-7 days late', late_8_14: '8-14 days late', late_15_plus: '15+ days late',
};
const LAG_COLOR: Record<string, RGB> = {
  ahead: [22, 163, 74], same_day: [74, 190, 120], late_1_3: [234, 179, 8], late_4_7: [217, 119, 6], late_8_14: [239, 100, 90], late_15_plus: [185, 28, 28],
};
const GROUP_COLOR: Record<string, RGB> = { self_only: PURPLE, mixed: AMBER, agent_only: BLUE, no_payment: GREY };

export interface PaymentBehaviorPdfMeta {
  periodLabel: string;
  phrase: string;
  filters: { agent: string | null; region: string | null; district: string | null; cadence: string | null };
}

interface Card { label: string; value: string; sub?: string; color: RGB }

function createReport(title: string, subtitle: string, meta: string[]) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 14;
  let y = 0;
  const accent = PURPLE;

  doc.setFillColor(...accent);
  doc.rect(0, 0, W, 4, 'F');
  y = 16;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(...accent);
  doc.text('WELILE', M, y);
  doc.setFontSize(9); doc.setTextColor(...MUTED); doc.setFont('helvetica', 'normal');
  doc.text('Tenant Operations', M, y + 5);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...INK);
  doc.text(title, W - M, y, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text(subtitle, W - M, y + 5, { align: 'right' });
  y += 11;
  doc.setDrawColor(...LINE); doc.line(M, y, W - M, y);
  y += 5;
  doc.setFontSize(8.5);
  meta.forEach((m) => { doc.text(m, M, y); y += 4.2; });
  y += 3;

  const ensure = (h: number) => { if (y + h > H - 16) { doc.addPage(); y = 16; } };

  const api = {
    doc,
    get y() { return y; },
    gap(h = 3) { y += h; },
    pageBreak() { doc.addPage(); y = 16; },
    heading(label: string, tag?: 'OBSERVED' | 'ESTIMATE', note?: string) {
      ensure(40);
      doc.setFillColor(...accent); doc.rect(M, y - 3.5, 1.2, 5, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...INK);
      doc.text(label, M + 3.5, y + 0.5);
      let x = M + 3.5 + doc.getTextWidth(label) + 3;
      if (tag) {
        const c = tag === 'ESTIMATE' ? AMBER : GREEN;
        doc.setFontSize(6.5);
        const w = doc.getTextWidth(tag) + 4;
        doc.setFillColor(c[0], c[1], c[2]);
        doc.roundedRect(x, y - 3, w, 4.6, 1.2, 1.2, 'F');
        doc.setTextColor(255, 255, 255);
        doc.text(tag, x + 2, y + 0.3);
        x += w + 3;
      }
      if (note) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
        doc.text(note, x, y + 0.5);
      }
      y += 6;
    },
    cards(cards: Card[]) {
      const gap = 4;
      const cw = (W - 2 * M - gap * (cards.length - 1)) / cards.length;
      const ch = 24;
      ensure(ch + 4);
      cards.forEach((c, i) => {
        const x = M + i * (cw + gap);
        doc.setFillColor(...PANEL); doc.setDrawColor(...LINE);
        doc.roundedRect(x, y, cw, ch, 2.5, 2.5, 'FD');
        doc.setFillColor(...c.color); doc.roundedRect(x, y, 1.6, ch, 0.8, 0.8, 'F');
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
        doc.text(c.label.toUpperCase(), x + 5, y + 6);
        doc.setFont('helvetica', 'bold'); let fs = 15; doc.setFontSize(fs);
        while (fs > 9 && doc.getTextWidth(c.value) > cw - 8) { fs -= 1; doc.setFontSize(fs); }
        doc.setTextColor(...INK);
        doc.text(doc.splitTextToSize(c.value, cw - 8)[0], x + 5, y + 14.5);
        if (c.sub) {
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7.4); doc.setTextColor(...MUTED);
          doc.text(doc.splitTextToSize(c.sub, cw - 8)[0], x + 5, y + 20.5);
        }
      });
      y += ch + 6;
    },
    table(head: string[], body: (string | number)[][], opts: { align?: ('left' | 'right' | 'center')[]; widths?: number[] } = {}) {
      ensure(20);
      autoTable(doc, {
        startY: y,
        head: [head],
        body: body.map((r) => r.map(String)),
        margin: { left: M, right: M, bottom: 16 },
        theme: 'plain',
        styles: { font: 'helvetica', fontSize: 8, textColor: INK, cellPadding: 1.8, lineColor: LINE, lineWidth: { bottom: 0.1 } },
        headStyles: { fillColor: accent, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.8 },
        alternateRowStyles: { fillColor: PANEL },
        columnStyles: opts.widths ? Object.fromEntries(opts.widths.map((w, i) => [i, { cellWidth: w }])) : undefined,
        didParseCell: (h) => { const a = opts.align?.[h.column.index]; if (a) h.cell.styles.halign = a; },
      });
      y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 7;
    },
    note(text: string, color: RGB = MUTED, size = 8) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(size); doc.setTextColor(...color);
      const lines = doc.splitTextToSize(text, W - 2 * M);
      ensure(lines.length * (size * 0.5) + 3);
      doc.text(lines, M, y);
      y += lines.length * (size * 0.5) + 3;
    },
    bullets(items: string[]) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.8); doc.setTextColor(...INK);
      items.forEach((t) => {
        const lines = doc.splitTextToSize(t, W - 2 * M - 6);
        ensure(lines.length * 4.4 + 2);
        doc.setFillColor(...accent); doc.circle(M + 1.5, y - 1, 0.8, 'F');
        doc.text(lines, M + 5, y);
        y += lines.length * 4.4 + 1.6;
      });
      y += 2;
    },
    /** A single stacked bar (parts are 0-100 shares already computed upstream). */
    stackedBar(parts: { label: string; share: number; color: RGB }[], height = 9) {
      ensure(height + 14);
      const w = W - 2 * M;
      let x = M;
      parts.forEach((p) => {
        const pw = Math.max(0, (p.share / 100) * w);
        if (pw <= 0) return;
        doc.setFillColor(...p.color); doc.rect(x, y, pw, height, 'F');
        x += pw;
      });
      doc.setDrawColor(...LINE); doc.rect(M, y, w, height);
      y += height + 4;
      let lx = M;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.6);
      parts.forEach((p) => {
        doc.setFillColor(...p.color); doc.rect(lx, y - 2.4, 3, 3, 'F');
        doc.setTextColor(...INK);
        const t = `${p.label} ${pct(p.share)}`;
        doc.text(t, lx + 4.5, y);
        lx += doc.getTextWidth(t) + 12;
      });
      y += 7;
    },
    hbars(rows: { label: string; value: number; display: string; color?: RGB }[], max?: number, height = 6.5) {
      const top = Math.max(1e-9, max ?? Math.max(...rows.map((r) => r.value), 0));
      const labelW = 70; const valueW = 46;
      const barW = W - 2 * M - labelW - valueW;
      rows.forEach((r) => {
        ensure(height + 2);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.2); doc.setTextColor(...INK);
        doc.text(doc.splitTextToSize(r.label, labelW - 3)[0], M, y + height / 2 + 1);
        doc.setFillColor(...PANEL); doc.roundedRect(M + labelW, y, barW, height - 1.6, 1, 1, 'F');
        const w = Math.max(0.6, (Math.max(0, r.value) / top) * barW);
        doc.setFillColor(...(r.color ?? accent)); doc.roundedRect(M + labelW, y, w, height - 1.6, 1, 1, 'F');
        doc.setFont('helvetica', 'bold'); doc.text(r.display, W - M, y + height / 2 + 1, { align: 'right' });
        y += height + 1.2;
      });
      y += 3;
    },
    /** Columns for a small distribution (e.g. payments by hour). */
    columns(title: string, labels: string[], values: number[], color: RGB, x: number, width: number, h = 30) {
      const top = y;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...INK);
      doc.text(title, x, top);
      const base = top + 4 + h;
      const max = Math.max(1, ...values);
      const n = values.length;
      const bw = width / n;
      doc.setFillColor(...PANEL); doc.rect(x, top + 4, width, h, 'F');
      values.forEach((v, i) => {
        const bh = (v / max) * (h - 2);
        doc.setFillColor(...color); doc.rect(x + i * bw + bw * 0.12, base - bh, bw * 0.76, bh, 'F');
      });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor(...MUTED);
      labels.forEach((l, i) => { if (l) doc.text(l, x + i * bw + bw / 2, base + 3, { align: 'center' }); });
    },
    /** Line chart on one 0-100 axis plus optional dashed estimate segment. */
    lineChart(labels: string[], values: (number | null)[], opts: { color: RGB; unit?: string; estimate?: { labels: string[]; values: number[] } }) {
      const h = 52;
      ensure(h + 18);
      const x0 = M + 10; const x1 = W - M - 4; const top = y + 4; const bottom = y + h;
      doc.setFillColor(...PANEL); doc.setDrawColor(...LINE);
      doc.roundedRect(M, y - 1, W - 2 * M, h + 12, 2.5, 2.5, 'FD');
      const all = [...values.filter((v): v is number => v !== null), ...(opts.estimate?.values ?? [])];
      const hi = Math.max(5, Math.ceil(Math.max(0, ...all) / 5) * 5);
      const total = labels.length + (opts.estimate?.labels.length ?? 0);
      const xAt = (i: number) => (total <= 1 ? (x0 + x1) / 2 : x0 + 4 + ((x1 - x0 - 8) * i) / (total - 1));
      const yAt = (v: number) => bottom - (v / hi) * (bottom - top);
      doc.setDrawColor(...LINE);
      for (let g = 0; g <= 4; g++) {
        const gy = top + ((bottom - top) * g) / 4;
        doc.line(x0, gy, x1, gy);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...MUTED);
        doc.text(`${Math.round(hi - (hi * g) / 4)}${opts.unit ?? ''}`, x0 - 2, gy + 1.5, { align: 'right' });
      }
      doc.setDrawColor(...opts.color); doc.setLineWidth(0.7);
      let prev: number | null = null;
      values.forEach((v, i) => {
        if (v === null) { prev = null; return; }
        if (prev !== null) doc.line(xAt(i - 1), yAt(prev), xAt(i), yAt(v));
        doc.setFillColor(...opts.color); doc.circle(xAt(i), yAt(v), 0.7, 'F');
        prev = v;
      });
      if (opts.estimate && opts.estimate.values.length) {
        doc.setDrawColor(...AMBER); doc.setLineDashPattern([1.2, 1.2], 0);
        let px = labels.length - 1;
        let pv = [...values].reverse().find((v) => v !== null) ?? null;
        opts.estimate.values.forEach((v, j) => {
          const xi = labels.length + j;
          if (pv !== null) doc.line(xAt(px), yAt(pv), xAt(xi), yAt(v));
          doc.setFillColor(...AMBER); doc.circle(xAt(xi), yAt(v), 0.8, 'F');
          px = xi; pv = v;
        });
        doc.setLineDashPattern([], 0);
      }
      doc.setLineWidth(0.2);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...MUTED);
      const every = Math.max(1, Math.ceil(total / 14));
      [...labels, ...(opts.estimate?.labels ?? [])].forEach((l, i) => { if (i % every === 0) doc.text(l, xAt(i), bottom + 4.5, { align: 'center' }); });
      y += h + 14;
    },
    finish(footerTitle: string) {
      const pages = doc.getNumberOfPages();
      for (let p = 1; p <= pages; p++) {
        doc.setPage(p);
        doc.setDrawColor(...LINE); doc.line(M, H - 11, W - M, H - 11);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
        doc.text(`Welile Tenant Operations  |  ${footerTitle}  |  Confidential`, M, H - 6.5);
        doc.text(`Page ${p} of ${pages}`, W - M, H - 6.5, { align: 'right' });
      }
    },
    save(name: string) { doc.save(name); },
    W, M,
  };
  return api;
}

function dimTable(r: ReturnType<typeof createReport>, rows: DimensionRow[], label: string, limit = 15) {
  r.table(
    [label, 'Paying tenants', 'Self-paying', '% self', 'Self share of money', 'Bill covered', 'Self vs agent-only covered', 'Short'],
    rows.slice(0, limit).map((x) => [
      x.label, num(x.paying_tenants), num(x.self_payers), pct(x.self_payers_pct), pct(x.self_share_pct), pct(x.coverage_pct),
      `${pct(x.self_payers_coverage_pct)} / ${pct(x.agent_only_coverage_pct)}`, ugx(x.short_ugx),
    ]),
    { align: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'] },
  );
  if (rows.length > limit) r.note(`Showing the ${limit} largest of ${rows.length}.`);
}

function onTimeRows(by: { self: ChannelOnTime; agent: ChannelOnTime }) {
  return (['self', 'agent'] as const).map((k) => {
    const c = by[k];
    return [k === 'self' ? 'Tenants paying themselves' : 'Agents paying for tenants', ugx(c.settled_ugx), num(c.settled_days), pct(c.on_time_pct), pct(c.late_pct),
      c.avg_days_late_when_late === null ? '-' : `${c.avg_days_late_when_late}`, c.median_days_vs_due === null ? '-' : c.median_days_vs_due === 0 ? 'on the due day' : c.median_days_vs_due < 0 ? `${Math.abs(c.median_days_vs_due)} ahead` : `${c.median_days_vs_due} after`];
  });
}

export async function generatePaymentBehaviorPdf(data: PaymentBehaviorReportData, meta: PaymentBehaviorPdfMeta): Promise<void> {
  const { overview, trend, timing, byDimension, watchlist } = data;
  const s = overview.summary;
  const t = s.tenants;
  const p = s.payments;

  const filterText = [
    meta.filters.agent ? `Agent: ${meta.filters.agent}` : null,
    meta.filters.region ? `Region: ${meta.filters.region}` : null,
    meta.filters.district ? `District: ${meta.filters.district}` : null,
    meta.filters.cadence ? `Frequency: ${meta.filters.cadence}` : null,
  ].filter(Boolean).join('   |   ') || 'All agents, places and plan frequencies';

  const r = createReport('Tenant Payment Behavior', 'Self-payments versus agent payments', [
    `Period: ${meta.periodLabel} (${s.window.days} day${s.window.days === 1 ? '' : 's'}, Kampala days)   |   Data as at ${day(s.window.asof)}`,
    `Selection: ${filterText}`,
    `Generated ${format(new Date(), 'dd MMM yyyy, HH:mm')}   |   Figures marked OBSERVED are read from recorded payments; ESTIMATE marks projections, comparisons and risk scoring.`,
  ]);

  // ─── Headline ───
  r.heading('Headline', 'OBSERVED');
  r.cards([
    { label: 'Tenants paying for themselves', value: pct(t.self_payers_pct), sub: `${num(t.self_payers)} of ${num(t.paying)} paying tenants`, color: PURPLE },
    { label: 'Paid for by agents only', value: pct(t.agent_only_pct), sub: `${num(t.agent_only)} tenants`, color: BLUE },
    { label: 'Collected by self-pay', value: ugx(p.self.ugx), sub: `${pct(p.self_share_pct)} of the money, ${num(p.self.n)} payments`, color: PURPLE },
    { label: 'Collected by agents', value: ugx(p.agent.ugx), sub: `${pct(p.agent_share_pct)} of the money, ${num(p.agent.n)} payments`, color: BLUE },
  ]);
  r.cards([
    { label: 'Average payment', value: `${ugx(p.self.avg_ugx)} / ${ugx(p.agent.avg_ugx)}`, sub: 'self / agent', color: GREY },
    { label: 'Median payment', value: `${ugx(p.self.median_ugx)} / ${ugx(p.agent.median_ugx)}`, sub: 'self / agent', color: GREY },
    { label: 'Paid on time or early', value: `${pct(timing.on_time.by_channel.self.on_time_pct)} / ${pct(timing.on_time.by_channel.agent.on_time_pct)}`, sub: 'self / agent, by UGX', color: GREEN },
    { label: 'Bill covered', value: pct(s.coverage.coverage_pct), sub: `${ugx(s.coverage.short_ugx)} short of ${ugx(s.coverage.billed_ugx)}`, color: AMBER },
  ]);

  const findings: string[] = [
    `${pct(t.self_payers_pct)} of paying tenants (${num(t.self_payers)} of ${num(t.paying)}) paid at least once from their own phone; ${num(t.self_only)} pay only themselves and ${num(t.mixed)} use both methods. Compared with the previous ${s.window.days} day${s.window.days === 1 ? '' : 's'} (${pct(t.previous.self_payers_pct)}), that is ${pp(t.self_payers_pct_change_pp)}.`,
    `Self-pay carried ${pct(p.self_share_pct)} of the money collected and ${pct(p.self_count_share_pct)} of payments. The typical self-payment is ${ugx(p.self.median_ugx)}, against ${ugx(p.agent.median_ugx)} when an agent pays.`,
  ];
  const ot = timing.on_time.by_channel;
  if (ot.self.settled_days > 0 && ot.agent.settled_days > 0) {
    findings.push(`On the payments that carry billed-day detail, ${pct(ot.self.on_time_pct)} of self-paid UGX arrived on or before the due day, against ${pct(ot.agent.on_time_pct)} of agent-paid UGX.`);
  }
  const cmp = overview.comparison;
  if (cmp.self_payers && cmp.agent_only) {
    findings.push(`Tenants who paid themselves covered ${pct(cmp.self_payers.coverage_pct)} of their bill on average (${num(cmp.self_payers.tenants)} tenants) versus ${pct(cmp.agent_only.coverage_pct)} for agent-only tenants (${num(cmp.agent_only.tenants)}): a difference of ${pp(cmp.difference_pp)} with a margin of error of about ${cmp.margin_pp_95 ?? '-'} points${cmp.enough_data ? '' : ' (small groups, rough indication only)'}.`);
  }
  r.heading('Key readings');
  r.bullets(findings);

  // ─── How tenants paid ───
  r.heading('How tenants paid', 'OBSERVED', 'Share of paying tenants by who made their payments');
  r.stackedBar([
    { label: `${GROUP_LABEL.self_only} (of paying tenants)`, share: t.self_only_pct ?? 0, color: GROUP_COLOR.self_only },
    { label: GROUP_LABEL.mixed, share: t.mixed_pct ?? 0, color: GROUP_COLOR.mixed },
    { label: GROUP_LABEL.agent_only, share: t.agent_only_pct ?? 0, color: GROUP_COLOR.agent_only },
  ]);
  r.table(
    ['Group', 'Tenants', 'Billed', 'Paid against the bill', 'Bill covered', 'Still short'],
    s.coverage.by_segment.map((g) => [GROUP_LABEL[g.segment], num(g.tenants), ugx(g.billed_ugx), ugx(g.covered_ugx), pct(g.coverage_pct), ugx(g.short_ugx)]),
    { align: ['left', 'right', 'right', 'right', 'right', 'right'] },
  );

  // ─── Trends ───
  r.heading('Trend over time', 'OBSERVED', `Self-pay share of the money collected, per ${trend.bucket}`);
  const pts = trend.points;
  const billedPts = pts.filter((x) => x.self_n + x.agent_n > 0);
  if (billedPts.length > 1) {
    r.lineChart(billedPts.map((x) => dayShort(x.bucket_start)), billedPts.map((x) => x.self_share_pct), {
      color: PURPLE, unit: '%',
      estimate: trend.projection.available && trend.bucket === 'week' ? { labels: trend.projection.projected.map((w) => dayShort(w.week_start)), values: trend.projection.projected.map((w) => w.self_share_pct) } : undefined,
    });
    r.note(trend.projection.available && trend.bucket === 'week'
      ? 'Solid line: observed self-pay share. Dashed amber line: ESTIMATE of the next four weeks (see below).'
      : 'Solid line: observed self-pay share. The estimate for the coming weeks is given below.');
  } else {
    r.note('Not enough days with payments in this selection to draw a trend.');
  }
  r.table(
    [trend.bucket === 'day' ? 'Day' : trend.bucket === 'week' ? 'Week starting' : 'Month', 'Self-paid', 'Self payments', 'Agent-paid', 'Agent payments', 'Self-paying tenants', 'Self share of money'],
    billedPts.slice(-32).map((x) => [
      `${day(x.bucket_start)}${x.partial ? ' *' : ''}`, ugx(x.self_ugx), num(x.self_n), ugx(x.agent_ugx), num(x.agent_n),
      `${num(x.self_tenants)} of ${num(x.paying_tenants)}`, pct(x.self_share_pct),
    ]),
    { align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'] },
  );
  r.note('* The period is still in progress or only partly inside the selected dates.');
  r.heading('Projection', 'ESTIMATE');
  const proj: PaymentBehaviorTrend['projection'] = trend.projection;
  if (proj.available === true) {
    r.table(['Week starting', 'Projected self-pay share', 'Projected self-paid'], proj.projected.map((w) => [day(w.week_start), pct(w.self_share_pct), `about ${ugx(w.self_ugx)}`]), { align: ['left', 'right', 'right'] });
    r.note(`${proj.method} Based on ${proj.weeks_used} complete weeks (${day(proj.first_week)} to ${day(proj.last_week)}); the share has been moving about ${proj.slope_pp_per_week} points a week (r-squared ${proj.r_squared}). Confidence: ${proj.confidence}. A guide only, not a guarantee.`, AMBER);
  } else {
    r.note(proj.reason);
  }

  // ─── Timeliness ───
  r.heading('On time versus late', 'OBSERVED', 'Receipts settled against billed days, oldest first');
  r.table(
    ['Method', 'Settled UGX', 'Billed days settled', 'On time or early', 'Late', 'Avg days late (when late)', 'Median vs due day'],
    onTimeRows(ot),
    { align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'] },
  );
  (['self', 'agent'] as const).forEach((k) => {
    const c = ot[k];
    if (c.settled_days === 0) return;
    r.note(k === 'self' ? 'Tenants paying themselves' : 'Agents paying for tenants', INK, 8.5);
    r.stackedBar(c.buckets.map((b) => ({ label: LAG_LABEL[b.key], share: b.settled_pct ?? 0, color: LAG_COLOR[b.key] })), 7);
  });
  if ((timing.on_time.detail_coverage_pct ?? 100) < 100) {
    r.note(`Billed-day settlement records start on ${day(timing.on_time.settlement_detail_since)}: ${num(timing.on_time.receipts_with_detail)} of ${num(timing.on_time.receipts_in_window)} payments in the period (${pct(timing.on_time.detail_coverage_pct)}) have that detail, so the on-time figures describe those payments only.`, AMBER);
  }
  r.heading('Frequency and consistency', 'OBSERVED', 'Share of billed days on which a payment arrived');
  r.table(
    ['Group (Rent Plans)', 'Plans', 'Billed days paid', 'Consistent (80%+)', 'Patchy (40-80%)', 'Sporadic (<40%)'],
    timing.frequency.by_segment.map((g) => [GROUP_LABEL[g.segment] ?? g.segment, num(g.plans), pct(g.paid_day_pct), num(g.consistent), num(g.patchy), num(g.sporadic)]),
    { align: ['left', 'right', 'right', 'right', 'right', 'right'] },
  );
  r.table(
    ['Method', 'Tenants', 'Payments per tenant', 'Days paid per tenant', 'Average days between payments', 'Median days between payments'],
    (['self', 'agent'] as const).map((k) => {
      const c = timing.frequency.by_channel[k];
      return [k === 'self' ? 'Tenants paying themselves' : 'Agents paying for tenants', num(c.tenants), `${c.avg_payments_per_tenant ?? '-'}`, `${c.avg_pay_days_per_tenant ?? '-'}`, `${c.avg_days_between_payments ?? '-'}`, `${c.median_days_between_payments ?? '-'}`];
    }),
    { align: ['left', 'right', 'right', 'right', 'right', 'right'] },
  );
  r.heading('Size of payments', 'OBSERVED');
  r.table(
    ['Method', 'Payments', '10th percentile', 'Median', 'Average', '90th percentile', 'Largest'],
    (['self', 'agent'] as const).map((k) => {
      const a = timing.amounts[k];
      return [k === 'self' ? 'Self-paid' : 'Agent-paid', num(a?.n), ugx(a?.p10), ugx(a?.median_ugx), ugx(a?.avg_ugx), ugx(a?.p90), ugx(a?.max_ugx)];
    }),
    { align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'] },
  );
  r.heading('When payments are made', 'OBSERVED', 'Hour of day, Kampala time');
  const hourLabels = Array.from({ length: 24 }, (_, h) => (h % 3 === 0 ? `${h}h` : ''));
  const half = (r.W - 2 * r.M - 8) / 2;
  const yStart = r.y;
  r.columns('Self-paid by hour', hourLabels, timing.clock.hours.self, PURPLE, r.M, half);
  r.columns('Agent-paid by hour', hourLabels, timing.clock.hours.agent, BLUE, r.M + half + 8, half);
  r.gap(yStart + 44 - r.y);
  r.note(`Typical hour: self-paid ${timing.clock.median_hour?.self ?? '-'}h, agent-paid ${timing.clock.median_hour?.agent ?? '-'}h. Agent payments reflect when agents enter them.`);

  // ─── Segments ───
  r.heading('Behavioural segments', 'OBSERVED', 'By the share of what each tenant paid that came from their own payments');
  r.table(
    ['Segment', 'Tenants', 'Bill covered', 'Billed days paid', 'Still short', 'Self-paid', 'Agent-paid'],
    overview.segments.rows.map((g) => [SEGMENT_LABEL[g.segment] ?? g.segment, num(g.tenants), pct(g.coverage_pct), pct(g.avg_paid_day_pct), ugx(g.short_ugx), ugx(g.self_ugx), ugx(g.agent_ugx)]),
    { align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'] },
  );
  r.heading('Shift in how tenants pay', 'OBSERVED', `Versus ${day(overview.shift.previous_window.start_day)} to ${day(overview.shift.previous_window.end_day)}`);
  r.table(
    ['Group', 'Tenants', 'Meaning'],
    (['moving_to_agents', 'moving_to_self', 'new_self_adopter'] as const).map((k) => [SHIFT_LABEL[k], num(overview.shift.counts[k] ?? 0),
      k === 'moving_to_agents' ? 'Was mostly self-paying, now relies on agents or stopped self-paying'
        : k === 'moving_to_self' ? 'Relied on agents, now pays a large share themselves' : 'Paid only through agents before, now pays some themselves']),
    { align: ['left', 'right', 'left'] },
  );
  const toAgents = overview.shift.rows.filter((x) => x.shift === 'moving_to_agents').slice(0, 15);
  if (toAgents.length) {
    r.note('Tenants increasingly relying on agents (largest first):', INK, 8.5);
    r.table(
      ['Tenant', 'Phone', 'Self-pay share before', 'Self-pay share now', 'Self-paid', 'Agent-paid'],
      toAgents.map((x) => [x.tenant_name, x.tenant_phone ?? '-', pct(x.previous_self_share_pct, 0), pct(x.self_share_pct, 0), ugx(x.self_ugx), ugx(x.agent_ugx)]),
      { align: ['left', 'left', 'right', 'right', 'right', 'right'] },
    );
  }
  r.heading('Self-payers compared with agent-only tenants', 'ESTIMATE');
  if (cmp.self_payers && cmp.agent_only) {
    r.table(
      ['Group', 'Tenants', 'Average bill covered', 'Billed days paid'],
      [['Tenants who paid themselves', num(cmp.self_payers.tenants), pct(cmp.self_payers.coverage_pct), pct(cmp.self_payers.paid_day_pct)],
        ['Agent-only tenants', num(cmp.agent_only.tenants), pct(cmp.agent_only.coverage_pct), pct(cmp.agent_only.paid_day_pct)]],
      { align: ['left', 'right', 'right', 'right'] },
    );
    r.note(`Difference ${pp(cmp.difference_pp)}, margin of error about ${cmp.margin_pp_95 ?? '-'} points. ${cmp.definition}`, AMBER);
  } else {
    r.note('One of the two groups has no billed tenants in this selection.');
  }
  r.heading('Correlations', 'ESTIMATE', `${num(overview.correlations.tenants_with_self_pay)} tenants with self-payments`);
  r.table(
    ['Relationship', 'Correlation (-1 to +1)', 'Tenants'],
    overview.correlations.pairs.map((c) => [c.label, c.r === null ? '-' : c.r.toFixed(2), num(c.n)]),
    { align: ['left', 'right', 'right'] },
  );
  r.note(`${overview.correlations.definition}${overview.correlations.enough_data ? '' : ' Few self-paying tenants exist in this selection, so these are weak evidence.'}`, AMBER);

  // ─── Breakdowns ───
  r.heading('By agent', 'OBSERVED', 'Largest by paying tenants');
  dimTable(r, byDimension.agent, 'Agent', 18);
  r.heading('By region', 'OBSERVED');
  dimTable(r, byDimension.region, 'Region', 10);
  r.heading('By district', 'OBSERVED', 'Largest by paying tenants');
  dimTable(r, byDimension.district, 'District', 14);
  r.heading('By rent level', 'OBSERVED');
  dimTable(r, byDimension.rent_band, 'Rent level', 10);
  r.heading('By payment frequency', 'OBSERVED');
  dimTable(r, byDimension.cadence, 'Frequency', 10);
  r.heading('By Rent Plan start month (cohorts)', 'OBSERVED');
  dimTable(r, byDimension.cohort, 'Start month', 14);

  // ─── Early warning ───
  r.heading('Early-warning signs', 'ESTIMATE', `Live Rent Plans as at ${day(watchlist.asof)}`);
  const ws = watchlist.summary;
  r.cards([
    { label: 'Rent Plans scored', value: num(ws.plans_scored), color: GREY },
    { label: 'No signs', value: num(ws.score_0), color: GREEN },
    { label: 'One sign', value: num(ws.score_1), color: AMBER },
    { label: 'Two or more signs', value: num(ws.score_2 + ws.score_3_plus), sub: `${num(ws.score_3_plus)} with three or more`, color: RED },
  ]);
  r.table(
    ['Sign', 'Rent Plans with it', 'What it means'],
    (Object.keys(FLAG_LABEL) as WarningFlag[]).map((f) => [FLAG_LABEL[f], num(ws.by_flag[f]),
      f === 'silent' ? 'No payment for longer than their usual gap (at least 3 days, 10 for weekly plans)'
        : f === 'slipping' ? 'The last 7 days covered 30+ points less of the bill than the 7 days before'
          : f === 'behind' ? '7 or more days behind on the oldest unpaid bill'
            : f === 'moving_to_agent' ? 'Was paying mostly themselves, now 20% or less'
              : 'Tried to pay themselves in the last 14 days and was refused']),
    { align: ['left', 'right', 'left'] },
  );
  const bt = watchlist.backtest;
  r.heading('Back-test: have the signs predicted missed payments?', 'ESTIMATE');
  r.note(`Signs as they stood on ${day(bt.cutoff_day)}, against ${day(bt.outcome_window.start_day)} to ${day(bt.outcome_window.end_day)}. ${bt.missed_definition}`);
  r.table(
    ['Group', 'Rent Plans', 'Missed', 'Share missed'],
    [['No signs', num(bt.no_signs_plans), '', pct(bt.no_signs_missed_pct)], ['Two or more signs', num(bt.two_plus_signs_plans), '', pct(bt.two_plus_signs_missed_pct)],
      ...bt.by_score.map((x) => [`Score ${x.score}`, num(x.plans), num(x.missed), pct(x.missed_pct)]), ['All plans', num(bt.plans), num(bt.missed), pct(bt.missed_pct)]],
    { align: ['left', 'right', 'right', 'right'] },
  );
  r.table(
    ['Sign', 'Plans that had it', 'Missed', 'Plans without it', 'Missed'],
    bt.by_flag.map((f) => [FLAG_LABEL[f.flag], num(f.flagged_plans), pct(f.flagged_missed_pct), num(f.unflagged_plans), pct(f.unflagged_missed_pct)]),
    { align: ['left', 'right', 'right', 'right', 'right'] },
  );
  r.note('A sign is useful only when plans that had it missed more often than plans that did not. This is a single week of history and becomes more reliable as weeks accumulate.', AMBER);
  r.heading('Rent Plans to follow up', 'ESTIMATE', 'Two or more signs, highest score first');
  r.table(
    ['Tenant', 'Phone', 'Agent', 'District', 'Score', 'Signs', 'Days behind', 'Last paid'],
    watchlist.rows.map((x) => [x.tenant_name, x.tenant_phone ?? '-', x.agent_name, x.district ?? '-', x.score, x.flags.map((f) => FLAG_LABEL[f]).join(', '),
      x.days_behind === null ? '-' : x.days_behind, x.last_paid_day ? day(x.last_paid_day) : 'Not in 28 days']),
    { align: ['left', 'left', 'left', 'left', 'right', 'left', 'right', 'right'] },
  );
  if (watchlist.total > watchlist.rows.length) r.note(`Showing ${watchlist.rows.length} of ${num(watchlist.total)} Rent Plans with two or more signs. Open the tab for the full list.`);

  // ─── Method ───
  r.heading('How to read this report');
  r.bullets([
    `Paid by the tenant: a rent receipt written when the tenant paid from their own registered phone and it was applied to their Rent Plan automatically. These match one-for-one the settled attempts on the Tenant Self-Repayments list.`,
    `Paid by an agent: a rent receipt the agent recorded, settled from the agent's own float. Reversed receipts, zero amounts and receipts without a Rent Plan are excluded everywhere. Days are Kampala days.`,
    `Bill covered: the daily bill pinned for each Rent Plan against what was paid, capped at the bill per Rent Plan, as on the Collection Shortfall page.`,
    `On time or late: each receipt is settled against the oldest unpaid billed day; a receipt entered on or before that day is on time.`,
    `Self-payments began on ${day(s.data_since.first_self_payment_day)} and the daily bill on ${day(s.data_since.first_billed_day)}; earlier periods cannot show self-pay or coverage.`,
    'Self-paying tenants are a small share of all tenants, so group comparisons and correlations have wide margins. Estimates (projection, comparison, correlations, early-warning signs and their back-test) are guides, not recorded facts.',
  ]);

  r.finish('Tenant Payment Behavior');
  r.save(`Welile_Tenant_Payment_Behavior_${format(parseISO(s.window.start_day), 'yyyyMMdd')}-${format(parseISO(s.window.end_day), 'yyyyMMdd')}.pdf`);
}
