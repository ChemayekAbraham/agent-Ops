// Agent Daily Activity & Growth Report — daily morning email.
//
// Sent every morning at 07:00 EAT (04:00 UTC) via pg_cron. Because it runs in
// the morning, it reports on the PREVIOUS calendar day (EAT) — "yesterday" —
// not the partial current day.
//
// It combines two data sources into one branded PDF + email:
//   1. get_agent_daily_activity_report(p_date)  → yesterday's field activity:
//      active agents, active sub-agents, houses listed, rent requests posted,
//      rent repayments, field collections, visits, and invites sent, plus a
//      per-agent activity leaderboard.
//   2. get_agent_leaderboard_stats('daily')     → trailing 30-day growth series,
//      top recruiters, and the invitee pipeline (context).
//
// Every KPI in the header strip reflects DAILY (yesterday) data, not cumulative
// network totals. Delivery uses the Gmail connector (multipart/mixed MIME)
// because the Lovable email queue cannot carry file attachments.
//
// Idempotent per EAT report-day via an `agent_growth_daily_report` system_event
// (bypass with { force: true }). Optional { date } (YYYY-MM-DD) overrides which
// day is reported.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsPDF } from "https://esm.sh/jspdf@2.5.1";
import autoTable from "https://esm.sh/jspdf-autotable@3.8.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Fixed recipients for the morning report.
const REPORT_RECIPIENTS = ["benjamin@welile.com", "joshwanda17@gmail.com"];
const REPORT_CC = ["ssenkaali.pius@welile.com"];

type RGB = [number, number, number];

const BRAND: RGB = [105, 0, 204];
const BRAND_DARK: RGB = [66, 0, 128];
const INK: RGB = [30, 27, 46];
const MUTED: RGB = [120, 116, 132];
const STRIPE: RGB = [244, 240, 252];
const BORDER: RGB = [226, 222, 236];
const EMERALD: RGB = [16, 150, 100];
const BLUE: RGB = [37, 99, 235];
const VIOLET: RGB = [124, 58, 237];
const TEAL: RGB = [13, 148, 136];
const AMBER: RGB = [202, 138, 4];
const RED: RGB = [201, 42, 42];
const SLATE: RGB = [100, 116, 139];
const ROSE: RGB = [219, 39, 119];

const fmtInt = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
const fmtUgx = (n: number) => `UGX ${fmtInt(n)}`;
const tint = (c: RGB, amt: number): RGB =>
  [Math.round(c[0] + (255 - c[0]) * amt), Math.round(c[1] + (255 - c[1]) * amt), Math.round(c[2] + (255 - c[2]) * amt)];

// ── Data shapes ──
interface DailyActivity {
  report_date: string;
  totals: {
    active_agents: number;
    active_subagents: number;
    total_agents: number;
    total_subagents: number;
    new_subagents: number;
    houses_listed: number;
    rent_requests_posted: number;
    repayments_count: number;
    repayments_amount: number;
    collections_count: number;
    collections_amount: number;
    visits: number;
    subagent_invites: number;
    supporter_invites: number;
    invites_total: number;
  };
  top_agents: {
    agent_id: string;
    name: string;
    phone: string | null;
    collections: number;
    collected: number;
    visits: number;
    houses: number;
    rent_requests: number;
    total_actions: number;
  }[];
}

interface LeaderboardStats {
  series: { bucket: string; agents: number; subagents: number }[];
  top_recruiters: { agent_id: string; name: string; phone: string | null; invited: number; verified: number }[];
  invitees: { status: string }[];
}

interface WeeklyForecastGroup {
  last_week: number;
  now: number;
  new_this_week: number;
  new_last_week: number;
  avg_weekly_new: number;
  next_week_forecast: number;
}
interface WeeklyForecast {
  week_start: string;
  last_week_start: string;
  agents: WeeklyForecastGroup;
  subagents: WeeklyForecastGroup;
}

