/**
 * PDF exports for Tenant Ops -> Workspaces -> Weekly Performance.
 * Presentation only: figures come straight from the tab's existing RPC data.
 * Style mirrors generateTenantOpsToolReportPdf (WELILE header, KPI cards,
 * accent table heads, zebra rows, page footer).
 */
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';
import type { TenantOpsWeeklyHistoryRow, TenantOpsWeeklyPerformance } from '@/hooks/useTenantOpsWeeklyPerformance';
import type { TenantOpsNoPaymentReport } from '@/hooks/useTenantOpsNoPaymentReport';

type RGB = [number, number, number];
const INK: RGB = [15, 23, 42];
const MUTED: RGB = [110, 110, 120];
const LINE: RGB = [225, 227, 232];
const PANEL: RGB = [248, 249, 252];
const GREEN: RGB = [22, 163, 74];
const RED: RGB = [220, 38, 38];
const AMBER: RGB = [217, 119, 6];
const BLUE: RGB = [37, 99, 235];
const PURPLE: RGB = [124, 58, 237];

const ugx = (n: number | null | undefined) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const num = (n: number | null | undefined) => (Number(n) || 0).toLocaleString('en-US');
const d = (iso: string | null | undefined) => {
  if (!iso) return '-';
  const [y, m, dd] = iso.slice(0, 10).split('-').map(Number);
  return format(new Date(y, (m || 1) - 1, dd || 1), 'dd MMM yyyy');
};
const short = (iso: string) => {
  const [y, m, dd] = iso.slice(0, 10).split('-').map(Number);
  return format(new Date(y, (m || 1) - 1, dd || 1), 'dd MMM');
};
const signed = (n: number, suffix = '') => `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('en-US')}${suffix}`;

interface Card { label: string; value: string; sub?: string; subColor?: RGB; color: RGB }

