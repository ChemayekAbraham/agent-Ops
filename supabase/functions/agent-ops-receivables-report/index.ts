// Agent Ops daily receivables report — branded PDF + HTML email.
//
// Aggregates, for tenants on an ACTIVE rent repayment (funded/repaying):
//   1. Total tenants                      5. Total service centres
//   2. Receivable from all tenants        6. Receivable from service centres
//   3. Total agents (super + sub)         7. Total landlords
//   4. Receivable from agent accounts     8. Receivable from landlords
//
// Delivery uses the Gmail connector (multipart/mixed MIME) so the PDF can be
// attached; falls back to the transactional email queue (HTML only) if the
// connector credentials are missing.
//
// Idempotent per EAT day via a system_event. Options: { force }, { preview },
// { pdf: true } (returns the raw PDF), { date }.

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

const REPORT_RECIPIENTS = ["ssenkaali.pius@welile.com", "grace.nation78@gmail.com"];
const FROM = "Welile Reports <info@welile.com>";
const SENDER_DOMAIN = "notify.welile.com";
const EVENT_TYPE = "agent_ops_receivables_report";
const LABEL = "agent-ops-receivables-report";

type Admin = ReturnType<typeof createClient>;
type RGB = [number, number, number];

const BRAND: RGB = [105, 0, 204];
const BRAND_DARK: RGB = [66, 0, 128];
const INK: RGB = [30, 27, 46];
const MUTED: RGB = [120, 116, 132];
const BORDER: RGB = [226, 222, 236];
const EMERALD: RGB = [16, 150, 100];
const BLUE: RGB = [37, 99, 235];
const VIOLET: RGB = [124, 58, 237];
const TEAL: RGB = [13, 148, 136];
const AMBER: RGB = [202, 138, 4];
const ROSE: RGB = [219, 39, 119];
const SLATE: RGB = [100, 116, 139];
const PURPLE = "#6c21c4";

const tint = (c: RGB, amt: number): RGB => [
  Math.round(c[0] + (255 - c[0]) * amt),
  Math.round(c[1] + (255 - c[1]) * amt),
  Math.round(c[2] + (255 - c[2]) * amt),
];

const num = (n: unknown) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
const fmtUGX = (n: unknown) => `UGX ${num(n)}`;
function compactUGX(n: unknown): string {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 1_000_000_000) return `UGX ${(v / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(v) >= 1_000_000) return `UGX ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `UGX ${(v / 1_000).toFixed(0)}k`;
  return `UGX ${num(v)}`;
}
function ascii(s: unknown): string {
  return String(s ?? "").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim() || "-";
}
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function eatToday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function ensureUnsubscribeToken(admin: Admin, email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const { data: existing } = await admin
    .from("email_unsubscribe_tokens").select("token").eq("email", normalized).maybeSingle();
  if (existing?.token) return existing.token as string;
  const token = generateToken();
  await admin.from("email_unsubscribe_tokens")
    .upsert({ token, email: normalized }, { onConflict: "email", ignoreDuplicates: true });
  const { data: stored } = await admin
    .from("email_unsubscribe_tokens").select("token").eq("email", normalized).maybeSingle();
  return (stored?.token as string) || token;
}

interface Party {
  name: string; phone?: string | null; kind?: string;
  tenants?: number; plans?: number; outstanding: number; repaid: number; billed: number;
}
interface Band { label: string; plans: number; outstanding: number }
interface Stats {
  tenants_count: number;
  active_plans_count: number;
  tenants_receivable: number;
  portfolio_billed: number;
  portfolio_repaid: number;
  daily_expected: number;
  plans_funded: number;
  plans_repaying: number;
  plans_not_started: number;
  plans_cleared: number;
  agents_count: number;
  super_agents_count: number;
  sub_agents_count: number;
  agents_receivable: number;
  super_agents_receivable: number;
  sub_agents_receivable: number;
  service_centers_total: number;
  service_centers_count: number;
  service_centers_receivable: number;
  landlords_count: number;
  landlords_receivable: number;
  bands: Band[];
  top_agents: Party[];
  top_service_centers: Party[];
  top_landlords: Party[];
}

