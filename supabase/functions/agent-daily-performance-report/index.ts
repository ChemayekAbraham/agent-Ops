// Agent daily performance report — emailed daily brief.
//
// This function is a server-side mirror of the Agent Ops dashboard
// "Agent daily performance → Today" PDF (see
// src/components/executive/AgentDailyOverviewReportButton.tsx +
// src/lib/agentDailyOverviewPdf.ts). The daily email now uses exactly the
// same "today's report" logic so the mailed brief reconciles 1:1 with what
// Agent Ops downloads on the dashboard.
//
// Logic (kept in sync with the client):
//   * Active book  = rent_requests in approved|disbursed|active|repaying|funded
//   * Principal    = outstanding_balance plans -> initial_outstanding_balance,
//                    otherwise rent_amount
//   * Expected     = sum(daily_repayment) over the active book
//   * Outstanding  = max(0, total_repayment - amount_repaid) (OB plans use
//                    initial_outstanding_balance as the billed figure)
//   * Collected    = agent_collections rows created inside the EAT day
//
// Idempotent per EAT day via a system_event. Options:
//   { force: true }              re-send even if already sent today
//   { date: "YYYY-MM-DD" }       backfill a specific EAT day
//   { recipients: ["a@b.com"] }  override recipients (sample sends)
//   { preview: true }            return HTML
//   { pdf: true }                return the raw PDF

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsPDF } from "https://esm.sh/jspdf@2.5.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const DEFAULT_RECIPIENTS = ["pexpert46@gmail.com"];
const EVENT_TYPE = "agent_daily_performance_report";
const LABEL = "agent-daily-performance-report";
const FROM = "Welile Reports <info@welile.com>";
const SENDER_DOMAIN = "notify.welile.com";

// Kept identical to the dashboard button.
const ACTIVE_STATUSES = ["approved", "disbursed", "active", "repaying", "funded"];
const UNASSIGNED_AGENT_KEY = "__unassigned__";

type Admin = any;
type RGB = [number, number, number];

const HEAD: RGB = [146, 52, 234];
const INK: RGB = [15, 23, 42];
const MUTED: RGB = [100, 116, 139];
const BORDER: RGB = [225, 227, 232];
const GREEN: RGB = [22, 163, 74];
const RED: RGB = [220, 38, 38];
const PURPLE = "#6c21c4";

const num = (n: unknown) =>
  Math.round(Number(n) || 0).toLocaleString("en-US");
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
function eatDayBounds(dateStr: string): { startISO: string; endISO: string } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const startEAT = Date.UTC(y, m - 1, d, 0, 0, 0) - 3 * 60 * 60 * 1000;
  return {
    startISO: new Date(startEAT).toISOString(),
    endISO: new Date(startEAT + 24 * 60 * 60 * 1000).toISOString(),
  };
}
function prettify(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
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

// PostgREST caps a select at 1000 rows — every bulk read must paginate.
async function fetchAll(
  admin: Admin,
  table: string,
  select: string,
  apply?: (q: any) => any,
): Promise<any[]> {
  const rows: any[] = [];
  const size = 1000;
  for (let page = 0; page < 100; page++) {
    let q: any = admin.from(table).select(select).range(page * size, page * size + size - 1);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < size) break;
  }
  return rows;
}

interface Row {
  agentName: string;
  agentPhone: string;
  activeTenants: number;
  expectedToday: number;
  collectedToday: number;
  tenantsPaidToday: number;
  paymentsToday: number;
  principalPaid: number;
  outstanding: number;
}
interface Totals {
  agents: number;
  tenants: number;
  expected: number;
  collected: number;
  paid: number;
  payments: number;
  principal: number;
  outstanding: number;
  rate: number;
  agentsCollecting: number;
}

