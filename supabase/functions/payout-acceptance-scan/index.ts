// Daily payout acceptance checks -> finance anomaly alert path.
//
// Runs `run_payout_acceptance_scan(trigger_source, window_days)`, which executes
// every structural + behavioural invariant of the payout pipeline and refreshes
// one `finance_anomaly_alert_states` row per check (prefix `acceptance:`).
//
// Any `status = 'fail'` row emails the recipients configured in
// `finance_anomaly_alert_config.notify_emails`. A fully clean run stores the
// state rows only (no email), so a regression pages someone the same day
// instead of waiting for the next manual audit.
//
// Body: { trigger_source?: string, window_days?: number, force?: boolean }

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

interface CheckRow {
  check_key: string;
  title: string;
  status: string;
  observed: number;
  expected: number;
  detail: string;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

const STATUS_COLOR: Record<string, string> = {
  fail: "#b42318",
  warn: "#b54708",
  pass: "#067647",
};

function row(c: CheckRow): string {
  return `<tr>
  <td style="padding:8px 10px;border-bottom:1px solid #eee">${esc(c.title)}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;text-transform:uppercase;font-weight:600;color:${STATUS_COLOR[c.status] ?? "#333"}">${esc(c.status)}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#475467">${esc(c.detail)}</td>
</tr>`;
}

function buildHtml(report: Record<string, unknown>, checks: CheckRow[]): string {
  const failing = checks.filter((c) => c.status === "fail");
  const warning = checks.filter((c) => c.status === "warn");
  return `<div style="font:14px system-ui;color:#111;max-width:860px">
  <h2 style="margin:0 0 6px;font:700 18px system-ui">
    Payout acceptance checks — <span style="color:${failing.length ? "#b42318" : "#067647"}">${failing.length ? "REGRESSION" : "ALL CLEAR"}</span>
  </h2>
  <p style="margin:0 0 14px;color:#555">
    Trigger: <strong>${esc(report.trigger_source)}</strong> ·
    Window: ${esc(report.window_days)} day(s) ·
    Checked: ${esc(report.scanned_at)}
  </p>
  <p style="margin:0 0 18px;padding:10px 12px;border-radius:8px;background:${failing.length ? "#fef3f2" : "#ecfdf3"};color:${failing.length ? "#b42318" : "#067647"};font-weight:600">
    ${failing.length} failing · ${warning.length} warning · ${checks.length} checks in total
  </p>
  <table style="width:100%;border-collapse:collapse;font:13px system-ui">
    <thead><tr style="background:#f9fafb">
      <th style="text-align:left;padding:8px 10px">Invariant</th>
      <th style="text-align:left;padding:8px 10px">Status</th>
      <th style="text-align:left;padding:8px 10px">Detail</th>
    </tr></thead>
    <tbody>${[...failing, ...warning, ...checks.filter((c) => c.status === "pass")].map(row).join("")}</tbody>
  </table>
  <p style="margin:22px 0 0;color:#777;font-size:12px">
    Each check is also stored on the CFO dashboard → Reconciliation → Finance monitoring board
    (keys prefixed <code>acceptance:</code>). The general ledger remains the source of truth.
  </p>
</div>`;
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  try {
    let body: { trigger_source?: string; window_days?: number; force?: boolean } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const triggerSource = String(body.trigger_source ?? "manual").slice(0, 40);
    const windowDays = Math.min(90, Math.max(1, Number(body.window_days ?? 7) || 7));
    const force = body.force === true;

    const { data: cfg } = await admin
      .from("finance_anomaly_alert_config")
      .select("enabled, notify_emails")
      .eq("id", 1)
      .maybeSingle();

    const { data: scan, error: scanErr } = await admin.rpc("run_payout_acceptance_scan", {
      p_trigger_source: triggerSource,
      p_window_days: windowDays,
    });
    if (scanErr) throw new Error(`acceptance scan failed: ${scanErr.message}`);

    const report = (scan ?? {}) as Record<string, unknown>;
    const checks = ((report.checks ?? []) as CheckRow[]).map((c) => ({
      ...c,
      observed: Number(c.observed ?? 0),
      expected: Number(c.expected ?? 0),
    }));
    const failing = checks.filter((c) => c.status === "fail");
    const warning = checks.filter((c) => c.status === "warn");

    const alertsEnabled = cfg?.enabled !== false;
    const shouldEmail = (force || failing.length > 0) && alertsEnabled;

    const emailResults: Record<string, string> = {};
    if (shouldEmail) {
      const emails = ((cfg?.notify_emails as string[] | null) ?? []).filter(Boolean);
      const subject =
        `Payout acceptance checks — ${failing.length ? `${failing.length} FAILING` : "all clear"} · ` +
        `${warning.length} warning${warning.length === 1 ? "" : "s"} of ${checks.length} (${triggerSource})`;
      const html = buildHtml(report, checks);
      const text = [
        subject,
        "",
        ...checks.map((c) => `${c.status.toUpperCase().padEnd(4)} ${c.title}: ${c.detail}`),
      ].join("\n");
      const stamp = new Date().toISOString();

      for (const to of emails) {
        const messageId = crypto.randomUUID();
        const unsubscribeToken = await ensureUnsubscribeToken(admin, to);
        await admin.from("email_send_log").insert({
          message_id: messageId,
          template_name: "payout-acceptance-checks",
          recipient_email: to,
          status: "pending",
          metadata: { subject, failing: failing.length, warnings: warning.length },
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
            label: "payout-acceptance-checks",
            idempotency_key: `payout-acceptance:${stamp.slice(0, 13)}:${to}`,
            unsubscribe_token: unsubscribeToken,
            queued_at: stamp,
          },
        });
        emailResults[to] = enqErr ? `error: ${enqErr.message}` : "queued";
        if (enqErr) console.error("[payout-acceptance-scan] enqueue error", to, enqErr);
      }
    }

    await admin.from("system_events").insert({
      event_type: "finance_anomaly_scan_completed",
      description: `Payout acceptance checks: ${failing.length} failing, ${warning.length} warning`,
      metadata: {
        source: "payout-acceptance-scan",
        trigger_source: triggerSource,
        window_days: windowDays,
        failing: failing.length,
        warnings: warning.length,
        total_checks: checks.length,
        failing_keys: failing.map((c) => c.check_key),
        email_results: emailResults,
      },
    });

    return new Response(
      JSON.stringify({
        trigger_source: triggerSource,
        window_days: windowDays,
        total_checks: checks.length,
        failing: failing.length,
        warnings: warning.length,
        failing_keys: failing.map((c) => c.check_key),
        notified: Object.values(emailResults).some((v) => v === "queued"),
        email_results: emailResults,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[payout-acceptance-scan]", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
