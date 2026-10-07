// Emails every logged partner-portfolio change to the portfolio watch addresses.
// Reads unnotified rows from `portfolio_change_log`, enqueues one email
// summarising them, then stamps notified_at so nothing is sent twice.
// Invoked directly by the DB triggers on user actions — no cron.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const FROM = "Welile Reports <info@welile.com>";
const SENDER_DOMAIN = "notify.welile.com";
const DEFAULT_RECIPIENTS = ["jlukodda@gmail.com", "ssenkaali.pius@welile.com"];

const fmtUGX = (n: unknown) =>
  `UGX ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

const stampOf = (v: unknown) => {
  if (!v) return "—";
  const d = new Date(String(v));
  return isNaN(d.getTime())
    ? String(v)
    : `${d.toISOString().replace("T", " ").slice(0, 16)} UTC`;
};

const ACTION_LABELS: Record<string, string> = {
  portfolio_created: "Portfolio created",
  portfolio_deleted: "Portfolio deleted",
  portfolio_principal_edited: "Principal edited",
  portfolio_contribution_date_edited: "Contribution date edited",
  portfolio_terms_edited: "Returns rate / duration edited",
  portfolio_topped_up: "Top-up applied",
  portfolio_compounded: "Returns compounded",
  portfolio_renewed: "Portfolio renewed",
  portfolio_suspended: "Portfolio suspended",
  portfolio_updated: "Portfolio updated",
  portfolio_split: "Portfolio split",
  partner_suspended: "Partner suspended",
  partner_reinstated: "Partner reinstated",
};

const FIELD_LABELS: Record<string, string> = {
  investment_amount: "Principal",
  contribution_date: "Contribution date",
  roi_percentage: "Returns rate",
  duration_months: "Duration (months)",
  maturity_date: "Maturity date",
  status: "Status",
  total_roi_earned: "Returns earned to date",
  frozen_at: "Suspension",
  frozen_reason: "Suspension reason",
};

const MONEY_FIELDS = new Set([
  "investment_amount",
  "total_roi_earned",
]);
const DATE_FIELDS = new Set(["contribution_date", "frozen_at"]);

interface LogRow {
  id: string;
  action: string;
  portfolio_id: string | null;
  portfolio_code: string | null;
  partner_id: string | null;
  partner_name: string | null;
  changed_fields: string[] | null;
  before_values: Record<string, unknown> | null;
  after_values: Record<string, unknown> | null;
  changed_by: string | null;
  changed_at: string;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ensureUnsubscribeToken(
  admin: ReturnType<typeof createClient>,
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
  return token;
}

function renderValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (MONEY_FIELDS.has(field)) return fmtUGX(v);
  if (DATE_FIELDS.has(field)) return stampOf(v);
  if (field === "roi_percentage") return `${Number(v)}%`;
  return String(v);
}

function changeDetail(r: LogRow): string {
  const before = r.before_values ?? {};
  const after = r.after_values ?? {};
  const fields = r.changed_fields?.length
    ? r.changed_fields
    : [...new Set([...Object.keys(before), ...Object.keys(after)])];
  if (!fields.length) return "—";
  return fields
    .map((f) => {
      const label = FIELD_LABELS[f] ?? f;
      if (r.action === "portfolio_created") {
        return `${label}: ${renderValue(f, after[f])}`;
      }
      if (r.action === "portfolio_deleted") {
        return `${label}: ${renderValue(f, before[f])}`;
      }
      return `${label}: ${renderValue(f, before[f])} → ${renderValue(f, after[f])}`;
    })
    .join(" · ");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  try {
    let recipients = DEFAULT_RECIPIENTS;
    try {
      const body = await req.json();
      if (Array.isArray(body?.recipients) && body.recipients.length) {
        recipients = body.recipients.filter((r: unknown) => typeof r === "string");
      }
    } catch (_) { /* no body — use defaults */ }

    const { data, error } = await admin
      .from("portfolio_change_log")
      .select(
        "id, action, portfolio_id, portfolio_code, partner_id, partner_name, changed_fields, before_values, after_values, changed_by, changed_at",
      )
      .is("notified_at", null)
      .order("changed_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(`log fetch failed: ${error.message}`);

    const rows = (data ?? []) as LogRow[];
    if (!rows.length) {
      return new Response(
        JSON.stringify({ notified: 0, reason: "no new portfolio changes" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const actorIds = [...new Set(rows.map((r) => r.changed_by).filter(Boolean) as string[])];
    const { data: actors } = actorIds.length
      ? await admin.from("profiles").select("id, full_name").in("id", actorIds)
      : { data: [] as { id: string; full_name: string | null }[] };
    const actorById = new Map(
      (actors ?? []).map((p: { id: string; full_name: string | null }) => [p.id, p.full_name ?? "—"]),
    );

    const subject =
      `Portfolio activity — ${rows.length} change${rows.length === 1 ? "" : "s"}`;

    const body = rows
      .map((r) => {
        const label = ACTION_LABELS[r.action] ?? r.action;
        return `<tr>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:600">${esc(label)}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(r.portfolio_code ?? "—")}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(r.partner_name ?? "—")}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(changeDetail(r))}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(actorById.get(r.changed_by ?? "") ?? "System")}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap">${esc(stampOf(r.changed_at))}</td>
