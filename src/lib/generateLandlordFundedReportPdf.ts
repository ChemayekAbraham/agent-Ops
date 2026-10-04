import jsPDF from 'jspdf';
import { format } from 'date-fns';
import type { LandlordFundedStats } from '@/hooks/useLandlordFundedStats';

/**
 * Board-grade "Landlords Funded" report for Landlord Ops.
 *
 * One landscape PDF containing, for the selected day or period:
 *  - KPI tiles with period-on-period comparisons (previous window of equal length)
 *  - a daily trend chart (money funded columns + landlords-funded line)
 *  - a top-districts bar chart
 *  - full tables: per district, per agent, per service centre
 *  - the detailed landlord-level funding register
 *
 * Everything is drawn with jsPDF primitives — no chart library, no images, so the
 * export stays fast and works offline.
 */

const ACCENT: [number, number, number] = [16, 122, 96];
const INK: [number, number, number] = [31, 41, 55];
const MUTED: [number, number, number] = [107, 114, 128];

export interface FundedReportMeta {
  dateFrom?: string | null;
  dateTo?: string | null;
  search?: string | null;
  generatedBy?: string | null;
}

export function landlordFundedFileName(meta: FundedReportMeta) {
  const a = meta.dateFrom || 'all';
  const b = meta.dateTo || 'today';
  return `landlords-funded_${a}_to_${b}.pdf`;
}

