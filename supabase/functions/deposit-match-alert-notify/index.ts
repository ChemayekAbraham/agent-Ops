// Ops notification for deposit-match failures.
//
// Runs the `detect_deposit_match_failures` detector (configurable window in
// `deposit_match_alert_config`), then emails every open alert that has not
// been notified yet to the configured ops recipients through the existing
// email queue (enqueue_email -> process-email-queue).
//
// Two failure classes are reported:
//  - deposit_unmatched:       an agent/user deposit submission is still
//                             pending past the window with no matching
//                             mobile-money email receipt.
//  - email_receipt_unmatched: an incoming mobile-money receipt arrived but
//                             was never attached/routed to any deposit.

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

function fmtUGX(n: number | null): string {
  return `UGX ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
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
  const { data: stored } = await admin
    .from("email_unsubscribe_tokens")
    .select("token")
    .eq("email", normalized)
    .maybeSingle();
  return (stored?.token as string) || token;
}

interface AlertRow {
  id: string;
  alert_type: string;
  subject_label: string | null;
  amount: number | null;
  transaction_reference: string | null;
  age_minutes: number;
  severity: string;
  details: Record<string, unknown> | null;
}

function table(title: string, rows: AlertRow[], refLabel: string): string {
  if (!rows.length) return "";
  const body = rows
    .map(
      (r) => `<tr>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(r.subject_label)}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmtUGX(r.amount)}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;font-family:monospace">${esc(r.transaction_reference) || "—"}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${r.age_minutes} min</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-transform:uppercase">${esc(r.severity)}</td>
</tr>`,
    )
    .join("");
  return `<h3 style="margin:22px 0 8px;font:600 15px system-ui">${esc(title)} (${rows.length})</h3>
<table style="width:100%;border-collapse:collapse;font:13px system-ui">
  <thead><tr style="background:#f6f6f6;text-align:left">
    <th style="padding:6px 10px">Subject</th>
    <th style="padding:6px 10px;text-align:right">Amount</th>
    <th style="padding:6px 10px">${esc(refLabel)}</th>
    <th style="padding:6px 10px;text-align:right">Age</th>
    <th style="padding:6px 10px">Severity</th>
  </tr></thead>
  <tbody>${body}</tbody>