async function loadRows(admin: Admin, dateStr: string): Promise<Row[]> {
  const { startISO, endISO } = eatDayBounds(dateStr);

  const requests = await fetchAll(
    admin,
    "rent_requests",
    "agent_id, tenant_id, rent_amount, daily_repayment, total_repayment, amount_repaid, status, registration_type, initial_outstanding_balance",
    (q) => q.in("status", ACTIVE_STATUSES),
  );

  const collections = await fetchAll(
    admin,
    "agent_collections",
    "agent_id, tenant_id, amount, created_at",
    // A reversed collection did not happen: it must not count toward an
    // agent's collected total or their tenants-paid count.
    (q) => q.is("reversed_at", null).gte("created_at", startISO).lt("created_at", endISO),
  );

  const agentIds = Array.from(new Set([
    ...requests.map((r: any) => r.agent_id),
    ...collections.map((c: any) => c.agent_id),
  ].filter(Boolean))) as string[];

  const profileMap = new Map<string, { full_name: string | null; phone: string | null }>();
  const chunk = 400;
  for (let i = 0; i < agentIds.length; i += chunk) {
    const slice = agentIds.slice(i, i + chunk);
    const { data, error } = await admin
      .from("profiles").select("id, full_name, phone").in("id", slice);
    if (error) throw new Error(`profiles: ${error.message}`);
    (data ?? []).forEach((p: any) => profileMap.set(p.id, p));
  }

  type Agg = Row & { tenantSet: Set<string>; paidSet: Set<string> };
  const map = new Map<string, Agg>();
  const ensure = (agentId: string): Agg => {
    let a = map.get(agentId);
    if (!a) {
      const isUnassigned = agentId === UNASSIGNED_AGENT_KEY;
      const p = isUnassigned ? null : profileMap.get(agentId);
      a = {
        agentName: isUnassigned ? "Unassigned" : (p?.full_name || "Unknown agent"),
        agentPhone: isUnassigned ? "" : (p?.phone || ""),
        activeTenants: 0,
        expectedToday: 0,
        collectedToday: 0,
        tenantsPaidToday: 0,
        paymentsToday: 0,
        principalPaid: 0,
        outstanding: 0,
        tenantSet: new Set<string>(),
        paidSet: new Set<string>(),
      };
      map.set(agentId, a);
    }
    return a;
  };

  requests.forEach((r: any) => {
    const a = ensure(r.agent_id || UNASSIGNED_AGENT_KEY);
    const isOB = r.registration_type === "outstanding_balance";
    const principal = isOB
      ? Number(r.initial_outstanding_balance || 0)
      : Number(r.rent_amount || 0);
    const billed = isOB
      ? Number(r.initial_outstanding_balance || 0)
      : Number(r.total_repayment || 0);
    a.expectedToday += Number(r.daily_repayment || 0);
    a.principalPaid += principal;
    a.outstanding += Math.max(0, billed - Number(r.amount_repaid || 0));
    if (r.tenant_id) a.tenantSet.add(r.tenant_id);
  });

  collections.forEach((c: any) => {
    const a = ensure(c.agent_id || UNASSIGNED_AGENT_KEY);
    a.collectedToday += Number(c.amount || 0);
    a.paymentsToday += 1;
    if (c.tenant_id) a.paidSet.add(c.tenant_id);
  });

  return Array.from(map.values())
    .map((a) => ({
      agentName: a.agentName,
      agentPhone: a.agentPhone,
      activeTenants: a.tenantSet.size,
      expectedToday: a.expectedToday,
      collectedToday: a.collectedToday,
      tenantsPaidToday: a.paidSet.size,
      paymentsToday: a.paymentsToday,
      principalPaid: a.principalPaid,
      outstanding: a.outstanding,
    }))
    .sort((x, y) => {
      const rx = x.expectedToday > 0 ? x.collectedToday / x.expectedToday : 1;
      const ry = y.expectedToday > 0 ? y.collectedToday / y.expectedToday : 1;
      if (rx !== ry) return ry - rx;
      return y.expectedToday - x.expectedToday;
    });
}

function totalsOf(rows: Row[]): Totals {
  const t = rows.reduce((a, r) => {
    a.tenants += r.activeTenants;
    a.expected += r.expectedToday;
    a.collected += r.collectedToday;
    a.paid += r.tenantsPaidToday;
    a.payments += r.paymentsToday;
    a.principal += r.principalPaid;
    a.outstanding += r.outstanding;
    if (r.collectedToday > 0) a.agentsCollecting += 1;
    return a;
  }, {
    agents: rows.length, tenants: 0, expected: 0, collected: 0, paid: 0,
    payments: 0, principal: 0, outstanding: 0, rate: 0, agentsCollecting: 0,
  } as Totals);
  t.rate = t.expected > 0 ? (t.collected / t.expected) * 100 : 0;
  return t;
}

