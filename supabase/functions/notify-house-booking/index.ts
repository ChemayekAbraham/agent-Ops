import "../_shared/smsFooterInterceptor.ts";
// Drains public.promissory_house_booking_notices — SMS + email notices for a
// Supporter's empty-house bookings (booked / funded / reminder / released / given up).
// The queue rows carry a full snapshot (name, phone, email, houses), so this
// worker needs no extra lookups. SMS and email are marked independently.
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

const dateLabel = (iso: string | null) => {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "";
  }
};

const DASHBOARD_URL = "https://welileapp.com/dashboard/supporter";

function buildSms(row: {
  kind: string;
  partner_name: string | null;
  house_count: number;
  total_rent: number;
  release_at: string | null;
  promised_funding_date: string | null;
  days_left: number | null;
}): string {
  const first = String(row.partner_name || "Partner").split(" ")[0];
  const n = row.house_count;
  const houses = `${n} house${n === 1 ? "" : "s"}`;
  const rent = ugx(row.total_rent);
  const hold = dateLabel(row.release_at);
  const d = row.days_left ?? 0;

  switch (row.kind) {
    case "funded":
      return `WELILE: ${first}, thank you. Your funding for ${houses} (${rent}) is submitted for review. Agents will place tenants once approved. ${DASHBOARD_URL}`;
    case "reminder":
      return `WELILE: ${first}, ${houses} (${rent}) you booked are still unfunded. We release them on ${hold} - ${d} day${d === 1 ? "" : "s"} left. ${DASHBOARD_URL}`;
    case "released":
      return `WELILE: ${first}, your 7-day hold on ${houses} (${rent}) has ended and they are back on the open empty-house list. Book again anytime: ${DASHBOARD_URL}`;
    case "given_up":
      return `WELILE: ${first}, you released ${houses} (${rent}). They are back on the open empty-house list. ${DASHBOARD_URL}`;
    default:
      return `WELILE: ${first}, we are holding ${houses} (${rent}) for you until ${hold}${
        row.promised_funding_date ? `. You promised funding by ${dateLabel(row.promised_funding_date)}` : ""
      }. ${DASHBOARD_URL}`;
  }
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
    console.error("[house-booking] Yoola error:", e);
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
    console.error("[house-booking] AT error:", e);
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

  let q = admin
    .from("promissory_house_booking_notices")
    .select("*")
    .or("sms_sent_at.is.null,email_sent_at.is.null")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (noteId) q = q.eq("note_id", noteId);

  const { data: rows, error } = await q;
  if (error) return json(500, { error: error.message });
  if (!rows?.length) return json(200, { processed: 0, sms_sent: 0, emails_sent: 0 });

  let smsSent = 0;
  let emailsSent = 0;
  const logRows: Record<string, unknown>[] = [];

  for (const row of rows as any[]) {
    const patch: Record<string, unknown> = {};
    const houseCount = Number(row.house_count) || 0;
    const totalRent = Number(row.total_rent) || 0;
    const monthlyReturn = Math.round(totalRent * 0.15);

    if (!row.sms_sent_at) {
      const phone = row.phone ? normalizePhone(row.phone) : "";
      if (!phone || phone.replace(/\D/g, "").length < 12) {
        patch.sms_error = "missing_partner_phone";
      } else {
        const message = buildSms({
          kind: row.kind,
          partner_name: row.partner_name,
          house_count: houseCount,
          total_rent: totalRent,
          release_at: row.release_at,
          promised_funding_date: row.promised_funding_date,
          days_left: row.days_left,
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
          source: "notify-house-booking",
        });
        if (outcome.ok) { smsSent++; patch.sms_sent_at = new Date().toISOString(); patch.sms_error = null; }
        else patch.sms_error = (outcome as any).reason ?? "sms_failed";
      }
    }

    if (!row.email_sent_at) {
      if (!row.email) {
        patch.email_error = "missing_partner_email";
      } else {
        try {
          const { error: mailErr } = await admin.functions.invoke("send-transactional-email", {
            body: {
              template: "funder-house-booking",
              to: row.email,
              data: {
                kind: row.kind,
                partner_name: row.partner_name,
                house_count: houseCount,
                total_rent: totalRent,
                monthly_return: monthlyReturn,
                promised_funding_date: dateLabel(row.promised_funding_date),
                release_date: dateLabel(row.release_at),
                days_left: Number(row.days_left) || 0,
                first_return_date: firstReturnLabel(row.promised_funding_date ?? row.funded_at ?? row.created_at),
                return_rate: 15,
                houses: row.houses ?? [],
                dashboard_url: DASHBOARD_URL,

                currency: "UGX",
              },
            },
          });
          if (mailErr) throw mailErr;
          emailsSent++;
          patch.email_sent_at = new Date().toISOString();
          patch.email_error = null;
        } catch (e) {
          patch.email_error = String((e as Error)?.message || "email_failed").slice(0, 160);
        }
      }
    }

    if (Object.keys(patch).length) {
      await admin.from("promissory_house_booking_notices").update(patch).eq("id", row.id);
    }
  }

  if (logRows.length) {
    const { error: logErr } = await admin.from("sms_delivery_log").insert(logRows);
    if (logErr) console.warn("[house-booking] delivery log insert failed:", logErr.message);
  }

  return json(200, { processed: rows.length, sms_sent: smsSent, emails_sent: emailsSent });
});