function createReport(title: string, subtitle: string, accent: RGB, meta: string[]) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 14;
  let y = 0;

  // Header band
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
  doc.text(meta.join('   |   '), M, y);
  y += 7;

  const ensure = (h: number) => { if (y + h > H - 16) { doc.addPage(); y = 16; } };

  const api = {
    doc,
    heading(label: string, note?: string) {
      ensure(45);
      doc.setFillColor(...accent); doc.rect(M, y - 3.5, 1.2, 5, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...INK);
      doc.text(label, M + 3.5, y + 0.5);
      if (note) {
        const lw = doc.getTextWidth(label);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
        doc.text(note, M + 3.5 + lw + 4, y + 0.5);
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
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
        doc.text(c.label.toUpperCase(), x + 5, y + 6);
        doc.setFont('helvetica', 'bold'); let fs = 15; doc.setFontSize(fs);
        while (fs > 9 && doc.getTextWidth(c.value) > cw - 8) { fs -= 1; doc.setFontSize(fs); }
        doc.setTextColor(...INK);
        doc.text(doc.splitTextToSize(c.value, cw - 8)[0], x + 5, y + 14.5);
        if (c.sub) {
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7.8); doc.setTextColor(...(c.subColor ?? MUTED));
          doc.text(doc.splitTextToSize(c.sub, cw - 8)[0], x + 5, y + 20.5);
        }
      });
      y += ch + 7;
    },
    table(head: string[], body: (string | number)[][], opts: { align?: ('left' | 'right' | 'center')[]; colors?: (RGB | null)[][]; foot?: (string | number)[] } = {}) {
      ensure(20);
      autoTable(doc, {
        startY: y,
        head: [head],
        body: body.map((r) => r.map(String)),
        foot: opts.foot ? [opts.foot.map(String)] : undefined,
        margin: { left: M, right: M, bottom: 16 },
        theme: 'plain',
        styles: { font: 'helvetica', fontSize: 8, textColor: INK, cellPadding: 2, lineColor: LINE, lineWidth: { bottom: 0.1 } },
        headStyles: { fillColor: accent, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
        footStyles: { fillColor: PANEL, textColor: INK, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: PANEL },
        showFoot: 'lastPage',
        didParseCell: (h) => {
          const a = opts.align?.[h.column.index];
          if (a) h.cell.styles.halign = a;
          if (h.section === 'body') {
            const c = opts.colors?.[h.row.index]?.[h.column.index];
            if (c) { h.cell.styles.textColor = c; h.cell.styles.fontStyle = 'bold'; }
          }
        },
      });
      y = (doc as any).lastAutoTable.finalY + 8;
    },
    hbars(rows: { label: string; value: number; display: string; color?: RGB }[], height = 7) {
      const max = Math.max(1e-9, ...rows.map((r) => r.value));
      const labelW = 62; const valueW = 40;
      const barW = W - 2 * M - labelW - valueW;
      rows.forEach((r) => {
        ensure(height + 2);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...INK);
        doc.text(doc.splitTextToSize(r.label, labelW - 3)[0], M, y + height / 2 + 1.2);
        doc.setFillColor(...PANEL); doc.roundedRect(M + labelW, y, barW, height - 1.5, 1, 1, 'F');
        const w = Math.max(0.8, (r.value / max) * barW);
        doc.setFillColor(...(r.color ?? accent)); doc.roundedRect(M + labelW, y, w, height - 1.5, 1, 1, 'F');
        doc.setFont('helvetica', 'bold'); doc.text(r.display, W - M, y + height / 2 + 1.2, { align: 'right' });
        y += height + 1.5;
      });
      y += 5;
    },
    lineChart(labels: string[], series: { name: string; values: number[]; color: RGB; suffix?: string }[], h = 58) {
      ensure(h + 14);
      const x0 = M + 4; const x1 = W - M - 4; const top = y + 8; const bottom = y + h;
      doc.setFillColor(...PANEL); doc.setDrawColor(...LINE);
      doc.roundedRect(M, y, W - 2 * M, h + 10, 2.5, 2.5, 'FD');
      // legend
      let lx = x0;
      series.forEach((s) => {
        doc.setFillColor(...s.color); doc.rect(lx, y + 3.2, 5, 1.6, 'F');
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.8); doc.setTextColor(...INK);
        doc.text(`${s.name} (own scale)`, lx + 7, y + 4.8);
        lx += doc.getTextWidth(`${s.name} (own scale)`) + 16;
      });
      // grid
      doc.setDrawColor(...LINE);
      for (let i = 0; i <= 3; i++) { const gy = top + ((bottom - top) * i) / 3; doc.line(x0, gy, x1, gy); }
      const n = labels.length;
      const xAt = (i: number) => (n <= 1 ? (x0 + x1) / 2 : x0 + 6 + ((x1 - x0 - 12) * i) / (n - 1));
      series.forEach((s) => {
        const vals = s.values;
        let lo = Math.min(...vals); let hi = Math.max(...vals);
        const pad = (hi - lo) * 0.15 || Math.max(1, Math.abs(hi) * 0.15);
        lo -= pad; hi += pad;
        const yAt = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
        doc.setDrawColor(...s.color); doc.setLineWidth(0.7);
        for (let i = 1; i < n; i++) doc.line(xAt(i - 1), yAt(vals[i - 1]), xAt(i), yAt(vals[i]));
        doc.setFillColor(...s.color);
        vals.forEach((v, i) => {
          doc.circle(xAt(i), yAt(v), 0.9, 'F');
        });
        // label last point value
        const li = n - 1;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(...s.color);
        doc.text(`${num(vals[li])}${s.suffix ?? ''}`, xAt(li), yAt(vals[li]) - 2, { align: 'center' });
      });
      doc.setLineWidth(0.2);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
      labels.forEach((l, i) => doc.text(l, xAt(i), bottom + 5, { align: 'center' }));
      y += h + 16;
    },
    note(text: string) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
      const lines = doc.splitTextToSize(text, W - 2 * M);
      ensure(lines.length * 4 + 2);
      doc.text(lines, M, y);
      y += lines.length * 4 + 3;
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
      return doc.output('blob');
    },
  };
  return api;
}

const generatedMeta = (preparedBy?: string) => [
  `Generated ${format(new Date(), 'dd MMM yyyy, HH:mm')}`,
  ...(preparedBy ? [`Prepared by ${preparedBy}`] : []),
];

const deltaColor = (v: number, goodUp = true): RGB => (v === 0 ? MUTED : (v > 0) === goodUp ? GREEN : RED);

