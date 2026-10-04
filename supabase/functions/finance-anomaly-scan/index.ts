// Finance / wallet anomaly monitoring + classified executive notification.
//
// Runs `run_finance_anomaly_scan(trigger_source)`. The RPC classifies every
// finding into exactly one category (financial_integrity, business_rule,
// operational, comparator, presentation, monitoring), computes a per-category
// count / exposure / severity, applies materiality routing, and fingerprints
// the scan so unchanged findings never page an executive twice.
//
// Notification channel comes from the RPC (`notify_channel`):
//   sms       -> executive SMS + email (genuine, material financial incident)
//   email     -> executive email only (operational / business-rule findings)
//   dashboard -> stored only (comparator, monitoring, presentation, historical)
//   heartbeat -> stored only (identical fingerprint, nothing changed)
//   none      -> clean scan
//
// Body: { trigger_source?: string, force?: boolean }
//   force=true emails the report regardless of channel.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const FROM = "Welile Reports <info@welile.com>";
const SENDER_DOMAIN = "notify.welile.com";

interface Check {
  key: string;
  label: string;
  category: string;
  channel: string;
  severity: string;
  count: number;
  amount: number;
  historical?: boolean;
  sample?: unknown[];
}

interface CategoryRollup {
  category: string;
  count: number;
  exposure: number;
  severity: string;
}

const CATEGORY_ORDER = [
  "financial_integrity",
  "business_rule",
  "operational",
  "comparator",
  "presentation",
  "monitoring",
];

const CATEGORY_LABEL: Record<string, string> = {
  financial_integrity: "Financial Integrity",
  business_rule: "Business Rule",
  operational: "Operational Issues",
  comparator: "Comparator Issues",
  presentation: "Presentation Issues",
  monitoring: "Monitoring Issues",
};

function fmtUGX(n: unknown): string {
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

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#b42318",
  high: "#b54708",
  medium: "#854a0e",
  low: "#475467",
  clean: "#067647",
};

function checkRow(c: Check): string {
  const clean = c.count === 0;
  return `<tr>
  <td style="padding:8px 10px;border-bottom:1px solid #eee">${esc(c.label)}${c.historical ? " <em>(historical)</em>" : ""}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right">${c.count}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right">${clean ? "—" : fmtUGX(c.amount)}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;text-transform:uppercase;color:${SEVERITY_COLOR[c.severity] ?? "#333"};font-weight:600">${clean ? "clean" : esc(c.severity)}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#667085">${esc(clean ? "—" : c.channel)}</td>
</tr>`;
}

function sampleBlock(c: Check): string {
  const rows = (c.sample ?? []) as Record<string, unknown>[];
  if (!c.count || !rows.length) return "";
  const items = rows
    .map(
      (r) =>
        `<li style="margin:2px 0;font:12px ui-monospace,monospace;color:#444">${esc(
          Object.entries(r)
            .map(([k, v]) => `${k}=${typeof v === "number" ? Math.round(v) : v}`)
            .join("  "),
        )}</li>`,
    )
    .join("");
  return `<h4 style="margin:16px 0 4px;font:600 13px system-ui">${esc(c.label)} — first ${rows.length}</h4>
<ul style="margin:0;padding-left:18px">${items}</ul>`;
}

function categorySection(cat: string, rollup: CategoryRollup | undefined, checks: Check[]): string {
  const scoped = checks.filter((c) => c.category === cat);
  if (!scoped.length) return "";
  const count = rollup?.count ?? 0;
  const severity = rollup?.severity ?? "clean";
  const exposure = rollup?.exposure ?? 0;
  const isFinancial = cat === "financial_integrity";
  return `<div style="margin:0 0 18px;border:1px solid #eaecf0;border-radius:10px;overflow:hidden">
  <div style="padding:10px 12px;background:#f9fafb;display:flex;justify-content:space-between">
    <strong style="font:600 14px system-ui">${esc(CATEGORY_LABEL[cat] ?? cat)}</strong>
    <span style="font:12px system-ui;color:${SEVERITY_COLOR[severity] ?? "#333"};text-transform:uppercase;font-weight:600">${esc(severity)}</span>
  </div>
  <div style="padding:8px 12px;font:13px system-ui;color:#475467">
    Findings: <strong>${count}</strong> ·
    ${isFinancial ? "Financial exposure" : "Reported amount (not financial exposure)"}: <strong>${fmtUGX(exposure)}</strong>
  </div>
  <table style="width:100%;border-collapse:collapse;font:13px system-ui">
    <tbody>${scoped.map(checkRow).join("")}</tbody>
  </table>
</div>`;
}

