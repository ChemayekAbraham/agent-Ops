import "../_shared/smsFooterInterceptor.ts";
// Tells a partner, the moment a promissory note is created, which tenants are
// reserved for them and what they earn over the next 12 months.
//
// Fully DB-backed: rows are queued by public.psm_queue_promissory_pledge_notice()
// inside the note-creation transaction. This worker drains the queue in ONE
// round trip (the row already carries name/phone/email/tenants snapshot, so no
// N+1 lookups) and marks SMS + email independently sent/failed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function normalizePhone(raw: string): string {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "256" + d.slice(1);
  if (!d.startsWith("256") && d.length === 9) d = "256" + d;
  return "+" + d;
}

const ugx = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

function buildMessage(row: {
  partner_name: string | null;
  amount: number;
  attached_count: number;
  monthly_return: number;
  annual_return: number;
  activation_url: string;
}): string {
  const first = String(row.partner_name || "Partner").split(" ")[0];
  const tenantPart = row.attached_count > 0
    ? `${row.attached_count} tenant${row.attached_count === 1 ? "" : "s"} reserved for you. `
    : "";
  return (
    `WELILE: ${first}, your rent funding pledge of ${ugx(row.amount)} is ready. ${tenantPart}` +
    `You earn ${ugx(row.monthly_return)} monthly (${ugx(row.annual_return)} over 12 months). ` +
    `Fund it here: ${row.activation_url}`
  );
}

async function sendViaYoola(phone: string, message: string) {
  const apiKey = (Deno.env.get("YOOLA_SMS_API_KEY") || "").trim();
  if (!apiKey) return { ok: false, reason: "yoola_not_configured" };
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        phone: phone.replace(/\D/g, ""),
        message,
        api_key: apiKey,
        sender: "WELILE",
      }),
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* raw */ }
    const status = String(data?.status ?? "").toLowerCase();
    const accepted = res.ok &&
      (status === "success" || status === "ok" || status === "sent" || status === "queued" ||
        (!data?.error && status === ""));
    return accepted ? { ok: true } : { ok: false, reason: `yoola_${res.status}_${status || "rejected"}` };
  } catch (e) {
    console.error("[pledge-notice] Yoola error:", e);
    return { ok: false, reason: "network_error" };
  }
}

async function sendViaAfricasTalking(phone: string, message: string) {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) return { ok: false, reason: "missing_credentials" };
  const baseUrl = username.toLowerCase() === "sandbox"
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { apiKey, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ username, from: "WELILE", to: phone, message }).toString(),
    });
    return res.ok ? { ok: true } : { ok: false, reason: `at_http_${res.status}` };
  } catch (e) {
    console.error("[pledge-notice] AT error:", e);
    return { ok: false, reason: "network_error" };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const noteId = body?.note_id ? String(body.note_id) : null;
  const limit = Math.min(Number(body?.limit) || 50, 200);

  // One round trip: notice snapshot + the note's activation token.
  let q = admin
    .from("promissory_note_pledge_notices")
    .select(
      "id, note_id, partner_name, phone, email, amount, attached_count, attached_amount, monthly_return, annual_return, tenants, sms_status, email_status, attempts, promissory_notes!inner(agent_id)",
    )
    .lt("attempts", 5)
    .or("sms_status.eq.pending,email_status.eq.pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (noteId) q = q.eq("note_id", noteId);

  const { data: rows, error } = await q;
  if (error) return json(500, { error: error.message });
  if (!rows?.length) return json(200, { processed: 0, sms_sent: 0, emails_sent: 0 });

  const origin = "https://welileapp.com";
  let smsSent = 0;
  let emailsSent = 0;
  const logRows: Record<string, unknown>[] = [];

  for (const row of rows as any[]) {
    // Partners are sent to the public funder signup, carrying the recruiting
    // agent as ?ref=<uuid> so the attribution the page already reads is kept
    // (see pages/Onboarding.tsx — strict UUID, persisted across confirmation).
    const agentId = row.promissory_notes?.agent_id;
    const activationUrl = agentId
      ? `${origin}/funder-onboarding?ref=${agentId}`
      : `${origin}/funder-onboarding`;
    const patch: Record<string, unknown> = { attempts: (row.attempts || 0) + 1 };
    const errors: string[] = [];

    // ── SMS ────────────────────────────────────────────────────────────────
    if (row.sms_status === "pending") {
      const phone = row.phone ? normalizePhone(row.phone) : "";
      if (!phone || phone.replace(/\D/g, "").length < 12) {
        patch.sms_status = "skipped";
        errors.push("missing_partner_phone");
      } else {
        const message = buildMessage({
          partner_name: row.partner_name,
          amount: Number(row.amount) || 0,
          attached_count: Number(row.attached_count) || 0,
          monthly_return: Number(row.monthly_return) || 0,
          annual_return: Number(row.annual_return) || 0,
          activation_url: activationUrl,
        });
        let outcome = await sendViaYoola(phone, message);
        let provider = "yoola";
        if (!outcome.ok) {
          outcome = await sendViaAfricasTalking(phone, message);
          provider = "africastalking";
        }
        logRows.push({
          recipient_phone: phone,
          recipient_name: row.partner_name,
          message,
          provider,
          status: outcome.ok ? "accepted" : "failed",
          error: outcome.ok ? null : (outcome as any).reason ?? null,
          reference_id: row.id,
          source: "notify-promissory-note-pledge",
        });
        if (outcome.ok) { smsSent++; patch.sms_status = "sent"; }
        else errors.push((outcome as any).reason ?? "sms_failed");
      }
    }

    // ── Email ──────────────────────────────────────────────────────────────
    if (row.email_status === "pending") {
      if (!row.email) {
        patch.email_status = "skipped";
      } else {
        try {
          const { error: mailErr } = await admin.functions.invoke("send-transactional-email", {
            body: {
              template: "promissory-note-pledge",
              to: row.email,
              data: {
                partner_name: row.partner_name,
                amount: Number(row.amount) || 0,
                attached_count: Number(row.attached_count) || 0,
                attached_amount: Number(row.attached_amount) || 0,
                monthly_return_amount: Number(row.monthly_return) || 0,
                annual_return_amount: Number(row.annual_return) || 0,
                roi_percentage: 15,
                term_months: 12,
                tenants: row.tenants ?? [],
                activation_url: activationUrl,
                currency: "UGX",
              },
            },
          });
          if (mailErr) throw mailErr;
          emailsSent++;
          patch.email_status = "sent";
        } catch (e) {
          errors.push(`email_${String((e as Error)?.message || "failed").slice(0, 120)}`);
        }
      }
    }

    patch.last_error = errors.length ? errors.join("; ") : null;
    if (patch.sms_status === undefined && row.sms_status === "pending" && (row.attempts || 0) + 1 >= 5) {
      patch.sms_status = "failed";
    }
    if (patch.email_status === undefined && row.email_status === "pending" && (row.attempts || 0) + 1 >= 5) {
      patch.email_status = "failed";
    }

    await admin.from("promissory_note_pledge_notices").update(patch).eq("id", row.id);
  }

  if (logRows.length) {
    const { error: logErr } = await admin.from("sms_delivery_log").insert(logRows);
    if (logErr) console.warn("[pledge-notice] delivery log insert failed:", logErr.message);
  }

  return json(200, { processed: rows.length, sms_sent: smsSent, emails_sent: emailsSent });
});
