// Partner Ops — partnership operations report (branded PDF + HTML email).
//
// Metrics and charts only — no partner-level name tables. Supports daily,
// weekly, monthly and weekend windows.
//
// Options: { date, period: 'daily'|'weekly'|'monthly'|'weekend', start, end,
//            force, preview, pdf, to }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsPDF } from "https://esm.sh/jspdf@2.5.1";
import autoTable from "https://esm.sh/jspdf-autotable@3.8.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const REPORT_RECIPIENTS = [
  "Atuhairecarol78@gmail.com",
  "jlukodda@gmail.com",
  "lkabahyma2015@gmail.com",
  "benjamin@welile.com",
];
const FROM = "Welile Reports <info@welile.com>";
const SENDER_DOMAIN = "notify.welile.com";
const EVENT_TYPE = "partner_ops_daily_report";
const LABEL = "partner-ops-daily-report";
const LOGO_URL = "https://welileapp.com/welile-logo.png";
const COMPANY_LOCATION = "Welile Technologies Ltd - Kabaale Palm Lane, Uganda";

type Admin = ReturnType<typeof createClient>;
type RGB = [number, number, number];
type Period = "daily" | "weekly" | "monthly" | "weekend";

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
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function eatToday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isoDow(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=Sun
  return d === 0 ? 7 : d;
}
function prettify(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}
function shortDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

