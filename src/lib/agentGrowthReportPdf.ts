import welileLogoUrl from '@/assets/welile-logo.png';

/**
 * Branded, print-quality "Agent & Sub-Agent Growth Analytics" report.
 * Renders a header band, KPI summary strip (totals / new / averages / %),
 * a period-by-period growth table, and a top-recruiters ranking.
 */

type RGB = [number, number, number];

const BRAND: RGB = [105, 0, 204];        // Welile primary (271 100% 40%)
const BRAND_DARK: RGB = [66, 0, 128];    // deeper violet
const INK: RGB = [30, 27, 46];           // near-black text
const MUTED: RGB = [120, 116, 132];      // muted label text
const STRIPE: RGB = [244, 240, 252];     // light violet row stripe
const BORDER: RGB = [226, 222, 236];

const EMERALD: RGB = [16, 150, 100];
const BLUE: RGB = [37, 99, 235];
const VIOLET: RGB = [124, 58, 237];
const TEAL: RGB = [13, 148, 136];
const AMBER: RGB = [202, 138, 4];
const RED: RGB = [201, 42, 42];
const SLATE: RGB = [100, 116, 139];

const fmtInt = (n: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));

const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n)}%`;
const fmtAvg = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(Number(n) || 0);

/** Blend a colour toward white by `amt` (0..1) — used for soft card fills. */
const tint = (c: RGB, amt: number): RGB =>
  [Math.round(c[0] + (255 - c[0]) * amt), Math.round(c[1] + (255 - c[1]) * amt), Math.round(c[2] + (255 - c[2]) * amt)];

async function loadLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export interface AgentGrowthSeriesRow {
  label: string;
  agents: number;
  subagents: number;
}

export interface AgentGrowthRecruiterRow {
  name: string;
  phone: string | null;
  invited: number;
  verified: number;
}

export interface AgentGrowthInviteeStatusCounts {
  verified: number;
  pending: number;
  expired: number;
  rejected: number;
  total: number;
}

export interface AgentGrowthReportInput {
  scopeLabel: string;           // e.g. "Monthly · trailing 12mo"
  periodNoun: string;           // e.g. "this month"
  generatedAt?: Date;
  totals: {
    total_agents: number;
    total_subagents: number;
    verified_subagents: number;
    pending_subagents: number;
    new_agents: number;
    new_subagents: number;
    prev_agents: number;
    prev_subagents: number;
  };
  series: AgentGrowthSeriesRow[];
  recruiters: AgentGrowthRecruiterRow[];
  /** Optional invitee pipeline breakdown by status (rendered as a funnel table). */
  inviteeStatus?: AgentGrowthInviteeStatusCounts;
}

export async function generateAgentGrowthReportPdf(
  input: AgentGrowthReportInput,
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const generatedAt = input.generatedAt ?? new Date();
  const t = input.totals;

  const logo = await loadLogoBase64();

  // ── Derived analytics ──
  const trendPct = (curr: number, prev: number) =>
    !prev ? (curr > 0 ? 100 : 0) : ((curr - prev) / prev) * 100;

  const agentTrend = trendPct(t.new_agents, t.prev_agents);
  const subTrend = trendPct(t.new_subagents, t.prev_subagents);

  const buckets = input.series.length || 1;
  const avgAgents = input.series.reduce((s, r) => s + (r.agents || 0), 0) / buckets;
  const avgSubs = input.series.reduce((s, r) => s + (r.subagents || 0), 0) / buckets;

  const verifiedRate = t.total_subagents > 0
    ? (t.verified_subagents / t.total_subagents) * 100 : 0;
  const subPerAgent = t.total_agents > 0 ? t.total_subagents / t.total_agents : 0;
  const netNew = t.new_agents + t.new_subagents;
  const prevNetNew = t.prev_agents + t.prev_subagents;
  const netTrend = trendPct(netNew, prevNetNew);

  // ── Header band ──
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, pageWidth, 26, 'F');
  doc.setFillColor(...BRAND_DARK);
  doc.rect(0, 26, pageWidth, 1.5, 'F');

  if (logo) {
    try { doc.addImage(logo, 'PNG', margin, 5.5, 15, 15); } catch { /* ignore */ }
  }
  const titleX = logo ? margin + 19 : margin;
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('Agent & Sub-Agent Growth Analytics', titleX, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(235, 225, 250);
  doc.text('Recruitment & network growth report', titleX, 18.5);

  doc.setFontSize(8.5);
  doc.setTextColor(255, 255, 255);
  doc.text(input.scopeLabel, pageWidth - margin, 11, { align: 'right' });
  doc.setTextColor(225, 210, 248);
  doc.text(
    `Generated ${generatedAt.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
    pageWidth - margin, 17, { align: 'right' },
  );

  // ── KPI summary strip (2 rows × 4 cards) ──
  const cards: { label: string; value: string; sub?: string; accent: RGB }[] = [
    { label: 'Total Agents', value: fmtInt(t.total_agents), sub: `${fmtInt(t.new_agents)} new ${input.periodNoun}`, accent: BRAND },
    { label: 'Total Sub-Agents', value: fmtInt(t.total_subagents), sub: `${fmtInt(t.verified_subagents)} verified · ${fmtInt(t.pending_subagents)} pending`, accent: VIOLET },
    { label: `New Agents (${input.periodNoun})`, value: fmtInt(t.new_agents), sub: `${fmtPct(agentTrend)} vs prev`, accent: EMERALD },
    { label: `New Sub-Agents (${input.periodNoun})`, value: fmtInt(t.new_subagents), sub: `${fmtPct(subTrend)} vs prev`, accent: AMBER },
    { label: 'Avg Agents / period', value: fmtAvg(avgAgents), sub: `over ${buckets} periods`, accent: BLUE },
    { label: 'Avg Sub-Agents / period', value: fmtAvg(avgSubs), sub: `over ${buckets} periods`, accent: TEAL },
    { label: 'Verified Rate', value: `${Math.round(verifiedRate)}%`, sub: 'of all sub-agents', accent: EMERALD },
    { label: 'Sub-Agents / Agent', value: fmtAvg(subPerAgent), sub: 'network depth', accent: SLATE },
  ];

  const cols = 4;
  const gap = 4;
  const cardW = (pageWidth - margin * 2 - gap * (cols - 1)) / cols;
  const cardH = 21;
  const startY = 33;

  cards.forEach((c, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = margin + col * (cardW + gap);
    const y = startY + row * (cardH + gap);
    doc.setFillColor(...tint(c.accent, 0.93));
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.2);
    doc.roundedRect(x, y, cardW, cardH, 2, 2, 'FD');
    doc.setFillColor(...c.accent);
    doc.roundedRect(x, y, cardW, 2.4, 2, 2, 'F');
    doc.rect(x, y + 1.4, cardW, 1, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.6);
    doc.setTextColor(...MUTED);
    doc.text(c.label.toUpperCase(), x + 3.5, y + 8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...c.accent);
    doc.text(c.value, x + 3.5, y + 15);
    if (c.sub) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.4);
      doc.setTextColor(...MUTED);
      doc.text(c.sub, x + 3.5, y + 19);
    }
  });

  // ── Executive summary (auto-generated insights) ──
  const summaryTop = startY + 2 * (cardH + gap) + 6;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_DARK);
  doc.text('Executive Summary', margin, summaryTop);
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(0.4);
  doc.line(margin, summaryTop + 1.8, pageWidth - margin, summaryTop + 1.8);

  const topRecruiter = input.recruiters[0];
  const insights: string[] = [
    `Network now spans ${fmtInt(t.total_agents)} agents and ${fmtInt(t.total_subagents)} sub-agents — a depth of ${fmtAvg(subPerAgent)} sub-agents per agent.`,
    `${fmtInt(netNew)} new members joined ${input.periodNoun} (${fmtInt(t.new_agents)} agents, ${fmtInt(t.new_subagents)} sub-agents), ${netTrend >= 0 ? 'up' : 'down'} ${fmtPct(Math.abs(netTrend)).replace('+', '')} versus the previous period.`,
    `${Math.round(verifiedRate)}% of sub-agents are verified (${fmtInt(t.verified_subagents)} verified, ${fmtInt(t.pending_subagents)} pending) — ${verifiedRate >= 70 ? 'a healthy activation rate' : 'an opportunity to tighten onboarding follow-up'}.`,
  ];
  if (topRecruiter && topRecruiter.invited > 0) {
    insights.push(
      `Top recruiter ${topRecruiter.name} brought in ${fmtInt(topRecruiter.invited)} invitees (${Math.round((topRecruiter.verified / topRecruiter.invited) * 100)}% verified) this period.`,
    );
  }

  const boxTop = summaryTop + 5;
  const lineH = 5.6;
  const boxH = insights.length * lineH + 6;
  doc.setFillColor(...tint(BRAND, 0.95));
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.2);
  doc.roundedRect(margin, boxTop, pageWidth - margin * 2, boxH, 2, 2, 'FD');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.4);
  doc.setTextColor(...INK);
  let iy = boxTop + 6.5;
  insights.forEach((line) => {
    doc.setFillColor(...BRAND);
    doc.circle(margin + 4, iy - 1.4, 0.9, 'F');
    const wrapped = doc.splitTextToSize(line, pageWidth - margin * 2 - 12);
    doc.text(wrapped, margin + 7, iy);
    iy += lineH * wrapped.length;
  });

  // ── Growth table ──
  let sectionTop = boxTop + boxH + 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_DARK);
  doc.text('Growth by Period', margin, sectionTop);
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(0.4);
  doc.line(margin, sectionTop + 1.8, pageWidth - margin, sectionTop + 1.8);

  const totalAgentsSeries = input.series.reduce((s, r) => s + (r.agents || 0), 0);
  const totalSubsSeries = input.series.reduce((s, r) => s + (r.subagents || 0), 0);

  // Period-over-period growth %
  const growthBody = input.series.map((r, i) => {
    const prev = i > 0 ? input.series[i - 1] : null;
    const total = (r.agents || 0) + (r.subagents || 0);
    const prevTotal = prev ? (prev.agents || 0) + (prev.subagents || 0) : 0;
    const g = prev ? trendPct(total, prevTotal) : 0;
    return [
      r.label,
      fmtInt(r.agents),
      fmtInt(r.subagents),
      fmtInt(total),
      i === 0 ? '—' : fmtPct(g),
    ];
  });

  autoTable(doc, {
    startY: sectionTop + 4,
    head: [['Period', 'New Agents', 'New Sub-Agents', 'Total', 'Growth %']],
    body: growthBody,
    foot: [[
      'Totals',
      fmtInt(totalAgentsSeries),
      fmtInt(totalSubsSeries),
      fmtInt(totalAgentsSeries + totalSubsSeries),
      '',
    ]],
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 8, cellPadding: 2, valign: 'middle', textColor: INK, lineColor: BORDER, lineWidth: 0.1 },
    headStyles: { fillColor: BRAND, textColor: 255, fontSize: 8, fontStyle: 'bold', halign: 'left' },
    footStyles: { fillColor: tint(BRAND, 0.85), textColor: BRAND_DARK, fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 34, halign: 'right' },
      2: { cellWidth: 40, halign: 'right' },
      3: { cellWidth: 28, halign: 'right', fontStyle: 'bold' },
      4: { cellWidth: 28, halign: 'right' },
    },
    didParseCell: (data: any) => {
      if (data.section === 'body' && data.column.index === 4) {
        const raw = String(data.cell.raw || '');
        if (raw.startsWith('+')) { data.cell.styles.textColor = EMERALD; data.cell.styles.fontStyle = 'bold'; }
        else if (raw.startsWith('-')) { data.cell.styles.textColor = RED; data.cell.styles.fontStyle = 'bold'; }
      }
    },
  });

  // ── Top recruiters table ──
  let afterTop = (doc as any).lastAutoTable.finalY + 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_DARK);
  doc.text(`Top Recruiters (${input.periodNoun})`, margin, afterTop);
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(0.4);
  doc.line(margin, afterTop + 1.8, pageWidth - margin, afterTop + 1.8);

  const recBody = (input.recruiters.length ? input.recruiters : []).map((r, i) => {
    const rate = r.invited > 0 ? (r.verified / r.invited) * 100 : 0;
    return [
      `#${i + 1}`,
      r.name || 'Unknown',
      r.phone || '—',
      fmtInt(r.invited),
      fmtInt(r.verified),
      `${Math.round(rate)}%`,
    ];
  });

  autoTable(doc, {
    startY: afterTop + 4,
    head: [['Rank', 'Recruiter', 'Phone', 'Invited', 'Verified', 'Verify %']],
    body: recBody.length ? recBody : [['—', 'No recruitment activity in this period', '', '', '', '']],
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 8, cellPadding: 2, valign: 'middle', textColor: INK, lineColor: BORDER, lineWidth: 0.1 },
    headStyles: { fillColor: VIOLET, textColor: 255, fontSize: 8, fontStyle: 'bold', halign: 'left' },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles: {
      0: { cellWidth: 16, fontStyle: 'bold', textColor: BRAND },
      1: { cellWidth: 'auto', fontStyle: 'bold' },
      2: { cellWidth: 34, textColor: MUTED },
      3: { cellWidth: 24, halign: 'right' },
      4: { cellWidth: 24, halign: 'right', textColor: EMERALD },
      5: { cellWidth: 24, halign: 'right' },
    },
  });

  // ── Invitee pipeline breakdown ──
  if (input.inviteeStatus && input.inviteeStatus.total > 0) {
    const s = input.inviteeStatus;
    let pipeTop = (doc as any).lastAutoTable.finalY + 8;
    if (pipeTop > pageHeight - 40) { doc.addPage(); pipeTop = 20; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...BRAND_DARK);
    doc.text('Invitee Pipeline', margin, pipeTop);
    doc.setDrawColor(...BRAND);
    doc.setLineWidth(0.4);
    doc.line(margin, pipeTop + 1.8, pageWidth - margin, pipeTop + 1.8);

    const pct = (n: number) => (s.total > 0 ? `${Math.round((n / s.total) * 100)}%` : '0%');
    const pipeBody = [
      ['Verified', fmtInt(s.verified), pct(s.verified)],
      ['Pending acceptance', fmtInt(s.pending), pct(s.pending)],
      ['Expired', fmtInt(s.expired), pct(s.expired)],
      ['Rejected', fmtInt(s.rejected), pct(s.rejected)],
    ];
    autoTable(doc, {
      startY: pipeTop + 4,
      head: [['Stage', 'Invitees', 'Share']],
      body: pipeBody,
      foot: [['Total invitees', fmtInt(s.total), '100%']],
      margin: { left: margin, right: margin },
      tableWidth: pageWidth - margin * 2,
      styles: { fontSize: 8, cellPadding: 2, valign: 'middle', textColor: INK, lineColor: BORDER, lineWidth: 0.1 },
      headStyles: { fillColor: TEAL, textColor: 255, fontSize: 8, fontStyle: 'bold', halign: 'left' },
      footStyles: { fillColor: tint(TEAL, 0.85), textColor: [8, 74, 67], fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: STRIPE },
      columnStyles: {
        0: { cellWidth: 'auto', fontStyle: 'bold' },
        1: { cellWidth: 40, halign: 'right' },
        2: { cellWidth: 40, halign: 'right' },
      },
      didParseCell: (data: any) => {
        if (data.section === 'body' && data.column.index === 0) {
          const raw = String(data.cell.raw || '');
          if (raw === 'Verified') data.cell.styles.textColor = EMERALD;
          else if (raw === 'Rejected') data.cell.styles.textColor = RED;
          else if (raw === 'Pending acceptance') data.cell.styles.textColor = AMBER;
        }
      },
    });
  }

  // ── Footer on every page ──
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.2);
    doc.line(margin, pageHeight - 9, pageWidth - margin, pageHeight - 9);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text('Powered by Welile — confidential agent growth analytics', margin, pageHeight - 5);
    doc.text(`Page ${p} / ${pageCount}`, pageWidth - margin, pageHeight - 5, { align: 'right' });
  }

  return doc.output('blob');
}
