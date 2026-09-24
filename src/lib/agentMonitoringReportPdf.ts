import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';

/**
 * Tenant Ops → Classic → Agent Monitoring PDF.
 *
 * PRESENTATION ONLY. Every figure is handed in already computed by
 * AgentMonitoring.tsx (same schedule map, same receipt attribution, same
 * status rule, same filters). This file never re-derives expected,
 * collected, arrears or status — it only sums and lays out what the page
 * shows, so the PDF and the screen always agree.
 */

export type ReportStatus = 'full' | 'partial' | 'critical' | 'none';

export interface ReportAgent {
  name: string;
  phone: string | null;
  tenantCount: number;
  dailyCount: number;
  weeklyCount: number;
  dueCount: number;
  coveredAheadCount: number;
  expected: number;
  collected: number;
  arrears: number;
  behindCount: number;
  aheadCount: number;
  requestCount: number;
  status: ReportStatus;
  /** Split by the tenants' own payment period, from the page's schedule map. */
  dailyExpected: number;
  dailyCollected: number;
  weeklyExpected: number;
  weeklyCollected: number;
}

export interface AgentMonitoringReportInput {
  day: Date;
  cohortLabel: string;
  frequencyLabel: string;
  statusLabel: string;
  search: string;
  agents: ReportAgent[];
}

const STATUS_LABEL: Record<ReportStatus, string> = {
  full: 'On target', partial: 'Partial', critical: 'Critical', none: 'Nothing due',
};

type RGB = [number, number, number];
const BRAND: RGB = [146, 52, 234];
const INK: RGB = [15, 23, 42];
const MUTED: RGB = [110, 112, 125];
const LINE: RGB = [226, 228, 236];
const SOFT: RGB = [248, 249, 252];
const GREEN: RGB = [5, 150, 105];
const AMBER: RGB = [217, 119, 6];
const RED: RGB = [220, 38, 38];
const SKY: RGB = [2, 132, 199];
const GREY: RGB = [148, 150, 160];
const STATUS_COLOR: Record<ReportStatus, RGB> = { full: GREEN, partial: AMBER, critical: RED, none: GREY };

const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-US')}`;
const pct = (num: number, den: number) => (den > 0 ? `${Math.min(100, (num / den) * 100).toFixed(1)}%` : '—');
const eat = (d: Date, f: string) => {
  const shifted = new Date(d.getTime() + (d.getTimezoneOffset() + 180) * 60_000);
  return format(shifted, f);
};

async function logPdfExport(filename: string) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('audit_logs').insert({
      user_id: user?.id ?? null,
      action_type: 'pdf_report_exported',
      table_name: 'export',
      record_id: null,
      metadata: { filename, report: 'tenant_ops_agent_monitoring' },
    });
  } catch (e) {
    console.warn('[agentMonitoringReportPdf] audit log insert failed:', e);
  }
}