/** Resolve the reporting window for a period, anchored on `date` (EAT day). */
function resolveWindow(period: Period, date: string): { start: string; end: string; title: string; pretty: string } {
  if (period === "weekly") {
    const start = addDays(date, -6);
    return { start, end: date, title: "Weekly Report", pretty: `${shortDate(start)} - ${shortDate(date)}` };
  }
  if (period === "monthly") {
    const start = `${date.slice(0, 7)}-01`;
    return { start, end: date, title: "Monthly Report", pretty: `${shortDate(start)} - ${shortDate(date)}` };
  }
  if (period === "weekend") {
    // Most recent completed/ongoing Sat-Sun pair on or before `date`.
    const dow = isoDow(date);
    const sat = dow === 6 ? date : dow === 7 ? addDays(date, -1) : addDays(date, -(dow + 1));
    const sun = addDays(sat, 1);
    const end = sun > date ? date : sun;
    return { start: sat, end, title: "Weekend Report", pretty: `${shortDate(sat)} - ${shortDate(end)}` };
  }
  return { start: date, end: date, title: "Daily Report", pretty: prettify(date) };
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

// ── Report shape (metrics only) ──
interface Report {
  start_date: string;
  end_date: string;
  days: number;
  kpis: Record<string, number>;
  topups: Record<string, any>;
  promissory: Record<string, any>;
  backlog: Record<string, number>;
  series: any[];
  forecast: {
    days: any[];
    weekdays_total: number; weekdays_count: number;
    weekend_total: number; weekend_count: number;
  };
  mix: { by_mode: any[]; by_band: any[] };
}

async function loadReport(admin: Admin, start: string, end: string): Promise<Report> {
  const { data, error } = await admin.rpc("get_partner_ops_range_report", { p_start: start, p_end: end });
  if (error) throw new Error(`get_partner_ops_range_report failed: ${error.message}`);
  const r = (data || {}) as Report;
  r.kpis = r.kpis || {};
  r.topups = r.topups || {};
  r.promissory = r.promissory || {};
  r.backlog = r.backlog || ({} as any);
  r.series = r.series || [];
  r.forecast = r.forecast || { days: [], weekdays_total: 0, weekdays_count: 0, weekend_total: 0, weekend_count: 0 };
  r.forecast.days = r.forecast.days || [];
  r.mix = r.mix || { by_mode: [], by_band: [] };
  return r;
}

async function fetchLogo(): Promise<Uint8Array | null> {
  try {
    const res = await fetch(LOGO_URL);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (_e) {
    return null;
  }
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

// ── PDF — mirrors the emailed HTML brief layout exactly (tiles, numbered
//    sections, brief-styled tables, daily bar chart, footer) ──
function buildPdf(r: Report, win: { title: string; pretty: string }, logo: Uint8Array | null): Uint8Array {
  const k = r.kpis || ({} as Record<string, number>);
  const t = r.topups || {};
  const pn = r.promissory || {};
  const b = r.backlog || ({} as Record<string, number>);
  const f = r.forecast;
  const days = Math.max(1, Number(r.days) || 1);
  // Capital in = new portfolio capital + top-ups applied, all in the window. Cash only:
  // compounded returns never leave the business, so they are not capital in or out.
  const inflow = (Number(k.new_capital) || 0) + (Number(t.applied_amount) || 0);
  const outflow = Number(k.paid_out_amount) || 0;

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 14;
  const contentW = pageWidth - margin * 2;
  const bottomLimit = pageHeight - 16;
  const generatedAt = new Date();

  /** Table cell text: preserves blanks (unlike ascii(), which renders "-"). */
  const cell = (v: unknown) => (String(v ?? "").trim() === "" ? "" : ascii(v));

  const HERO_BG: RGB = [250, 248, 255];
  const HERO_BC: RGB = [236, 229, 251];
  const GOOD_BG: RGB = [241, 251, 246];
  const GOOD_BC: RGB = [201, 236, 219];
  const BAD_BG: RGB = [255, 245, 248];
  const BAD_BC: RGB = [246, 207, 224];
  const CARD_BC: RGB = [230, 225, 240];
  const ROW_LINE: RGB = [242, 239, 249];
  const BRIEF_PURPLE: RGB = [108, 33, 196];

  let y = margin;
  let sectionNo = 0;

  const newPage = () => {
    doc.addPage();
    y = margin;
  };
  const ensure = (h: number) => {
    if (y + h > bottomLimit) newPage();
  };

  // ── Header block (purple card, like the brief hero) ──
  const headerH = 34;
  doc.setFillColor(...BRIEF_PURPLE);
  doc.roundedRect(margin, y, contentW, headerH, 3.5, 3.5, "F");
  const textX = margin + 8;
  // Wordmark drawn as type: the PNG logo is dark purple and disappears on the
  // purple header band. `logo` stays in the signature for callers.
  void logo;
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("WELILE", textX, y + 6.6);
  doc.setFontSize(13.5);
  doc.text(`Partner Operations - ${ascii(win.title)}`, textX, y + 15);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(232, 220, 250);
  const sub = doc.splitTextToSize(
    `${ascii(win.pretty)} (EAT) - aggregate only, no partner names - source: Partner Ops book (portfolios, top-ups, compounding, promissory notes, returns ledger)`,
    contentW - (textX - margin) - 10,
  );
  doc.text(sub, textX, y + 21);
  doc.setFontSize(7.4);
  doc.text(
    `Generated ${generatedAt.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Nairobi" })} EAT`,
    textX, y + headerH - 5,
  );
  y += headerH + 6;

  // ── Section helper (white rounded card with number + title + note) ──
  type Tile = { label: string; value: string; sub: string; kind?: "hero" | "good" | "bad" };

  const drawSectionHead = (title: string, note: string) => {
    sectionNo += 1;
    ensure(26);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(154, 148, 171);
    doc.text(String(sectionNo), margin + 6, y + 9);
    doc.setTextColor(...BRIEF_PURPLE);
    doc.text(ascii(title).toUpperCase(), margin + 13, y + 9);
    let bottom = y + 12;
    if (note) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.8);
      doc.setTextColor(...MUTED);
      const lines = doc.splitTextToSize(ascii(note), contentW - 12);
      doc.text(lines, margin + 6, y + 14.5);
      bottom = y + 12.5 + lines.length * 3.4;
    }
    return bottom;
  };

  const drawTiles = (tiles: Tile[], startY: number): number => {
    const cols = 3;
    const gap = 4;
    const tw = (contentW - 12 - gap * (cols - 1)) / cols;
    const th = 20;
    let ty = startY + 2;
    tiles.forEach((tl, i) => {
      const col = i % cols;
      if (col === 0 && i > 0) ty += th + gap;
      const x = margin + 6 + col * (tw + gap);
      const bg = tl.kind === "good" ? GOOD_BG : tl.kind === "bad" ? BAD_BG : HERO_BG;
      const bc = tl.kind === "good" ? GOOD_BC : tl.kind === "bad" ? BAD_BC : HERO_BC;
      doc.setFillColor(...bg);
      doc.setDrawColor(...bc);
      doc.setLineWidth(0.2);
      doc.roundedRect(x, ty, tw, th, 2.5, 2.5, "FD");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6);
      doc.setTextColor(...MUTED);
      doc.text(ascii(tl.label).toUpperCase(), x + 3.5, ty + 5.4);
      doc.setFontSize(10.2);
      doc.setTextColor(...INK);
      doc.text(doc.splitTextToSize(ascii(tl.value), tw - 7)[0], x + 3.5, ty + 11.6);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.6);
      doc.setTextColor(...MUTED);
      const subLines = doc.splitTextToSize(ascii(tl.sub), tw - 7).slice(0, 2);
      doc.text(subLines, x + 3.5, ty + 16);
    });
    return ty + th;
  };

  const drawTable = (head: string[], rows: string[][], startY: number, foot?: string[]): number => {
    autoTable(doc, {
      startY: startY + 4,
      margin: { left: margin + 6, right: margin + 6 },
      head: [head.map(cell)],
      body: rows.map(r2 => r2.map(cell)),
      foot: foot ? [foot.map(cell)] : undefined,
      theme: "plain",
      styles: { font: "helvetica", fontSize: 7.6, cellPadding: { top: 2, bottom: 2, left: 2.4, right: 2.4 }, textColor: INK, lineWidth: 0 },
      headStyles: { fontStyle: "bold", fontSize: 6.4, textColor: MUTED, lineWidth: { bottom: 0.25 }, lineColor: CARD_BC },
      footStyles: { fontStyle: "bold", fontSize: 7.6, textColor: INK, lineWidth: { top: 0.25 }, lineColor: CARD_BC, fillColor: [255, 255, 255] },
      bodyStyles: { lineWidth: { bottom: 0.15 }, lineColor: ROW_LINE },
      columnStyles: { 0: { halign: "left" } },
      didParseCell: (data: any) => {
        if (data.column.index > 0) data.cell.styles.halign = "right";
      },
    });
    return (doc as any).lastAutoTable.finalY;
  };

  const drawNote = (txt: string, startY: number): number => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.4);
    doc.setTextColor(...MUTED);
    const lines = doc.splitTextToSize(ascii(txt), contentW - 12);
    ensure(lines.length * 3.4 + 6);
    doc.text(lines, margin + 6, startY + 5);
    return startY + 3 + lines.length * 3.4;
  };

  const finishSection = (endY: number) => {
    y = endY + 8;
  };

  // 1 — Headline
  {
    let cur = drawSectionHead(
      "Headline - the window",
      `Window is ${days} day${days === 1 ? "" : "s"} of EAT calendar activity. Capital in = top-ups applied that day + new portfolios created that day (cash only; compounded returns are shown separately).`,
    );
    cur = drawTiles([
      { label: "Capital live (close)", value: compactUGX(k.total_capital), sub: `${num(k.active_portfolios)} active portfolios` },
      { label: "Capital in (cash)", value: fmtUGX(inflow), sub: `${num(k.new_portfolios)} new - ${num(t.applied_count)} top-ups`, kind: "good" },
      { label: "Returns paid", value: fmtUGX(k.paid_out_amount), sub: `${num(k.paid_out_count)} credits`, kind: "good" },
      { label: "Compounded", value: fmtUGX(k.compounded_amount), sub: `${num(k.compounded_count)} portfolios (non-cash)` },
      { label: "Net capital movement", value: fmtUGX(inflow - outflow), sub: inflow - outflow >= 0 ? "net inflow" : "net outflow", kind: inflow - outflow >= 0 ? "good" : "bad" },
      { label: "Total promissory notes receivable", value: fmtUGX(pn.receivable_amount), sub: `${num(pn.total_count)} notes - ${num(pn.pending_count)} pending`, kind: "bad" },
    ], cur);
    finishSection(cur);
  }

  // 2 — Capital in + daily chart + movement table
  {
    let cur = drawSectionHead(
      "Capital in - new money and top-ups",
      "New portfolio capital and top-ups merged into existing portfolios. Compounded returns are shown for reference and are not counted as capital in.",
    );
    cur = drawTiles([
      { label: "New portfolio capital", value: fmtUGX(k.new_capital), sub: `${num(k.new_portfolios)} portfolios`, kind: "good" },
      { label: "Top-ups applied", value: fmtUGX(t.applied_amount), sub: `${num(t.applied_count)} top-ups`, kind: "good" },
      { label: "Compounded into principal", value: fmtUGX(k.compounded_amount), sub: `${num(k.compounded_count)} portfolios` },
    ], cur);

    // Daily bar chart — capital in vs returns paid (cash)
    const series = r.series || [];
    if (series.length) {
      const chartH = 34;
      ensure(chartH + 22);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...INK);
      doc.text("Daily capital in vs returns paid", margin + 6, cur + 8);
      const baseY = cur + 12 + chartH;
      const maxSeries = Math.max(
        1,
        ...series.map((s: any) => Math.max(
          (Number(s.new_capital) || 0) + (Number(s.topups_applied) || 0),
          (Number(s.paid_out) || 0),
        )),
      );
      const slot = (contentW - 12) / series.length;
      series.forEach((s: any, i: number) => {
        const cin = (Number(s.new_capital) || 0) + (Number(s.topups_applied) || 0);
        const cout = (Number(s.paid_out) || 0);
        const h = (v: number) => Math.max(v > 0 ? 1 : 0, (v / maxSeries) * chartH);
        const cx = margin + 6 + i * slot + slot / 2;
        const bw = Math.min(4, slot / 3);
        doc.setFillColor(...EMERALD);
        doc.rect(cx - bw - 0.6, baseY - h(cin), bw, h(cin), "F");
        doc.setFillColor(...ROSE);
        doc.rect(cx + 0.6, baseY - h(cout), bw, h(cout), "F");
        doc.setFont("helvetica", "normal");
        doc.setFontSize(5.6);
        doc.setTextColor(...MUTED);
        doc.text(compactUGX(Math.max(cin, cout)), cx, baseY + 3, { align: "center" });
        doc.setTextColor(...(s.is_weekend ? AMBER : MUTED));
        doc.text(ascii(s.label), cx, baseY + 6, { align: "center" });
      });
      doc.setDrawColor(...CARD_BC);
      doc.setLineWidth(0.2);
      doc.line(margin + 6, baseY, pageWidth - margin - 6, baseY);
      doc.setFontSize(6.4);
      doc.setTextColor(...EMERALD);
      doc.text("capital in", margin + 6, baseY + 11);
      doc.setTextColor(...ROSE);
      doc.text("returns paid", margin + 28, baseY + 11);
      doc.setTextColor(...MUTED);
      doc.text(`peak ${compactUGX(maxSeries)}`, margin + 58, baseY + 11);
      cur = baseY + 12;
    }

    cur = drawTable(["Movement", "Count", "Volume"], [
      ["New portfolio capital", num(k.new_portfolios), fmtUGX(k.new_capital)],
      ["Top-ups applied", num(t.applied_count), fmtUGX(t.applied_amount)],
      ["Renewals", num(k.renewals_count), fmtUGX(k.renewals_topup_amount)],
    ], cur, ["Capital in", "", fmtUGX(inflow)]);

    if ((r.series || []).length) {
      cur = drawTable(
        ["Day", "New capital", "Top-ups applied", "Returns paid", "Compounded"],
        (r.series || []).map((s: any) => [
          ascii(s.label),
          fmtUGX(s.new_capital),
          fmtUGX(s.topups_applied),
          fmtUGX(s.paid_out),
          fmtUGX(s.compounded),
        ]),
        cur,
        ["Window total", fmtUGX(k.new_capital), fmtUGX(t.applied_amount), fmtUGX(k.paid_out_amount), fmtUGX(k.compounded_amount)],
      );
    }
    finishSection(cur);
  }

  // 3 — Returns
  {
    let cur = drawSectionHead(
      "Returns - paid and compounded",
      "Returns settled in the window split between cash credited to partner wallets and returns reinvested into principal.",
    );
    cur = drawTiles([
      { label: "Paid in cash to wallets", value: fmtUGX(k.paid_out_amount), sub: `${num(k.paid_out_count)} credits`, kind: "good" },
      { label: "Compounded (non-cash)", value: fmtUGX(k.compounded_amount), sub: `${num(k.compounded_count)} portfolios` },
      { label: "Returns settled", value: fmtUGX(Number(k.paid_out_amount) + Number(k.compounded_amount)), sub: "cash plus compounded" },
    ], cur);
    cur = drawTable(["Reconciliation", "Count", "Volume"], [
      ["Credited to partner wallets", num(k.paid_out_count), fmtUGX(k.paid_out_amount)],
      ["Compounded into principal", num(k.compounded_count), fmtUGX(k.compounded_amount)],
    ], cur, ["Returns settled", "", fmtUGX(Number(k.paid_out_amount) + Number(k.compounded_amount))]);
    cur = drawNote("Compounded returns add to capital live but never to capital in or capital out - they never leave the business.", cur);
    finishSection(cur);
  }

  // 4 — Forecast
  {
    let cur = drawSectionHead(
      "Returns forecast - next 7 days",
      "Active portfolios whose next payout date falls in the coming week, valued at principal times monthly rate.",
    );
    cur = drawTiles([
      { label: "Working days (Mon-Fri)", value: fmtUGX(f.weekdays_total), sub: `${num(f.weekdays_count)} portfolios due` },
      { label: "Weekend (Sat-Sun)", value: fmtUGX(f.weekend_total), sub: `${num(f.weekend_count)} portfolios due` },
      { label: "Total due", value: fmtUGX(Number(f.weekdays_total) + Number(f.weekend_total)), sub: `${num(Number(f.weekdays_count) + Number(f.weekend_count))} portfolios`, kind: "bad" },
    ], cur);
    const forecastRows = (f.days || []).map((d: any) => [
      ascii(d.label ?? d.date),
      num(d.portfolios ?? d.count),
      fmtUGX(Number(d.total_amount ?? d.cash_due ?? d.amount ?? 0)),
    ]);
    if (forecastRows.length) cur = drawTable(["Day", "Portfolios due", "Cash due"], forecastRows, cur);
    finishSection(cur);
  }

  // 5 — Portfolio mix
  {
    const modeRows = (r.mix?.by_mode || []).map((m: any) => [ascii(m.label ?? m.mode), num(m.portfolios ?? m.count), fmtUGX(m.amount ?? m.volume)]);
    const bandRows = (r.mix?.by_band || []).map((m: any) => [ascii(m.label ?? m.band), num(m.portfolios ?? m.count), fmtUGX(m.amount ?? m.volume)]);
    if (modeRows.length || bandRows.length) {
      let cur = drawSectionHead("Portfolio mix", "Book composition by payout mode and ticket size at window close.");
      if (modeRows.length) cur = drawTable(["Payout mode", "Portfolios", "Volume"], modeRows, cur);
      if (bandRows.length) cur = drawTable(["Ticket band", "Portfolios", "Volume"], bandRows, cur);
      finishSection(cur);
    }
  }

  // 6 — Promissory notes
  {
    let cur = drawSectionHead(
      "Promissory notes",
      "Signed partner commitments straight from the promissory notes book. Pending notes are commitments, not capital - they are excluded from capital live and from capital in until activated.",
    );
    cur = drawTiles([
      { label: `Created (${days === 1 ? "this day" : "this window"})`, value: fmtUGX(pn.created_amount), sub: `${num(pn.created_count)} notes`, kind: "good" },
      { label: "Pending", value: fmtUGX(pn.pending_amount), sub: `${num(pn.pending_count)} notes - oldest ${num(pn.pending_oldest_days)}d`, kind: "bad" },
      { label: "Activated (all time)", value: fmtUGX(pn.activated_amount), sub: `${num(pn.activated_count)} notes - oldest ${num(pn.activated_oldest_days)}d`, kind: "good" },
      { label: "Conversion rate", value: `${Number(pn.conversion_rate ?? 0)}%`, sub: "activated / all notes" },
      { label: "Total receivable", value: fmtUGX(pn.receivable_amount), sub: "pending plus activated, net of collections", kind: "bad" },
      { label: "Collected to date", value: fmtUGX(pn.collected_amount), sub: `${num(pn.total_count)} notes on the book`, kind: "good" },
    ], cur);
    const statusRows = ((pn.by_status || []) as any[]).map((s) => [
      ascii(String(s.status || "").replace(/^./, (c: string) => c.toUpperCase())),
      num(s.count),
      fmtUGX(s.amount),
      `${num(s.oldest_days)}d`,
    ]);
    if (statusRows.length) {
      cur = drawTable(
        ["Status", "Notes", "Committed volume", "Oldest"],
        statusRows,
        cur,
        ["Total", num(pn.total_count), fmtUGX(pn.total_amount), ""],
      );
    }
    finishSection(cur);
  }

  // 7 — Watchlist
  {
    const watch: string[] = [];
    if (Number(pn.pending_amount) > 0) watch.push(`Promissory notes pending activation: ${num(pn.pending_count)} - ${fmtUGX(pn.pending_amount)} (oldest ${num(pn.pending_oldest_days)} days)`);
    if (Number(b.pending_portfolios_count) > 0) watch.push(`Portfolios awaiting ops approval: ${num(b.pending_portfolios_count)} - ${fmtUGX(b.pending_portfolios_amount)}`);
    if (Number(k.renewals_count) > 0) watch.push(`Renewals in the window: ${num(k.renewals_count)} - ${fmtUGX(k.renewals_topup_amount)}`);
    if (Number(f.weekdays_total) + Number(f.weekend_total) > outflow) {
      watch.push(`Next 7 days of returns (${fmtUGX(Number(f.weekdays_total) + Number(f.weekend_total))}) exceed the returns paid this window (${fmtUGX(outflow)}) - cover must come from new capital`);
    }
    if (!watch.length) watch.push("No open exceptions - backlog, approvals and forecast cover are all clean.");

    let cur = drawSectionHead("Watchlist", "Only items needing action are listed. Clean areas are omitted rather than printed as zeros.");
    watch.forEach((w) => {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.6);
      const lines = doc.splitTextToSize(ascii(w), contentW - 24);
      const h = Math.max(8, lines.length * 3.6 + 4.5);
      if (cur + h + 6 > bottomLimit) { newPage(); cur = y; }
      doc.setFillColor(255, 253, 245);
      doc.setDrawColor(...AMBER);
      doc.rect(margin + 6, cur + 4, contentW - 12, h, "F");
      doc.setFillColor(...AMBER);
      doc.rect(margin + 6, cur + 4, 1.1, h, "F");
      doc.setTextColor(...INK);
      doc.text(lines, margin + 11, cur + 9.5);
      cur += h + 2.5;
    });
    finishSection(cur);
  }

  // ── Footer on every page ──
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setDrawColor(...CARD_BC);
    doc.setLineWidth(0.2);
    doc.line(margin, pageHeight - 11, pageWidth - margin, pageHeight - 11);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.6);
    doc.setTextColor(...MUTED);
    doc.text(
      `${COMPANY_LOCATION} - window ${ascii(win.pretty)} (EAT). Figures in UGX.`,
      margin, pageHeight - 6.5,
    );
    doc.text(`Page ${p} / ${pageCount}`, pageWidth - margin, pageHeight - 6.5, { align: "right" });
  }

  return new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
}