async function loadStats(admin: Admin): Promise<Stats> {
  const { data, error } = await admin.rpc("get_agent_ops_receivables_report");
  if (error) throw new Error(`get_agent_ops_receivables_report failed: ${error.message}`);
  const s = data as unknown as Stats;
  s.bands = s.bands || [];
  s.top_agents = s.top_agents || [];
  s.top_service_centers = s.top_service_centers || [];
  s.top_landlords = s.top_landlords || [];
  return s;
}

// ── Derived analytics ──
function derive(s: Stats) {
  const billed = Number(s.portfolio_billed) || 0;
  const repaid = Number(s.portfolio_repaid) || 0;
  const receivable = Number(s.tenants_receivable) || 0;
  const daily = Number(s.daily_expected) || 0;
  return {
    recoveryRate: billed > 0 ? (repaid / billed) * 100 : 0,
    perTenant: s.tenants_count > 0 ? receivable / s.tenants_count : 0,
    perPlan: s.active_plans_count > 0 ? receivable / s.active_plans_count : 0,
    perAgent: s.agents_count > 0 ? receivable / s.agents_count : 0,
    daysToClear: daily > 0 ? receivable / daily : 0,
    subShare: receivable > 0 ? (Number(s.sub_agents_receivable) / receivable) * 100 : 0,
    scmShare: receivable > 0 ? (Number(s.service_centers_receivable) / receivable) * 100 : 0,
    top5Share: receivable > 0
      ? (s.top_agents.slice(0, 5).reduce((a, p) => a + (Number(p.outstanding) || 0), 0) / receivable) * 100
      : 0,
    plansPerAgent: s.agents_count > 0 ? s.active_plans_count / s.agents_count : 0,
  };
}