export async function generateAgentMonitoringPdf(input: AgentMonitoringReportInput) {
  const { agents, day } = input;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 12;
  const generatedAt = new Date();

  // ---------- Totals (sums of the page's own per-agent figures) ----------
  const t = agents.reduce((s, a) => ({
    expected: s.expected + a.expected,
    collected: s.collected + a.collected,
    dueCount: s.dueCount + a.dueCount,
    covered: s.covered + a.coveredAheadCount,
    tenants: s.tenants + a.tenantCount,
    daily: s.daily + a.dailyCount,
    weekly: s.weekly + a.weeklyCount,
    arrears: s.arrears + a.arrears,
    behind: s.behind + a.behindCount,
    ahead: s.ahead + a.aheadCount,
    nothingDue: s.nothingDue + (a.expected <= 0 ? 1 : 0),
    dExp: s.dExp + a.dailyExpected, dCol: s.dCol + a.dailyCollected,
    wExp: s.wExp + a.weeklyExpected, wCol: s.wCol + a.weeklyCollected,
    requests: s.requests + a.requestCount,
  }), { expected: 0, collected: 0, dueCount: 0, covered: 0, tenants: 0, daily: 0, weekly: 0, arrears: 0, behind: 0, ahead: 0, nothingDue: 0, dExp: 0, dCol: 0, wExp: 0, wCol: 0, requests: 0 });
  const gap = Math.max(0, t.expected - t.collected);

  const byStatus = (['full', 'partial', 'critical', 'none'] as ReportStatus[]).map((s) => {
    const rows = agents.filter((a) => a.status === s);
    return {
      status: s, count: rows.length,
      expected: rows.reduce((x, a) => x + a.expected, 0),
      collected: rows.reduce((x, a) => x + a.collected, 0),
      arrears: rows.reduce((x, a) => x + a.arrears, 0),
    };
  });

  // ---------- Header ----------
  const header = (first: boolean) => {
    doc.setFillColor(...BRAND);
    doc.rect(0, 0, W, first ? 26 : 12, 'F');
    doc.setTextColor(255, 255, 255);
    if (first) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(17);
      doc.text('Agent Monitoring Report', M, 12);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text('Tenant Ops · Classic · Daily expected collections and field performance', M, 18.5);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
      doc.text(format(day, 'EEEE, dd MMMM yyyy'), W - M, 12, { align: 'right' });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      doc.text(`Generated ${eat(generatedAt, 'dd MMM yyyy, HH:mm')} EAT`, W - M, 18.5, { align: 'right' });
    } else {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
      doc.text('Agent Monitoring Report', M, 7.8);
      doc.setFont('helvetica', 'normal');
      doc.text(format(day, 'dd MMM yyyy'), W - M, 7.8, { align: 'right' });
    }
  };
  header(true);

  // ---------- Filter strip ----------
  let y = 31;
  const chips: [string, string][] = [
    ['Day', `${format(day, 'dd MMM yyyy')} (00:00–24:00 EAT)`],
    ['Cohort', input.cohortLabel],
    ['Payment period', input.frequencyLabel],
    ['Status', input.statusLabel],
    ['Search', input.search.trim() ? `"${input.search.trim()}"` : 'None'],
  ];
  let x = M;
  doc.setFontSize(7.5);
  chips.forEach(([k, v]) => {
    const label = `${k}: `;
    doc.setFont('helvetica', 'bold'); const lw = doc.getTextWidth(label);
    doc.setFont('helvetica', 'normal'); const vw = doc.getTextWidth(v);
    const w = lw + vw + 6;
    doc.setFillColor(243, 236, 253); doc.setDrawColor(221, 204, 250);
    doc.roundedRect(x, y - 4, w, 6, 1.5, 1.5, 'FD');
    doc.setTextColor(...BRAND); doc.setFont('helvetica', 'bold'); doc.text(label, x + 3, y);
    doc.setTextColor(...INK); doc.setFont('helvetica', 'normal'); doc.text(v, x + 3 + lw, y);
    x += w + 2.5;
  });
  y += 6;

  // ---------- KPI cards ----------
  const kpis: { label: string; value: string; hint: string; color: RGB }[] = [
    { label: 'Agents monitored', value: String(agents.length), hint: `${t.nothingDue} with nothing due`, color: INK },
    { label: 'Due this day', value: String(t.dueCount), hint: `of ${t.tenants} tenants`, color: BRAND },
    { label: 'Collected', value: ugx(t.collected), hint: `of ${ugx(t.expected)} expected`, color: GREEN },
    { label: 'Collection rate', value: pct(t.collected, t.expected), hint: `Gap ${ugx(gap)}`, color: t.expected > 0 && t.collected >= t.expected ? GREEN : AMBER },
    { label: 'Total arrears', value: ugx(t.arrears), hint: `${t.behind} tenants behind`, color: t.arrears > 0 ? RED : INK },
    { label: 'Paid ahead', value: String(t.ahead), hint: 'tenants covering future periods', color: SKY },
    { label: 'Daily / weekly', value: `${t.daily} / ${t.weekly}`, hint: 'plans by payment period', color: INK },
  ];
  const gapX = 2.5;
  const cw = (W - 2 * M - gapX * (kpis.length - 1)) / kpis.length;
  kpis.forEach((k, i) => {
    const cx = M + i * (cw + gapX);
    doc.setFillColor(...SOFT); doc.setDrawColor(...LINE);
    doc.roundedRect(cx, y, cw, 20, 2, 2, 'FD');
    doc.setFillColor(...k.color); doc.rect(cx, y + 2, 0.9, 16, 'F');
    doc.setTextColor(...MUTED); doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5);
    doc.text(k.label.toUpperCase(), cx + 3.5, y + 5.5);
    doc.setTextColor(...k.color); doc.setFontSize(k.value.length > 14 ? 10 : 12.5);
    doc.text(k.value, cx + 3.5, y + 12.5);
    doc.setTextColor(...MUTED); doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5);
    doc.text(doc.splitTextToSize(k.hint, cw - 6)[0], cx + 3.5, y + 17);
  });
  y += 26;

  // ---------- Row: status breakdown chart | expected vs collected by period | insights ----------
  const colW = (W - 2 * M - 8) / 3;
  const boxH = 62;
  const panel = (px: number, title: string) => {
    doc.setDrawColor(...LINE); doc.setFillColor(255, 255, 255);
    doc.roundedRect(px, y, colW, boxH, 2, 2, 'FD');
    doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text(title, px + 4, y + 6.5);
    doc.setDrawColor(...LINE); doc.line(px + 4, y + 9, px + colW - 4, y + 9);
  };

  // Panel 1 — status breakdown
  const p1 = M;
  panel(p1, 'Agent status breakdown');
  const total = Math.max(1, agents.length);
  let sx = p1 + 4;
  const barW = colW - 8;
  byStatus.forEach((s) => {
    const w = (s.count / total) * barW;
    if (w > 0) { doc.setFillColor(...STATUS_COLOR[s.status]); doc.rect(sx, y + 12, w, 5, 'F'); sx += w; }
  });
  if (agents.length === 0) { doc.setFillColor(...LINE); doc.rect(p1 + 4, y + 12, barW, 5, 'F'); }
  byStatus.forEach((s, i) => {
    const ry = y + 24 + i * 9;
    doc.setFillColor(...STATUS_COLOR[s.status]); doc.circle(p1 + 6, ry - 1.2, 1.3, 'F');
    doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.text(`${STATUS_LABEL[s.status]}`, p1 + 9, ry);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTED); doc.setFontSize(7);
    doc.text(`${s.count} agent${s.count === 1 ? '' : 's'} · ${pct(s.count, agents.length)}`, p1 + 9, ry + 3.5);
    doc.setTextColor(...INK); doc.setFontSize(7.5);
    doc.text(`${ugx(s.collected)} / ${ugx(s.expected)}`, p1 + colW - 4, ry, { align: 'right' });
    doc.setTextColor(...MUTED); doc.setFontSize(6.5);
    doc.text(`collected / expected`, p1 + colW - 4, ry + 3.5, { align: 'right' });
  });

  // Panel 2 — expected vs collected by payment period
  const p2 = M + colW + 4;
  panel(p2, 'Expected vs collected by payment period');
  const groups = [
    { label: 'All plans', exp: t.expected, col: t.collected, plans: t.daily + t.weekly },
    { label: 'Daily plans', exp: t.dExp, col: t.dCol, plans: t.daily },
    { label: 'Weekly plans', exp: t.wExp, col: t.wCol, plans: t.weekly },
  ];
  const maxV = Math.max(1, ...groups.flatMap((g) => [g.exp, g.col]));
  const labelW = 22;
  const chartW = colW - 8 - labelW - 2;
  groups.forEach((g, i) => {
    const gy = y + 15 + i * 15;
    doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5);
    doc.text(g.label, p2 + 4, gy + 2.5);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTED); doc.setFontSize(6.5);
    doc.text(`${g.plans} plans · ${pct(g.col, g.exp)}`, p2 + 4, gy + 6.5);
    const bx = p2 + 4 + labelW + 2;
    doc.setFillColor(226, 232, 240); doc.rect(bx, gy, chartW, 3.4, 'F');
    doc.setFillColor(148, 163, 184); doc.rect(bx, gy, (g.exp / maxV) * chartW, 3.4, 'F');
    doc.setFillColor(...GREEN); doc.rect(bx, gy + 4.4, Math.max(0.3, (g.col / maxV) * chartW), 3.4, 'F');
    doc.setTextColor(...INK); doc.setFontSize(6.3);
    doc.text(ugx(g.exp), bx + chartW, gy - 0.8, { align: 'right' });
    doc.setTextColor(...GREEN);
    doc.text(ugx(g.col), bx + chartW, gy + 11, { align: 'right' });
  });
  doc.setFontSize(6.5);
  doc.setFillColor(148, 163, 184); doc.rect(p2 + 4, y + boxH - 6, 3, 2, 'F');
  doc.setTextColor(...MUTED); doc.text('Expected', p2 + 8, y + boxH - 4.3);
  doc.setFillColor(...GREEN); doc.rect(p2 + 24, y + boxH - 6, 3, 2, 'F');
  doc.text('Collected', p2 + 28, y + boxH - 4.3);

  // Panel 3 — insights (derived only from the figures above)
  const p3 = M + 2 * (colW + 4);
  panel(p3, 'Key observations');
  const withDue = agents.filter((a) => a.expected > 0);
  const byRate = [...withDue].sort((a, b) => b.collected / b.expected - a.collected / a.expected);
  const topArrears = [...agents].sort((a, b) => b.arrears - a.arrears)[0];
  const topCollector = [...agents].sort((a, b) => b.collected - a.collected)[0];
  const zeroCollected = withDue.filter((a) => a.collected <= 0).length;
  const insights: string[] = [];
  if (agents.length === 0) insights.push('No agents match the selected filters for this day.');
  else {
    insights.push(`${pct(t.collected, t.expected)} of the ${ugx(t.expected)} due was collected; the shortfall is ${ugx(gap)}.`);
    const onTarget = byStatus[0].count;
    insights.push(`${onTarget} of ${withDue.length} agents with money due are on target; ${byStatus[2].count} are critical.`);
    if (zeroCollected > 0) insights.push(`${zeroCollected} agent${zeroCollected === 1 ? ' has' : 's have'} money due but recorded no collection.`);
    if (topCollector && topCollector.collected > 0) insights.push(`Highest collection: ${topCollector.name} with ${ugx(topCollector.collected)}.`);
    if (byRate[0]) insights.push(`Best rate: ${byRate[0].name} at ${pct(byRate[0].collected, byRate[0].expected)}.`);
    if (topArrears && topArrears.arrears > 0) insights.push(`Largest arrears: ${topArrears.name} with ${ugx(topArrears.arrears)} across ${topArrears.behindCount} tenants.`);
    if (t.covered > 0) insights.push(`${t.covered} due tenant${t.covered === 1 ? ' was' : 's were'} already covered by earlier over-payment.`);
  }
  let iy = y + 14;
  doc.setFontSize(7.3);
  for (const line of insights) {
    const wrapped = doc.splitTextToSize(line, colW - 12) as string[];
    if (iy + wrapped.length * 3.4 > y + boxH - 2) break;
    doc.setFillColor(...BRAND); doc.circle(p3 + 5.5, iy - 1, 0.8, 'F');
    doc.setTextColor(...INK); doc.setFont('helvetica', 'normal');
    doc.text(wrapped, p3 + 8, iy);
    iy += wrapped.length * 3.4 + 1.6;
  }
  y += boxH + 6;

  // ---------- Collection rate chart: top agents by expected ----------
  const chartAgents = [...withDue].sort((a, b) => b.expected - a.expected).slice(0, 15);
  const chartH = 58;
  if (y + chartH > H - 14) { doc.addPage(); header(false); y = 18; }
  doc.setDrawColor(...LINE); doc.setFillColor(255, 255, 255);
  doc.roundedRect(M, y, W - 2 * M, chartH, 2, 2, 'FD');
  doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text(`Collection rate — top ${chartAgents.length} agents by amount due`, M + 4, y + 6.5);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...MUTED);
  doc.text('Bar = collected ÷ expected for the day (capped at 100%). Colour follows the page status.', W - M - 4, y + 6.5, { align: 'right' });
  if (chartAgents.length === 0) {
    doc.setFontSize(8); doc.text('No agent had money due on this day.', M + 4, y + 20);
  } else {
    const cx0 = M + 14; const cy0 = y + chartH - 16; const ch = chartH - 28;
    const cwAll = W - 2 * M - 20;
    doc.setFontSize(6);
    [0, 50, 100].forEach((v) => {
      const gy = cy0 - (v / 100) * ch;
      doc.setDrawColor(...LINE); doc.line(cx0, gy, cx0 + cwAll, gy);
      doc.setTextColor(...MUTED); doc.text(`${v}%`, cx0 - 2, gy + 1, { align: 'right' });
    });
    const slot = cwAll / chartAgents.length;
    const bw = Math.min(10, slot * 0.6);
    chartAgents.forEach((a, i) => {
      const r = Math.min(1, a.collected / a.expected);
      const bx = cx0 + i * slot + (slot - bw) / 2;
      const bh = Math.max(0.4, r * ch);
      doc.setFillColor(...STATUS_COLOR[a.status]); doc.rect(bx, cy0 - bh, bw, bh, 'F');
      doc.setTextColor(...INK); doc.setFontSize(6);
      doc.text(`${(r * 100).toFixed(0)}%`, bx + bw / 2, cy0 - bh - 1, { align: 'center' });
      const nm = a.name.length > 14 ? `${a.name.slice(0, 13)}…` : a.name;
      doc.setTextColor(...MUTED); doc.setFontSize(5.8);
      doc.text(nm, bx + bw / 2, cy0 + 4, { align: 'center' });
      doc.text(ugx(a.expected).replace('UGX ', ''), bx + bw / 2, cy0 + 7.5, { align: 'center' });
    });
  }
  y += chartH + 6;

  // ---------- Status summary table ----------
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M, top: 18 },
    head: [['Status', 'Agents', 'Share', 'Expected', 'Collected', 'Collection %', 'Arrears']],
    body: byStatus.map((s) => [STATUS_LABEL[s.status], s.count, pct(s.count, agents.length), ugx(s.expected), ugx(s.collected), pct(s.collected, s.expected), ugx(s.arrears)]),
    foot: [['Total', agents.length, agents.length ? '100.0%' : '—', ugx(t.expected), ugx(t.collected), pct(t.collected, t.expected), ugx(t.arrears)]],
    theme: 'grid',
    styles: { fontSize: 7.5, cellPadding: 1.8, textColor: INK, lineColor: LINE, lineWidth: 0.1 },
    headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontStyle: 'bold' },
    footStyles: { fillColor: [243, 244, 248], textColor: INK, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: SOFT },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' } },
    didParseCell: (d) => {
      if (d.section === 'body' && d.column.index === 0) {
        d.cell.styles.textColor = STATUS_COLOR[byStatus[d.row.index].status];
        d.cell.styles.fontStyle = 'bold';
      }
    },
    didDrawPage: (d) => { if (d.pageNumber > 1) header(false); },
  });

  // ---------- Detailed agent table ----------
  doc.addPage(); header(false);
  doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text('Agent collection performance', M, 20);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
  doc.text(`${agents.length} agents · sorted as on the page (amount due, then name) · figures for ${format(day, 'dd MMM yyyy')}`, M, 24.5);

  autoTable(doc, {
    startY: 28,
    margin: { left: M, right: M, top: 18, bottom: 14 },
    head: [['#', 'Agent', 'Phone', 'Tenants', 'D / W', 'Due', 'Expected', 'Collected', 'Collection %', 'Arrears', 'Behind / ahead', 'Requests', 'Status']],
    body: agents.map((a, i) => [
      i + 1, a.name, a.phone || '—', a.tenantCount, `${a.dailyCount} / ${a.weeklyCount}`, a.dueCount,
      ugx(a.expected), ugx(a.collected), pct(a.collected, a.expected), ugx(a.arrears),
      `${a.behindCount} / ${a.aheadCount}`, a.requestCount, STATUS_LABEL[a.status],
    ]),
    foot: [['', 'Total', '', t.tenants, `${t.daily} / ${t.weekly}`, t.dueCount, ugx(t.expected), ugx(t.collected), pct(t.collected, t.expected), ugx(t.arrears), `${t.behind} / ${t.ahead}`, t.requests, '']],
    showFoot: 'lastPage',
    theme: 'grid',
    styles: { fontSize: 7, cellPadding: 1.5, textColor: INK, lineColor: LINE, lineWidth: 0.1, overflow: 'linebreak' },
    headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7 },
    footStyles: { fillColor: [243, 244, 248], textColor: INK, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: SOFT },
    columnStyles: {
      0: { cellWidth: 8, halign: 'right', textColor: MUTED },
      1: { cellWidth: 46, fontStyle: 'bold' },
      2: { cellWidth: 26 },
      3: { halign: 'right' }, 4: { halign: 'center' }, 5: { halign: 'right' },
      6: { halign: 'right' }, 7: { halign: 'right', textColor: GREEN, fontStyle: 'bold' },
      8: { halign: 'right', fontStyle: 'bold' }, 9: { halign: 'right' }, 10: { halign: 'center' },
      11: { halign: 'right' }, 12: { cellWidth: 20 },
    },
    didParseCell: (d) => {
      if (d.section !== 'body') return;
      const a = agents[d.row.index];
      if (d.column.index === 12) { d.cell.styles.textColor = STATUS_COLOR[a.status]; d.cell.styles.fontStyle = 'bold'; }
      if (d.column.index === 9 && a.arrears > 0) d.cell.styles.textColor = RED;
    },
    didDrawPage: (d) => { if (d.pageNumber > 1 && d.pageNumber !== doc.getNumberOfPages()) return; },
  });

  // ---------- Definitions ----------
  let dy = (doc as any).lastAutoTable.finalY + 8;
  if (dy > H - 40) { doc.addPage(); header(false); dy = 20; }
  doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
  doc.text('How these figures are defined', M, dy);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
  const defs = [
    'Expected: UGX genuinely due on the selected day under each tenant\'s own Rent Plan schedule (weekly plans fall due on their instalment weekday at 7 × the daily amount; tenants already covered by earlier over-payment owe nothing that day).',
    'Collected: every receipt posted against the Rent Plan during the selected day (00:00–24:00 EAT), whoever recorded it, plus tenant self-payments not already mirrored by an agent collection. Reversed collections are excluded.',
    'Arrears: UGX still owed for periods already due, after payments clear the oldest periods first. Paid ahead: tenants whose surplus covers future periods.',
    'Status: On target = collected ≥ expected; Partial / Critical by share collected; Nothing due = no money expected that day. Identical to the Agent Monitoring page.',
  ];
  defs.forEach((d) => {
    const w = doc.splitTextToSize(`• ${d}`, W - 2 * M) as string[];
    doc.text(w, M, dy + 4.5); dy += w.length * 3.2 + 1.2;
  });

  // ---------- Footer on every page ----------
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE); doc.line(M, H - 9, W - M, H - 9);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8); doc.setTextColor(...GREY);
    doc.text('Welile Technologies · Tenant Ops · Confidential — internal management use only', M, H - 5);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 5, { align: 'right' });
  }

  const filename = `agent-monitoring-${format(day, 'yyyy-MM-dd')}.pdf`;
  doc.save(filename);
  void logPdfExport(filename);
  return filename;
}