// ── Email HTML (metrics only) ──
// ── HTML email — same layout language as the printed Partner Ops brief ──
function buildHtml(r: Report, win: { title: string; pretty: string }): string {
  const k = r.kpis || ({} as Record<string, number>);
  const t = r.topups || {};
  const pn = r.promissory || {};
  const b = r.backlog || ({} as Record<string, number>);
  const f = r.forecast;
  const days = Math.max(1, Number(r.days) || 1);
  const inflow = (Number(k.new_capital) || 0) + (Number(t.applied_amount) || 0);
  const outflow = Number(k.paid_out_amount) || 0;

  const tile = (label: string, value: string, sub: string, kind: "hero" | "good" | "bad" = "hero") => {
    const bg = kind === "good" ? "#f1fbf6" : kind === "bad" ? "#fff5f8" : "#faf8ff";
    const bc = kind === "good" ? "#c9ecdb" : kind === "bad" ? "#f6cfe0" : "#ece5fb";
    return `<td class="tile" width="33%" style="width:33.33%;padding:0 4px 8px 4px;vertical-align:top">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${bg};border:1px solid ${bc};border-radius:12px;">
        <tr><td style="padding:12px 14px">
          <div style="font-size:10px;color:#787484;text-transform:uppercase;font-weight:700;letter-spacing:.4px">${esc(label)}</div>
          <div class="tile-val" style="font-size:19px;font-weight:800;color:#1e1b2e;margin-top:4px;line-height:1.2">${esc(value)}</div>
          <div style="font-size:11px;color:#787484;margin-top:3px;line-height:1.4">${esc(sub)}</div>
        </td></tr>
      </table>
    </td>`;
  };
  const tiles = (cells: string[]) => {
    const rows: string[] = [];
    for (let i = 0; i < cells.length; i += 3) {
      const grp = cells.slice(i, i + 3);
      while (grp.length < 3) grp.push('<td width="33%" style="width:33.33%"></td>');
      rows.push(`<tr>${grp.join("")}</tr>`);
    }
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;table-layout:fixed;margin-top:10px">${rows.join("")}</table>`;
  };
  let sectionNo = 0;
  const section = (title: string, note: string, inner: string) => {
    sectionNo += 1;
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fff;border:1px solid #e6e1f0;border-radius:14px;margin-top:16px;border-collapse:separate">
      <tr><td class="pad" style="padding:18px 20px">
        <div style="font-size:13px;font-weight:800;color:${PURPLE};text-transform:uppercase;letter-spacing:.4px">
          <span style="color:#9a94ab">${sectionNo}</span>&nbsp;&nbsp;${esc(title)}
        </div>
        ${note ? `<div style="font-size:12px;color:#787484;margin-top:6px;line-height:1.5">${esc(note)}</div>` : ""}
        ${inner}
      </td></tr>
    </table>`;
  };
  const dataTable = (head: string[], rows: string[][], foot?: string[]) => {
    const th = head.map((h, i) => `<th style="text-align:${i === 0 ? "left" : "right"};padding:7px 8px;font-size:10.5px;color:#787484;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #e6e1f0">${esc(h)}</th>`).join("");
    const tb = rows.map(cells => `<tr>${cells.map((c, i) => `<td style="padding:7px 8px;font-size:12.5px;color:#1e1b2e;text-align:${i === 0 ? "left" : "right"};border-bottom:1px solid #f2eff9;white-space:${i === 0 ? "normal" : "nowrap"}">${esc(c)}</td>`).join("")}</tr>`).join("");
    const tf = foot ? `<tr>${foot.map((c, i) => `<td style="padding:8px;font-size:12.5px;font-weight:800;color:#1e1b2e;text-align:${i === 0 ? "left" : "right"};border-top:1px solid #e6e1f0;white-space:nowrap">${esc(c)}</td>`).join("")}</tr>` : "";
    return `<table class="data" role="presentation" width="100%" style="width:100%;border-collapse:collapse;margin-top:12px"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody>${tf ? `<tfoot>${tf}</tfoot>` : ""}</table>`;
  };
  const note = (txt: string) => `<div style="font-size:11.5px;color:#787484;margin-top:10px;line-height:1.55">${esc(txt)}</div>`;

  // Daily chart — capital in vs returns paid (cash)
  const maxSeries = Math.max(
    1,
    ...r.series.map((s: any) => Math.max(
      (Number(s.new_capital) || 0) + (Number(s.topups_applied) || 0),
      (Number(s.paid_out) || 0),
    )),
  );
  const bars = r.series.map((s: any) => {
    const cin = (Number(s.new_capital) || 0) + (Number(s.topups_applied) || 0);
    const cout = (Number(s.paid_out) || 0);
    const h = (v: number) => Math.max(v > 0 ? 3 : 0, Math.round((v / maxSeries) * 92));
    return `<td style="vertical-align:bottom;text-align:center;padding:0 2px">
      <div style="height:100px;font-size:0;line-height:0">
        <div style="display:inline-block;width:9px;height:${h(cin)}px;background:#0f9664;vertical-align:bottom;border-radius:3px 3px 0 0"></div>
        <div style="display:inline-block;width:9px;height:${h(cout)}px;background:#db2777;vertical-align:bottom;border-radius:3px 3px 0 0"></div>
      </div>
      <div style="font-size:9.5px;color:#787484;margin-top:5px">${esc(compactUGX(Math.max(cin, cout)))}</div>
      <div style="font-size:9.5px;color:${s.is_weekend ? "#b45309" : "#787484"};margin-top:2px">${esc(ascii(s.label))}</div>
    </td>`;
  }).join("");

  const modeRows = (r.mix?.by_mode || []).map((m: any) => [ascii(m.label ?? m.mode), num(m.portfolios ?? m.count), fmtUGX(m.amount ?? m.volume)]);
  const bandRows = (r.mix?.by_band || []).map((m: any) => [ascii(m.label ?? m.band), num(m.portfolios ?? m.count), fmtUGX(m.amount ?? m.volume)]);
  const forecastRows = (f.days || []).map((d: any) => [
    ascii(d.label ?? d.date),
    num(d.portfolios ?? d.count),
    fmtUGX(Number(d.total_amount ?? d.cash_due ?? d.amount ?? 0)),
  ]);

  const watch: string[] = [];
  if (Number(pn.pending_amount) > 0) watch.push(`Promissory notes pending activation: ${num(pn.pending_count)} - ${fmtUGX(pn.pending_amount)} (oldest ${num(pn.pending_oldest_days)} days)`);
  if (Number(b.pending_portfolios_count) > 0) watch.push(`Portfolios awaiting ops approval: ${num(b.pending_portfolios_count)} - ${fmtUGX(b.pending_portfolios_amount)}`);
  if (Number(k.renewals_count) > 0) watch.push(`Renewals in the window: ${num(k.renewals_count)} - ${fmtUGX(k.renewals_topup_amount)}`);
  if (Number(f.weekdays_total) + Number(f.weekend_total) > outflow) watch.push(`Next 7 days of returns (${fmtUGX(Number(f.weekdays_total) + Number(f.weekend_total))}) exceed the returns paid this window (${fmtUGX(outflow)}) - cover must come from new capital`);
  if (!watch.length) watch.push("No open exceptions - backlog, approvals and forecast cover are all clean.");

  return `<!DOCTYPE html><html><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(`Partner Operations - ${win.title} - ${win.pretty}`)}</title>
  <style type="text/css">
    @media only screen and (max-width:600px) {
      .wrap { padding: 10px !important; }
      .pad { padding: 14px 12px !important; }
      .tile { display:block !important; width:100% !important; max-width:100% !important; }
      .tile-val { font-size: 17px !important; }
      table.data td, table.data th { padding: 6px 5px !important; font-size: 11.5px !important; }
    }
  </style>
</head><body style="margin:0;padding:0;background:#f6f4fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1e1b2e">
  <div class="wrap" style="padding:20px">
  <div style="max-width:700px;margin:0 auto">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:${PURPLE};border-radius:14px">
      <tr><td class="pad" style="padding:22px 24px">
        <img src="${LOGO_URL}" alt="Welile" width="104" style="display:block;max-width:104px;height:auto;margin-bottom:10px" />
        <div style="color:#fff;font-size:19px;font-weight:800;letter-spacing:-.3px">Partner Operations - ${esc(win.title)}</div>
        <div style="color:#e8dcfa;font-size:12.5px;margin-top:6px;line-height:1.5">
          ${esc(win.pretty)} (EAT) · aggregate only, no partner names · source: Partner Ops book (portfolios, top-ups, compounding, promissory notes, returns ledger)
        </div>
      </td></tr>
    </table>

    ${section("Headline - the window", `Window is ${days} day${days === 1 ? "" : "s"} of EAT calendar activity. Capital in = top-ups applied that day + new portfolios created that day (cash only; compounded returns are shown separately).`, tiles([
      tile("Capital live (close)", compactUGX(k.total_capital), `${num(k.active_portfolios)} active portfolios`),
      tile("Capital in (cash)", fmtUGX(inflow), `${num(k.new_portfolios)} new · ${num(t.applied_count)} top-ups`, "good"),
      tile("Returns paid", fmtUGX(k.paid_out_amount), `${num(k.paid_out_count)} credits`, "good"),
      tile("Compounded", fmtUGX(k.compounded_amount), `${num(k.compounded_count)} portfolios (non-cash)`),
      tile("Net capital movement", fmtUGX(inflow - outflow), inflow - outflow >= 0 ? "net inflow" : "net outflow", inflow - outflow >= 0 ? "good" : "bad"),
      tile("Total promissory notes receivable", fmtUGX(pn.receivable_amount), `${num(pn.total_count)} notes · ${num(pn.pending_count)} pending`, "bad"),
    ]))}

    ${section("Capital in - new money and top-ups", "New portfolio capital and top-ups merged into existing portfolios. Compounded returns are shown for reference and are not counted as capital in.", tiles([
      tile("New portfolio capital", fmtUGX(k.new_capital), `${num(k.new_portfolios)} portfolios`, "good"),
      tile("Top-ups applied", fmtUGX(t.applied_amount), `${num(t.applied_count)} top-ups`, "good"),
      tile("Compounded into principal", fmtUGX(k.compounded_amount), `${num(k.compounded_count)} portfolios`),
    ]) + `<div style="font-size:12px;font-weight:700;color:#1e1b2e;margin-top:16px">Daily capital in vs returns paid</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:8px"><tr>${bars}</tr></table>
      <div style="font-size:11px;color:#787484;margin-top:8px">
        <span style="color:#0f9664;font-weight:800">&#9632;</span> capital in &nbsp;
        <span style="color:#db2777;font-weight:800">&#9632;</span> returns paid &nbsp;· peak ${esc(compactUGX(maxSeries))}
      </div>` + dataTable(["Movement", "Count", "Volume"], [
        ["New portfolio capital", num(k.new_portfolios), fmtUGX(k.new_capital)],
        ["Top-ups applied", num(t.applied_count), fmtUGX(t.applied_amount)],
        ["Renewals", num(k.renewals_count), fmtUGX(k.renewals_topup_amount)],
      ], ["Capital in", "", fmtUGX(inflow)]))}

    ${section("Returns - paid and compounded", "Returns settled in the window split between cash credited to partner wallets and returns reinvested into principal.", tiles([
      tile("Paid in cash to wallets", fmtUGX(k.paid_out_amount), `${num(k.paid_out_count)} credits`, "good"),
      tile("Compounded (non-cash)", fmtUGX(k.compounded_amount), `${num(k.compounded_count)} portfolios`),
      tile("Returns settled", fmtUGX(Number(k.paid_out_amount) + Number(k.compounded_amount)), "cash plus compounded"),
    ]) + note("Compounded returns add to capital live but never to capital in or capital out - they never leave the business."))}

    ${section("Returns forecast - next 7 days", "Active portfolios whose next payout date falls in the coming week, valued at principal times monthly rate.", tiles([
      tile("Working days (Mon-Fri)", fmtUGX(f.weekdays_total), `${num(f.weekdays_count)} portfolios due`),
      tile("Weekend (Sat-Sun)", fmtUGX(f.weekend_total), `${num(f.weekend_count)} portfolios due`),
      tile("Total due", fmtUGX(Number(f.weekdays_total) + Number(f.weekend_total)), `${num(Number(f.weekdays_count) + Number(f.weekend_count))} portfolios`, "bad"),
    ]) + (forecastRows.length ? dataTable(["Day", "Portfolios due", "Cash due"], forecastRows) : ""))}

    ${(modeRows.length || bandRows.length) ? section("Portfolio mix", "Book composition by payout mode and ticket size at window close.",
      (modeRows.length ? dataTable(["Payout mode", "Portfolios", "Volume"], modeRows) : "") +
      (bandRows.length ? dataTable(["Ticket band", "Portfolios", "Volume"], bandRows) : "")) : ""}

    ${section("Promissory notes", "Signed partner commitments straight from the promissory notes book. Pending notes are commitments, not capital - they are excluded from capital live and from capital in until activated.", tiles([
      tile(`Created (${days === 1 ? "this day" : "this window"})`, fmtUGX(pn.created_amount), `${num(pn.created_count)} notes`, "good"),
      tile("Pending", fmtUGX(pn.pending_amount), `${num(pn.pending_count)} notes · oldest ${num(pn.pending_oldest_days)}d`, "bad"),
      tile("Activated (all time)", fmtUGX(pn.activated_amount), `${num(pn.activated_count)} notes · oldest ${num(pn.activated_oldest_days)}d`, "good"),
      tile("Conversion rate", `${Number(pn.conversion_rate ?? 0)}%`, "activated / all notes"),
      tile("Total receivable", fmtUGX(pn.receivable_amount), "pending plus activated, net of collections", "bad"),
      tile("Collected to date", fmtUGX(pn.collected_amount), `${num(pn.total_count)} notes on the book`, "good"),
    ]) + (((pn.by_status || []) as any[]).length
      ? dataTable(
          ["Status", "Notes", "Committed volume", "Oldest"],
          ((pn.by_status || []) as any[]).map((s) => [
            ascii(String(s.status || "").replace(/^./, (c: string) => c.toUpperCase())),
            num(s.count),
            fmtUGX(s.amount),
            `${num(s.oldest_days)}d`,
          ]),
          ["Total", num(pn.total_count), fmtUGX(pn.total_amount), ""],
        )
      : ""))}

    ${section("Watchlist", "Only items needing action are listed. Clean areas are omitted rather than printed as zeros.",
      watch.map(w => `<div style="border-left:3px solid #b45309;background:#fffdf5;border-radius:0 8px 8px 0;padding:9px 12px;margin-top:8px;font-size:12.5px;color:#1e1b2e">${esc(w)}</div>`).join(""))}

    <div style="padding:16px 6px;color:#787484;font-size:11px;text-align:center;line-height:1.6">
      ${esc(COMPANY_LOCATION)} · window ${esc(win.pretty)} (EAT), aggregated from the Partner Ops book at generation time.
      Figures in UGX. Ledger reads exclude admin corrections and system balance corrections. The attached PDF carries the same metrics with print charts.
    </div>
  </div></div></body></html>`;
}

function buildText(r: Report, win: { title: string; pretty: string }): string {
  const k = r.kpis || ({} as Record<string, number>);
  const t = r.topups || {};
  const pn = r.promissory || {};
  return [
    `Partner Operations - ${win.title} (${win.pretty})`,
    `Capital live: ${fmtUGX(k.total_capital)} across ${num(k.active_portfolios)} active portfolios`,
    `New capital: ${fmtUGX(k.new_capital)} (${num(k.new_portfolios)} portfolios)`,
    `Returns paid: ${fmtUGX(k.paid_out_amount)} - compounded: ${fmtUGX(k.compounded_amount)}`,
    `Top-ups applied: ${fmtUGX(t.applied_amount)}`,
    `Promissory notes receivable: ${fmtUGX(pn.receivable_amount)} (${num(pn.total_count)} notes, ${num(pn.pending_count)} pending)`,
    `Forecast Mon-Fri: ${fmtUGX(r.forecast.weekdays_total)} - weekend: ${fmtUGX(r.forecast.weekend_total)}`,
    `Full metrics report attached as PDF.`,
  ].join("\n");
}
// ── Gmail attachment delivery ──
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

async function sendForPeriod(
  admin: Admin, period: Period, dateStr: string, force: boolean, overrideTo?: string[],
) {
  const recipients = overrideTo && overrideTo.length ? overrideTo : REPORT_RECIPIENTS;
  const win = resolveWindow(period, dateStr);
  if (!force) {
    const { data: existing } = await admin
      .from("system_events").select("id").eq("event_type", EVENT_TYPE)
      .contains("metadata", { date: dateStr, period }).limit(1).maybeSingle();
    if (existing) return { date: dateStr, period, skipped: true, reason: "Already sent" };
  }

  const report = await loadReport(admin, win.start, win.end);
  const logo = await fetchLogo();
  const html = buildHtml(report, win);
  const text = buildText(report, win);
  const pdf = buildPdf(report, win, logo);
  const filename = `Welile_Partner_Ops_${period}_${win.start}_${win.end}.pdf`;
  const k = report.kpis || ({} as Record<string, number>);
  const subject = `Partner Ops ${win.title} - ${win.pretty}: ${compactUGX(k.total_capital)} live, ${fmtUGX(k.paid_out_amount)} returns paid`;

  const results: Record<string, string> = {};
  let usedQueue = false;
  for (const to of recipients) {
    const sent = await sendWithAttachment(to, subject, html, text, pdf, filename);
    if (sent.ok) {
      results[to] = "sent with PDF";
    } else {
      console.error(`[${LABEL}] gmail send failed`, to, sent.status, sent.raw);
      usedQueue = true;
      results[to] = await queueFallback(admin, to, subject, html, text, `${period}:${dateStr}`, force);
    }
  }

  await admin.from("system_events").insert({
    event_type: EVENT_TYPE,
    metadata: { date: dateStr, period, window: { start: win.start, end: win.end }, recipients, kpis: report.kpis, results, pdf_bytes: pdf.length },
  });

  return { date: dateStr, period, window: win, recipients, results, pdf_bytes: pdf.length, usedQueue, kpis: report.kpis };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    let body: any = {};
    try { body = await req.json(); } catch (_) { body = {}; }

    const dateStr = typeof body?.date === "string" && body.date ? body.date.slice(0, 10) : eatToday();
    const period: Period = ["daily", "weekly", "monthly", "weekend"].includes(body?.period)
      ? body.period as Period
      : "daily";
    const win = resolveWindow(period, dateStr);
    const start = typeof body?.start === "string" && body.start ? body.start.slice(0, 10) : win.start;
    const end = typeof body?.end === "string" && body.end ? body.end.slice(0, 10) : win.end;
    const customWin = { ...win, pretty: start === end ? prettify(start) : `${shortDate(start)} - ${shortDate(end)}` };

    if (body?.pdf === true) {
      const report = await loadReport(admin, start, end);
      const pdf = buildPdf(report, customWin, await fetchLogo());
      return new Response(pdf, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="Welile_Partner_Ops_${period}_${start}_${end}.pdf"`,
        },
      });
    }

    if (body?.preview === true) {
      const report = await loadReport(admin, start, end);
      return new Response(buildHtml(report, customWin), {
        headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const overrideTo = Array.isArray(body?.to)
      ? body.to.filter((x: unknown) => typeof x === "string" && x.includes("@"))
      : typeof body?.to === "string" && body.to.includes("@")
        ? [body.to]
        : undefined;

    const report = await sendForPeriod(admin, period, dateStr, body?.force === true, overrideTo);

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