function bucketDayLabel(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const mon = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${day} ${mon}`;
}

// Calendar date (YYYY-MM-DD) in East Africa Time (UTC+3, no DST).
function eatToday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function eatYesterday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Build the branded PDF ──
function buildPdf(activity: DailyActivity, stats: LeaderboardStats, weekly: WeeklyForecast, prettyDate: string): Uint8Array {
  const a = activity.totals;
  const series = (stats.series || []).map((s) => ({
    label: bucketDayLabel(s.bucket), agents: s.agents || 0, subagents: s.subagents || 0,
  }));
  const recruiters = (stats.top_recruiters || []).map((r) => ({
    name: r.name, phone: r.phone, invited: r.invited || 0, verified: r.verified || 0,
  }));
  const inv = stats.invitees || [];
  const inviteeStatus = {
    verified: inv.filter((i) => i.status === "verified").length,
    pending: inv.filter((i) => i.status === "pending_acceptance").length,
    expired: inv.filter((i) => i.status === "expired").length,
    rejected: inv.filter((i) => i.status === "rejected").length,
    total: inv.length,
  };

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const generatedAt = new Date();

  // Header band
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, pageWidth, 26, "F");
  doc.setFillColor(...BRAND_DARK);
  doc.rect(0, 26, pageWidth, 1.5, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text("Agent Daily Activity & Growth Report", margin, 12);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(235, 225, 250);
  doc.text("Yesterday's field activity, network growth & recruitment", margin, 18.5);
  doc.setFontSize(8.5);
  doc.setTextColor(255, 255, 255);
  doc.text(`Report day: ${prettyDate} EAT`, pageWidth - margin, 11, { align: "right" });
  doc.setTextColor(225, 210, 248);
  doc.text(
    `Generated ${generatedAt.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Nairobi" })} EAT`,
    pageWidth - margin, 17, { align: "right" },
  );

  // KPI strip — all metrics reflect YESTERDAY (daily), not cumulative totals.
  const cards: { label: string; value: string; sub?: string; accent: RGB }[] = [
    { label: "Active Agents", value: fmtInt(a.active_agents), sub: `of ${fmtInt(a.total_agents)} total`, accent: BRAND },
    { label: "Active Sub-Agents", value: fmtInt(a.active_subagents), sub: `of ${fmtInt(a.total_subagents)} total`, accent: VIOLET },
    { label: "Houses Listed", value: fmtInt(a.houses_listed), sub: "new listings", accent: AMBER },
    { label: "Rent Requests", value: fmtInt(a.rent_requests_posted), sub: "posted", accent: BLUE },
    { label: "Rent Repayments", value: fmtInt(a.repayments_count), sub: fmtUgx(a.repayments_amount), accent: EMERALD },
    { label: "Field Collections", value: fmtInt(a.collections_count), sub: fmtUgx(a.collections_amount), accent: TEAL },
    { label: "New Sub-Agents", value: fmtInt(a.new_subagents), sub: `${fmtInt(a.visits)} visits logged`, accent: SLATE },
    { label: "Invites Sent", value: fmtInt(a.invites_total), sub: `${fmtInt(a.subagent_invites)} agent · ${fmtInt(a.supporter_invites)} supporter`, accent: ROSE },
  ];
  const cols = 4, gap = 4;
  const cardW = (pageWidth - margin * 2 - gap * (cols - 1)) / cols;
  const cardH = 21, startY = 33;
  cards.forEach((c, i) => {
    const x = margin + (i % cols) * (cardW + gap);
    const y = startY + Math.floor(i / cols) * (cardH + gap);
    doc.setFillColor(...tint(c.accent, 0.93));
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.2);
    doc.roundedRect(x, y, cardW, cardH, 2, 2, "FD");
    doc.setFillColor(...c.accent);
    doc.roundedRect(x, y, cardW, 2.4, 2, 2, "F");
    doc.rect(x, y + 1.4, cardW, 1, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.6);
    doc.setTextColor(...MUTED);
    doc.text(c.label.toUpperCase(), x + 3.5, y + 8);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(...c.accent);
    doc.text(c.value, x + 3.5, y + 15);
    if (c.sub) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6);
      doc.setTextColor(...MUTED);
      doc.text(c.sub, x + 3.5, y + 19);
    }
  });

  // Executive summary
  const summaryTop = startY + 2 * (cardH + gap) + 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_DARK);
  doc.text("Executive Summary", margin, summaryTop);
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(0.4);
  doc.line(margin, summaryTop + 1.8, pageWidth - margin, summaryTop + 1.8);
  const topAgent = activity.top_agents?.[0];
  const totalFieldActions = a.collections_count + a.visits + a.houses_listed + a.rent_requests_posted;
  const insights: string[] = [
    `${fmtInt(a.active_agents)} agents and ${fmtInt(a.active_subagents)} sub-agents were active yesterday, generating ${fmtInt(totalFieldActions)} field actions across collections, visits, listings and rent requests.`,
    `Field money movement: ${fmtInt(a.collections_count)} collections (${fmtUgx(a.collections_amount)}) and ${fmtInt(a.repayments_count)} rent repayments (${fmtUgx(a.repayments_amount)}).`,
    `Supply & growth: ${fmtInt(a.houses_listed)} houses listed, ${fmtInt(a.rent_requests_posted)} rent requests posted, ${fmtInt(a.new_subagents)} new sub-agents, and ${fmtInt(a.invites_total)} invites sent.`,
  ];
  if (topAgent && topAgent.total_actions > 0) {
    insights.push(
      `Most active agent: ${topAgent.name} with ${fmtInt(topAgent.total_actions)} actions (${fmtInt(topAgent.collections)} collections, ${fmtUgx(topAgent.collected)}).`,
    );
  }
  const boxTop = summaryTop + 5;
  const lineH = 5.6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.4);
  // measure height
  let measured = 6;
  const wrappedLines = insights.map((line) => doc.splitTextToSize(line, pageWidth - margin * 2 - 12) as string[]);
  wrappedLines.forEach((w) => { measured += lineH * w.length; });
  const boxH = measured;
  doc.setFillColor(...tint(BRAND, 0.95));
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.2);
  doc.roundedRect(margin, boxTop, pageWidth - margin * 2, boxH, 2, 2, "FD");
  doc.setTextColor(...INK);
  let iy = boxTop + 6.5;
  wrappedLines.forEach((wrapped) => {
    doc.setFillColor(...BRAND);
    doc.circle(margin + 4, iy - 1.4, 0.9, "F");
    doc.text(wrapped, margin + 7, iy);
    iy += lineH * wrapped.length;
  });

  // Weekly headcount & forecast — last week vs now vs next week (forecast).
  let wkTop = boxTop + boxH + 8;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_DARK);
  doc.text("Weekly Headcount & Forecast", margin, wkTop);
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(0.4);
  doc.line(margin, wkTop + 1.8, pageWidth - margin, wkTop + 1.8);
  const wa = weekly.agents;
  const ws = weekly.subagents;
  const wkDelta = (g: WeeklyForecastGroup) => {
    const d = g.next_week_forecast - g.now;
    return `${d >= 0 ? "+" : ""}${fmtInt(d)} (~${fmtInt(g.avg_weekly_new)}/wk)`;
  };
  autoTable(doc, {
    startY: wkTop + 4,
    head: [["Segment", "Last week", "Now", "Next week (forecast)", "Projected growth"]],
    body: [
      ["Agents", fmtInt(wa.last_week), fmtInt(wa.now), fmtInt(wa.next_week_forecast), wkDelta(wa)],
      ["Sub-Agents", fmtInt(ws.last_week), fmtInt(ws.now), fmtInt(ws.next_week_forecast), wkDelta(ws)],
    ],
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 8.4, cellPadding: 2.4, valign: "middle", textColor: INK, lineColor: BORDER, lineWidth: 0.1 },
    headStyles: { fillColor: BRAND_DARK, textColor: 255, fontSize: 8, fontStyle: "bold", halign: "left" },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles: {
      0: { cellWidth: "auto", fontStyle: "bold" },
      1: { cellWidth: 30, halign: "right" },
      2: { cellWidth: 30, halign: "right", fontStyle: "bold", textColor: BRAND },
      3: { cellWidth: 40, halign: "right", textColor: EMERALD, fontStyle: "bold" },
      4: { cellWidth: 40, halign: "right", textColor: MUTED },
    },
  });
  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.6);
  doc.setTextColor(...MUTED);
  doc.text(
    "Forecast = current headcount + trailing 4-week average of new joins per week. Weeks start Monday (EAT).",
    margin, (doc as any).lastAutoTable.finalY + 4,
  );

  // Top active agents (yesterday)
  let actTop = (doc as any).lastAutoTable.finalY + 10;
  if (actTop > pageHeight - 60) { doc.addPage(); actTop = 20; }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_DARK);
  doc.text("Top Active Agents (yesterday)", margin, actTop);
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(0.4);
  doc.line(margin, actTop + 1.8, pageWidth - margin, actTop + 1.8);
  const actBody = (activity.top_agents || []).map((r, i) => [
    `#${i + 1}`,
    r.name || "Unknown",
    r.phone || "—",
    fmtInt(r.collections),
    fmtInt(r.collected),
    fmtInt(r.visits),
    fmtInt(r.houses),
    fmtInt(r.rent_requests),
    fmtInt(r.total_actions),
  ]);
  autoTable(doc, {
    startY: actTop + 4,
    head: [["#", "Agent", "Phone", "Collect.", "Collected", "Visits", "Houses", "Rent Req", "Actions"]],
    body: actBody.length ? actBody : [["—", "No agent activity yesterday", "", "", "", "", "", "", ""]],
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 7.6, cellPadding: 1.6, valign: "middle", textColor: INK, lineColor: BORDER, lineWidth: 0.1 },
    headStyles: { fillColor: BRAND, textColor: 255, fontSize: 7.4, fontStyle: "bold", halign: "left" },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles: {
      0: { cellWidth: 9, fontStyle: "bold", textColor: BRAND },
      1: { cellWidth: "auto", fontStyle: "bold" },
      2: { cellWidth: 26, textColor: MUTED },
      3: { cellWidth: 16, halign: "right" },
      4: { cellWidth: 24, halign: "right", textColor: EMERALD },
      5: { cellWidth: 15, halign: "right" },
      6: { cellWidth: 15, halign: "right" },
      7: { cellWidth: 16, halign: "right" },
      8: { cellWidth: 16, halign: "right", fontStyle: "bold" },
    },
  });

  // 30-day growth line chart — Agents vs Sub-Agents (trailing context).
  let chartTop = (doc as any).lastAutoTable.finalY + 8;
  if (chartTop > pageHeight - 90) { doc.addPage(); chartTop = 20; }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_DARK);
  doc.text("Network Growth — trailing 30 days", margin, chartTop);
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(0.4);
  doc.line(margin, chartTop + 1.8, pageWidth - margin, chartTop + 1.8);

  const chartX = margin;
  const chartY = chartTop + 5;
  const chartW = pageWidth - margin * 2;
  const chartH = 60;
  doc.setFillColor(...tint(BRAND, 0.97));
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.2);
  doc.roundedRect(chartX, chartY, chartW, chartH, 2, 2, "FD");

  const lgY = chartY + 5;
  const lgX = chartX + chartW - 62;
  doc.setFillColor(...BLUE); doc.circle(lgX, lgY - 0.8, 1.1, "F");
  doc.setFont("helvetica", "normal"); doc.setFontSize(7.2); doc.setTextColor(...INK);
  doc.text("Agents", lgX + 2.5, lgY);
  doc.setFillColor(...VIOLET); doc.circle(lgX + 24, lgY - 0.8, 1.1, "F");
  doc.text("Sub-Agents", lgX + 26.5, lgY);

  const padL = 16, padR = 6, padT = 10, padB = 12;
  const plotX = chartX + padL;
  const plotW = chartW - padL - padR;
  const plotY = chartY + padT;
  const plotH = chartH - padT - padB;
  const n = series.length;

  if (n === 0) {
    doc.setFont("helvetica", "italic"); doc.setFontSize(9); doc.setTextColor(...MUTED);
    doc.text("No growth data for this period.", chartX + chartW / 2, chartY + chartH / 2, { align: "center" });
  } else {
    const maxRaw = Math.max(1, ...series.map((s) => Math.max(s.agents, s.subagents)));
    const yMax = Math.max(1, Math.ceil(maxRaw * 1.15));
    const gridN = 4;
    doc.setFont("helvetica", "normal");
    for (let g = 0; g <= gridN; g++) {
      const gy = plotY + plotH - (plotH * g) / gridN;
      doc.setDrawColor(...BORDER); doc.setLineWidth(0.1);
      doc.line(plotX, gy, plotX + plotW, gy);
      doc.setFontSize(6.2); doc.setTextColor(...MUTED);
      doc.text(fmtInt((yMax * g) / gridN), plotX - 2, gy + 1.4, { align: "right" });
    }
    const xAt = (i: number) => (n <= 1 ? plotX + plotW / 2 : plotX + (plotW * i) / (n - 1));
    const yAt = (v: number) => plotY + plotH - (plotH * Math.min(v, yMax)) / yMax;
    const plotLine = (get: (s: { agents: number; subagents: number }) => number, color: RGB) => {
      doc.setDrawColor(...color); doc.setLineWidth(0.8);
      for (let i = 1; i < n; i++) {
        doc.line(xAt(i - 1), yAt(get(series[i - 1])), xAt(i), yAt(get(series[i])));
      }
      doc.setFillColor(...color);
      for (let i = 0; i < n; i++) doc.circle(xAt(i), yAt(get(series[i])), 0.6, "F");
    };
    plotLine((s) => s.agents, BLUE);
    plotLine((s) => s.subagents, VIOLET);
    doc.setFontSize(6); doc.setTextColor(...MUTED);
    const labelEvery = Math.max(1, Math.ceil(n / 8));
    for (let i = 0; i < n; i++) {
      if (i % labelEvery === 0 || i === n - 1) {
        doc.text(String(series[i].label), xAt(i), plotY + plotH + 4.5, { align: "center" });
      }
    }
  }

  // Top recruiters (trailing period)
  let afterTop = chartY + chartH + 8;
  if (afterTop > pageHeight - 40) { doc.addPage(); afterTop = 20; }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_DARK);
  doc.text("Top Recruiters (trailing)", margin, afterTop);
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(0.4);
  doc.line(margin, afterTop + 1.8, pageWidth - margin, afterTop + 1.8);
  const recBody = recruiters.map((r, i) => {
    const rate = r.invited > 0 ? (r.verified / r.invited) * 100 : 0;
    return [`#${i + 1}`, r.name || "Unknown", r.phone || "—", fmtInt(r.invited), fmtInt(r.verified), `${Math.round(rate)}%`];
  });
  autoTable(doc, {
    startY: afterTop + 4,
    head: [["Rank", "Recruiter", "Phone", "Invited", "Verified", "Verify %"]],
    body: recBody.length ? recBody : [["—", "No recruitment activity", "", "", "", ""]],
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 8, cellPadding: 2, valign: "middle", textColor: INK, lineColor: BORDER, lineWidth: 0.1 },
    headStyles: { fillColor: VIOLET, textColor: 255, fontSize: 8, fontStyle: "bold", halign: "left" },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles: {
      0: { cellWidth: 16, fontStyle: "bold", textColor: BRAND },
      1: { cellWidth: "auto", fontStyle: "bold" },
      2: { cellWidth: 34, textColor: MUTED },
      3: { cellWidth: 24, halign: "right" },
      4: { cellWidth: 24, halign: "right", textColor: EMERALD },
      5: { cellWidth: 24, halign: "right" },
    },
  });

  // Invitee pipeline
  if (inviteeStatus.total > 0) {
    const s = inviteeStatus;
    let pipeTop = (doc as any).lastAutoTable.finalY + 8;
    if (pipeTop > pageHeight - 40) { doc.addPage(); pipeTop = 20; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...BRAND_DARK);
    doc.text("Invitee Pipeline", margin, pipeTop);
    doc.setDrawColor(...BRAND);
    doc.setLineWidth(0.4);
    doc.line(margin, pipeTop + 1.8, pageWidth - margin, pipeTop + 1.8);
    const pct = (nn: number) => (s.total > 0 ? `${Math.round((nn / s.total) * 100)}%` : "0%");
    autoTable(doc, {
      startY: pipeTop + 4,
      head: [["Stage", "Invitees", "Share"]],
      body: [
        ["Verified", fmtInt(s.verified), pct(s.verified)],
        ["Pending acceptance", fmtInt(s.pending), pct(s.pending)],
        ["Expired", fmtInt(s.expired), pct(s.expired)],
        ["Rejected", fmtInt(s.rejected), pct(s.rejected)],
      ],
      foot: [["Total invitees", fmtInt(s.total), "100%"]],
      margin: { left: margin, right: margin },
      tableWidth: pageWidth - margin * 2,
      styles: { fontSize: 8, cellPadding: 2, valign: "middle", textColor: INK, lineColor: BORDER, lineWidth: 0.1 },
      headStyles: { fillColor: TEAL, textColor: 255, fontSize: 8, fontStyle: "bold", halign: "left" },
      footStyles: { fillColor: tint(TEAL, 0.85), textColor: [8, 74, 67], fontStyle: "bold", fontSize: 8 },
      alternateRowStyles: { fillColor: STRIPE },
      columnStyles: { 0: { cellWidth: "auto", fontStyle: "bold" }, 1: { cellWidth: 40, halign: "right" }, 2: { cellWidth: 40, halign: "right" } },
      didParseCell: (data: any) => {
        if (data.section === "body" && data.column.index === 0) {
          const raw = String(data.cell.raw || "");
          if (raw === "Verified") data.cell.styles.textColor = EMERALD;
          else if (raw === "Rejected") data.cell.styles.textColor = RED;
          else if (raw === "Pending acceptance") data.cell.styles.textColor = AMBER;
        }
      },
    });
  }

  // Footer
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.2);
    doc.line(margin, pageHeight - 9, pageWidth - margin, pageHeight - 9);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text("Powered by Welile — confidential agent activity & growth analytics", margin, pageHeight - 5);
    doc.text(`Page ${p} / ${pageCount}`, pageWidth - margin, pageHeight - 5, { align: "right" });
  }

  return new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
}