// ── PDF ──
function buildPdf(s: Stats, prettyDate: string): Uint8Array {
  const d = derive(s);
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
  doc.text("Agent Ops — Daily Receivables Report", margin, 12);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(235, 225, 250);
  doc.text("Tenant repayment book viewed through every accountable party", margin, 18.5);
  doc.setFontSize(8.5);
  doc.setTextColor(255, 255, 255);
  doc.text(`Report day: ${prettyDate}`, pageWidth - margin, 11, { align: "right" });
  doc.setTextColor(225, 210, 248);
  doc.text(
    `Generated ${generatedAt.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Nairobi" })} EAT`,
    pageWidth - margin, 17, { align: "right" },
  );

  // KPI strip
  const cards: { label: string; value: string; sub: string; accent: RGB }[] = [
    { label: "Tenants on plan", value: num(s.tenants_count), sub: `${num(s.active_plans_count)} active plans`, accent: BRAND },
    { label: "Tenant receivable", value: compactUGX(s.tenants_receivable), sub: `${compactUGX(d.perTenant)} avg / tenant`, accent: ROSE },
    { label: "Recovered to date", value: `${d.recoveryRate.toFixed(1)}%`, sub: `${compactUGX(s.portfolio_repaid)} of ${compactUGX(s.portfolio_billed)}`, accent: EMERALD },
    { label: "Daily expected", value: compactUGX(s.daily_expected), sub: `${num(d.daysToClear)} days to clear`, accent: TEAL },
    { label: "Agents accountable", value: num(s.agents_count), sub: `${num(s.super_agents_count)} super · ${num(s.sub_agents_count)} sub`, accent: VIOLET },
    { label: "Agent receivable", value: compactUGX(s.agents_receivable), sub: `${compactUGX(d.perAgent)} avg / agent`, accent: BLUE },
    { label: "Service centres", value: `${num(s.service_centers_count)}/${num(s.service_centers_total)}`, sub: `${compactUGX(s.service_centers_receivable)} in book`, accent: AMBER },
    { label: "Landlords", value: num(s.landlords_count), sub: `${compactUGX(s.landlords_receivable)} in book`, accent: SLATE },
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
    doc.setFontSize(12);
    doc.setTextColor(...c.accent);
    doc.text(c.value, x + 3.5, y + 15);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6);
    doc.setTextColor(...MUTED);
    doc.text(c.sub, x + 3.5, y + 19);
  });

  // Recovery progress bar
  let y = startY + 2 * (cardH + gap) + 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_DARK);
  doc.text("Book recovery position", margin, y);
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(0.4);
  doc.line(margin, y + 1.8, pageWidth - margin, y + 1.8);
  y += 7;
  const barW = pageWidth - margin * 2;
  const barH = 9;
  doc.setFillColor(...tint(ROSE, 0.88));
  doc.roundedRect(margin, y, barW, barH, 1.5, 1.5, "F");
  const filled = Math.max(0, Math.min(1, d.recoveryRate / 100)) * barW;
  if (filled > 0.5) {
    doc.setFillColor(...EMERALD);
    doc.roundedRect(margin, y, filled, barH, 1.5, 1.5, "F");
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setTextColor(255, 255, 255);
  if (filled > 30) doc.text(`Repaid ${compactUGX(s.portfolio_repaid)}`, margin + 3, y + 6);
  doc.setTextColor(...ROSE);
  doc.text(`Outstanding ${compactUGX(s.tenants_receivable)}`, pageWidth - margin - 3, y + 6, { align: "right" });
  y += barH + 8;

  // Outstanding bands
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_DARK);
  doc.text("Where the outstanding money sits", margin, y);
  doc.setDrawColor(...BRAND);
  doc.line(margin, y + 1.8, pageWidth - margin, y + 1.8);
  y += 7;
  const maxBand = Math.max(1, ...s.bands.map((b) => Number(b.outstanding) || 0));
  const bandColors = [SLATE, TEAL, BLUE, AMBER, ROSE];
  s.bands.forEach((b, i) => {
    const c = bandColors[i % bandColors.length];
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...INK);
    doc.text(String(b.label), margin, y + 3.6);
    const trackX = margin + 30;
    const trackW = pageWidth - margin - 42 - trackX;
    doc.setFillColor(...tint(c, 0.9));
    doc.roundedRect(trackX, y, trackW, 5, 1, 1, "F");
    const w = ((Number(b.outstanding) || 0) / maxBand) * trackW;
    if (w > 0.4) {
      doc.setFillColor(...c);
      doc.roundedRect(trackX, y, w, 5, 1, 1, "F");
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.setTextColor(...c);
    doc.text(`${compactUGX(b.outstanding)} · ${num(b.plans)} plans`, pageWidth - margin, y + 3.6, { align: "right" });
    y += 7.4;
  });
  y += 8;

  // Executive read-out
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_DARK);
  doc.text("What this means", margin, y);
  doc.setDrawColor(...BRAND);
  doc.line(margin, y + 1.8, pageWidth - margin, y + 1.8);
  y += 6;
  const insights = [
    `${num(s.tenants_count)} tenants are on an active rent repayment across ${num(s.active_plans_count)} plans, leaving ${fmtUGX(s.tenants_receivable)} still to collect (avg ${fmtUGX(d.perTenant)} per tenant).`,
    `${d.recoveryRate.toFixed(1)}% of the billed book (${fmtUGX(s.portfolio_billed)}) has already been repaid. At the contracted ${fmtUGX(s.daily_expected)} per day the remaining balance clears in about ${num(d.daysToClear)} collection days.`,
    `${num(s.agents_count)} agents carry the book — ${num(s.super_agents_count)} super (${compactUGX(s.super_agents_receivable)}) and ${num(s.sub_agents_count)} sub (${compactUGX(s.sub_agents_receivable)}, ${d.subShare.toFixed(0)}% of exposure), averaging ${d.plansPerAgent.toFixed(1)} plans each.`,
    `${num(s.service_centers_count)} of ${num(s.service_centers_total)} service centres have a live book worth ${fmtUGX(s.service_centers_receivable)} (${d.scmShare.toFixed(0)}% of total), and ${num(s.landlords_count)} landlords are attached to ${fmtUGX(s.landlords_receivable)}.`,
    `Concentration watch: the top 5 agents hold ${d.top5Share.toFixed(0)}% of all outstanding, and ${num(s.plans_not_started)} funded plans have not made a single repayment yet.`,
  ];
  const lineH = 5.4;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.3);
  const wrapped = insights.map((t) => doc.splitTextToSize(t, pageWidth - margin * 2 - 12) as string[]);
  let boxH = 6;
  wrapped.forEach((w) => { boxH += lineH * w.length; });
  doc.setFillColor(...tint(BRAND, 0.95));
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.2);
  doc.roundedRect(margin, y, pageWidth - margin * 2, boxH, 2, 2, "FD");
  let iy = y + 6;
  wrapped.forEach((w) => {
    doc.setFillColor(...BRAND);
    doc.circle(margin + 4, iy - 1.2, 0.9, "F");
    doc.setTextColor(...INK);
    w.forEach((line, li) => {
      doc.text(line, margin + 7.5, iy + li * lineH);
    });
    iy += lineH * w.length;
  });

  const tableTheme = {
    theme: "grid" as const,
    styles: { fontSize: 7.6, cellPadding: 1.8, textColor: INK, lineColor: BORDER, lineWidth: 0.1 },
    headStyles: { fillColor: BRAND, textColor: [255, 255, 255] as RGB, fontStyle: "bold" as const, fontSize: 7.4 },
    alternateRowStyles: { fillColor: [248, 245, 254] as RGB },
    margin: { left: margin, right: margin },
  };

  // Accountability matrix (page 1, below the read-out)
  const matrixTop = y + boxH + 9;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_DARK);
  doc.text("Accountability matrix", margin, matrixTop);
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(0.4);
  doc.line(margin, matrixTop + 1.8, pageWidth - margin, matrixTop + 1.8);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.6);
  doc.setTextColor(...MUTED);
  doc.text(
    "Same tenant book seen through each accountable party - views, not additive totals.",
    margin, matrixTop + 6.6,
  );
  autoTable(doc, {
    ...tableTheme,
    startY: matrixTop + 9,
    head: [["Group", "Count", "Receivable", "Share of book"]],
    body: [
      ["Tenants (active repayment)", num(s.tenants_count), fmtUGX(s.tenants_receivable), "100%"],
      ["Agents — total (super + sub)", num(s.agents_count), fmtUGX(s.agents_receivable), `${((Number(s.agents_receivable) / (Number(s.tenants_receivable) || 1)) * 100).toFixed(0)}%`],
      ["   Super agents", num(s.super_agents_count), fmtUGX(s.super_agents_receivable), `${(100 - d.subShare).toFixed(0)}%`],
      ["   Sub agents", num(s.sub_agents_count), fmtUGX(s.sub_agents_receivable), `${d.subShare.toFixed(0)}%`],
      [`Service centres${Number(s.service_centers_total) > 0 ? ` (of ${num(s.service_centers_total)})` : ""}`, num(s.service_centers_count), fmtUGX(s.service_centers_receivable), `${d.scmShare.toFixed(0)}%`],
      ["Landlords", num(s.landlords_count), fmtUGX(s.landlords_receivable), `${((Number(s.landlords_receivable) / (Number(s.tenants_receivable) || 1)) * 100).toFixed(0)}%`],
    ],
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" } },
  });

  const section = (title: string, head: string[], body: (string | number)[][]) => {
    const prevY = (doc as any).lastAutoTable?.finalY ?? 26;
    let top = prevY + 10;
    if (top > pageHeight - 55) { doc.addPage(); top = 18; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(...BRAND_DARK);
    doc.text(title, margin, top);
    autoTable(doc, {
      ...tableTheme,
      startY: top + 3,
      head: [head],
      body: body.length ? body : [["No records", "", "", "", ""].slice(0, head.length)],
      columnStyles: Object.fromEntries(head.map((_, i) => [i, { halign: i === 0 ? "left" : "right" }])) as any,
    });
  };

  section(
    "Top agents by outstanding",
    ["Agent", "Type", "Tenants", "Repaid", "Outstanding", "Recovered"],
    s.top_agents.map((p) => [
      ascii(p.name), p.kind ?? "-", num(p.tenants), compactUGX(p.repaid), compactUGX(p.outstanding),
      `${(Number(p.billed) > 0 ? (Number(p.repaid) / Number(p.billed)) * 100 : 0).toFixed(0)}%`,
    ]),
  );
  section(
    "Service centre managers by outstanding",
    ["Service centre", "Tenants", "Repaid", "Outstanding", "Recovered"],
    s.top_service_centers.map((p) => [
      ascii(p.name), num(p.tenants), compactUGX(p.repaid), compactUGX(p.outstanding),
      `${(Number(p.billed) > 0 ? (Number(p.repaid) / Number(p.billed)) * 100 : 0).toFixed(0)}%`,
    ]),
  );
  section(
    "Landlords by outstanding",
    ["Landlord", "Plans", "Repaid", "Outstanding", "Recovered"],
    s.top_landlords.map((p) => [
      ascii(p.name), num(p.plans), compactUGX(p.repaid), compactUGX(p.outstanding),
      `${(Number(p.billed) > 0 ? (Number(p.repaid) / Number(p.billed)) * 100 : 0).toFixed(0)}%`,
    ]),
  );

  // Footers
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.2);
    doc.line(margin, pageHeight - 9, pageWidth - margin, pageHeight - 9);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text("Powered by Welile — confidential Agent Ops receivables analytics", margin, pageHeight - 5);
    doc.text(`Page ${p} / ${pageCount}`, pageWidth - margin, pageHeight - 5, { align: "right" });
  }

  return new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
}