export function generateLandlordFundedReportPdf(
  stats: LandlordFundedStats,
  meta: FundedReportMeta,
): Blob {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 10;
  const contentWidth = pageWidth - margin * 2;
  const bottomLimit = pageHeight - 12;
  let y = 14;

  const ugx = (n: number | null | undefined) => `UGX ${Math.round(Number(n || 0)).toLocaleString()}`;
  const num = (n: number | null | undefined) => Math.round(Number(n || 0)).toLocaleString();
  const dt = (d: string | null | undefined, withTime = false) => {
    if (!d) return '—';
    try { return format(new Date(d), withTime ? 'dd MMM yyyy HH:mm' : 'dd MMM yyyy'); } catch { return '—'; }
  };
  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  const txt = (s: string | null | undefined, fb = '—') => {
    const v = (s ?? '').toString().trim();
    return v.length ? v : fb;
  };
  const compact = (n: number) => {
    const v = Math.abs(n);
    if (v >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (v >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return `${Math.round(n)}`;
  };
  const delta = (curr: number, prev: number) => {
    if (!prev) return curr > 0 ? 'new vs previous period' : 'no change';
    const pct = ((curr - prev) / prev) * 100;
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}% vs ${num(prev)} prev`;
  };

  const newPage = () => { doc.addPage(); y = 14; };
  const ensure = (needed: number) => { if (y + needed > bottomLimit) newPage(); };

  const sectionTitle = (title: string, subtitle?: string) => {
    ensure(14);
    doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.rect(margin, y - 3.2, 2, 6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(INK[0], INK[1], INK[2]);
    doc.text(title, margin + 4.5, y + 1.5);
    if (subtitle) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
      doc.text(subtitle, margin + 4.5 + doc.getTextWidth(title) + 3, y + 1.5);
    }
    y += 7;
  };

  /** Generic table renderer with repeating header on page breaks. */
  const table = (
    headers: string[],
    widths: number[],
    rows: (string | number)[][],
    opts?: { totals?: (string | number)[] },
  ) => {
    const rowH = 5.2;
    const drawHeader = () => {
      doc.setFillColor(238, 242, 240);
      doc.rect(margin, y, contentWidth, rowH + 0.6, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.6);
      doc.setTextColor(INK[0], INK[1], INK[2]);
      let x = margin + 1.5;
      headers.forEach((h, i) => {
        doc.text(clip(h.toUpperCase(), Math.floor(widths[i] / 1.5)), x, y + 3.9);
        x += widths[i];
      });
      y += rowH + 0.6;
    };
    drawHeader();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.6);
    rows.forEach((r, idx) => {
      if (y + rowH > bottomLimit) { newPage(); drawHeader(); doc.setFont('helvetica', 'normal'); doc.setFontSize(6.6); }
      if (idx % 2 === 1) {
        doc.setFillColor(250, 251, 250);
        doc.rect(margin, y, contentWidth, rowH, 'F');
      }
      doc.setTextColor(INK[0], INK[1], INK[2]);
      let x = margin + 1.5;
      r.forEach((cell, i) => {
        doc.text(clip(String(cell ?? '—'), Math.floor(widths[i] / 1.28)), x, y + 3.6);
        x += widths[i];
      });
      y += rowH;
    });
    if (opts?.totals) {
      if (y + rowH > bottomLimit) newPage();
      doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
      doc.rect(margin, y, contentWidth, rowH + 0.4, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.8);
      doc.setTextColor(255, 255, 255);
      let x = margin + 1.5;
      opts.totals.forEach((cell, i) => {
        doc.text(clip(String(cell ?? ''), Math.floor(widths[i] / 1.28)), x, y + 3.7);
        x += widths[i];
      });
      y += rowH + 2.5;
      doc.setTextColor(INK[0], INK[1], INK[2]);
    } else {
      y += 2.5;
    }
  };

  // ─── Header ───
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(20, 40, 120);
  doc.text('WELILE', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
  doc.text('Landlord Operations', margin + 22, y);
  doc.text(`Generated ${format(new Date(), 'dd MMM yyyy HH:mm')}`, pageWidth - margin, y, { align: 'right' });
  y += 6;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.text('Landlords Funded Report', margin, y);
  y += 6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.6);
  doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
  const periodLabel = `Period: ${dt(stats.range.from)} — ${dt(stats.range.to)}  (${num(stats.range.days)} day${stats.range.days === 1 ? '' : 's'})`;
  doc.text(periodLabel, margin, y);
  y += 4;
  doc.text(
    `Comparison period: ${dt(stats.range.previous_from)} — ${dt(stats.range.previous_to)}`
    + (meta.search ? `   ·   Search: "${meta.search}"` : '')
    + (meta.generatedBy ? `   ·   Prepared by: ${meta.generatedBy}` : ''),
    margin, y,
  );
  y += 4;
  doc.text(
    'A landlord counts as FUNDED on the date company money was committed to their property (rent request funding date).',
    margin, y,
  );
  y += 6;

  // ─── KPI tiles ───
  const s = stats.summary;
  const p = stats.previous;
  const tiles: { label: string; value: string; hint: string }[] = [
    { label: 'LANDLORDS FUNDED', value: num(s.landlords_funded), hint: delta(s.landlords_funded, p.landlords_funded) },
    { label: 'MONEY FUNDED', value: ugx(s.total_funded), hint: `prev ${ugx(p.total_funded)}` },
    { label: 'FUNDED PLACEMENTS', value: num(s.requests_funded), hint: delta(s.requests_funded, p.requests_funded) },
    { label: 'AVG PER LANDLORD', value: ugx(s.avg_per_landlord), hint: `avg per placement ${ugx(s.avg_per_request)}` },
    { label: 'FIRST-TIME LANDLORDS', value: num(s.first_time_landlords), hint: `${num(s.repeat_landlords)} repeat landlords` },
    { label: 'DISTRICTS COVERED', value: num(s.districts_covered), hint: `prev ${num(p.districts_covered)} districts` },
    { label: 'AGENTS INVOLVED', value: num(s.agents_involved), hint: `${num(stats.by_service_centre.length)} service centres` },
    { label: 'EXPECTED REPAYMENT', value: ugx(s.total_repayment), hint: `fees ${ugx(s.total_fees)}` },
  ];
  const perRow = 4;
  const tileW = (contentWidth - (perRow - 1) * 3) / perRow;
  const tileH = 15;
  tiles.forEach((t, i) => {
    const col = i % perRow;
    if (col === 0) ensure(tileH + 3);
    const x = margin + col * (tileW + 3);
    const ty = y;
    doc.setDrawColor(226, 232, 230);
    doc.setFillColor(252, 253, 252);
    doc.roundedRect(x, ty, tileW, tileH, 1.6, 1.6, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(5.9);
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    doc.text(t.label, x + 2.4, ty + 4);
    doc.setFontSize(10.5);
    doc.setTextColor(INK[0], INK[1], INK[2]);
    doc.text(clip(t.value, 24), x + 2.4, ty + 9.6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5.9);
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    doc.text(clip(t.hint, 42), x + 2.4, ty + 13.2);
    if (col === perRow - 1 || i === tiles.length - 1) y += tileH + 3;
  });
  y += 2;

  // ─── Verification / payout readiness strip ───
  sectionTitle('Funded landlord quality', 'verification + payout readiness inside the period');
  table(
    ['Metric', 'Count', 'Share of funded landlords'],
    [90, 60, contentWidth - 150],
    [
      ['Verified landlords', num(s.verified_landlords), pct(s.verified_landlords, s.landlords_funded)],
      ['Unverified landlords funded', num(s.unverified_landlords), pct(s.unverified_landlords, s.landlords_funded)],
      ['Mobile money details on file', num(s.with_momo), pct(s.with_momo, s.landlords_funded)],
      ['Bank details on file', num(s.with_bank), pct(s.with_bank, s.landlords_funded)],
      ['First-time funded landlords', num(s.first_time_landlords), pct(s.first_time_landlords, s.landlords_funded)],
      ['Repeat funded landlords', num(s.repeat_landlords), pct(s.repeat_landlords, s.landlords_funded)],
    ],
  );

  // ─── Daily trend chart ───
  if (stats.daily.length > 0) {
    const chartH = 42;
    ensure(chartH + 18);
    sectionTitle('Daily funding trend', 'columns = money funded · line = landlords funded');
    drawTrendChart(doc, {
      x: margin, y, w: contentWidth, h: chartH,
      data: stats.daily,
      compact, num,
    });
    y += chartH + 8;
  }

  // ─── Top districts bar chart ───
  if (stats.by_district.length > 0) {
    const top = stats.by_district.slice(0, 12);
    const chartH = Math.max(24, top.length * 6 + 8);
    ensure(chartH + 14);
    sectionTitle('Money funded by district', 'top 12 districts in this period');
    drawBarChart(doc, {
      x: margin, y, w: contentWidth, h: chartH,
      items: top.map(d => ({ label: d.district, value: Number(d.total_funded), sub: `${num(d.landlords_funded)} landlords` })),
      compact,
    });
    y += chartH + 8;
  }

  // ─── District table ───
  sectionTitle('Landlords funded per district', `${num(stats.by_district.length)} district(s)`);
  table(
    ['District', 'Region', 'Landlords', 'Placements', 'Money funded', 'Avg / landlord', 'Prev landlords', 'Change'],
    [42, 34, 22, 24, 40, 38, 28, contentWidth - 228],
    stats.by_district.map(d => [
      txt(d.district), txt(d.region), num(d.landlords_funded), num(d.requests_funded),
      ugx(d.total_funded), ugx(d.avg_per_landlord), num(d.previous_landlords_funded),
      changeLabel(Number(d.landlords_funded), Number(d.previous_landlords_funded)),
    ]),
    {
      totals: [
        'TOTAL', '', num(s.landlords_funded), num(s.requests_funded), ugx(s.total_funded),
        ugx(s.avg_per_landlord), num(p.landlords_funded),
        changeLabel(s.landlords_funded, p.landlords_funded),
      ],
    },
  );

  // ─── Agent table ───
  sectionTitle('Landlords funded per agent', `${num(stats.by_agent.length)} agent(s)`);
  table(
    ['Agent', 'Service centre', 'Landlords', 'Placements', 'Money funded', 'Districts', 'Prev landlords', 'Change'],
    [48, 46, 22, 24, 40, 22, 28, contentWidth - 230],
    stats.by_agent.map(a => [
      txt(a.agent_name), txt(a.service_centre), num(a.landlords_funded), num(a.requests_funded),
      ugx(a.total_funded), num(a.districts), num(a.previous_landlords_funded),
      changeLabel(Number(a.landlords_funded), Number(a.previous_landlords_funded)),
    ]),
  );

  // ─── Service centre table ───
  sectionTitle('Landlords funded per service centre', 'a sub-agent is attributed to the senior agent who recruited them');
  table(
    ['Service centre', 'Agents', 'Landlords', 'Placements', 'Money funded', 'Prev landlords', 'Prev money', 'Change'],
    [56, 22, 22, 24, 40, 28, 40, contentWidth - 232],
    stats.by_service_centre.map(c => [
      txt(c.service_centre), num(c.agents), num(c.landlords_funded), num(c.requests_funded),
      ugx(c.total_funded), num(c.previous_landlords_funded), ugx(c.previous_total_funded),
      changeLabel(Number(c.landlords_funded), Number(c.previous_landlords_funded)),
    ]),
  );

  // ─── Detailed register ───
  newPage();
  sectionTitle('Funding register', `${num(stats.rows.length)} funded placement(s), newest first`);
  table(
    ['Funded on', 'Landlord', 'Phone', 'Verified', 'District', 'Tenant', 'Agent', 'Service centre', 'Channel', 'Rent funded', 'Repayment', 'Status', 'First time'],
    [22, 34, 22, 14, 26, 32, 32, 32, 20, 26, 26, 20, contentWidth - 338],
    stats.rows.map(r => [
      dt(r.funded_at), txt(r.landlord_name), txt(r.landlord_phone), r.verified ? 'Yes' : 'No',
      txt(r.district), txt(r.tenant_name), txt(r.agent_name), txt(r.service_centre),
      txt(r.payout_channel), ugx(r.rent_amount), ugx(r.total_repayment),
      txt(r.status).replace(/_/g, ' '), r.first_time ? 'Yes' : 'No',
    ]),
  );

  // ─── Footer on every page ───
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.2);
    doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
    doc.text('Welile — Landlords Funded Report · internal management document', margin, pageHeight - 6);
    doc.text(`Page ${i} of ${pages}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
  }

  return doc.output('blob');

  function pct(part: number, total: number) {
    if (!total) return '—';
    return `${((Number(part) / Number(total)) * 100).toFixed(1)}%`;
  }
}

function changeLabel(curr: number, prev: number) {
  if (!prev) return curr > 0 ? 'new' : '—';
  const pctChange = ((curr - prev) / prev) * 100;
  return `${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(0)}%`;
}

/** Column + line combo chart for the daily series. */
function drawTrendChart(
  doc: jsPDF,
  o: {
    x: number; y: number; w: number; h: number;
    data: { day: string; total_funded: number; landlords_funded: number }[];
    compact: (n: number) => string;
    num: (n: number) => string;
  },
) {
  const { x, y, w, h, data } = o;
  doc.setDrawColor(226, 232, 230);
  doc.setFillColor(252, 253, 252);
  doc.roundedRect(x, y, w, h, 1.6, 1.6, 'FD');

  const padL = 18, padR = 14, padT = 5, padB = 9;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const maxMoney = Math.max(1, ...data.map(d => Number(d.total_funded)));
  const maxCount = Math.max(1, ...data.map(d => Number(d.landlords_funded)));

  // gridlines + money axis
  doc.setFontSize(5.2);
  doc.setTextColor(150, 156, 163);
  for (let g = 0; g <= 3; g++) {
    const gy = y + padT + plotH - (plotH * g) / 3;
    doc.setDrawColor(238, 242, 240);
    doc.line(x + padL, gy, x + padL + plotW, gy);
    doc.text(o.compact((maxMoney * g) / 3), x + padL - 1.5, gy + 1.2, { align: 'right' });
  }

  const slot = plotW / data.length;
  const barW = Math.max(0.9, Math.min(6, slot * 0.55));
  data.forEach((d, i) => {
    const cx = x + padL + slot * i + slot / 2;
    const bh = (Number(d.total_funded) / maxMoney) * plotH;
    doc.setFillColor(16, 122, 96);
    doc.rect(cx - barW / 2, y + padT + plotH - bh, barW, bh, 'F');
  });

  // landlords line
  doc.setDrawColor(217, 119, 6);
  doc.setLineWidth(0.4);
  data.forEach((d, i) => {
    if (i === 0) return;
    const prev = data[i - 1];
    const x1 = x + padL + slot * (i - 1) + slot / 2;
    const x2 = x + padL + slot * i + slot / 2;
    const y1 = y + padT + plotH - (Number(prev.landlords_funded) / maxCount) * plotH;
    const y2 = y + padT + plotH - (Number(d.landlords_funded) / maxCount) * plotH;
    doc.line(x1, y1, x2, y2);
  });
  doc.setLineWidth(0.2);

  // x labels — thin out so they never overlap
  const step = Math.ceil(data.length / 14);
  doc.setFontSize(5);
  doc.setTextColor(120, 126, 133);
  data.forEach((d, i) => {
    if (i % step !== 0) return;
    const cx = x + padL + slot * i + slot / 2;
    let label = d.day.slice(5);
    try { label = format(new Date(`${d.day}T00:00:00`), 'dd MMM'); } catch { /* keep */ }
    doc.text(label, cx, y + h - 3, { align: 'center' });
  });

  // legend
  doc.setFontSize(5.2);
  doc.setFillColor(16, 122, 96);
  doc.rect(x + w - 44, y + 2.4, 2.4, 2.4, 'F');
  doc.setTextColor(120, 126, 133);
  doc.text('Money funded', x + w - 40.5, y + 4.5);
  doc.setFillColor(217, 119, 6);
  doc.rect(x + w - 18, y + 2.4, 2.4, 2.4, 'F');
  doc.text('Landlords', x + w - 14.5, y + 4.5);
}

/** Horizontal bar chart for district totals. */
function drawBarChart(
  doc: jsPDF,
  o: {
    x: number; y: number; w: number; h: number;
    items: { label: string; value: number; sub: string }[];
    compact: (n: number) => string;
  },
) {
  const { x, y, w, h, items } = o;
  doc.setDrawColor(226, 232, 230);
  doc.setFillColor(252, 253, 252);
  doc.roundedRect(x, y, w, h, 1.6, 1.6, 'FD');
  const labelW = 34;
  const valueW = 34;
  const trackX = x + labelW + 3;
  const trackW = w - labelW - valueW - 8;
  const max = Math.max(1, ...items.map(i => i.value));
  items.forEach((it, i) => {
    const by = y + 5 + i * 6;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5.8);
    doc.setTextColor(31, 41, 55);
    doc.text(it.label.length > 22 ? `${it.label.slice(0, 21)}…` : it.label, x + 2.5, by + 2.6);
    doc.setFillColor(238, 242, 240);
    doc.rect(trackX, by, trackW, 3.2, 'F');
    doc.setFillColor(16, 122, 96);
    doc.rect(trackX, by, Math.max(0.6, (it.value / max) * trackW), 3.2, 'F');
    doc.setFontSize(5.6);
    doc.setTextColor(107, 114, 128);
    doc.text(`UGX ${o.compact(it.value)} · ${it.sub}`, trackX + trackW + 2, by + 2.6);
  });
}
