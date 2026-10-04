import "../_shared/smsFooterInterceptor.ts";
// Warns a partner 4 days before their reserved (booked) tenant plans are released
// back to the general funding queue — the 7-day promissory booking window.
//
// Fully DB-backed: public.psm_queue_promissory_release_warnings() queues rows
// (name/phone/email/tenants snapshot included, so no N+1 lookups here). This
// worker drains the queue in ONE round trip and marks SMS + email independently.
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

const dateLabel = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "";
  }
};

function buildMessage(row: {
  partner_name: string | null;
  booked_count: number;
  booked_amount: number;
  days_left: number;
  release_at: string;
  activation_url: string;
}): string {
  const first = String(row.partner_name || "Partner").split(" ")[0];
  const d = row.days_left;
  return (
    `WELILE: ${first}, ${row.booked_count} tenant${row.booked_count === 1 ? "" : "s"} (${ugx(row.booked_amount)}) ` +
    `are still held for your pledge. We release them on ${dateLabel(row.release_at)} - ${d} day${d === 1 ? "" : "s"} left. ` +
    `Complete your funding: ${row.activation_url}`
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
    console.error("[release-notice] Yoola error:", e);
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
    console.error("[release-notice] AT error:", e);
    return { ok: false, reason: "network_error" };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: any = {};
  try { body = await req.json(); } catch { /* cron sends nothing */ }
  const limit = Math.min(Math.max(Number(body?.limit) || 40, 1), 200);
  const noteId: string | null = body?.note_id ?? null;

  // Queue fresh warnings first (idempotent, set-based), then drain.
  if (body?.skip_queue !== true) {
    const { error: qErr } = await admin.rpc("psm_queue_promissory_release_warnings");
    if (qErr) console.warn("[release-notice] queue rpc failed:", qErr.message);
  }

  let q = admin
    .from("promissory_note_release_notices")
    .select("*, promissory_notes!inner(activation_token, approved_at)")
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
    const patch: Record<string, unknown> = { attempts: (row.attempts || 0) + 1 };
    const errors: string[] = [];

    // Already funded/approved in the meantime — nothing to warn about.
    if (row.promissory_notes?.approved_at) {
      await admin.from("promissory_note_release_notices")
        .update({ sms_status: "skipped", email_status: "skipped", last_error: "note_already_approved" })
        .eq("id", row.id);
      continue;
    }

    const token = row.promissory_notes?.activation_token;
    const activationUrl = token ? `${origin}/activate?token=${token}` : `${origin}/activate`;

    if (row.sms_status === "pending") {
      const phone = row.phone ? normalizePhone(row.phone) : "";
      if (!phone || phone.replace(/\D/g, "").length < 12) {
        patch.sms_status = "skipped";
        errors.push("missing_partner_phone");
      } else {
        const message = buildMessage({
          partner_name: row.partner_name,
          booked_count: Number(row.booked_count) || 0,
          booked_amount: Number(row.booked_amount) || 0,
          days_left: Number(row.days_left) || 4,
          release_at: row.release_at,
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
          source: "notify-promissory-note-release",
        });
        if (outcome.ok) { smsSent++; patch.sms_status = "sent"; }
        else errors.push((outcome as any).reason ?? "sms_failed");
      }
    }

    if (row.email_status === "pending") {
      if (!row.email) {
        patch.email_status = "skipped";
      } else {
        try {
          const { error: mailErr } = await admin.functions.invoke("send-transactional-email", {
            body: {
              template: "promissory-note-release-warning",
              to: row.email,
              data: {
                partner_name: row.partner_name,
                amount: Number(row.amount) || 0,
                booked_count: Number(row.booked_count) || 0,
                booked_amount: Number(row.booked_amount) || 0,
                days_left: Number(row.days_left) || 4,
                release_date: dateLabel(row.release_at),
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

    await admin.from("promissory_note_release_notices").update(patch).eq("id", row.id);
  }

  if (logRows.length) {
    const { error: logErr } = await admin.from("sms_delivery_log").insert(logRows);
    if (logErr) console.warn("[release-notice] delivery log insert failed:", logErr.message);
  }

  return json(200, { processed: rows.length, sms_sent: smsSent, emails_sent: emailsSent });
});