</tr>`;
      })
      .join("");

    const html = `<div style="font:14px system-ui;color:#111;max-width:960px">
  <h2 style="margin:0 0 6px;font:700 18px system-ui">Partner portfolio activity</h2>
  <p style="margin:0 0 4px;color:#555">Every portfolio creation, principal edit, contribution-date change, returns-rate or duration edit, top-up, compound, renewal, deletion and partner suspension is logged and reported here with the before and after values.</p>
  <table style="width:100%;border-collapse:collapse;font:13px system-ui;margin-top:14px">
    <thead><tr style="background:#f6f6f6;text-align:left">
      <th style="padding:6px 10px">Action</th>
      <th style="padding:6px 10px">Portfolio ID</th>
      <th style="padding:6px 10px">Partner</th>
      <th style="padding:6px 10px">Before → After</th>
      <th style="padding:6px 10px">Done by</th>
      <th style="padding:6px 10px">When</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>
</div>`;

    const text = [
      subject,
      "",
      ...rows.map(
        (r) =>
          `${ACTION_LABELS[r.action] ?? r.action} — ${r.portfolio_code ?? "—"} (${r.partner_name ?? "—"}): ${changeDetail(r)} by ${actorById.get(r.changed_by ?? "") ?? "System"} at ${stampOf(r.changed_at)}`,
      ),
    ].join("\n");

    const stamp = new Date().toISOString();
    const results: Record<string, string> = {};
    for (const to of recipients) {
      const messageId = crypto.randomUUID();
      const unsubscribeToken = await ensureUnsubscribeToken(admin, to);
      await admin.from("email_send_log").insert({
        message_id: messageId,
        template_name: "portfolio-change",
        recipient_email: to,
        status: "pending",
        metadata: { subject, changes: rows.length },
      });
      const { error: enqErr } = await admin.rpc("enqueue_email", {
        queue_name: "transactional_emails",
        payload: {
          message_id: messageId,
          to,
          from: FROM,
          sender_domain: SENDER_DOMAIN,
          subject,
          html,
          text,
          purpose: "transactional",
          label: "portfolio-change",
          idempotency_key: `portfolio-change:${rows[0].id}:${to}`,
          unsubscribe_token: unsubscribeToken,
          queued_at: stamp,
        },
      });
      results[to] = enqErr ? `error: ${enqErr.message}` : "queued";
      if (enqErr) console.error("[portfolio-change-notify] enqueue error", to, enqErr);
    }

    const { error: stampErr } = await admin
      .from("portfolio_change_log")
      .update({ notified_at: stamp })
      .in("id", rows.map((r) => r.id));
    if (stampErr) console.error("[portfolio-change-notify] stamp error", stampErr);

    return new Response(
      JSON.stringify({ notified: rows.length, recipients: results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[portfolio-change-notify]", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