// ---------------------------------------------------------------- Weekly
export function generateWeeklyPerformancePdf(
  data: TenantOpsWeeklyPerformance,
  history: TenantOpsWeeklyHistoryRow[],
  preparedBy?: string,
): Blob {
  const { current: c, previous: p, delta: dl } = data;
  const r = createReport(
    'Weekly Performance Report',
    `Week ${d(data.week_start)} to ${d(data.week_end)} (${data.is_current_week_open ? 'in progress' : 'closed'})`,
    BLUE,
    [...generatedMeta(preparedBy), 'Reporting week runs Wednesday to Tuesday'],
  );

  r.heading('Management Summary', 'This week compared with the week before');
  r.cards([
    { label: 'Active Tenants', value: num(c.total_active_tenants), sub: `${signed(dl.total_active_tenants)} vs last week`, subColor: deltaColor(dl.total_active_tenants), color: BLUE },
    { label: 'Paying Tenants', value: num(c.paying_tenants), sub: `${signed(dl.paying_tenants)} vs last week`, subColor: deltaColor(dl.paying_tenants), color: GREEN },
    { label: 'Payment Rate', value: `${c.payment_rate_pct}%`, sub: `${signed(dl.payment_rate_pct, ' pts')} vs last week`, subColor: deltaColor(dl.payment_rate_pct), color: GREEN },
    { label: 'New Tenants', value: num(c.new_tenants_added), sub: `${signed(dl.new_tenants_added)} vs last week`, subColor: deltaColor(dl.new_tenants_added), color: PURPLE },
    { label: '20+ Days No Payment', value: num(c.dormant_20_plus_count), sub: `${signed(dl.dormant_20_plus_count)} vs last week`, subColor: deltaColor(dl.dormant_20_plus_count, false), color: AMBER },
  ]);

  r.heading('Tenant Self-Payments', 'Tenants who paid themselves via a merchant or mobile money');
  const inc = dl.self_payment_increase_pct;
  r.cards([
    { label: 'Self-paying this week', value: num(c.self_payment_tenants), color: GREEN },
    { label: 'Self-paying last week', value: num(p.self_payment_tenants), color: BLUE },
    { label: 'Week-on-week change', value: inc == null ? 'n/a' : `${signed(Math.round(inc * 10) / 10, '%')}`, sub: inc == null ? 'No self-payments last week to compare' : `${signed(dl.self_payment_tenants)} tenants`, subColor: inc == null ? MUTED : deltaColor(inc), color: PURPLE },
    { label: 'Non-paying tenants', value: num(c.non_paying_tenants), sub: `${signed(dl.non_paying_tenants)} vs last week`, subColor: deltaColor(dl.non_paying_tenants, false), color: RED },
  ]);

  r.heading('This Week vs Last Week');
  const rows: [string, number, number, number, boolean, string][] = [
    ['Active tenants', c.total_active_tenants, p.total_active_tenants, dl.total_active_tenants, true, ''],
    ['Paying tenants', c.paying_tenants, p.paying_tenants, dl.paying_tenants, true, ''],
    ['Non-paying tenants', c.non_paying_tenants, p.non_paying_tenants, dl.non_paying_tenants, false, ''],
    ['Payment rate', c.payment_rate_pct, p.payment_rate_pct, dl.payment_rate_pct, true, '%'],
    ['New tenants added', c.new_tenants_added, p.new_tenants_added, dl.new_tenants_added, true, ''],
    ['20+ days no payment', c.dormant_20_plus_count, p.dormant_20_plus_count, dl.dormant_20_plus_count, false, ''],
    ['Self-paid via merchant', c.self_payment_tenants, p.self_payment_tenants, dl.self_payment_tenants, true, ''],
  ];
  r.table(
    ['Measure', `This week (${short(data.week_start)} - ${short(data.week_end)})`, `Last week (${short(p.week_start)} - ${short(p.week_end)})`, 'Change'],
    rows.map(([l, a, b, ch, , s]) => [l, `${num(a)}${s}`, `${num(b)}${s}`, signed(ch, s === '%' ? ' pts' : '')]),
    { align: ['left', 'right', 'right', 'right'], colors: rows.map(([, , , ch, up]) => [null, null, null, deltaColor(ch, up)]) },
  );

  if (history.length > 0) {
    const chron = history.slice().reverse();
    r.heading('Weekly Trend', `Last ${history.length} recorded weeks`);
    r.lineChart(
      chron.map((w) => short(w.week_start)),
      [
        { name: 'Payment rate %', values: chron.map((w) => Number(w.payment_rate_pct) || 0), color: GREEN, suffix: '%' },
        { name: 'Active tenants', values: chron.map((w) => w.total_active_tenants), color: BLUE },
      ],
    );
    r.lineChart(
      chron.map((w) => short(w.week_start)),
      [
        { name: '20+ days no payment', values: chron.map((w) => w.dormant_20_plus_count), color: AMBER },
        { name: 'Self-paid via merchant', values: chron.map((w) => w.self_payment_tenants), color: PURPLE },
      ],
    );
    r.heading('Historical Weekly Records', 'Frozen once each week closes on Tuesday night');
    r.table(
      ['Week', 'Active', 'Paying', 'Payment rate', 'New', '20+ days no payment', 'Self-paid via merchant'],
      history.map((w) => [`${short(w.week_start)} - ${short(w.week_end)}`, num(w.total_active_tenants), num(w.paying_tenants), `${w.payment_rate_pct}%`, num(w.new_tenants_added), num(w.dormant_20_plus_count), num(w.self_payment_tenants)]),
      { align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'] },
    );
  } else {
    r.note('No closed weeks recorded yet. A week\'s figures are frozen once it closes on Tuesday night.');
  }
  return r.finish('Weekly Performance Report');
}

// ---------------------------------------------------------------- 20+ days
export function generateNoPaymentPdf(report: TenantOpsNoPaymentReport, agentLabel: string | null, preparedBy?: string): Blob {
  const agents = report.agent_summary ?? [];
  const tenants = report.tenants ?? [];
  const t20 = agents.reduce((s, a) => s + a.gte_20, 0);
  const t30 = agents.reduce((s, a) => s + a.gte_30, 0);
  const t40 = agents.reduce((s, a) => s + a.gte_40, 0);
  const outstanding = tenants.reduce((s, t) => s + (Number(t.outstanding_balance) || 0), 0);
  const dailyAtRisk = tenants.reduce((s, t) => s + (Number(t.expected_daily_payment) || 0), 0);

  const r = createReport(
    '20+ Days No Payment',
    `As of ${d(report.as_of ?? new Date().toISOString())}`,
    AMBER,
    [...generatedMeta(preparedBy), `Agent filter: ${agentLabel ?? 'All agents'}`],
  );

  r.heading('Dormancy Overview', 'Live, landlord-funded Rent Plans with no payment in 20+ days');
  r.cards([
    { label: '20+ days', value: num(t20), sub: `${num(t20 - t30)} between 20 and 29 days`, color: AMBER },
    { label: '30+ days', value: num(t30), sub: `${num(t30 - t40)} between 30 and 39 days`, color: RED },
    { label: '40+ days', value: num(t40), sub: 'Most urgent follow-up', subColor: RED, color: RED },
    { label: 'Outstanding (listed)', value: ugx(outstanding), sub: `${num(tenants.length)} tenants in this report`, color: BLUE },
    { label: 'Daily payments missed', value: ugx(dailyAtRisk), sub: 'Sum of expected daily payments', color: PURPLE },
  ]);

  r.heading('How Long Tenants Have Gone Quiet');
  r.hbars([
    { label: '20 - 29 days', value: t20 - t30, display: num(t20 - t30), color: AMBER },
    { label: '30 - 39 days', value: t30 - t40, display: num(t30 - t40), color: [234, 88, 12] },
    { label: '40+ days', value: t40, display: num(t40), color: RED },
  ], 8);

  const top = agents.slice().sort((a, b) => b.gte_20 - a.gte_20).slice(0, 10).filter((a) => a.gte_20 > 0);
  if (top.length) {
    r.heading('Agents With The Most Dormant Tenants', 'Top 10 by 20+ days count');
    r.hbars(top.map((a) => ({ label: a.label, value: a.gte_20, display: `${a.gte_20}  (30+: ${a.gte_30}, 40+: ${a.gte_40})`, color: a.gte_40 > 0 ? RED : AMBER })));
  }

  if (agents.length) {
    r.heading('Agent Accountability', 'Every agent with at least one dormant tenant');
    const sorted = agents.slice().sort((a, b) => b.gte_20 - a.gte_20);
    r.table(
      ['Agent', '20+ days', '30+ days', '40+ days'],
      sorted.map((a) => [a.label, a.gte_20, a.gte_30, a.gte_40]),
      { align: ['left', 'right', 'right', 'right'], foot: ['All agents', t20, t30, t40], colors: sorted.map((a) => [null, null, a.gte_30 > 0 ? AMBER : null, a.gte_40 > 0 ? RED : null]) },
    );
  }

  r.heading('Tenant List', agentLabel ? `Filtered to ${agentLabel}` : 'All agents, longest dormant first');
  if (!tenants.length) {
    r.note('No tenants have gone 20+ days without a payment.');
  } else {
    const list = tenants.slice().sort((a, b) => b.days_since_last_payment - a.days_since_last_payment);
    r.table(
      ['Tenant', 'Account No.', 'Agent', 'Last payment', 'Days', 'Daily payment', 'Outstanding', 'Total paid', 'Progress', 'Status'],
      list.map((t) => [t.tenant_name ?? 'Unnamed tenant', t.tenant_account_number ?? '-', t.agent_name, d(t.date_of_last_payment), `${t.days_since_last_payment}d`, ugx(t.expected_daily_payment), ugx(t.outstanding_balance), ugx(t.total_amount_paid), `${t.progress_pct}%`, t.tenant_status.replace(/_/g, ' ')]),
      {
        align: ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'left'],
        colors: list.map((t) => [null, null, null, null, t.days_since_last_payment >= 40 ? RED : t.days_since_last_payment >= 30 ? AMBER : null, null, null, null, null, null]),
      },
    );
  }
  return r.finish('20+ Days No Payment');
}