function ratingOf(rate: number): string {
  if (rate >= 95) return "Excellent";
  if (rate >= 75) return "Good";
  if (rate >= 50) return "Moderate";
  if (rate >= 25) return "Low";
  return "Critical";
}

// ── PDF ──
// Pixel-for-pixel mirror of the Agent Ops dashboard "Daily PDF" download
// (src/lib/agentDailyOverviewPdf.ts). Keep the two in sync.
const ZEBRA: RGB = [248, 249, 252];
const AMBER: RGB = [245, 158, 11];
const BLUE: RGB = [37, 99, 235];

function statusOf(rate: number): { label: string; color: RGB } {
  if (rate >= 95) return { label: "Excellent", color: GREEN };
  if (rate >= 75) return { label: "Good", color: [34, 139, 87] };
  if (rate >= 50) return { label: "Moderate", color: AMBER };
  if (rate >= 25) return { label: "Low", color: [234, 88, 12] };
  return { label: "Critical", color: RED };
}

// "Thu, 13 Aug 2026" for the given EAT date string.
function shortDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  }).replace(/,?\s+/g, " ").replace(/^(\w{3}) /, "$1, ");
}
// "13 Aug 2026 09:06" in EAT.
function generatedStamp(): string {
  const eat = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const d = eat.toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  });
  const hh = String(eat.getUTCHours()).padStart(2, "0");
  const mm = String(eat.getUTCMinutes()).padStart(2, "0");
  return `${d} ${hh}:${mm}`;
}

