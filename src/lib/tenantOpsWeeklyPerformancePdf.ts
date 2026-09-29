import jsPDF from 'jspdf';
import { format } from 'date-fns';
import type {
  TenantOpsWeeklyHistoryRow,
  TenantOpsWeeklyPerformance,
} from '@/hooks/useTenantOpsWeeklyPerformance';
import type { TenantOpsNoPaymentReport } from '@/hooks/useTenantOpsNoPaymentReport';

/**
 * PDF exports for Tenant Ops -> Weekly Performance (three tabs).
 * Visual language mirrors generateTenantOpsToolReportPdf: WELILE header,
 * rounded KPI cards, accent-filled table heads, zebra rows, page footer.
 * Figures are taken as-is from the same RPC payloads the screens render.
 */

type RGB = [number, number, number];
type Align = 'left' | 'right';

const INK: RGB = [15, 23, 42];
const MUTED: RGB = [110, 110, 120];
const LINE: RGB = [225, 227, 232];
const PANEL: RGB = [248, 249, 252];
const GREEN: RGB = [22, 163, 74];
const RED: RGB = [220, 38, 38];
const AMBER: RGB = [217, 119, 6];
const BLUE: RGB = [37, 99, 235];

const ugx = (n: any) => `UGX ${Math.round(Number(n || 0)).toLocaleString()}`;
const num = (n: any) => Math.round(Number(n || 0)).toLocaleString();
const dayLabel = (iso: string | null | undefined, year = false) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return format(new Date(y, (m || 1) - 1, d || 1), year ? 'dd MMM yyyy' : 'dd MMM');
};
const signed = (n: number, suffix = '') => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString()}${suffix}`;

interface Card { label: string; value: string; sub?: string; subColor?: RGB; accent?: RGB }
interface Col<T> { label: string; w: number; align?: Align; get: (r: T) => string; color?: (r: T) => RGB | null }

function createReport(title: string, subtitle: string, accent: RGB, meta: string[]) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 10;
  const contentWidth = pageWidth - margin * 2;
  const bottomLimit = pageHeight - 12;
  let y = 14;

  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  const ensure = (needed: number, onNewPage?: () => void) => {
    if (y + needed > bottomLimit) { doc.addPage(); y = 14; onNewPage?.(); }
  };

  // Header
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(20, 40, 120);
  doc.text('WELILE', margin, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text(format(new Date(), 'dd MMM yyyy, hh:mm a'), pageWidth - margin, y, { align: 'right' });
  y += 8;
  doc.setFillColor(...accent); doc.rect(margin, y - 5.5, 1.4, 7, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(19); doc.setTextColor(...INK);
  doc.text(`Tenant Operations — ${title}`, margin + 3.5, y);
  y += 5;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text(subtitle, margin, y);
  if (meta.length) {
    y += 4.2;
    doc.setFont('helvetica', 'italic');
    doc.text(meta.join('   •   '), margin, y);
  }
  y += 4;
  doc.setDrawColor(...LINE); doc.setLineWidth(0.3); doc.line(margin, y, pageWidth - margin, y);
  y += 6;

  const api = {
    doc, margin, contentWidth, pageWidth,
    get y() { return y; },
    set y(v: number) { y = v; },
    ensure,

    heading(label: string, note?: string) {
      ensure(18);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
      doc.text(label, margin, y);
      if (note) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
        doc.text(note, margin + doc.getTextWidth(label) * (7 / 10) * 0 + doc.getStringUnitWidth(label) * 10 / doc.internal.scaleFactor + 3, y);
      }
      y += 4;
    },

    cards(cards: Card[], perRow = cards.length) {
      const gap = 2.5;
      const cardW = (contentWidth - gap * (perRow - 1)) / perRow;
      const cardH = cards.some(c => c.sub) ? 20 : 16;
      for (let i = 0; i < cards.length; i += perRow) {
        ensure(cardH + 3);
        cards.slice(i, i + perRow).forEach((c, j) => {
          const x = margin + j * (cardW + gap);
          doc.setFillColor(...PANEL); doc.setDrawColor(...LINE); doc.setLineWidth(0.2);
          (doc as any).roundedRect(x, y, cardW, cardH, 2, 2, 'FD');
          doc.setFillColor(...(c.accent ?? accent));
          doc.rect(x + 0.6, y + 3, 0.9, cardH - 6, 'F');
          doc.setFont('helvetica', 'bold'); doc.setFontSize(6); doc.setTextColor(120, 122, 135);
          doc.text(c.label.toUpperCase(), x + 3.5, y + 5.5);
          doc.setFontSize(12); doc.setTextColor(...INK);
          doc.text(clip(c.value, 22), x + 3.5, y + 12.5);
          if (c.sub) {
            doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5);
            doc.setTextColor(...(c.subColor ?? MUTED));
            doc.text(clip(c.sub, 40), x + 3.5, y + 17);
          }
        });
        y += cardH + 3;
      }
      y += 3;
    },

    table<T>(rows: T[], cols: Col<T>[], headColor: RGB = accent, emptyText = 'No records.') {
      const scale = contentWidth / cols.reduce((s, c) => s + c.w, 0);
      const widths = cols.map(c => c.w * scale);
      const head = () => {
        doc.setFillColor(...headColor); doc.rect(margin, y, contentWidth, 6, 'F');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(255, 255, 255);
        let x = margin;
        cols.forEach((c, i) => {
          const a = c.align || 'left';
          doc.text(c.label, a === 'right' ? x + widths[i] - 1.5 : x + 1.5, y + 4, { align: a });
          x += widths[i];
        });
        y += 6;
      };
      ensure(12);
      head();
      doc.setFontSize(6.8);
      if (!rows.length) {
        doc.setFont('helvetica', 'italic'); doc.setTextColor(...MUTED);
        doc.text(emptyText, margin + 1.5, y + 4); y += 7;
        return;
      }
      rows.forEach((r, ri) => {
        ensure(5.6, head);
        if (ri % 2 === 1) { doc.setFillColor(...PANEL); doc.rect(margin, y, contentWidth, 5, 'F'); }
        let x = margin;
        cols.forEach((c, i) => {
          const a = c.align || 'left';
          const color = c.color?.(r);
          doc.setFont('helvetica', color ? 'bold' : 'normal');
          doc.setTextColor(...(color ?? [30, 35, 50] as RGB));
          const maxChars = Math.max(4, Math.floor(widths[i] / 1.4));
          doc.text(clip(c.get(r), maxChars), a === 'right' ? x + widths[i] - 1.5 : x + 1.5, y + 3.5, { align: a });
          x += widths[i];
        });
        y += 5;
      });
      y += 6;
    },

    /** Horizontal bar chart. */
    hbars(items: { label: string; value: number; color?: RGB; display?: string }[], x: number, w: number, labelW = 50) {
      const max = Math.max(1, ...items.map(i => i.value));
      const barArea = w - labelW - 22;
      items.forEach(it => {
        ensure(7);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(30, 35, 50);
        doc.text(clip(it.label, Math.floor(labelW / 1.5)), x, y + 3.6);
        doc.setFillColor(238, 240, 245);
        (doc as any).roundedRect(x + labelW, y + 0.8, barArea, 3.8, 1, 1, 'F');
        const bw = Math.max(it.value > 0 ? 1.2 : 0, (it.value / max) * barArea);
        if (bw > 0) { doc.setFillColor(...(it.color ?? accent)); (doc as any).roundedRect(x + labelW, y + 0.8, bw, 3.8, 1, 1, 'F'); }
        doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK);
        doc.text(it.display ?? num(it.value), x + labelW + barArea + 2, y + 3.6);
        y += 6.2;
      });
    },

    /** Line chart with 1–2 series, each normalised to its own axis. */
    lineChart(
      labels: string[],
      series: { name: string; values: number[]; color: RGB; suffix?: string }[],
      h = 55,
    ) {
      ensure(h + 12);
      const x0 = margin + 12, x1 = margin + contentWidth - 12;
      const top = y + 4, bottom = y + h;
      doc.setFillColor(...PANEL); doc.setDrawColor(...LINE); doc.setLineWidth(0.2);
      (doc as any).roundedRect(margin, y - 1, contentWidth, h + 10, 2, 2, 'FD');
      doc.setDrawColor(230, 232, 238); doc.setLineWidth(0.15);
      for (let g = 0; g <= 4; g += 1) {
        const gy = top + ((bottom - top) * g) / 4;
        doc.line(x0, gy, x1, gy);
      }
      const n = labels.length;
      const px = (i: number) => (n <= 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1));
      series.forEach((s, si) => {
        const max = Math.max(...s.values, 1);
        const min = Math.min(...s.values, 0);
        const span = max - min || 1;
        const py = (v: number) => bottom - ((v - min) / span) * (bottom - top);
        // axis labels (left for series 0, right for series 1)
        doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor(...s.color);
        const ax = si === 0 ? margin + 1.5 : x1 + 1.5;
        doc.text(`${num(max)}${s.suffix ?? ''}`, ax, top + 1);
        doc.text(`${num(min)}${s.suffix ?? ''}`, ax, bottom);
        doc.setDrawColor(...s.color); doc.setLineWidth(0.7);
        for (let i = 1; i < n; i += 1) doc.line(px(i - 1), py(s.values[i - 1]), px(i), py(s.values[i]));
        doc.setFillColor(...s.color);
        s.values.forEach((v, i) => doc.circle(px(i), py(v), 0.8, 'F'));
        // last value label
        if (n) {
          doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5);
          doc.text(`${num(s.values[n - 1])}${s.suffix ?? ''}`, px(n - 1) - 1, py(s.values[n - 1]) - 1.8, { align: 'right' });
        }
      });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor(...MUTED);
      labels.forEach((l, i) => doc.text(l, px(i), bottom + 4, { align: 'center' }));
      // legend
      let lx = margin + contentWidth - 4;
      [...series].reverse().forEach(s => {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5);
        const tw = doc.getTextWidth(s.name);
        lx -= tw;
        doc.setTextColor(...s.color); doc.text(s.name, lx, y + 2.5);
        lx -= 3.5;
        doc.setFillColor(...s.color); doc.rect(lx, y + 0.8, 2.5, 2, 'F');
        lx -= 5;
      });
      y += h + 14;
    },

    note(text: string) {
      ensure(8);
      doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(...MUTED);
      const lines = doc.splitTextToSize(text, contentWidth);
      doc.text(lines, margin, y);
      y += lines.length * 3.4 + 3;
    },

    finish(footerTitle: string): Blob {
      const pages = doc.getNumberOfPages();
      for (let p = 1; p <= pages; p += 1) {
        doc.setPage(p);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(140, 142, 155);
        doc.text(`Welile — Tenant Operations · ${footerTitle} · generated ${format(new Date(), 'dd MMM yyyy HH:mm')}`, margin, pageHeight - 6);
        doc.text(`Page ${p} of ${pages}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
      }
      return doc.output('blob');
    },
  };
  return api;
}

