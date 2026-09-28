// Emails every logged rent-amount change to the finance watch address.
// Reads unnotified rows from `rent_amount_change_log`, enqueues one email
// summarising them, then stamps notified_at so nothing is sent twice.

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
// Rent fee edit alerts go to ssenkaali.pius@welile.com ONLY.
// Do NOT source recipients from finance_anomaly_alert_config.
const DEFAULT_RECIPIENTS = ["ssenkaali.pius@welile.com"];
const DEFAULT_PHONES: string[] = [];

const fmtUGX = (n: unknown) =>
  `UGX ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

interface ChangeRow {
  id: string;
  rent_request_id: string;
  tenant_id: string | null;
  agent_id: string | null;
  old_rent_amount: number | null;
  new_rent_amount: number | null;
  old_total_repayment: number | null;
  new_total_repayment: number | null;
  old_duration_days: number | null;
  new_duration_days: number | null;
  old_access_fee: number | null;
  new_access_fee: number | null;
  old_request_fee: number | null;
  new_request_fee: number | null;
  old_daily_repayment: number | null;
  new_daily_repayment: number | null;
  changed_fields: string[] | null;
  status: string | null;
  changed_by: string | null;
  changed_at: string;
  source: string | null;
}

/**
 * A row is worth an email when it is a change to the RENT PLAN, not an ordinary
 * collection.
 *
 * Every agent collection moves `amount_repaid` and therefore writes a log row —
 * 4,005 of them in the last 60 days against 318 genuine ops edits. Mailing
 * those buried the changes that matter. A collection is the case where
 * amount_repaid moved ON ITS OWN and no door labelled itself, so that is the
 * only case excluded. Anything with a `source` (a CFO-approved balance edit, an
 * agent correcting a rejected or renewal plan) or any change to the plan's terms
 * is reported.
 */
const isRentPlanChange = (r: ChangeRow): boolean => {
  if (r.source) return true;
  const fields = r.changed_fields ?? [];
  return !(fields.length === 1 && fields[0] === "amount_repaid");
};

const SOURCE_LABEL: Record<string, string> = {
  cfo_approved_tenant_ops_balance: "Tenant Ops balance edit — CFO approved",
  cfo_approved_tenant_ops_correction: "Tenant Ops plan correction — CFO approved",
  cfo_approved_ops_payment_edit: "Ops payment edit — CFO approved",
  agent_rent_plan_edit: "Agent — rejected or renewal plan",
};

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  try {
    let recipients = DEFAULT_RECIPIENTS;
    const phones = DEFAULT_PHONES;
    try {
      const body = await req.json();
      if (Array.isArray(body?.recipients) && body.recipients.length) {
        recipients = body.recipients.filter((r: unknown) => typeof r === "string");
      }
    } catch (_) { /* no body — use defaults */ }

    const { data, error } = await admin
      .from("rent_amount_change_log")
      .select(
        "id, rent_request_id, tenant_id, agent_id, old_rent_amount, new_rent_amount, old_total_repayment, new_total_repayment, old_duration_days, new_duration_days, old_access_fee, new_access_fee, old_request_fee, new_request_fee, old_daily_repayment, new_daily_repayment, changed_fields, status, changed_by, changed_at, source",
      )
      .is("notified_at", null)
      .order("changed_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(`log fetch failed: ${error.message}`);

    const fetched = (data ?? []) as ChangeRow[];
    const rows = fetched.filter(isRentPlanChange);
    const skipped = fetched.filter((r) => !isRentPlanChange(r));

    // Collections are marked seen even though nobody is mailed about them,
    // otherwise they sit at the front of the queue forever and crowd out the
    // rows that do matter.
    if (skipped.length) {
      await admin
        .from("rent_amount_change_log")
        .update({ notified_at: new Date().toISOString() })
        .in("id", skipped.map((r) => r.id));
    }

    if (!rows.length) {
      return new Response(
        JSON.stringify({ notified: 0, skipped_collections: skipped.length, reason: "no new rent plan changes" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const ids = [
      ...new Set(
        rows.flatMap((r) => [r.tenant_id, r.agent_id, r.changed_by].filter(Boolean) as string[]),
      ),
    ];
    const { data: profiles } = ids.length
      ? await admin.from("profiles").select("id, full_name, phone").in("id", ids)
      : { data: [] as { id: string; full_name: string | null; phone: string | null }[] };
    const nameById = new Map(
      (profiles ?? []).map((p: { id: string; full_name: string | null }) => [p.id, p.full_name ?? "—"]),
    );

    const FIELD_LABELS: Record<string, string> = {
      rent_amount: "Rent",
      duration_days: "Term (days)",
      access_fee: "Access fee",
      request_fee: "Request fee",
      total_repayment: "Total repayment",
      daily_repayment: "Daily amount",
    };
    const changeDetail = (r: ChangeRow): string => {
      const parts: string[] = [];
      const fields = r.changed_fields?.length
        ? r.changed_fields
        : ["rent_amount", "total_repayment"];
      for (const f of fields) {
        const label = FIELD_LABELS[f] ?? f;
        if (f === "duration_days") {
          parts.push(`${label}: ${r.old_duration_days ?? "—"} → ${r.new_duration_days ?? "—"}`);
          continue;
        }
        const oldV = (r as unknown as Record<string, unknown>)[`old_${f}`];
        const newV = (r as unknown as Record<string, unknown>)[`new_${f}`];
        parts.push(`${label}: ${fmtUGX(oldV)} → ${fmtUGX(newV)}`);
      }
      return parts.join(" · ");
    };

    const subject = `Rent fees changed — ${rows.length} rent plan${rows.length === 1 ? "" : "s"}`;
    const body = rows
      .map((r) => {
        const delta = Number(r.new_rent_amount ?? 0) - Number(r.old_rent_amount ?? 0);
        const color = delta === 0 ? "#4b5563" : delta > 0 ? "#15803d" : "#b91c1c";
        return `<tr>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(nameById.get(r.tenant_id ?? "") ?? "—")}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(nameById.get(r.agent_id ?? "") ?? "—")}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmtUGX(r.old_rent_amount)}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">${fmtUGX(r.new_rent_amount)}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:${color}">${delta > 0 ? "+" : ""}${fmtUGX(delta)}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmtUGX(r.new_total_repayment)}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(changeDetail(r))}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(r.status)}</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(nameById.get(r.changed_by ?? "") ?? "System")}${
    r.source ? `<div style="color:#667;font-size:11px">${esc(SOURCE_LABEL[r.source] ?? r.source)}</div>` : ""
  }</td>
  <td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap">${esc(new Date(r.changed_at).toISOString().replace("T", " ").slice(0, 16))} UTC</td>