function buildPdf(rows: Row[], t: Totals, dateStr: string): Uint8Array {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 10;
  const contentW = pageW - margin * 2;
  let y = 10;

  const overallRate = t.expected > 0 ? Math.round((t.collected / t.expected) * 100) : 0;

  // ===== Header bar =====
  doc.setFillColor(...INK);
  doc.rect(margin, y, contentW, 20, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(255, 255, 255);
  doc.text("WELILE - AGENT DAILY PERFORMANCE", margin + 4, y + 8);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(200, 208, 225);
  doc.text("One row per agent: expected vs collected, principal & outstanding", margin + 4, y + 14);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(255, 255, 255);
  doc.text(shortDate(dateStr), pageW - margin - 4, y + 10, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(200, 208, 225);
  doc.text(`Generated ${generatedStamp()}`, pageW - margin - 4, y + 15, { align: "right" });
  y += 24;

  // ===== Summary chips =====
  const chips: { label: string; value: string; color: RGB }[] = [
    { label: "Agents", value: String(rows.length), color: INK },
    { label: "Active tenants", value: String(t.tenants), color: INK },
    { label: "Expected today (UGX)", value: num(t.expected), color: INK },
    { label: "Collected today (UGX)", value: num(t.collected), color: BLUE },
    { label: "Collection rate", value: `${overallRate}%`, color: overallRate >= 75 ? GREEN : overallRate >= 50 ? BLUE : RED },
    { label: "Principal paid (UGX)", value: num(t.principal), color: INK },
    { label: "Outstanding (UGX)", value: num(t.outstanding), color: RED },
  ];
  const gap = 3;
  const chipW = (contentW - gap * (chips.length - 1)) / chips.length;
  const chipH = 18;
  chips.forEach((c, i) => {
    const x = margin + i * (chipW + gap);
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.25);
    doc.roundedRect(x, y, chipW, chipH, 2, 2, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.text(c.label.toUpperCase(), x + 3, y + 5);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...c.color);
    doc.text(c.value, x + 3, y + 13);
  });
  y += chipH + 5;

  // ===== Per-agent table =====
  doc.setFillColor(...HEAD);
  doc.rect(margin, y, contentW, 7, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text("PER-AGENT BREAKDOWN", margin + 3, y + 4.8);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.text("All amounts in UGX", pageW - margin - 3, y + 4.8, { align: "right" });
  y += 7;

  const fixed = 8 + 46 + 26 + 16 + 26 + 26 + 14 + 14 + 14 + 28 + 28;
  const cols: { label: string; w: number; align: "left" | "right" | "center" }[] = [
    { label: "#", w: 8, align: "left" },
    { label: "Agent", w: 46, align: "left" },
    { label: "Phone", w: 26, align: "left" },
    { label: "Tenants", w: 16, align: "right" },
    { label: "Expected", w: 26, align: "right" },
    { label: "Collected", w: 26, align: "right" },
    { label: "Rate", w: 14, align: "right" },
    { label: "Paid", w: 14, align: "right" },
    { label: "Pmts", w: 14, align: "right" },
    { label: "Principal paid", w: 28, align: "right" },
    { label: "Outstanding", w: 28, align: "right" },
    { label: "Status", w: contentW - fixed, align: "center" },
  ];
  const colX = (i: number) => margin + cols.slice(0, i).reduce((s, c) => s + c.w, 0);

  const drawHeader = () => {
    doc.setFillColor(241, 245, 249);
    doc.rect(margin, y, contentW, 6.5, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.setTextColor(...INK);
    cols.forEach((c, i) => {
      const tx = c.align === "right"
        ? colX(i) + c.w - 1.5
        : c.align === "center" ? colX(i) + c.w / 2 : colX(i) + 1.5;
      doc.text(c.label, tx, y + 4.3, { align: c.align });
    });
    y += 6.5;
  };
  drawHeader();

  const rowH = 5.8;
  const bottomLimit = pageH - 14;
  const trunc = (s: string, n: number) => {
    const v = ascii(s);
    if (!v || v === "-") return "-";
    return v.length > n ? `${v.slice(0, n - 1)}...` : v;
  };

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  rows.forEach((r, i) => {
    if (y + rowH > bottomLimit) {
      doc.addPage();
      y = 10;
      drawHeader();
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
    }
    if (i % 2 === 1) {
      doc.setFillColor(...ZEBRA);
      doc.rect(margin, y, contentW, rowH, "F");
    }
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.1);
    doc.line(margin, y + rowH, margin + contentW, y + rowH);
    const b = y + rowH - 1.9;
    const rate = r.expectedToday > 0 ? Math.round((r.collectedToday / r.expectedToday) * 100) : 0;
    const st = statusOf(rate);
    doc.setTextColor(...INK);
    doc.text(String(i + 1), colX(0) + 1.5, b);
    doc.setFont("helvetica", "bold");
    doc.text(trunc(r.agentName, 28), colX(1) + 1.5, b);
    doc.setFont("helvetica", "normal");
    doc.text(trunc(r.agentPhone, 16), colX(2) + 1.5, b);
    doc.text(String(r.activeTenants), colX(3) + cols[3].w - 1.5, b, { align: "right" });
    doc.text(num(r.expectedToday), colX(4) + cols[4].w - 1.5, b, { align: "right" });
    if (r.collectedToday > 0) doc.setTextColor(...GREEN);
    doc.text(num(r.collectedToday), colX(5) + cols[5].w - 1.5, b, { align: "right" });
    doc.setTextColor(...st.color);
    doc.setFont("helvetica", "bold");
    doc.text(`${rate}%`, colX(6) + cols[6].w - 1.5, b, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...INK);
    doc.text(String(r.tenantsPaidToday), colX(7) + cols[7].w - 1.5, b, { align: "right" });
    doc.text(String(r.paymentsToday), colX(8) + cols[8].w - 1.5, b, { align: "right" });
    doc.text(num(r.principalPaid), colX(9) + cols[9].w - 1.5, b, { align: "right" });
    if (r.outstanding > 0) doc.setTextColor(...RED);
    doc.text(num(r.outstanding), colX(10) + cols[10].w - 1.5, b, { align: "right" });
    doc.setTextColor(...INK);
    // Status pill
    doc.setFillColor(...st.color);
    doc.roundedRect(colX(11) + 2, y + 1.4, cols[11].w - 4, rowH - 2.8, 0.8, 0.8, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.5);
    doc.setTextColor(255, 255, 255);
    doc.text(st.label, colX(11) + cols[11].w / 2, b - 0.3, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...INK);
    y += rowH;
  });

  if (rows.length === 0) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text("No agents with active tenants for this date.", margin + 3, y + 6);
    y += 8;
  }

  // Totals row
  if (y + rowH + 1 > bottomLimit) {
    doc.addPage();
    y = 10;
    drawHeader();
  }
  doc.setFillColor(232, 240, 254);
  doc.rect(margin, y, contentW, rowH + 1, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  const tb = y + rowH - 1.4;
  doc.setTextColor(...BLUE);
  doc.text("TOTAL", colX(1) + 1.5, tb);
  doc.setTextColor(...INK);
  doc.text(String(t.tenants), colX(3) + cols[3].w - 1.5, tb, { align: "right" });
  doc.text(num(t.expected), colX(4) + cols[4].w - 1.5, tb, { align: "right" });
  doc.setTextColor(...GREEN);
  doc.text(num(t.collected), colX(5) + cols[5].w - 1.5, tb, { align: "right" });
  doc.setTextColor(...INK);
  doc.text(`${overallRate}%`, colX(6) + cols[6].w - 1.5, tb, { align: "right" });
  doc.text(String(t.paid), colX(7) + cols[7].w - 1.5, tb, { align: "right" });
  doc.text(String(t.payments), colX(8) + cols[8].w - 1.5, tb, { align: "right" });
  doc.text(num(t.principal), colX(9) + cols[9].w - 1.5, tb, { align: "right" });
  doc.setTextColor(...RED);
  doc.text(num(t.outstanding), colX(10) + cols[10].w - 1.5, tb, { align: "right" });

  // Footer page numbers
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text(`Page ${p} of ${pageCount}  -  Welile Receipts  -  Confidential`, pageW / 2, pageH - 5, { align: "center" });
  }

  return new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
}

// ── Email ──
function buildHtml(rows: Row[], t: Totals, prettyDate: string): string {
  const tile = (label: string, value: string, sub: string, color: string) =>
    `<td style="width:25%;background:#faf8ff;border-radius:10px;padding:12px;vertical-align:top">
       <div style="font-size:10px;color:#787484;text-transform:uppercase;font-weight:700">${esc(label)}</div>
       <div style="font-size:19px;font-weight:800;color:${color};margin-top:2px">${esc(value)}</div>
       <div style="font-size:11px;color:#787484">${esc(sub)}</div>
     </td>`;
  const top = rows.filter((r) => r.expectedToday > 0 || r.collectedToday > 0).slice(0, 15);
  const body = top.map((r) => {
    const rate = r.expectedToday > 0 ? (r.collectedToday / r.expectedToday) * 100 : 0;
    return `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;color:#222;">${esc(r.agentName)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">${num(r.activeTenants)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">${esc(compactUGX(r.expectedToday))}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:right;font-weight:600;">${esc(compactUGX(r.collectedToday))}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;text-align:right;color:${rate >= 75 ? "#109664" : "#dc2626"};font-weight:700;">${rate.toFixed(0)}%</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f6f6f8;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e6e6ec;">
    <div style="background:${PURPLE};padding:20px 24px;">
      <div style="color:#fff;font-size:18px;font-weight:700;">Agent daily performance</div>
      <div style="color:#e8dcfa;font-size:13px;margin-top:4px;">${esc(prettyDate)} (EAT) &middot; today's collections vs expected</div>
    </div>
    <div style="padding:20px 24px;">
      <table style="width:100%;border-collapse:separate;border-spacing:6px 0;"><tr>
        ${tile("Collected today", compactUGX(t.collected), `${num(t.payments)} payments`, "#109664")}
        ${tile("Expected today", compactUGX(t.expected), `${num(t.tenants)} active tenants`, "#6c21c4")}
        ${tile("Coverage", `${t.rate.toFixed(1)}%`, ratingOf(t.rate), t.rate >= 75 ? "#109664" : "#dc2626")}
        ${tile("Agents collecting", `${num(t.agentsCollecting)} / ${num(t.agents)}`, `${num(t.paid)} tenants paid`, "#0d9488")}
      </tr></table>
      <table style="width:100%;border-collapse:collapse;margin-top:18px;">
        <thead><tr>
          <th style="text-align:left;padding:8px 10px;font-size:12px;color:#666;text-transform:uppercase;">Agent</th>
          <th style="text-align:right;padding:8px 10px;font-size:12px;color:#666;text-transform:uppercase;">Tenants</th>
          <th style="text-align:right;padding:8px 10px;font-size:12px;color:#666;text-transform:uppercase;">Expected</th>
          <th style="text-align:right;padding:8px 10px;font-size:12px;color:#666;text-transform:uppercase;">Collected</th>
          <th style="text-align:right;padding:8px 10px;font-size:12px;color:#666;text-transform:uppercase;">Cov.</th>
        </tr></thead>
        <tbody>${body || `<tr><td colspan="5" style="padding:12px;font-size:13px;color:#777;">No active agent book for this day.</td></tr>`}</tbody>
      </table>
      <p style="font-size:13px;color:#555;line-height:1.6;margin-top:18px;">
        📎 <strong>Attached PDF</strong> — the full agent-by-agent register (all ${num(t.agents)} agents) with
        expected, collected, coverage, tenants paid, principal and outstanding.
      </p>
      <p style="font-size:12px;color:#777;line-height:1.6;">
        Same figures as Agent Ops → Daily PDF → <em>Today</em>. Collections are
        <strong>agent_collections</strong> rows logged inside the EAT day; expected is the sum of
        daily repayments on the active rent book.
      </p>
    </div>
    <div style="padding:14px 24px;background:#faf8fe;color:#777;font-size:11px;">Welile · automated Agent Ops brief</div>
  </div></body></html>`;
}

function buildText(t: Totals, prettyDate: string): string {
  return [
    `Agent daily performance (${prettyDate}, EAT)`,
    `Collected today: ${fmtUGX(t.collected)} from ${num(t.payments)} payments / ${num(t.paid)} tenants`,
    `Expected today: ${fmtUGX(t.expected)} across ${num(t.tenants)} active tenants`,
    `Coverage: ${t.rate.toFixed(1)}% (${ratingOf(t.rate)})`,
    `Agents collecting: ${num(t.agentsCollecting)} of ${num(t.agents)}`,
    `Outstanding book: ${fmtUGX(t.outstanding)}`,
    `Full agent-by-agent register attached as PDF.`,
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
): Promise<string> {
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

async function sendForDate(
  admin: Admin, dateStr: string, force: boolean, recipients: string[],
) {
  if (!force) {
    const { data: existing } = await admin
      .from("system_events").select("id").eq("event_type", EVENT_TYPE)
      .contains("metadata", { date: dateStr }).limit(1).maybeSingle();
    if (existing) return { date: dateStr, skipped: true, reason: "Already sent" };
  }

  const rows = await loadRows(admin, dateStr);
  const t = totalsOf(rows);
  const prettyDate = prettify(dateStr);
  const html = buildHtml(rows, t, prettyDate);
  const text = buildText(t, prettyDate);
  const pdf = buildPdf(rows, t, dateStr);
  const filename = `agent-daily-performance-${dateStr}.pdf`;
  const subject = `Agent daily performance - ${prettyDate}: ${fmtUGX(t.collected)} collected of ${fmtUGX(t.expected)} (${t.rate.toFixed(0)}%)`;

  const results: Record<string, string> = {};
  let usedQueue = false;
  for (const to of recipients) {
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
    metadata: {
      date: dateStr, recipients, results, pdf_bytes: pdf.length,
      totals: { ...t }, agents: rows.length,
    },
  });

  return { date: dateStr, recipients, results, pdf_bytes: pdf.length, usedQueue, totals: t, agents: rows.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    let body: any = {};
    try { body = await req.json(); } catch (_) { body = {}; }

    const dateStr = typeof body?.date === "string" && body.date ? body.date.slice(0, 10) : eatToday();
    const recipients = Array.isArray(body?.recipients) && body.recipients.length
      ? body.recipients.map((r: unknown) => String(r).trim()).filter(Boolean)
      : DEFAULT_RECIPIENTS;

    if (body?.pdf === true || body?.preview === true) {
      const rows = await loadRows(admin, dateStr);
      const t = totalsOf(rows);
      if (body?.pdf === true) {
        const pdf = buildPdf(rows, t, dateStr);
        return new Response(pdf as unknown as BodyInit, {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="agent-daily-performance-${dateStr}.pdf"`,
          },
        });
      }
      return new Response(buildHtml(rows, t, prettify(dateStr)), {
        headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const report = await sendForDate(admin, dateStr, body?.force === true, recipients);

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