const deltaColor = (d: number, goodUp = true): RGB => (d === 0 ? MUTED : (d > 0) === goodUp ? GREEN : RED);

/* ───────────────────────── 1. Weekly Performance ───────────────────────── */

export function generateWeeklyPerformancePdf(
  data: TenantOpsWeeklyPerformance,
  history: TenantOpsWeeklyHistoryRow[],
  preparedBy?: string | null,
): Blob {
  const { current, previous, delta } = data;
  const r = createReport(
    'Weekly Performance',
    'Portfolio growth, payment behaviour and collection-slowdown risk, reported Wednesday to Tuesday.',
    BLUE,
    [
      `Reporting week: ${dayLabel(data.week_start, true)} – ${dayLabel(data.week_end, true)} (${data.is_current_week_open ? 'in progress' : 'closed'})`,
      `Compared with: ${dayLabel(previous.week_start)} – ${dayLabel(previous.week_end)}`,
      ...(preparedBy ? [`Prepared by: ${preparedBy}`] : []),
    ],
  );

  r.heading('Management summary');
  const sub = (d: number, suffix = '', goodUp = true) => ({ sub: `${signed(d, suffix)} vs last week`, subColor: deltaColor(d, goodUp) });
  r.cards([
    { label: 'Active tenants', value: num(current.total_active_tenants), ...sub(delta.total_active_tenants), accent: BLUE },
    { label: 'Paying tenants', value: num(current.paying_tenants), ...sub(delta.paying_tenants), accent: GREEN },
    { label: 'Non-paying tenants', value: num(current.non_paying_tenants), ...sub(delta.non_paying_tenants, '', false), accent: RED },
    { label: 'Payment rate', value: `${current.payment_rate_pct}%`, ...sub(delta.payment_rate_pct, ' pts'), accent: GREEN },
    { label: 'New tenants', value: num(current.new_tenants_added), ...sub(delta.new_tenants_added), accent: BLUE },
    { label: '20+ days no payment', value: num(current.dormant_20_plus_count), ...sub(delta.dormant_20_plus_count, '', false), accent: AMBER },
  ]);

  // Self-payment highlight + this vs last week comparison side by side
  const rate = delta.self_payment_increase_pct;
  r.cards([
    {
      label: 'Tenant self-payments via merchant',
      value: `${num(current.self_payment_tenants)} tenants`,
      sub: `${signed(delta.self_payment_tenants)}${rate !== null ? ` (${rate > 0 ? '+' : ''}${rate}%)` : ''} vs last week (${num(previous.self_payment_tenants)})`,
      subColor: deltaColor(delta.self_payment_tenants),
      accent: BLUE,
    },
  ], 2);

  r.heading('This week vs last week');
  type CmpRow = { metric: string; now: number; prev: number; d: number; suffix?: string; goodUp: boolean };
  const cmp: CmpRow[] = [
    { metric: 'Active tenants', now: current.total_active_tenants, prev: previous.total_active_tenants, d: delta.total_active_tenants, goodUp: true },
    { metric: 'Paying tenants', now: current.paying_tenants, prev: previous.paying_tenants, d: delta.paying_tenants, goodUp: true },
    { metric: 'Non-paying tenants', now: current.non_paying_tenants, prev: previous.non_paying_tenants, d: delta.non_paying_tenants, goodUp: false },
    { metric: 'Payment rate', now: current.payment_rate_pct, prev: previous.payment_rate_pct, d: delta.payment_rate_pct, suffix: '%', goodUp: true },
    { metric: 'New tenants added', now: current.new_tenants_added, prev: previous.new_tenants_added, d: delta.new_tenants_added, goodUp: true },
    { metric: 'Self-paid via merchant', now: current.self_payment_tenants, prev: previous.self_payment_tenants, d: delta.self_payment_tenants, goodUp: true },
    { metric: '20+ days no payment', now: current.dormant_20_plus_count, prev: previous.dormant_20_plus_count, d: delta.dormant_20_plus_count, goodUp: false },
  ];
  r.table(cmp, [
    { label: 'Metric', w: 60, get: c => c.metric },
    { label: 'This week', w: 30, align: 'right', get: c => `${num(c.now)}${c.suffix ?? ''}` },
    { label: 'Last week', w: 30, align: 'right', get: c => `${num(c.prev)}${c.suffix ?? ''}` },
    { label: 'Change', w: 30, align: 'right', get: c => signed(c.d, c.suffix === '%' ? ' pts' : ''), color: c => deltaColor(c.d, c.goodUp) },
    { label: 'Reading', w: 40, get: c => (c.d === 0 ? 'Unchanged' : (c.d > 0) === c.goodUp ? 'Improved' : 'Worsened'), color: c => deltaColor(c.d, c.goodUp) },
  ]);

  // Paying vs non-paying split bar
  r.heading('Payment split this week');
  const tot = Math.max(1, current.paying_tenants + current.non_paying_tenants);
  r.hbars([
    { label: 'Paying tenants', value: current.paying_tenants, color: GREEN, display: `${num(current.paying_tenants)} (${Math.round((current.paying_tenants / tot) * 100)}%)` },
    { label: 'Non-paying tenants', value: current.non_paying_tenants, color: RED, display: `${num(current.non_paying_tenants)} (${Math.round((current.non_paying_tenants / tot) * 100)}%)` },
    { label: '20+ days no payment', value: current.dormant_20_plus_count, color: AMBER },
  ], r.margin, r.contentWidth, 45);
  r.y += 4;

  const hist = history.slice().reverse();
  if (hist.length) {
    r.doc.addPage(); r.y = 14;
    r.heading('Trend — last closed weeks', 'Payment rate and active tenants, each on its own scale');
    r.lineChart(
      hist.map(w => dayLabel(w.week_start)),
      [
        { name: 'Payment rate %', values: hist.map(w => w.payment_rate_pct), color: GREEN, suffix: '%' },
        { name: 'Active tenants', values: hist.map(w => w.total_active_tenants), color: BLUE },
      ],
    );
    r.heading('Trend — new tenants, self-payments and 20+ days no payment');
    r.lineChart(
      hist.map(w => dayLabel(w.week_start)),
      [
        { name: 'New tenants', values: hist.map(w => w.new_tenants_added), color: BLUE },
        { name: '20+ days no payment', values: hist.map(w => w.dormant_20_plus_count), color: AMBER },
      ],
      45,
    );
  }

  r.heading(`Historical weekly records (${history.length})`);
  r.table(history, [
    { label: 'Week', w: 40, get: w => `${dayLabel(w.week_start)} – ${dayLabel(w.week_end)}` },
    { label: 'Active', w: 22, align: 'right', get: w => num(w.total_active_tenants) },
    { label: 'Paying', w: 22, align: 'right', get: w => num(w.paying_tenants) },
    { label: 'Non-paying', w: 22, align: 'right', get: w => num(w.non_paying_tenants) },
    { label: 'Payment rate', w: 24, align: 'right', get: w => `${w.payment_rate_pct}%` },
    { label: 'New', w: 18, align: 'right', get: w => num(w.new_tenants_added) },
    { label: '20+ days', w: 20, align: 'right', get: w => num(w.dormant_20_plus_count) },
    { label: 'Self-paid via merchant', w: 32, align: 'right', get: w => num(w.self_payment_tenants) },
    { label: 'Frozen at', w: 30, get: w => (w.captured_at ? format(new Date(w.captured_at), 'dd MMM yyyy HH:mm') : '—') },
  ], BLUE, 'No closed weeks recorded yet.');
  r.note('A reporting week runs Wednesday to Tuesday. Figures for a closed week are frozen when it closes and are never recalculated.');

  return r.finish('Weekly Performance');
}

