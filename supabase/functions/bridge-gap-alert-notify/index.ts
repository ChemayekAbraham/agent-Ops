// Ops notification for deposit-bridge gap alerts.
//
// Runs `detect_deposit_bridge_gaps()` then emails + Slack-posts every open
// alert that has not been notified yet. Recipients (email) come from the
// existing `deposit_match_alert_config.notify_emails` list so ops has ONE
// address book. Slack goes to the `OPS_SLACK_WEBHOOK_URL` secret.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SLACK_WEBHOOK = Deno.env.get("OPS_SLACK_WEBHOOK_URL") ?? "";

const FROM = "Welile Reports <info@welile.com>";
const SENDER_DOMAIN = "notify.welile.com";

const fmtUGX = (n: number | null) =>
  `UGX ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

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

interface GapRow {
  id: string;
  source: string;
  source_id: string;
  transaction_id: string | null;
  user_id: string | null;
  amount: number | null;
  approved_at: string | null;
  alert_reason: string;
  severity: string;
  detected_at: string;
}

function severityColor(s: string): string {
  if (s === "critical") return "#b91c1c";
  if (s === "high") return "#c2410c";
  if (s === "medium") return "#a16207";
  return "#4b5563";
}

function ageMinutes(ts: string | null): number {
  if (!ts) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
}

function buildEmail(rows: GapRow[]): { subject: string; html: string; text: string } {
  const critical = rows.filter((r) => r.severity === "critical").length;
  const high = rows.filter((r) => r.severity === "high").length;
  const subject =
    `Bridge gap alert — ${rows.length} unreconciled deposit${rows.length === 1 ? "" : "s"} ` +
    `(${critical} critical, ${high} high)`;

  const body = rows
    .map(
      (r) => `<tr>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(r.source)}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;font-family:monospace">${esc(r.transaction_id) || "—"}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmtUGX(r.amount)}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${ageMinutes(r.approved_at ?? r.detected_at)} min</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;color:${severityColor(r.severity)};text-transform:uppercase;font-weight:600">${esc(r.severity)}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(r.alert_reason)}</td>
</tr>`,
    )
    .join("");

  const html = `<div style="font:14px system-ui;color:#111;max-width:820px">
  <h2 style="margin:0 0 6px;font:700 18px system-ui">Deposit bridge has unreconciled events</h2>
  <p style="margin:0 0 4px;color:#555">
    These approved deposits or receipts have no matching ledger credit after the reconciliation window.
    Resolve in <b>Financial Ops → Bridge Alerts</b> or <b>CTO → Bridge Health</b>.
  </p>
  <table style="width:100%;border-collapse:collapse;font:13px system-ui;margin-top:14px">
    <thead><tr style="background:#f6f6f6;text-align:left">
      <th style="padding:6px 10px">Source</th>
      <th style="padding:6px 10px">TID</th>
      <th style="padding:6px 10px;text-align:right">Amount</th>
      <th style="padding:6px 10px;text-align:right">Age</th>
      <th style="padding:6px 10px">Severity</th>
      <th style="padding:6px 10px">Reason</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p style="margin:20px 0 0;color:#777;font-size:12px">
    Alerts clear automatically once the ledger row is posted or the alert is resolved.
  </p>