function buildHtml(
  report: Record<string, unknown>,
  checks: Check[],
  rollups: CategoryRollup[],
  triggerSource: string,
): string {
  const finSeverity = String(report.financial_severity ?? "clean");
  const byCat = new Map(rollups.map((r) => [r.category, r]));
  const failing = checks.filter((c) => c.count > 0);
  const actionRequired = report.action_required === true;
  return `<div style="font:14px system-ui;color:#111;max-width:860px">
  <h2 style="margin:0 0 4px;font:700 18px system-ui">
    Finance monitoring report — Financial integrity:
    <span style="color:${SEVERITY_COLOR[finSeverity] ?? "#333"};text-transform:uppercase">${esc(finSeverity)}</span>
  </h2>
  <p style="margin:0 0 14px;color:#555">
    Trigger: <strong>${esc(triggerSource)}</strong> ·
    Scanned: ${esc(report.scanned_at)} ·
    Threshold: ${fmtUGX(report.min_amount)} ·
    SMS materiality: ${fmtUGX(report.sms_materiality_ugx)} ·
    Channel: <strong>${esc(report.notify_channel)}</strong>
  </p>
  <p style="margin:0 0 18px;padding:10px 12px;border-radius:8px;background:${actionRequired ? "#fef3f2" : "#ecfdf3"};color:${actionRequired ? "#b42318" : "#067647"};font-weight:600">
    Financial integrity: ${Number(report.financial_count ?? 0)} finding(s), ${fmtUGX(report.financial_exposure)} ·
    Executive action required: ${actionRequired ? "YES" : "No"}
  </p>
  ${CATEGORY_ORDER.map((cat) => categorySection(cat, byCat.get(cat), checks)).join("")}
  <p style="margin:0 0 14px;color:#667085;font-size:12px">
    Reason this report was generated: ${esc(report.notification_reason)}
  </p>
  ${failing.map(sampleBlock).join("")}
  <p style="margin:22px 0 0;color:#777;font-size:12px">
    Comparator, monitoring and presentation findings are monitoring-layer issues and are never
    counted as financial exposure. Ledger remains the source of truth — never correct a wallet with
    a direct update. Review in CFO dashboard → Reconciliation → Finance monitoring.
  </p>
</div>`;
}