/* ───────────────────────── 2. 20+ Days No Payment ───────────────────────── */

export function generateNoPaymentPdf(
  report: TenantOpsNoPaymentReport,
  agentLabel: string | null,
  preparedBy?: string | null,
): Blob {
  const agents = report.agent_summary ?? [];
  const tenants = (report.tenants ?? []).slice().sort((a, b) => b.days_since_last_payment - a.days_since_last_payment);
  const totals = agents.reduce(
    (a, x) => ({ g20: a.g20 + x.gte_20, g30: a.g30 + x.gte_30, g40: a.g40 + x.gte_40 }),
    { g20: 0, g30: 0, g40: 0 },
  );
  const outstanding = tenants.reduce((s, t) => s + Number(t.outstanding_balance || 0), 0);
  const dailyAtRisk = tenants.reduce((s, t) => s + Number(t.expected_daily_payment || 0), 0);
  const paid = tenants.reduce((s, t) => s + Number(t.total_amount_paid || 0), 0);
  const avgDays = tenants.length ? tenants.reduce((s, t) => s + t.days_since_last_payment, 0) / tenants.length : 0;

  const r = createReport(
    '20+ Days No Payment',
    'Tenants on a live, landlord-funded Rent Plan who have gone 20 or more days without a single payment.',
    RED,
    [
      `As of: ${report.as_of ? format(new Date(report.as_of), 'dd MMM yyyy HH:mm') : format(new Date(), 'dd MMM yyyy')}`,
      `Agent: ${agentLabel ?? 'All agents'}`,
      ...(preparedBy ? [`Prepared by: ${preparedBy}`] : []),
    ],
  );

  r.heading('Dormancy bands (all agents)');
  r.cards([
    { label: '20+ days', value: num(totals.g20), sub: 'quiet 20 days or more', accent: AMBER },
    { label: '30+ days', value: num(totals.g30), sub: 'quiet 30 days or more', accent: RED },
    { label: '40+ days', value: num(totals.g40), sub: 'quiet 40 days or more', accent: RED },
    { label: 'Agents affected', value: num(agents.filter(a => a.gte_20 > 0).length), accent: BLUE },
  ]);
  r.heading(agentLabel ? `Exposure — ${agentLabel}` : 'Exposure — tenants listed');
  r.cards([
    { label: 'Tenants listed', value: num(tenants.length), accent: RED },
    { label: 'Outstanding balance', value: ugx(outstanding), accent: RED },
    { label: 'Daily payments missing', value: ugx(dailyAtRisk), sub: 'expected per day, not coming in', accent: AMBER },
    { label: 'Paid to date', value: ugx(paid), accent: GREEN },
    { label: 'Average days quiet', value: `${Math.round(avgDays)} days`, accent: AMBER },
  ]);

  // Band distribution bars
  r.heading('How long they have gone quiet');
  const b2029 = tenants.filter(t => t.days_since_last_payment < 30).length;
  const b3039 = tenants.filter(t => t.days_since_last_payment >= 30 && t.days_since_last_payment < 40).length;
  const b40 = tenants.filter(t => t.days_since_last_payment >= 40).length;
  r.hbars([
    { label: '20 – 29 days', value: b2029, color: AMBER },
    { label: '30 – 39 days', value: b3039, color: [234, 88, 12] },
    { label: '40+ days', value: b40, color: RED },
  ], r.margin, r.contentWidth / 2, 30);
  r.y += 4;

  r.heading('Agent accountability', 'Sorted by tenants 20+ days quiet');
  const agentRows = agents.slice().sort((a, b) => b.gte_20 - a.gte_20);
  const topAgents = agentRows.filter(a => a.gte_20 > 0).slice(0, 12);
  if (topAgents.length) {
    r.hbars(topAgents.map(a => ({ label: a.label, value: a.gte_20, color: a.gte_40 > 0 ? RED : AMBER })), r.margin, r.contentWidth, 70);
    r.y += 4;
  }
  r.table(agentRows, [
    { label: 'Agent', w: 90, get: a => a.label },
    { label: '20+ days', w: 25, align: 'right', get: a => num(a.gte_20) },
    { label: '30+ days', w: 25, align: 'right', get: a => num(a.gte_30), color: a => (a.gte_30 > 0 ? AMBER : null) },
    { label: '40+ days', w: 25, align: 'right', get: a => num(a.gte_40), color: a => (a.gte_40 > 0 ? RED : null) },
    { label: 'Share of 20+', w: 25, align: 'right', get: a => `${totals.g20 ? Math.round((a.gte_20 / totals.g20) * 100) : 0}%` },
  ], RED, 'No agents have tenants in this band.');

  r.heading(`Tenant list (${tenants.length})`, 'Longest-quiet first');
  const tone = (d: number): RGB | null => (d >= 40 ? RED : d >= 30 ? AMBER : null);
  r.table(tenants, [
    { label: 'Tenant', w: 38, get: t => t.tenant_name ?? 'Unnamed tenant' },
    { label: 'Account no.', w: 24, get: t => t.tenant_account_number ?? '—' },
    { label: 'Agent responsible', w: 34, get: t => t.agent_name },
    { label: 'Last payment', w: 22, get: t => dayLabel(t.date_of_last_payment, true) },
    { label: 'Days quiet', w: 16, align: 'right', get: t => `${t.days_since_last_payment}d`, color: t => tone(t.days_since_last_payment) },
    { label: 'Daily expected', w: 22, align: 'right', get: t => num(t.expected_daily_payment) },
    { label: 'Outstanding', w: 24, align: 'right', get: t => num(t.outstanding_balance) },
    { label: 'Total paid', w: 24, align: 'right', get: t => num(t.total_amount_paid) },
    { label: 'Progress', w: 16, align: 'right', get: t => `${t.progress_pct}%` },
    { label: 'Status', w: 20, get: t => t.tenant_status.replace(/_/g, ' ') },
  ], RED, 'No tenants have gone 20+ days without a payment.');
  r.note('Amounts are in UGX. Days since last payment count collections and repayments on file.');

  return r.finish('20+ Days No Payment');
}