</div>`;

  const text = [
    subject,
    "",
    ...rows.map(
      (r) =>
        `[${r.severity.toUpperCase()}] ${r.source} tid=${r.transaction_id ?? "-"} ${fmtUGX(r.amount)} age=${ageMinutes(r.approved_at ?? r.detected_at)}m — ${r.alert_reason}`,
    ),
  ].join("\n");

  return { subject, html, text };
}

function buildSlackPayload(rows: GapRow[]) {
  const critical = rows.filter((r) => r.severity === "critical").length;
  const high = rows.filter((r) => r.severity === "high").length;
  const header = `:rotating_light: *Deposit bridge — ${rows.length} unreconciled* (${critical} critical, ${high} high)`;
  const lines = rows.slice(0, 20).map((r) => {
    const emoji = r.severity === "critical" ? ":red_circle:"
      : r.severity === "high" ? ":large_orange_circle:"
      : r.severity === "medium" ? ":large_yellow_circle:"
      : ":white_circle:";
    return `${emoji} \`${r.source}\` • ${fmtUGX(r.amount)} • tid \`${r.transaction_id ?? "—"}\` • ${ageMinutes(r.approved_at ?? r.detected_at)}m • ${r.alert_reason}`;
  });
  const overflow = rows.length > 20 ? `\n_+ ${rows.length - 20} more…_` : "";
  return {
    text: `${header}\n${lines.join("\n")}${overflow}\nResolve in Financial Ops → Bridge Alerts or CTO → Bridge Health.`,
  };
}

async function postSlack(payload: unknown): Promise<{ ok: boolean; error?: string }> {
  if (!SLACK_WEBHOOK) return { ok: false, error: "OPS_SLACK_WEBHOOK_URL not configured" };
  try {
    const res = await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: `slack ${res.status}: ${await res.text()}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  try {
    const { error: detectErr } = await admin.rpc("detect_deposit_bridge_gaps");
    if (detectErr) throw new Error(`detector failed: ${detectErr.message}`);

    const { data: cfg } = await admin
      .from("deposit_match_alert_config")
      .select("notify_emails")
      .eq("id", 1)
      .maybeSingle();
    const recipients: string[] =
      (cfg?.notify_emails as string[] | null)?.filter(Boolean) ?? [];

    const { data: alerts, error: alertsErr } = await admin
      .from("deposit_bridge_gap_alerts")
      .select(
        "id, source, source_id, transaction_id, user_id, amount, approved_at, alert_reason, severity, detected_at",
      )
      .is("resolved_at", null)
      .is("notified_at", null)
      .order("detected_at", { ascending: false })
      .limit(200);
    if (alertsErr) throw new Error(`alert fetch failed: ${alertsErr.message}`);

    const pending = (alerts ?? []) as GapRow[];
    if (!pending.length) {
      return new Response(
        JSON.stringify({ notified: 0, reason: "no new gap alerts" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { subject, html, text } = buildEmail(pending);
    const stamp = new Date().toISOString();
    const emailResults: Record<string, string> = {};

    for (const to of recipients) {
      const messageId = crypto.randomUUID();
      const unsubscribeToken = await ensureUnsubscribeToken(admin, to);
      await admin.from("email_send_log").insert({
        message_id: messageId,
        template_name: "bridge-gap-alert",
        recipient_email: to,
        status: "pending",
        metadata: { subject, alerts: pending.length },
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
          label: "bridge-gap-alert",
          idempotency_key: `bridge-gap-alert:${stamp.slice(0, 16)}:${to}`,
          unsubscribe_token: unsubscribeToken,
          queued_at: stamp,
        },
      });
      emailResults[to] = enqErr ? `error: ${enqErr.message}` : "queued";
      if (enqErr) console.error("[bridge-gap-alert] enqueue error", to, enqErr);
    }

    const slackResult = await postSlack(buildSlackPayload(pending));

    const anyQueued = Object.values(emailResults).some((v) => v === "queued");
    const update: Record<string, string> = {};
    if (anyQueued) update.notified_at = stamp;
    if (slackResult.ok) update.slack_notified_at = stamp;
    if (Object.keys(update).length) {
      await admin
        .from("deposit_bridge_gap_alerts")
        .update(update)
        .in("id", pending.map((a) => a.id));
    }

    await admin.from("system_events").insert({
      event_type: "bridge_gap_alert_notified",
      metadata: {
        alerts: pending.length,
        recipients,
        email_results: emailResults,
        slack_ok: slackResult.ok,
        slack_error: slackResult.error ?? null,
      },
    });

    return new Response(
      JSON.stringify({
        notified: pending.length,
        email_results: emailResults,
        slack: slackResult,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[bridge-gap-alert-notify]", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});