// Base64-encode bytes in chunks (avoids call-stack limits on large buffers).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function chunk76(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trim();
}

async function sendWithAttachment(
  to: string,
  cc: string[],
  subject: string,
  html: string,
  pdf: Uint8Array,
  filename: string,
): Promise<{ ok: boolean; status: number; raw?: string }> {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const gmailKey = Deno.env.get("GOOGLE_MAIL_API_KEY");
  if (!lovableKey || !gmailKey) {
    return { ok: false, status: 0, raw: "Gmail connector creds missing" };
  }
  const boundary = `welile_${crypto.randomUUID().replace(/-/g, "")}`;
  const altBoundary = `alt_${crypto.randomUUID().replace(/-/g, "")}`;
  const pdfB64 = chunk76(bytesToBase64(pdf));
  // Base64-encode the HTML part: the generated markup has very long lines
  // (>998 chars), which is illegal for 7bit and makes Gmail drop the body.
  const htmlB64 = chunk76(bytesToBase64(new TextEncoder().encode(html)));
  const textB64 = chunk76(bytesToBase64(new TextEncoder().encode(
    `${subject}\r\n\r\nYour Welile agent daily report is attached as a PDF. Open this message in an HTML-capable client to view the full summary.`,
  )));
  const encodedSubject = /[^\x00-\x7F]/.test(subject)
    ? `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(subject))}?=`
    : subject;
  const headerLines = [
    `To: ${to}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  // NOTE: do NOT filter out empty strings here — the blank lines below are the
  // MIME header/body separators. Dropping them collapses the message body.
  const raw = [
    ...headerLines,
    "",
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    textB64,
    "",
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    htmlB64,
    "",
    `--${altBoundary}--`,
    "",
    `--${boundary}`,
    "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    pdfB64,
    "",
    `--${boundary}--`,
  ].join("\r\n");
  const encoded = bytesToBase64(new TextEncoder().encode(raw))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await fetch(
    "https://connector-gateway.lovable.dev/google_mail/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": gmailKey,
      },
      body: JSON.stringify({ raw: encoded }),
    },
  );
  const text = await res.text();
  return { ok: res.ok, status: res.status, raw: text };
}

function buildHtml(activity: DailyActivity, weekly: WeeklyForecast, prettyDate: string): string {
  const a = activity.totals;
  const top = activity.top_agents?.[0];
  const wa = weekly.agents;
  const ws = weekly.subagents;
  const cell = (label: string, value: string, sub: string, bg: string, color: string) =>
    `<td style="width:33.3%;background:${bg};border-radius:10px;padding:12px">
       <div style="font-size:10px;color:#787484;text-transform:uppercase;font-weight:700">${esc(label)}</div>
       <div style="font-size:20px;font-weight:800;color:${color};margin-top:2px">${esc(value)}</div>
       <div style="font-size:11px;color:#787484">${esc(sub)}</div>
     </td>`;
  const wkRow = (seg: string, g: WeeklyForecastGroup) =>
    `<tr>
       <td style="padding:8px 10px;font-weight:700;border-bottom:1px solid #eee">${esc(seg)}</td>
       <td style="padding:8px 10px;text-align:right;border-bottom:1px solid #eee">${fmtInt(g.last_week)}</td>
       <td style="padding:8px 10px;text-align:right;font-weight:800;color:#6900cc;border-bottom:1px solid #eee">${fmtInt(g.now)}</td>
       <td style="padding:8px 10px;text-align:right;font-weight:800;color:#109664;border-bottom:1px solid #eee">${fmtInt(g.next_week_forecast)}</td>
     </tr>`;
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#f5f3fa;margin:0;padding:24px;color:#1e1b2e">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2deec;border-radius:14px;overflow:hidden">
    <div style="background:#6900cc;color:#fff;padding:22px 26px">
      <div style="font-size:13px;letter-spacing:.4px;opacity:.85;text-transform:uppercase">Welile · Agent Ops</div>
      <h1 style="margin:6px 0 0;font-size:21px">Agent Daily Activity & Growth</h1>
      <div style="margin-top:4px;font-size:13px;opacity:.9">Report day: ${esc(prettyDate)} (yesterday)</div>
    </div>
    <div style="padding:24px 26px">
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155">
        Good morning. Here is yesterday's agent &amp; sub-agent activity across the network.
        The full branded report is attached as a PDF.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px">
        <tr>
          ${cell("Active Agents", fmtInt(a.active_agents), `of ${fmtInt(a.total_agents)} total`, "#f4f0fc", "#6900cc")}
          ${cell("Active Sub-Agents", fmtInt(a.active_subagents), `of ${fmtInt(a.total_subagents)} total`, "#f4f0fc", "#7c3aed")}
          ${cell("New Sub-Agents", fmtInt(a.new_subagents), "joined yesterday", "#fef7e7", "#ca8a04")}
        </tr>
        <tr>
          ${cell("Houses Listed", fmtInt(a.houses_listed), "new listings", "#eefaf4", "#109664")}
          ${cell("Rent Requests", fmtInt(a.rent_requests_posted), "posted", "#eef4fe", "#2563eb")}
          ${cell("Visits Logged", fmtInt(a.visits), "field visits", "#f4f0fc", "#7c3aed")}
        </tr>
        <tr>
          ${cell("Rent Repayments", fmtInt(a.repayments_count), fmtUgx(a.repayments_amount), "#eefaf4", "#109664")}
          ${cell("Field Collections", fmtInt(a.collections_count), fmtUgx(a.collections_amount), "#e9faf7", "#0d9488")}
          ${cell("Invites Sent", fmtInt(a.invites_total), `${fmtInt(a.subagent_invites)} agent · ${fmtInt(a.supporter_invites)} supp.`, "#fdeef6", "#db2777")}
        </tr>
      </table>
      <h2 style="margin:22px 0 8px;font-size:15px;color:#42007f">Weekly Headcount &amp; Forecast</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;border:1px solid #eee;border-radius:10px;overflow:hidden">
        <tr style="background:#42007f;color:#fff">
          <th style="padding:8px 10px;text-align:left">Segment</th>
          <th style="padding:8px 10px;text-align:right">Last week</th>
          <th style="padding:8px 10px;text-align:right">Now</th>
          <th style="padding:8px 10px;text-align:right">Next week (forecast)</th>
        </tr>
        ${wkRow("Agents", wa)}
        ${wkRow("Sub-Agents", ws)}
      </table>
      <p style="margin:6px 0 0;font-size:11px;color:#94a3b8">
        Forecast = current headcount + trailing 4-week average of new joins per week
        (~${fmtInt(wa.avg_weekly_new)} agents/wk, ~${fmtInt(ws.avg_weekly_new)} sub-agents/wk). Weeks start Monday (EAT).
      </p>
      ${top && top.total_actions > 0 ? `<p style="margin:18px 0 0;font-size:14px;line-height:1.6;color:#334155">
        🏆 <strong>Most active: ${esc(top.name)}</strong> — ${fmtInt(top.total_actions)} actions
        (${fmtInt(top.collections)} collections, ${fmtUgx(top.collected)}) yesterday.
      </p>` : ""}
      <p style="margin:20px 0 0;font-size:13px;color:#64748b;line-height:1.6">
        📎 <strong>Attached:</strong> full PDF with the daily KPI strip, weekly headcount &amp; forecast,
        top active agents, trailing 30-day network growth, top recruiters and the invitee pipeline.
      </p>
    </div>
    <div style="border-top:1px solid #e2deec;padding:16px 26px;font-size:11px;color:#94a3b8">
      Automated report from Welile Agent Ops · Report day ${esc(prettyDate)}.
    </div>
  </div></body></html>`;
}

async function run(admin: any, reportDate: string, force: boolean) {
  // reportDate is the EAT calendar day being reported (yesterday by default).
  if (!force) {
    const { data: existing } = await admin
      .from("system_events")
      .select("id")
      .eq("event_type", "agent_growth_daily_report")
      .filter("metadata->>report_date", "eq", reportDate)
      .maybeSingle();
    if (existing) {
      return { report_date: reportDate, skipped: true, reason: "already sent for this report day" };
    }
  }

  const [{ data: actData, error: actErr }, { data: lbData, error: lbErr }, { data: wkData, error: wkErr }] = await Promise.all([
    admin.rpc("get_agent_daily_activity_report", { p_date: reportDate }),
    admin.rpc("get_agent_leaderboard_stats", { p_period: "daily" }),
    admin.rpc("get_agent_weekly_growth_forecast"),
  ]);
  if (actErr) throw actErr;
  if (lbErr) throw lbErr;
  if (wkErr) throw wkErr;

  const activity = actData as unknown as DailyActivity;
  const stats = lbData as unknown as LeaderboardStats;
  const weekly = wkData as unknown as WeeklyForecast;

  const prettyDate = new Date(`${reportDate}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });

  const pdf = buildPdf(activity, stats, weekly, prettyDate);
  const html = buildHtml(activity, weekly, prettyDate);
  const filename = `Welile_Agent_Daily_Report_${reportDate}.pdf`;
  const a = activity.totals;
  const subject = `Agent Daily Report - ${prettyDate}: ${fmtInt(a.active_agents)} active agents, ${fmtInt(a.houses_listed)} houses, ${fmtInt(a.collections_count)} collections`;

  const results: Record<string, string> = {};
  for (const to of REPORT_RECIPIENTS) {
    try {
      const r = await sendWithAttachment(to, REPORT_CC, subject, html, pdf, filename);
      results[to] = r.ok ? "sent" : `error(${r.status}): ${r.raw?.slice(0, 200)}`;
      if (!r.ok) console.error("[agent-growth-daily-report] send failed", to, r.status, r.raw);
    } catch (e) {
      results[to] = `error: ${String(e)}`;
      console.error("[agent-growth-daily-report] send threw", to, e);
    }
  }

  await admin.from("system_events").insert({
    event_type: "agent_growth_daily_report",
    metadata: {
      report_date: reportDate,
      sent_on: eatToday(),
      recipients: REPORT_RECIPIENTS,
      cc: REPORT_CC,
      active_agents: a.active_agents,
      active_subagents: a.active_subagents,
      agents_last_week: weekly.agents.last_week,
      agents_now: weekly.agents.now,
      agents_next_week_forecast: weekly.agents.next_week_forecast,
      houses_listed: a.houses_listed,
      rent_requests_posted: a.rent_requests_posted,
      collections_count: a.collections_count,
      results,
    },
  });

  return { report_date: reportDate, recipients: REPORT_RECIPIENTS, pdf_bytes: pdf.length, results };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    let body: any = {};
    try { body = await req.json(); } catch (_) { body = {}; }
    const force = body?.force === true;
    // Default: report on yesterday (EAT). Optional { date: 'YYYY-MM-DD' } override.
    const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(body?.date) ? body.date : eatYesterday();
    const out = await run(admin, reportDate, force);
    return new Response(JSON.stringify({ success: true, ...out }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[agent-growth-daily-report] Fatal:", err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