// ── Email HTML ──
function row(label: string, count: string, amount: string): string {
  return `<tr>
    <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;color:#333;">${esc(label)}</td>
    <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;color:#111;text-align:right;font-weight:600;">${esc(count)}</td>
    <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;color:#111;text-align:right;font-weight:600;">${esc(amount)}</td>
  </tr>`;
}

function buildHtml(s: Stats, prettyDate: string): string {
  const d = derive(s);
  const tile = (label: string, value: string, sub: string, color: string) =>
    `<td style="width:25%;background:#faf8ff;border-radius:10px;padding:12px;vertical-align:top">
       <div style="font-size:10px;color:#787484;text-transform:uppercase;font-weight:700">${esc(label)}</div>
       <div style="font-size:19px;font-weight:800;color:${color};margin-top:2px">${esc(value)}</div>
       <div style="font-size:11px;color:#787484">${esc(sub)}</div>
     </td>`;
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f6f6f8;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e6e6ec;">
    <div style="background:${PURPLE};padding:20px 24px;">
      <div style="color:#fff;font-size:18px;font-weight:700;">Agent Ops — Daily Receivables</div>
      <div style="color:#e8dcfa;font-size:13px;margin-top:4px;">${esc(prettyDate)} · tenants on an active rent repayment</div>
    </div>
    <div style="padding:20px 24px;">
      <table style="width:100%;border-collapse:separate;border-spacing:6px 0;"><tr>
        ${tile("Tenants", num(s.tenants_count), `${num(s.active_plans_count)} active plans`, "#6c21c4")}
        ${tile("Receivable", compactUGX(s.tenants_receivable), `${compactUGX(d.perTenant)} / tenant`, "#db2777")}
        ${tile("Recovered", `${d.recoveryRate.toFixed(1)}%`, `of ${compactUGX(s.portfolio_billed)}`, "#109664")}
        ${tile("Days to clear", num(d.daysToClear), `${compactUGX(s.daily_expected)} / day`, "#0d9488")}
      </tr></table>
      <table style="width:100%;border-collapse:collapse;margin-top:18px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 12px;font-size:12px;color:#666;text-transform:uppercase;">Group</th>
            <th style="text-align:right;padding:8px 12px;font-size:12px;color:#666;text-transform:uppercase;">Count</th>
            <th style="text-align:right;padding:8px 12px;font-size:12px;color:#666;text-transform:uppercase;">Receivable</th>
          </tr>
        </thead>
        <tbody>
          ${row("Tenants (active repayment)", num(s.tenants_count), fmtUGX(s.tenants_receivable))}
          ${row("Agents — total (super + sub)", num(s.agents_count), fmtUGX(s.agents_receivable))}
          ${row("· Super agents", num(s.super_agents_count), fmtUGX(s.super_agents_receivable))}
          ${row("· Sub agents", num(s.sub_agents_count), fmtUGX(s.sub_agents_receivable))}
          ${row("Service centres (with active book)", `${num(s.service_centers_count)} of ${num(s.service_centers_total)}`, fmtUGX(s.service_centers_receivable))}
          ${row("Landlords", num(s.landlords_count), fmtUGX(s.landlords_receivable))}
        </tbody>
      </table>
      <p style="font-size:13px;color:#555;line-height:1.6;margin-top:18px;">
        📎 <strong>Attached PDF</strong> — KPI strip, book recovery position, outstanding-by-size bands,
        an executive read-out, and accountability ledgers for the top agents, service centres and landlords.
      </p>
      <p style="font-size:13px;color:#555;line-height:1.6;">
        Receivable is total repayment less amount already repaid, on rent plans in
        <em>funded</em> or <em>repaying</em> state. Agent, service centre and landlord figures
        are the same tenant book viewed through each accountable party, so they are not additive.
        Top 5 agents hold <strong>${d.top5Share.toFixed(0)}%</strong> of all outstanding.
      </p>
    </div>
    <div style="padding:14px 24px;background:#faf8fe;color:#777;font-size:11px;">
      Welile · automated Agent Ops brief
    </div>
  </div></body></html>`;
}

function buildText(s: Stats, prettyDate: string): string {
  const d = derive(s);
  return [
    `Agent Ops — Daily Receivables (${prettyDate})`,
    `Tenants on active repayment: ${num(s.tenants_count)} — ${fmtUGX(s.tenants_receivable)}`,
    `Agents total (super+sub): ${num(s.agents_count)} — ${fmtUGX(s.agents_receivable)}`,
    `  Super agents: ${num(s.super_agents_count)} — ${fmtUGX(s.super_agents_receivable)}`,
    `  Sub agents: ${num(s.sub_agents_count)} — ${fmtUGX(s.sub_agents_receivable)}`,
    `Service centres: ${num(s.service_centers_count)} of ${num(s.service_centers_total)} — ${fmtUGX(s.service_centers_receivable)}`,
    `Landlords: ${num(s.landlords_count)} — ${fmtUGX(s.landlords_receivable)}`,
    `Active rent plans: ${num(s.active_plans_count)} · recovered ${d.recoveryRate.toFixed(1)}%`,
    `Full report attached as PDF.`,
  ].join("\n");
}

// ── Gmail attachment delivery ──
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
  to: string, subject: string, html: string, text: string, pdf: Uint8Array, filename: string,
): Promise<{ ok: boolean; status: number; raw?: string }> {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const gmailKey = Deno.env.get("GOOGLE_MAIL_API_KEY");
  if (!lovableKey || !gmailKey) return { ok: false, status: 0, raw: "Gmail connector creds missing" };

  const boundary = `welile_${crypto.randomUUID().replace(/-/g, "")}`;
  const altBoundary = `alt_${crypto.randomUUID().replace(/-/g, "")}`;
  const pdfB64 = chunk76(bytesToBase64(pdf));
  const htmlB64 = chunk76(bytesToBase64(new TextEncoder().encode(html)));
  const textB64 = chunk76(bytesToBase64(new TextEncoder().encode(text)));
  const encodedSubject = /[^\x00-\x7F]/.test(subject)
    ? `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(subject))}?=`
    : subject;
  const raw = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
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
  const body = await res.text();
  return { ok: res.ok, status: res.status, raw: body };
}

async function queueFallback(
  admin: Admin, to: string, subject: string, html: string, text: string, dateStr: string, force: boolean,
) {
  const messageId = crypto.randomUUID();
  const unsubscribeToken = await ensureUnsubscribeToken(admin, to);
  await admin.from("email_send_log").insert({
    message_id: messageId,
    template_name: LABEL,
    recipient_email: to,
    status: "pending",
    metadata: { subject, date: dateStr },
  });
  const { error } = await admin.rpc("enqueue_email", {
    queue_name: "transactional_emails",
    payload: {
      message_id: messageId, to, from: FROM, sender_domain: SENDER_DOMAIN,
      subject, html, text, purpose: "transactional", label: LABEL,
      idempotency_key: `${LABEL}:${dateStr}:${to}${force ? `:${messageId}` : ""}`,
      unsubscribe_token: unsubscribeToken, queued_at: new Date().toISOString(),
    },
  });
  return error ? `queue error: ${error.message}` : "queued (no attachment)";
}

function prettify(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

async function sendForDate(admin: Admin, dateStr: string, force: boolean) {
  if (!force) {
    const { data: existing } = await admin
      .from("system_events").select("id").eq("event_type", EVENT_TYPE)
      .contains("metadata", { date: dateStr }).limit(1).maybeSingle();
    if (existing) return { date: dateStr, skipped: true, reason: "Already sent" };
  }

  const stats = await loadStats(admin);
  const prettyDate = prettify(dateStr);
  const html = buildHtml(stats, prettyDate);
  const text = buildText(stats, prettyDate);
  const pdf = buildPdf(stats, prettyDate);
  const filename = `Welile_Agent_Ops_Receivables_${dateStr}.pdf`;
  const subject = `Agent Ops receivables - ${prettyDate}: ${num(stats.tenants_count)} tenants, ${fmtUGX(stats.tenants_receivable)} receivable`;

  const results: Record<string, string> = {};
  let usedQueue = false;
  for (const to of REPORT_RECIPIENTS) {
    const sent = await sendWithAttachment(to, subject, html, text, pdf, filename);
    if (sent.ok) {
      results[to] = "sent with PDF";
    } else {
      console.error(`[${LABEL}] gmail send failed`, to, sent.status, sent.raw);
      usedQueue = true;
      results[to] = await queueFallback(admin, to, subject, html, text, dateStr, force);
    }
  }

  await admin.from("system_events").insert({
    event_type: EVENT_TYPE,
    metadata: { date: dateStr, recipients: REPORT_RECIPIENTS, stats, results, pdf_bytes: pdf.length },
  });

  return { date: dateStr, recipients: REPORT_RECIPIENTS, results, pdf_bytes: pdf.length, usedQueue, stats };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    let body: any = {};
    try { body = await req.json(); } catch (_) { body = {}; }

    const dateStr = typeof body?.date === "string" && body.date ? body.date.slice(0, 10) : eatToday();

    if (body?.pdf === true) {
      const stats = await loadStats(admin);
      const pdf = buildPdf(stats, prettify(dateStr));
      return new Response(pdf, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="Welile_Agent_Ops_Receivables_${dateStr}.pdf"`,
        },
      });
    }

    if (body?.preview === true) {
      const stats = await loadStats(admin);
      return new Response(buildHtml(stats, prettify(dateStr)), {
        headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const report = await sendForDate(admin, dateStr, body?.force === true);

    if ((report as any).usedQueue) {
      fetch(`${SUPABASE_URL}/functions/v1/process-email-queue`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" },
        body: "{}",
      }).catch((e) => console.error(`[${LABEL}] dispatch trigger failed:`, e));
    }

    return new Response(JSON.stringify({ success: true, report }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`[${LABEL}] Fatal:`, err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