function buildSms(report: Record<string, unknown>, rollups: CategoryRollup[]): string {
  const byCat = new Map(rollups.map((r) => [r.category, r]));
  const fin = byCat.get("financial_integrity");
  const lines: string[] = ["WELILE FINANCE ALERT"];

  lines.push("Financial Integrity");
  if (!fin || fin.count === 0) {
    lines.push("No active financial integrity incidents.");
  } else {
    lines.push(
      `${fin.count} ${fin.severity} finding(s) affecting ${fmtUGX(fin.exposure)}.`,
    );
  }

  for (const cat of ["business_rule", "operational"]) {
    const r = byCat.get(cat);
    if (r && r.count > 0) {
      lines.push(`${CATEGORY_LABEL[cat]}: ${r.count} (${fmtUGX(r.exposure)}).`);
    }
  }

  const monitoring = (byCat.get("comparator")?.count ?? 0) +
    (byCat.get("monitoring")?.count ?? 0) +
    (byCat.get("presentation")?.count ?? 0);
  if (monitoring > 0) {
    lines.push(`Monitoring Issues: ${monitoring} (no financial exposure).`);
  }

  lines.push(
    `Executive action required: ${report.action_required === true ? "YES" : "No"}.`,
  );
  return lines.join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  try {
    let body: { trigger_source?: string; force?: boolean } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const triggerSource = String(body.trigger_source ?? "manual").slice(0, 40);
    const force = body.force === true;

    const { data: cfg } = await admin
      .from("finance_anomaly_alert_config")
      .select("enabled, min_amount, notify_emails, notify_phones")
      .eq("id", 1)
      .maybeSingle();

    if (cfg && cfg.enabled === false) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "alerts disabled in config" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: scan, error: scanErr } = await admin.rpc("run_finance_anomaly_scan", {
      p_trigger_source: triggerSource,
    });
    if (scanErr) throw new Error(`scan failed: ${scanErr.message}`);

    const report = (scan ?? {}) as Record<string, unknown>;
    const checks = ((report.checks ?? []) as Check[]).map((c) => ({
      ...c,
      count: Number(c.count ?? 0),
      amount: Number(c.amount ?? 0),
    }));
    const rollups = ((report.categories ?? []) as CategoryRollup[]).map((r) => ({
      ...r,
      count: Number(r.count ?? 0),
      exposure: Number(r.exposure ?? 0),
    }));
    const anomalyCount = Number(report.anomaly_count ?? 0);
    const scanId = report.scan_id as string | undefined;
    const channel = String(report.notify_channel ?? "none");
    const reason = String(report.notification_reason ?? "");

    // Materiality + fingerprint gate. The scan is always persisted by the RPC,
    // so suppressed runs remain fully auditable (monitoring heartbeat).
    const shouldEmail = force || channel === "sms" || channel === "email";
    const shouldSms = channel === "sms";

    if (!shouldEmail && !shouldSms) {
      if (scanId) {
        await admin
          .from("finance_anomaly_scans")
          .update({
            notified: false,
            notifications_sent: { channel, email: [], sms: [] },
          })
          .eq("id", scanId);
      }
      return new Response(
        JSON.stringify({
          scan_id: scanId,
          financial_severity: report.financial_severity,
          financial_exposure: report.financial_exposure,
          anomaly_count: anomalyCount,
          notify_channel: channel,
          notified: false,
          reason,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- recipients ----
    const emails = ((cfg?.notify_emails as string[] | null) ?? []).filter(Boolean);
    // Explicit allow-list only. NO role-based fallback broadcast: an empty
    // notify_phones means "send no SMS", never "SMS every CFO/CTO".
    const phones = Array.from(
      new Set(((cfg?.notify_phones as string[] | null) ?? []).filter(Boolean)),
    );

    const finCount = Number(report.financial_count ?? 0);
    const subject =
      `Finance monitoring — financial integrity ${String(report.financial_severity ?? "clean").toUpperCase()} · ` +
      `${finCount} incident${finCount === 1 ? "" : "s"} · ${fmtUGX(report.financial_exposure)} · ` +
      `${anomalyCount} total finding${anomalyCount === 1 ? "" : "s"} (${triggerSource})`;

    const html = buildHtml(report, checks, rollups, triggerSource);
    const text = [
      subject,
      "",
      `Executive action required: ${report.action_required === true ? "YES" : "No"}`,
      `Reason: ${reason}`,
      "",
      ...rollups.map(
        (r) => `${(CATEGORY_LABEL[r.category] ?? r.category).padEnd(22)} ${r.count} · ${fmtUGX(r.exposure)} · ${r.severity}`,
      ),
      "",
      ...checks.map(
        (c) => `${c.count === 0 ? "OK  " : "FAIL"} [${c.category}] ${c.label}: ${c.count} · ${fmtUGX(c.amount)} · ${c.severity}`,
      ),
    ].join("\n");

    const stamp = new Date().toISOString();
    const emailResults: Record<string, string> = {};
    if (shouldEmail) {
      for (const to of emails) {
        const messageId = crypto.randomUUID();
        const unsubscribeToken = await ensureUnsubscribeToken(admin, to);
        await admin.from("email_send_log").insert({
          message_id: messageId,
          template_name: "finance-anomaly-report",
          recipient_email: to,
          status: "pending",
          metadata: {
            subject,
            scan_id: scanId,
            anomalies: anomalyCount,
            financial_count: finCount,
            channel,
          },
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
            label: "finance-anomaly-report",
            idempotency_key: `finance-anomaly:${scanId ?? stamp}:${to}`,
            unsubscribe_token: unsubscribeToken,
            queued_at: stamp,
          },
        });
        emailResults[to] = enqErr ? `error: ${enqErr.message}` : "queued";
        if (enqErr) console.error("[finance-anomaly-scan] enqueue error", to, enqErr);
      }
    }

    const smsResults: Record<string, string> = {};
    if (shouldSms) {
      const smsBody = buildSms(report, rollups);
      for (const phone of phones) {
        try {
          const ok = await sendSMS(phone, smsBody, {
            admin,
            source: "finance-anomaly-scan",
            reference_id: scanId ?? null,
            idempotencyKey: `finance-anomaly:${scanId ?? stamp}:${phone}`,
          });
          smsResults[phone] = ok ? "sent" : "failed";
        } catch (e) {
          smsResults[phone] = `error: ${(e as Error)?.message ?? e}`;
        }
      }
    }

    const anyEmail = Object.values(emailResults).some((v) => v === "queued");
    const anySms = Object.values(smsResults).some((v) => v === "sent");

    if (scanId) {
      await admin
        .from("finance_anomaly_scans")
        .update({
          email_recipients: shouldEmail ? emails : [],
          sms_recipients: shouldSms ? phones : [],
          notified: anyEmail || anySms,
          notifications_sent: {
            channel,
            email: emailResults,
            sms: smsResults,
          },
          notify_error:
            anyEmail || anySms || (!shouldEmail && !shouldSms)
              ? null
              : `email=${JSON.stringify(emailResults)} sms=${JSON.stringify(smsResults)}`,
        })
        .eq("id", scanId);
    }

    await admin.from("system_events").insert({
      event_type: "finance_anomaly_scan_completed",
      metadata: {
        scan_id: scanId,
        trigger_source: triggerSource,
        notify_channel: channel,
        notification_reason: reason,
        financial_severity: report.financial_severity,
        financial_count: finCount,
        financial_exposure: report.financial_exposure,
        anomaly_count: anomalyCount,
        categories: rollups,
        email_results: emailResults,
        sms_results: smsResults,
      },
    });

    return new Response(
      JSON.stringify({
        scan_id: scanId,
        notify_channel: channel,
        notification_reason: reason,
        financial_severity: report.financial_severity,
        financial_count: finCount,
        financial_exposure: report.financial_exposure,
        anomaly_count: anomalyCount,
        categories: rollups,
        email_results: emailResults,
        sms_results: smsResults,
        notified: anyEmail || anySms,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[finance-anomaly-scan]", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
