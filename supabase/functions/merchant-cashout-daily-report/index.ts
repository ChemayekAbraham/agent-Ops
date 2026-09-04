// Daily report of INDIVIDUAL merchant (cash-out) agent payouts.
//
// Scheduled at 00:00 EAT (21:00 UTC) via pg_cron for the completed previous
// EAT day. Figures come straight from
// the immutable general_ledger through the SECURITY DEFINER RPC
// `generate_merchant_cashout_daily_report`, so totals are accurate and match
// what merchants actually settled during the day.
//
// The rendered report (per-merchant summary + per-payout detail) is emailed to
// the fixed ops recipients below via the existing Lovable email queue
// (enqueue_email -> process-email-queue -> sendLovableEmail).
//
// Idempotent per EAT day via a `merchant_cashout_daily_report` system_event.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Fixed recipients for the operational report.
const REPORT_RECIPIENTS = ["benjamin@welile.com", "joshwanda17@gmail.com", "benjaminmuhanguzi29@gmail.com"];

// Email sender identity (matches send-transactional-email scaffold).
const FROM = "Welile Reports <info@welile.com>";
const SENDER_DOMAIN = "notify.welile.com";

function fmtUGX(n: number): string {
  return `UGX ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
}

// Generate a cryptographically random 32-byte hex token.
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Ensure an unsubscribe token exists for a recipient (the email API requires
// one on transactional sends). Upsert-then-read handles concurrent inserts.
async function ensureUnsubscribeToken(
  admin: any,
  email: string,
): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const { data: existing } = await admin
    .from("email_unsubscribe_tokens")
    .select("token")
    .eq("email", normalized)
    .maybeSingle();
  if (existing?.token) return existing.token as string;

  const token = generateToken();
  await admin
    .from("email_unsubscribe_tokens")
    .upsert({ token, email: normalized }, { onConflict: "email", ignoreDuplicates: true });
  const { data: stored } = await admin
    .from("email_unsubscribe_tokens")
    .select("token")
    .eq("email", normalized)
    .maybeSingle();
  return (stored?.token as string) || token;
}

// Calendar date in East Africa Time (UTC+3, no DST), offset by whole days.
function eatDate(daysOffset = 0): string {
  const eat = new Date(Date.now() + (3 * 60 * 60 + daysOffset * 24 * 60 * 60) * 1000);
  return eat.toISOString().slice(0, 10);
}

function defaultReportDate(): string {
  return eatDate(-1);
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface SummaryRow {
  agent_id: string;
  merchant_name: string;
  merchant_phone: string | null;
  payouts: number;
  total_paid: number;
  total_commission: number;
  total_telecom?: number;
  total_float_consumed?: number;
}
interface DetailRow {
  time: string;
  merchant_name: string;
  merchant_phone: string | null;
  customer_name: string | null;
  amount: number;
  commission: number;
  telecom_charge?: number;
  float_consumed?: number;
  payout_method: string | null;
  withdrawal_id: string;
  settlement_status?: string;
  request_status?: string | null;
  settlement_state?: string | null;
  missing_legs?: string[] | null;
  has_customer_debit?: boolean;
}

function buildHtml(report: any, prettyDate: string): string {
  const summary: SummaryRow[] = report.summary || [];
  const detail: DetailRow[] = report.detail || [];
  const byCategory: Array<{
    category_id: string;
    category_label: string;
    merchant_count: number;
    payouts: number;
    total_paid: number;
    total_commission: number;
    total_telecom: number;
    total_float_consumed: number;
  }> = report.by_category || [];
  const roi = report.roi || { total_paid: 0, total_reinvested: 0, payout_count: 0, recipient_count: 0, recipients: [] };
  const roiRecipients: Array<{ recipient_name: string; recipient_phone: string | null; payouts: number; total_paid: number }> =
    roi.recipients || [];
  const byStatus: Array<{
    settlement_status: string;
    status_label: string;
    payouts: number;
    total_amount: number;
    total_commission: number;
    total_telecom: number;
  }> = report.by_settlement_status || [];
  const exceptions: Array<any> = report.exceptions || [];
  const statusTone = (s: string): { bg: string; fg: string } => {
    switch (s) {
      case "fully_settled": return { bg: "#ecfdf5", fg: "#0f766e" };
      case "reconciled": return { bg: "#eff6ff", fg: "#1d4ed8" };
      case "partially_settled": return { bg: "#fff7ed", fg: "#b45309" };
      case "unsettled": return { bg: "#fef2f2", fg: "#b91c1c" };
      case "failed": return { bg: "#fef2f2", fg: "#7f1d1d" };
      default: return { bg: "#f5f3ff", fg: "#6c21c4" };
    }
  };
  const statusLabel = (s?: string) =>
    ({
      fully_settled: "Fully settled",
      partially_settled: "Partially settled",
      unsettled: "Unsettled",
      failed: "Failed",
      reconciled: "Reconciled",
      exception: "Exception",
    } as Record<string, string>)[s || ""] || "Exception";
  const statusPill = (s?: string) => {
    const t = statusTone(s || "exception");
    return `<span style="display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:${t.bg};color:${t.fg};">${esc(statusLabel(s))}</span>`;
  };

  // Summary metric tile — half-width on mobile via inline-block, still stacks
  // gracefully in email clients that ignore media queries.
  const metric = (label: string, value: string, accent = "#1a1a2e", bg = "#f7f3ff") => `
    <div class="metric" style="display:inline-block;vertical-align:top;width:48%;box-sizing:border-box;background:${bg};border-radius:10px;padding:12px 10px;margin:0 1% 8px 0;text-align:center;">
      <div style="font-size:12px;color:#666;line-height:1.2;">${esc(label)}</div>
      <div style="font-size:18px;font-weight:700;color:${accent};line-height:1.25;margin-top:4px;word-break:break-word;">${value}</div>
    </div>`;

  const summaryCards = summary.length
    ? summary
        .map(
          (r) => `
      <div style="border:1px solid #e7e0f5;border-radius:12px;padding:14px;margin:0 0 12px;background:#ffffff;">
        <div style="font-size:15px;font-weight:700;color:#1a1a2e;line-height:1.3;">${esc(r.merchant_name)}</div>
        <div style="font-size:12px;color:#666;margin-top:2px;">${esc(r.merchant_phone || "—")} · ${r.payouts} payout${r.payouts === 1 ? "" : "s"}</div>
        <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;margin-top:10px;font-size:13px;">
          <tr><td style="padding:4px 0;color:#666;">Customer payouts</td><td style="padding:4px 0;text-align:right;font-weight:600;">${fmtUGX(r.total_paid)}</td></tr>
          <tr><td style="padding:4px 0;color:#666;">Telecom</td><td style="padding:4px 0;text-align:right;color:#b45309;">${fmtUGX(r.total_telecom || 0)}</td></tr>
          <tr><td style="padding:4px 0;color:#666;">Float consumed</td><td style="padding:4px 0;text-align:right;font-weight:600;">${fmtUGX(r.total_float_consumed || ((r.total_paid || 0) + (r.total_telecom || 0)))}</td></tr>
          <tr><td style="padding:4px 0;color:#666;">Commission</td><td style="padding:4px 0;text-align:right;color:#6c21c4;font-weight:700;">${fmtUGX(r.total_commission)}</td></tr>
        </table>
      </div>`,
        )
        .join("")
    : `<div style="padding:16px;text-align:center;color:#888;background:#faf7ff;border-radius:10px;">No merchant cash-out payouts recorded for this day.</div>`;

  const categoryCards = byCategory.length
    ? byCategory
        .map(
          (c) => `
      <div style="border:1px solid #e7e0f5;border-radius:12px;padding:14px;margin:0 0 12px;background:#faf7ff;">
        <div style="font-size:15px;font-weight:700;color:#6c21c4;line-height:1.3;">${esc(c.category_label)}</div>
        <div style="font-size:12px;color:#666;margin-top:2px;">${c.merchant_count} merchant agent${c.merchant_count === 1 ? "" : "s"} · ${c.payouts} transaction${c.payouts === 1 ? "" : "s"}</div>
        <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;margin-top:10px;font-size:13px;">
          <tr><td style="padding:4px 0;color:#666;">Customer payouts</td><td style="padding:4px 0;text-align:right;font-weight:600;">${fmtUGX(c.total_paid)}</td></tr>
          <tr><td style="padding:4px 0;color:#666;">Telecom charges</td><td style="padding:4px 0;text-align:right;color:#b45309;">${fmtUGX(c.total_telecom || 0)}</td></tr>
          <tr><td style="padding:4px 0;color:#666;">Commission</td><td style="padding:4px 0;text-align:right;color:#6c21c4;font-weight:700;">${fmtUGX(c.total_commission)}</td></tr>
          <tr><td style="padding:4px 0;color:#666;">Float consumed</td><td style="padding:4px 0;text-align:right;font-weight:600;">${fmtUGX(c.total_float_consumed || 0)}</td></tr>
        </table>
      </div>`,
        )
        .join("")
    : "";

  const detailCards = detail
    .map(
      (r) => `
      <div style="border:1px solid #eee;border-radius:10px;padding:10px 12px;margin:0 0 8px;background:#ffffff;">
        <div style="display:block;font-size:12px;color:#666;">${esc(r.time)} · ${esc(r.payout_method || "—")}</div>
        <div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-top:2px;line-height:1.3;">${esc(r.merchant_name)}</div>
        <div style="font-size:12px;color:#555;margin-top:1px;">→ ${esc(r.customer_name || "—")}</div>
        <div style="margin-top:6px;">${statusPill(r.settlement_status)}</div>
        <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;margin-top:8px;font-size:12px;">
          <tr><td style="padding:2px 0;color:#666;">Amount</td><td style="padding:2px 0;text-align:right;font-weight:600;">${fmtUGX(r.amount)}</td></tr>
          <tr><td style="padding:2px 0;color:#666;">Telecom</td><td style="padding:2px 0;text-align:right;color:#b45309;">${fmtUGX(r.telecom_charge || 0)}</td></tr>
          <tr><td style="padding:2px 0;color:#666;">Float consumed</td><td style="padding:2px 0;text-align:right;">${fmtUGX(r.float_consumed || ((r.amount || 0) + (r.telecom_charge || 0)))}</td></tr>
          <tr><td style="padding:2px 0;color:#666;">Commission</td><td style="padding:2px 0;text-align:right;color:#6c21c4;font-weight:600;">${fmtUGX(r.commission)}</td></tr>
          ${
            r.settlement_status && r.settlement_status !== "fully_settled" && r.settlement_status !== "reconciled"
              ? `<tr><td style="padding:2px 0;color:#666;">Missing</td><td style="padding:2px 0;text-align:right;color:#b91c1c;">${esc(((r.missing_legs || []) as string[]).join(", ") || (r.has_customer_debit ? "—" : "customer wallet debit"))}</td></tr>`
              : ""
          }
        </table>
      </div>`,
    )
    .join("");

  const settlementSection = byStatus.length
    ? `
      <h2 style="font-size:15px;margin:22px 0 10px;color:#1a1a2e;">Settlement Status</h2>
      ${byStatus
        .map((s) => {
          const t = statusTone(s.settlement_status);
          return `
      <div style="border:1px solid ${t.fg}22;border-radius:12px;padding:12px 14px;margin:0 0 8px;background:${t.bg};">
        <div style="font-size:14px;font-weight:700;color:${t.fg};">${esc(s.status_label)}</div>
        <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px;">
          <tr><td style="padding:2px 0;color:#666;">Payouts</td><td style="padding:2px 0;text-align:right;font-weight:600;">${s.payouts}</td></tr>
          <tr><td style="padding:2px 0;color:#666;">Amount</td><td style="padding:2px 0;text-align:right;font-weight:600;">${fmtUGX(s.total_amount || 0)}</td></tr>
        </table>
      </div>`;
        })
        .join("")}
      ${
        exceptions.length
          ? `<h2 style="font-size:15px;margin:22px 0 10px;color:#b91c1c;">Needs Reconciliation (${exceptions.length})</h2>
      ${exceptions
        .slice(0, 50)
        .map(
          (e) => `
      <div style="border:1px solid #fecaca;border-radius:10px;padding:10px 12px;margin:0 0 8px;background:#fffafa;">
        <div style="font-size:13px;font-weight:600;color:#1a1a2e;">${esc(e.merchant_name || "Unknown agent")} → ${esc(e.customer_name || "—")}</div>
        <div style="margin-top:4px;">${statusPill(e.settlement_status)}</div>
        <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;margin-top:8px;font-size:12px;">
          <tr><td style="padding:2px 0;color:#666;">Amount</td><td style="padding:2px 0;text-align:right;font-weight:700;">${fmtUGX(e.amount || 0)}</td></tr>
          <tr><td style="padding:2px 0;color:#666;">Request status</td><td style="padding:2px 0;text-align:right;">${esc(e.request_status || "—")}</td></tr>
          <tr><td style="padding:2px 0;color:#666;">Customer wallet debited</td><td style="padding:2px 0;text-align:right;color:${e.has_customer_debit ? "#0f766e" : "#b91c1c"};font-weight:600;">${e.has_customer_debit ? "Yes" : "No"}</td></tr>
          <tr><td style="padding:2px 0;color:#666;">Missing</td><td style="padding:2px 0;text-align:right;color:#b91c1c;">${esc(((e.missing_legs || []) as string[]).join(", ") || "—")}</td></tr>
          <tr><td style="padding:2px 0;color:#666;">Payout ref</td><td style="padding:2px 0;text-align:right;color:#888;">${esc(String(e.withdrawal_id || "").slice(0, 8))}</td></tr>
        </table>
      </div>`,
        )
        .join("")}
      ${exceptions.length > 50 ? `<p style="font-size:12px;color:#888;">+ ${exceptions.length - 50} more — see the FinOps payout reconciliation queue.</p>` : ""}`
          : ""
      }`
    : "";

  const roiSection = `
      <h2 style="font-size:15px;margin:22px 0 10px;color:#1a1a2e;">ROI Payouts — ${esc(prettyDate)}</h2>
      <div style="font-size:0;margin-bottom:14px;">
        ${metric("ROI Payouts", String(roi.payout_count || 0))}
        ${metric("Recipients", String(roi.recipient_count || 0))}
        ${metric("ROI Paid", fmtUGX(roi.total_paid || 0), "#0f766e", "#ecfdf5")}
        ${metric("ROI Reinvested", fmtUGX(roi.total_reinvested || 0), "#6c21c4")}
      </div>
      ${
        roiRecipients.length
          ? roiRecipients
              .map(
                (r) => `
        <div style="border:1px solid #d1fae5;border-radius:10px;padding:10px 12px;margin:0 0 8px;background:#f8fefb;">
          <div style="font-size:14px;font-weight:600;color:#1a1a2e;line-height:1.3;">${esc(r.recipient_name || "—")}</div>
          <div style="font-size:12px;color:#666;margin-top:2px;">${esc(r.recipient_phone || "—")} · ${r.payouts} payout${r.payouts === 1 ? "" : "s"}</div>
          <table role="presentation" width="100%" style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px;">
            <tr><td style="padding:2px 0;color:#666;">ROI paid</td><td style="padding:2px 0;text-align:right;font-weight:700;color:#0f766e;">${fmtUGX(r.total_paid)}</td></tr>
          </table>
        </div>`,
              )
              .join("")
          : `<div style="padding:16px;text-align:center;color:#888;background:#f0fdf4;border-radius:10px;">No ROI payouts recorded for this day.</div>`
      }`;

  return `<!doctype html><html><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <meta name="format-detection" content="telephone=no" />
  <title>Merchant Cash-Out Daily Report</title>
  <style>
    body { margin:0; padding:0; background:#f4f1fa; -webkit-text-size-adjust:100%; }
    a { color:#6c21c4; }
    @media only screen and (max-width: 480px) {
      .container { padding:12px !important; }
      .card { padding:16px !important; border-radius:12px !important; }
      .header { padding:18px 16px !important; }
      .header h1 { font-size:18px !important; }
      .metric { width:48% !important; }
      .metric-full { width:98% !important; }
    }
  </style>
  </head><body style="margin:0;background:#f4f1fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a2e;">
  <div class="container" style="max-width:640px;margin:0 auto;padding:20px;">
    <div class="header" style="background:#6c21c4;color:#fff;border-radius:12px 12px 0 0;padding:20px 24px;">
      <h1 style="margin:0;font-size:20px;line-height:1.25;">Merchant Cash-Out Daily Payout Report</h1>
      <p style="margin:6px 0 0;font-size:13px;opacity:.92;">${esc(prettyDate)} (East Africa Time)</p>
    </div>
    <div class="card" style="background:#fff;padding:18px;border:1px solid #e7e0f5;border-top:0;border-radius:0 0 12px 12px;">

      <div style="font-size:0;margin-bottom:14px;">
        ${metric("Merchants", String(report.merchant_count || 0))}
        ${metric("Payouts", String(report.total_payouts || 0))}
        ${metric("Customer Payouts", fmtUGX(report.total_paid || 0))}
        ${metric("Telecom Charges", fmtUGX(report.total_telecom || 0), "#b45309", "#fff7ed")}
        ${metric("Float Consumed", fmtUGX(report.total_float_consumed || ((report.total_paid || 0) + (report.total_telecom || 0))))}
        ${metric("Commission", fmtUGX(report.total_commission || 0), "#6c21c4")}
        ${metric("Needs Reconciliation", `${report.unresolved_payouts || 0} · ${fmtUGX(report.unresolved_amount || 0)}`, "#b91c1c", "#fef2f2")}
      </div>

      <p style="margin:0 0 18px;font-size:12px;line-height:1.5;color:#555;background:#f7f3ff;padding:12px;border-radius:10px;">
        <strong>Reconciliation:</strong> Merchant Float Allocated = Customer Payouts + Telecom Charges + Remaining Float.
        Every shilling that leaves the merchant's Mobile Money account (payout or telecom fee) is deducted from their float bucket.
      </p>

      <h2 style="font-size:15px;margin:0 0 10px;color:#1a1a2e;">Per Merchant Agent</h2>
      ${summaryCards}

      ${settlementSection}

      ${
        byCategory.length
          ? `<h2 style="font-size:15px;margin:22px 0 10px;color:#1a1a2e;">Breakdown by Cash-Out Category</h2>
      ${categoryCards}`
          : ""
      }

      ${
        detail.length
          ? `<h2 style="font-size:15px;margin:22px 0 10px;color:#1a1a2e;">Individual Payouts (${detail.length})</h2>
      ${detailCards}`
          : ""
      }

      ${roiSection}

      <p style="margin:22px 0 0;font-size:11px;line-height:1.5;color:#999;">
        Generated automatically from the Welile financial ledger. Figures reflect merchant cash-out
        settlements posted for the reporting day (Africa/Kampala). This is an internal operations report.
      </p>
    </div>
  </div>
  </body></html>`;
}

function buildText(report: any, prettyDate: string): string {
  const lines: string[] = [];
  lines.push(`Merchant Cash-Out Daily Payout Report — ${prettyDate} (EAT)`);
  lines.push("");
  lines.push(`Merchants: ${report.merchant_count || 0}`);
  lines.push(`Payouts: ${report.total_payouts || 0}`);
  lines.push(`Customer payouts: ${fmtUGX(report.total_paid || 0)}`);
  lines.push(`Telecom charges: ${fmtUGX(report.total_telecom || 0)}`);
  lines.push(`Float consumed:  ${fmtUGX(report.total_float_consumed || ((report.total_paid || 0) + (report.total_telecom || 0)))}`);
  lines.push(`Total commission: ${fmtUGX(report.total_commission || 0)}`);
  lines.push("");
  const byStatus: Array<any> = report.by_settlement_status || [];
  if (byStatus.length) {
    lines.push("Settlement status:");
    for (const s of byStatus) {
      lines.push(`- ${s.status_label}: ${s.payouts} payouts, ${fmtUGX(s.total_amount || 0)}`);
    }
    lines.push(
      `Needs reconciliation: ${report.unresolved_payouts || 0} payouts, ${fmtUGX(report.unresolved_amount || 0)}`,
    );
    lines.push("");
  }
  const byCategory: Array<any> = report.by_category || [];
  if (byCategory.length) {
    lines.push("Breakdown by cash-out category:");
    for (const c of byCategory) {
      lines.push(
        `- ${c.category_label}: ${c.merchant_count} agents, ${c.payouts} txns, ` +
          `${fmtUGX(c.total_paid)} paid + ${fmtUGX(c.total_telecom || 0)} telecom = ` +
          `${fmtUGX(c.total_float_consumed || 0)} float, ${fmtUGX(c.total_commission)} commission`,
      );
    }
    lines.push("");
  }
  const roi = report.roi || { total_paid: 0, total_reinvested: 0, payout_count: 0, recipient_count: 0, recipients: [] };
  lines.push(`ROI payouts: ${roi.payout_count || 0} to ${roi.recipient_count || 0} recipients`);
  lines.push(`ROI paid:      ${fmtUGX(roi.total_paid || 0)}`);
  lines.push(`ROI reinvested: ${fmtUGX(roi.total_reinvested || 0)}`);
  for (const r of (roi.recipients || []) as Array<{ recipient_name: string; recipient_phone: string | null; payouts: number; total_paid: number }>) {
    lines.push(`- ${r.recipient_name} (${r.recipient_phone || "—"}): ${r.payouts} payouts, ${fmtUGX(r.total_paid)}`);
  }
  lines.push("");
  lines.push("Per merchant agent:");
  for (const r of (report.summary || []) as SummaryRow[]) {
    lines.push(
      `- ${r.merchant_name} (${r.merchant_phone || "—"}): ${r.payouts} payouts, ` +
        `${fmtUGX(r.total_paid)} paid + ${fmtUGX(r.total_telecom || 0)} telecom = ` +
        `${fmtUGX(r.total_float_consumed || ((r.total_paid || 0) + (r.total_telecom || 0)))} float, ` +
        `${fmtUGX(r.total_commission)} commission`,
    );
  }
  if (!(report.summary || []).length) lines.push("- No payouts recorded for this day.");
  return lines.join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Resolve target date (default: the completed previous EAT day).
    // Manual POST requests can still override the date for backfills/regeneration.
    let targetDate = defaultReportDate();
    let force = false;
    let recipientsOverride: string[] | null = null;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (body && typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
          targetDate = body.date;
        }
        force = body?.force === true;
        if (Array.isArray(body?.recipients) && body.recipients.every((r: unknown) => typeof r === "string")) {
          recipientsOverride = body.recipients as string[];
        }
      } catch (_) {
        // no/invalid body — use defaults
      }
    }

    // Idempotency: one report per EAT day unless forced.
    if (!force) {
      const { data: existing } = await admin
        .from("system_events")
        .select("id")
        .eq("event_type", "merchant_cashout_daily_report")
        .contains("metadata", { date: targetDate })
        .limit(1)
        .maybeSingle();
      if (existing) {
        return new Response(
          JSON.stringify({ success: true, skipped: true, reason: "Already sent", date: targetDate }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Pull accurate figures from the ledger-backed RPC.
    const { data: report, error: rpcErr } = await admin.rpc(
      "generate_merchant_cashout_daily_report",
      { p_date: targetDate },
    );
    if (rpcErr) {
      console.error("[merchant-cashout-daily-report] RPC error:", rpcErr);
      return new Response(JSON.stringify({ success: false, error: rpcErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- ROI Payouts (from immutable ledger) ----
    // EAT day boundaries: EAT = UTC+3, so day [D 00:00 EAT, D+1 00:00 EAT) is
    // [D 21:00 UTC prev, D 21:00 UTC].
    const startUtc = new Date(`${targetDate}T00:00:00+03:00`).toISOString();
    const endUtc = new Date(new Date(`${targetDate}T00:00:00+03:00`).getTime() + 24 * 60 * 60 * 1000).toISOString();

    const { data: roiCredits } = await admin
      .from("general_ledger")
      .select("user_id, amount")
      .eq("category", "roi_wallet_credit")
      .eq("direction", "cash_in")
      .gte("created_at", startUtc)
      .lt("created_at", endUtc);

    const { data: roiReinv } = await admin
      .from("general_ledger")
      .select("amount")
      .eq("category", "roi_reinvestment")
      .eq("direction", "cash_in")
      .gte("created_at", startUtc)
      .lt("created_at", endUtc);

    const byRecipient = new Map<string, { total: number; count: number }>();
    let roiTotalPaid = 0;
    for (const row of (roiCredits || []) as Array<{ user_id: string | null; amount: number }>) {
      const amt = Number(row.amount) || 0;
      roiTotalPaid += amt;
      const key = row.user_id || "unknown";
      const cur = byRecipient.get(key) || { total: 0, count: 0 };
      cur.total += amt;
      cur.count += 1;
      byRecipient.set(key, cur);
    }
    const roiTotalReinvested = ((roiReinv || []) as Array<{ amount: number }>).reduce(
      (s, r) => s + (Number(r.amount) || 0),
      0,
    );

    // Resolve recipient names/phones.
    const recipientIds = Array.from(byRecipient.keys()).filter((k) => k !== "unknown");
    const nameMap = new Map<string, { name: string; phone: string | null }>();
    if (recipientIds.length) {
      const { data: profs } = await admin
        .from("profiles")
        .select("id, full_name, phone")
        .in("id", recipientIds);
      for (const p of (profs || []) as Array<{ id: string; full_name: string | null; phone: string | null }>) {
        nameMap.set(p.id, { name: p.full_name || "Unknown", phone: p.phone });
      }
    }
    const roiRecipients = Array.from(byRecipient.entries())
      .map(([id, v]) => ({
        recipient_name: nameMap.get(id)?.name || (id === "unknown" ? "Unknown" : id.slice(0, 8)),
        recipient_phone: nameMap.get(id)?.phone || null,
        payouts: v.count,
        total_paid: v.total,
      }))
      .sort((a, b) => b.total_paid - a.total_paid);

    (report as any).roi = {
      total_paid: roiTotalPaid,
      total_reinvested: roiTotalReinvested,
      payout_count: (roiCredits || []).length,
      recipient_count: roiRecipients.length,
      recipients: roiRecipients,
    };

    const prettyDate = new Date(`${targetDate}T00:00:00Z`).toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

    const html = buildHtml(report, prettyDate);
    const text = buildText(report, prettyDate);
    const subject = `Merchant Cash-Out Payouts — ${prettyDate}: ${fmtUGX(
      report?.total_paid || 0,
    )} paid + ${fmtUGX(report?.total_telecom || 0)} telecom across ${report?.total_payouts || 0} payouts · ROI ${fmtUGX((report as any)?.roi?.total_paid || 0)} (${(report as any)?.roi?.payout_count || 0})`;

    // Enqueue one email per recipient into the existing Lovable email queue.
    const results: Record<string, string> = {};
    const recipientList = recipientsOverride && recipientsOverride.length > 0
      ? recipientsOverride
      : REPORT_RECIPIENTS;
    for (const to of recipientList) {
      const messageId = crypto.randomUUID();
      const unsubscribeToken = await ensureUnsubscribeToken(admin, to);
      const payload = {
        message_id: messageId,
        to,
        from: FROM,
        sender_domain: SENDER_DOMAIN,
        subject,
        html,
        text,
        purpose: "transactional",
        label: "merchant-cashout-daily-report",
        idempotency_key: `merchant-cashout-daily-report:${targetDate}:${to}`,
        unsubscribe_token: unsubscribeToken,
        queued_at: new Date().toISOString(),
      };

      await admin.from("email_send_log").insert({
        message_id: messageId,
        template_name: "merchant-cashout-daily-report",
        recipient_email: to,
        status: "pending",
        metadata: { subject, date: targetDate },
      });

      const { error: enqErr } = await admin.rpc("enqueue_email", {
        queue_name: "transactional_emails",
        payload,
      });
      results[to] = enqErr ? `error: ${enqErr.message}` : "queued";
      if (enqErr) console.error("[merchant-cashout-daily-report] enqueue error:", to, enqErr);
    }

    // Record the event for idempotency + auditability.
    await admin.from("system_events").insert({
      event_type: "merchant_cashout_daily_report",
      metadata: {
        date: targetDate,
        recipients: REPORT_RECIPIENTS,
        merchant_count: report?.merchant_count ?? 0,
        total_payouts: report?.total_payouts ?? 0,
        total_paid: report?.total_paid ?? 0,
        total_commission: report?.total_commission ?? 0,
        total_telecom: report?.total_telecom ?? 0,
        total_float_consumed: report?.total_float_consumed ?? 0,
        roi_total_paid: (report as any)?.roi?.total_paid ?? 0,
        roi_total_reinvested: (report as any)?.roi?.total_reinvested ?? 0,
        roi_payout_count: (report as any)?.roi?.payout_count ?? 0,
        roi_recipient_count: (report as any)?.roi?.recipient_count ?? 0,
        results,
      },
    });

    // Best-effort: trigger the dispatcher so the emails go out promptly.
    fetch(`${SUPABASE_URL}/functions/v1/process-email-queue`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" },
      body: "{}",
    }).catch((e) => console.error("[merchant-cashout-daily-report] dispatch trigger failed:", e));

    return new Response(
      JSON.stringify({
        success: true,
        date: targetDate,
        recipients: REPORT_RECIPIENTS,
        merchant_count: report?.merchant_count ?? 0,
        total_payouts: report?.total_payouts ?? 0,
        total_paid: report?.total_paid ?? 0,
        total_commission: report?.total_commission ?? 0,
        total_telecom: report?.total_telecom ?? 0,
        total_float_consumed: report?.total_float_consumed ?? 0,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[merchant-cashout-daily-report] Fatal:", err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});