// ---------------------------------------------------------------- Promo
export interface PromoRow { surface: string; unique_tenants: number; impressions: number; clicks: number; click_through_rate: number }

export function generatePromoReachPdf(rows: PromoRow[], from: string, to: string, labels: Record<string, string>, preparedBy?: string): Blob {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const reach = rows.reduce((s, x) => s + x.unique_tenants, 0);
  const imp = rows.reduce((s, x) => s + x.impressions, 0);
  const clk = rows.reduce((s, x) => s + x.clicks, 0);
  const ctr = imp > 0 ? clk / imp : 0;
  const name = (s: string) => labels[s] ?? s;

  const r = createReport(
    'Rent-Access Promo Report',
    `${d(from)} to ${d(to)}`,
    PURPLE,
    [...generatedMeta(preparedBy), 'Message: "grow your rent access up to UGX 30,000,000"'],
  );

  r.heading('Reach & Engagement');
  const best = rows.slice().sort((a, b) => b.click_through_rate - a.click_through_rate)[0];
  r.cards([
    { label: 'Reach', value: num(reach), sub: 'unique tenants (per screen)', color: BLUE },
    { label: 'Sightings', value: num(imp), sub: 'times shown', color: PURPLE },
    { label: 'Taps', value: num(clk), sub: 'times tapped', color: GREEN },
    { label: 'Tap-rate', value: pct(ctr), sub: 'taps per sighting', color: AMBER },
    { label: 'Best screen', value: best ? name(best.surface) : '-', sub: best ? `${pct(best.click_through_rate)} tap-rate` : 'No data', color: GREEN },
  ]);

  if (!rows.length) {
    r.note('No sightings recorded in this date range yet.');
    return r.finish('Rent-Access Promo Report');
  }

  r.heading('Sightings By Screen');
  r.hbars(rows.slice().sort((a, b) => b.impressions - a.impressions).map((x) => ({ label: name(x.surface), value: x.impressions, display: num(x.impressions), color: PURPLE })));
  r.heading('Tap-rate By Screen');
  r.hbars(rows.slice().sort((a, b) => b.click_through_rate - a.click_through_rate).map((x) => ({ label: name(x.surface), value: x.click_through_rate, display: pct(x.click_through_rate), color: GREEN })));
  r.heading('Share Of Taps');
  r.hbars(rows.slice().sort((a, b) => b.clicks - a.clicks).map((x) => ({ label: name(x.surface), value: x.clicks, display: `${num(x.clicks)}  (${clk ? ((x.clicks / clk) * 100).toFixed(1) : '0.0'}%)`, color: BLUE })));

  r.heading('Breakdown By Screen');
  r.table(
    ['Screen', 'Reach', 'Sightings', 'Taps', 'Tap-rate'],
    rows.map((x) => [name(x.surface), num(x.unique_tenants), num(x.impressions), num(x.clicks), pct(x.click_through_rate)]),
    { align: ['left', 'right', 'right', 'right', 'right'], foot: ['All screens', num(reach), num(imp), num(clk), pct(ctr)] },
  );
  r.note('Reach counts unique tenants per screen, so a tenant who saw the message on two screens is counted on each.');
  return r.finish('Rent-Access Promo Report');
}

export function downloadPdf(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