</table>`;
}

async function postSlack(
  deposits: AlertRow[],
  receipts: AlertRow[],
  windowMinutes: number,
  pipelineAlerts: AlertRow[] = [],
) {
  if (!SLACK_WEBHOOK) return { ok: false, error: "OPS_SLACK_WEBHOOK_URL not configured" };
  const total = deposits.length + receipts.length;
  const line = (r: AlertRow, kind: string) =>
    `• *${kind}* ${r.subject_label ?? "—"} • ${fmtUGX(r.amount)} • ref \`${r.transaction_reference ?? "—"}\` • ${r.age_minutes}m • _${r.severity}_`;
  const pipelineLines = pipelineAlerts.map(
    (a) => `:rotating_light: *PIPELINE* ${a.subject_label ?? "—"} — ${(a.details as any)?.message ?? "see details"} • ${a.age_minutes}m`,
  );
  const lines = [
    ...pipelineLines,
    ...deposits.slice(0, 15).map((d) => line(d, "DEPOSIT")),
    ...receipts.slice(0, 15).map((r) => line(r, "RECEIPT")),
  ];
  const overflow = total > lines.length - pipelineLines.length ? `\n_+ ${total - (lines.length - pipelineLines.length)} more…_` : "";
  const text =
    `:warning: *Deposit-match alert — ${total} unmatched* after ${windowMinutes}m ` +
    `(${deposits.length} deposits, ${receipts.length} receipts)\n${lines.join("\n")}${overflow}`;
  try {
    const res = await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return { ok: false, error: `slack ${res.status}` };
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
    const { data: detect, error: detectErr } = await admin.rpc(
      "detect_deposit_match_failures",
    );
    if (detectErr) throw new Error(`detector failed: ${detectErr.message}`);

    const detection = (detect ?? {}) as Record<string, unknown>;
    if (detection.enabled === false) {
      return new Response(JSON.stringify({ skipped: true, reason: "alerts disabled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: cfg } = await admin
      .from("deposit_match_alert_config")
      .select("window_minutes, notify_emails")
      .eq("id", 1)
      .maybeSingle();

    const recipients: string[] = (cfg?.notify_emails as string[] | null)?.filter(Boolean) ?? [];
    const windowMinutes = Number(cfg?.window_minutes ?? 30);

    const { data: alerts, error: alertsErr } = await admin
      .from("deposit_match_alerts")
      .select(
        "id, alert_type, subject_label, amount, transaction_reference, age_minutes, severity, details",
      )
      .is("resolved_at", null)
      .is("notified_at", null)
      .order("created_at", { ascending: false })
      .limit(200);
    if (alertsErr) throw new Error(`alert fetch failed: ${alertsErr.message}`);

    const pending = (alerts ?? []) as AlertRow[];
    if (!pending.length) {
      return new Response(
        JSON.stringify({ ...detection, notified: 0, reason: "no new alerts" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const deposits = pending.filter((a) => a.alert_type === "deposit_unmatched");
    const receipts = pending.filter((a) => a.alert_type === "email_receipt_unmatched");
    // Pipeline-health alerts (Gmail auth failures, poll-heartbeat staleness)
    // are a different failure class entirely — surface them prominently
    // rather than letting them ride along unnoticed in `pending` (they
    // still get marked notified_at below with everything else, so without
    // this block they'd be silently swallowed: fetched, marked handled,
    // never actually shown to anyone).
    const pipelineAlerts = pending.filter(
      (a) => a.alert_type === "gmail_auth_failure" || a.alert_type === "gmail_poll_stale",
    );

    const parts: string[] = [];
    if (deposits.length || receipts.length) {
      parts.push(`${deposits.length} deposits, ${receipts.length} receipts unmatched after ${windowMinutes} min`);
    }
    if (pipelineAlerts.length) {
      parts.push(`${pipelineAlerts.length} pipeline health alert${pipelineAlerts.length === 1 ? "" : "s"}`);
    }
    const subject = `Deposit match alert — ${parts.join("; ")}`;

    const pipelineHtml = pipelineAlerts.length
      ? `<div style="margin:0 0 18px;padding:12px;border:1px solid #b91c1c;border-radius:6px;background:#fef2f2">
    <h3 style="margin:0 0 6px;font:700 15px system-ui;color:#b91c1c">Pipeline health (${pipelineAlerts.length})</h3>
    ${pipelineAlerts
      .map(
        (a) => `<p style="margin:4px 0;font-size:13px">
      <b>${esc(a.subject_label)}</b> — ${esc((a.details as any)?.message ?? "see details")}
      ${a.age_minutes ? `<span style="color:#777"> (${a.age_minutes}m)</span>` : ""}
    </p>`,
      )
      .join("")}
  </div>`
      : "";

    const html = `<div style="font:14px system-ui;color:#111;max-width:760px">
  <h2 style="margin:0 0 6px;font:700 18px system-ui">Deposit matching needs attention</h2>
  ${pipelineHtml}
  ${deposits.length || receipts.length ? `<p style="margin:0 0 4px;color:#555">
    These items have not matched within the configured ${windowMinutes}-minute window.
  </p>` : ""}
  ${table("Deposit submissions with no email receipt", deposits, "Reference typed")}
  ${table("Email receipts not attached to any deposit", receipts, "Receipt TID")}
  <p style="margin:20px 0 0;color:#777;font-size:12px">
    Resolve in Financial Ops → Email Transactions. Alerts clear automatically once the
    deposit is approved, the receipt is linked/routed, or the pipeline recovers.
  </p>
</div>`;

    const text = [
      subject,
      "",
      ...pipelineAlerts.map(
        (a) => `PIPELINE  ${a.subject_label} — ${(a.details as any)?.message ?? "see details"} (${a.age_minutes}m)`,
      ),
      ...deposits.map(
        (d) =>
          `DEPOSIT  ${d.subject_label} ${fmtUGX(d.amount)} ref=${d.transaction_reference ?? "-"} age=${d.age_minutes}m ${d.severity}`,
      ),
      ...receipts.map(
        (r) =>
          `RECEIPT  ${r.subject_label} ${fmtUGX(r.amount)} tid=${r.transaction_reference ?? "-"} age=${r.age_minutes}m ${r.severity}`,
      ),
    ].join("\n");

    const results: Record<string, string> = {};
    const stamp = new Date().toISOString();
    for (const to of recipients) {
      const messageId = crypto.randomUUID();
      const unsubscribeToken = await ensureUnsubscribeToken(admin, to);
      await admin.from("email_send_log").insert({
        message_id: messageId,
        template_name: "deposit-match-alert",
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
          label: "deposit-match-alert",
          idempotency_key: `deposit-match-alert:${stamp.slice(0, 16)}:${to}`,
          unsubscribe_token: unsubscribeToken,
          queued_at: stamp,
        },
      });
      results[to] = enqErr ? `error: ${enqErr.message}` : "queued";
      if (enqErr) console.error("[deposit-match-alert] enqueue error", to, enqErr);
    }

    const anyQueued = Object.values(results).some((v) => v === "queued");
    if (anyQueued) {
      await admin
        .from("deposit_match_alerts")
        .update({ notified_at: stamp })
        .in("id", pending.map((a) => a.id));
    }

    const slackResult = await postSlack(deposits, receipts, windowMinutes, pipelineAlerts);

    await admin.from("system_events").insert({
      event_type: "deposit_match_alert_notified",
      metadata: {
        alerts: pending.length,
        deposits: deposits.length,
        receipts: receipts.length,
        window_minutes: windowMinutes,
        recipients,
        results,
        slack_ok: slackResult.ok,
        slack_error: slackResult.error ?? null,
      },
    });

    return new Response(
      JSON.stringify({ ...detection, notified: anyQueued ? pending.length : 0, results, slack: slackResult }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[deposit-match-alert-notify]", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});