/* ───────────────────────── 3. Rent-Access Promo ───────────────────────── */

export interface PromoStatsRow {
  surface: string;
  unique_tenants: number;
  impressions: number;
  clicks: number;
  click_through_rate: number;
}

export function generatePromoReachPdf(
  rows: PromoStatsRow[],
  from: string,
  to: string,
  surfaceLabels: Record<string, string>,
  preparedBy?: string | null,
): Blob {
  const PURPLE: RGB = [124, 58, 237];
  const label = (s: string) => surfaceLabels[s] ?? s;
  const impressions = rows.reduce((s, x) => s + x.impressions, 0);
  const clicks = rows.reduce((s, x) => s + x.clicks, 0);
  const reach = rows.reduce((s, x) => s + x.unique_tenants, 0);
  const ctr = impressions > 0 ? clicks / impressions : 0;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const best = rows.slice().sort((a, b) => b.click_through_rate - a.click_through_rate)[0];

  const r = createReport(
    'Rent-Access Promo Reach',
    'How often tenants see and tap the "grow your rent access up to UGX 30,000,000" message, per screen.',
    PURPLE,
    [
      `Period: ${dayLabel(from, true)} → ${dayLabel(to, true)}`,
      ...(preparedBy ? [`Prepared by: ${preparedBy}`] : []),
    ],
  );

  r.heading('Totals');
  r.cards([
    { label: 'Reach', value: num(reach), sub: 'unique tenants (summed per screen)', accent: PURPLE },
    { label: 'Sightings', value: num(impressions), sub: 'times shown', accent: BLUE },
    { label: 'Taps', value: num(clicks), sub: 'times tapped', accent: GREEN },
    { label: 'Tap-rate', value: pct(ctr), sub: 'taps per sighting', accent: AMBER },
    { label: 'Best screen', value: best ? label(best.surface) : '—', sub: best ? `${pct(best.click_through_rate)} tap-rate` : undefined, accent: GREEN },
  ]);

  if (rows.length) {
    const half = r.contentWidth / 2 - 4;
    const startY = r.y;
    r.heading('Sightings per screen');
    r.hbars(rows.map(x => ({ label: label(x.surface), value: x.impressions, color: BLUE })), r.margin, half, 42);
    const leftEnd = r.y;
    r.y = startY;
    const rx = r.margin + half + 8;
    r.doc.setFont('helvetica', 'bold'); r.doc.setFontSize(10); r.doc.setTextColor(...INK);
    r.doc.text('Tap-rate per screen', rx, r.y); r.y += 4;
    const maxCtr = Math.max(...rows.map(x => x.click_through_rate));
    r.hbars(rows.map(x => ({ label: label(x.surface), value: x.click_through_rate, color: x.click_through_rate === maxCtr ? GREEN : PURPLE, display: pct(x.click_through_rate) })), rx, half, 42);
    r.y = Math.max(leftEnd, r.y) + 4;

    r.heading('Share of taps by screen');
    r.hbars(rows.map(x => ({ label: label(x.surface), value: x.clicks, color: GREEN, display: `${num(x.clicks)} (${clicks ? Math.round((x.clicks / clicks) * 100) : 0}%)` })), r.margin, r.contentWidth, 50);
    r.y += 4;
  }

  r.heading('Per-screen breakdown');
  const withTotal = [...rows, { surface: '__total', unique_tenants: reach, impressions, clicks, click_through_rate: ctr }];
  const isTotal = (x: PromoStatsRow) => x.surface === '__total';
  r.table(withTotal, [
    { label: 'Screen', w: 70, get: x => (isTotal(x) ? 'All screens' : label(x.surface)), color: x => (isTotal(x) ? INK : null) },
    { label: 'Reach', w: 30, align: 'right', get: x => num(x.unique_tenants) },
    { label: 'Sightings', w: 30, align: 'right', get: x => num(x.impressions) },
    { label: 'Taps', w: 30, align: 'right', get: x => num(x.clicks) },
    { label: 'Tap-rate', w: 30, align: 'right', get: x => pct(x.click_through_rate), color: x => (isTotal(x) ? INK : null) },
    { label: 'Sightings per tenant', w: 36, align: 'right', get: x => (x.unique_tenants ? (x.impressions / x.unique_tenants).toFixed(1) : '—') },
  ], PURPLE, 'No sightings recorded in this date range yet.');
  r.note('Reach is counted per screen; a tenant who saw the message on two screens is counted on each.');

  return r.finish('Rent-Access Promo Reach');
}

export function downloadPdf(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