</tr>`;
      })
      .join("");

    const html = `<div style="font:14px system-ui;color:#111;max-width:900px">
  <h2 style="margin:0 0 6px;font:700 18px system-ui">Rent fees changed</h2>
  <p style="margin:0 0 4px;color:#555">Every admin change to a tenant's rent amount, term, access fee, request fee, total repayment or daily amount is logged and reported here. Fees, total repayment and the daily amount are recalculated automatically on each change.</p>
  <table style="width:100%;border-collapse:collapse;font:13px system-ui;margin-top:14px">
    <thead><tr style="background:#f6f6f6;text-align:left">
      <th style="padding:6px 10px">Tenant</th>
      <th style="padding:6px 10px">Agent</th>
      <th style="padding:6px 10px;text-align:right">Old rent</th>
      <th style="padding:6px 10px;text-align:right">New rent</th>
      <th style="padding:6px 10px;text-align:right">Change</th>
      <th style="padding:6px 10px;text-align:right">New total repayment</th>
      <th style="padding:6px 10px">Fields changed</th>
      <th style="padding:6px 10px">Status</th>
      <th style="padding:6px 10px">Changed by</th>
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
          `${nameById.get(r.tenant_id ?? "") ?? "—"}: ${changeDetail(r)} by ${nameById.get(r.changed_by ?? "") ?? "System"} at ${r.changed_at}`,
      ),
    ].join("\n");

    const stamp = new Date().toISOString();
    const results: Record<string, string> = {};
    for (const to of recipients) {
      const messageId = crypto.randomUUID();
      const unsubscribeToken = await ensureUnsubscribeToken(admin, to);
      await admin.from("email_send_log").insert({
        message_id: messageId,
        template_name: "rent-amount-change",
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
          label: "rent-amount-change",
          idempotency_key: `rent-amount-change:${rows[0].id}:${to}`,
          unsubscribe_token: unsubscribeToken,
          queued_at: stamp,
        },
      });
      results[to] = enqErr ? `error: ${enqErr.message}` : "queued";
      if (enqErr) console.error("[rent-amount-change-notify] enqueue error", to, enqErr);
    }

    const smsBody = [
      `WELILE: ${rows.length} rent fee edit${rows.length === 1 ? "" : "s"}.`,
      ...rows.slice(0, 3).map(
        (r) => `${nameById.get(r.tenant_id ?? "") ?? "tenant"} — ${changeDetail(r)}`,
      ),
      rows.length > 3 ? `+${rows.length - 3} more. Check email report.` : "",
    ].filter(Boolean).join(" | ").slice(0, 480);

    const smsResults: Record<string, string> = {};
    for (const phone of phones) {
      try {
        const ok = await sendSMS(phone, smsBody, {
          admin,
          source: "rent-amount-change-notify",
          reference_id: rows[0].id,
          idempotencyKey: `rent-fee-change:${rows[0].id}:${phone}`,
        });
        smsResults[phone] = ok ? "sent" : "failed";
      } catch (e) {
        smsResults[phone] = `error: ${(e as Error)?.message ?? e}`;
      }
    }

    if (Object.values(results).some((v) => v === "queued")) {
      await admin
        .from("rent_amount_change_log")
        .update({ notified_at: stamp })
        .in("id", rows.map((r) => r.id));
    }

    return new Response(JSON.stringify({ notified: rows.length, skipped_collections: skipped.length, email_results: results, sms_results: smsResults }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[rent-amount-change-notify]", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
