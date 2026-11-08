import "../_shared/smsFooterInterceptor.ts";
// Drains public.funder_house_progress_notices — SMS + email notices telling a
// Supporter that an agent was assigned, a tenant was placed, or their Returns
// have started. Queue rows carry a full snapshot, so no extra lookups here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { rateEmailTarget, rateOrNull, ratesPublicBeforeCutoff, readConfirmedLoginEmails } from "../_shared/partnerReturnPolicy.ts";

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

const DASHBOARD_URL = "https://welileapp.com/dashboard/funder";

// First monthly Returns date: one month after the money starts working,
// with the day capped at 28 so every month has it.
const firstReturnLabel = (baseIso: string | null): string => {
  const base = baseIso ? new Date(baseIso) : new Date();
  if (Number.isNaN(base.getTime())) return "";
  const day = Math.min(base.getUTCDate(), 28);
  const next = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, day));
  return dateLabel(next.toISOString());
};

function buildSms(row: {
  kind: string;
  partner_name: string | null;
  house_title: string | null;
  district: string | null;
  agent_name: string | null;
  monthly_return: number;
  placed_at: string | null;
}): string {
  const first = String(row.partner_name || "Partner").split(" ")[0];
  const house = row.house_title || "your funded house";
  const where = row.district ? ` in ${row.district}` : "";

  switch (row.kind) {
    case "tenant_placed":
      return `WELILE: ${first}, tenant placed in ${house}${where}. Returns follow as rent is paid. ${DASHBOARD_URL}`;
    case "earning_started":
      // No stored monthly Returns (no rate on the house or commitment) -> no figure.
      return row.monthly_return > 0
        ? `WELILE: ${first}, your Returns started: about ${ugx(row.monthly_return)}/month to your wallet. ${DASHBOARD_URL}`
        : `WELILE: ${first}, your Returns have started; see your dashboard. ${DASHBOARD_URL}`;
    default:
      return `WELILE: ${first}, ${row.agent_name || "an agent"} assigned to ${house}${where}; tenant within 7 days. ${DASHBOARD_URL}`;
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
    console.error("[funder-progress] Yoola error:", e);
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
    console.error("[funder-progress] AT error:", e);
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
  const noticeId: string | null = body?.notice_id ?? null;

  let q = admin
    .from("funder_house_progress_notices")
    .select("*")
    .or("sms_sent_at.is.null,email_sent_at.is.null")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (noticeId) q = q.eq("id", noticeId);

  const { data: rows, error } = await q;
  if (error) return json(500, { error: error.message });
  if (!rows?.length) return json(200, { processed: 0, sms_sent: 0, emails_sent: 0 });

  let smsSent = 0;
  let emailsSent = 0;
  const logRows: Record<string, unknown>[] = [];

  // The email states the partner's own rate and monthly Returns. Before the first switch-on every rate
  // is today's public rate: the row's email, as today. Afterwards it goes to the confirmed login email
  // (only the partner can change it); with none, to the profile email without figures (D4).
  // One RPC for the whole batch, and only when some row still needs its email. SMS keeps the
  // profile phone on the row (accepted residual, D4).
  const emailPartnerIds = [...new Set(
    (rows as any[]).filter((r) => !r.email_sent_at && r.partner_id).map((r) => String(r.partner_id)),
  )];
  const houseRatesPublic = (rows as any[]).some((r) => !r.email_sent_at) ? await ratesPublicBeforeCutoff(admin) : false;
  const loginEmails = emailPartnerIds.length && !houseRatesPublic
    ? await readConfirmedLoginEmails(admin, emailPartnerIds)
    : new Map<string, string>();

  for (const row of rows as any[]) {
    const patch: Record<string, unknown> = {};
    const monthlyReturn = Number(row.monthly_return) || 0;

    if (!row.sms_sent_at) {
      const phone = row.phone ? normalizePhone(row.phone) : "";
      if (!phone || phone.replace(/\D/g, "").length < 12) {
        patch.sms_error = "missing_partner_phone";
      } else {
        const message = buildSms({
          kind: row.kind,
          partner_name: row.partner_name,
          house_title: row.house_title,
          district: row.district,
          agent_name: row.agent_name,
          monthly_return: monthlyReturn,
          placed_at: row.placed_at,
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
          source: "notify-funder-house-progress",
        });
        if (outcome.ok) { smsSent++; patch.sms_sent_at = new Date().toISOString(); patch.sms_error = null; }
        else patch.sms_error = (outcome as any).reason ?? "sms_failed";
      }
    }

    if (!row.email_sent_at) {
      const target = rateEmailTarget(
        row.partner_id ? loginEmails.get(String(row.partner_id)) ?? null : null,
        row.email ?? null,
        houseRatesPublic,
      );
      if (!target.to) {
        patch.email_error = "missing_partner_email";
      } else {
        try {
          const { error: mailErr } = await admin.functions.invoke("send-transactional-email", {
            body: {
              template: "funder-house-progress",
              to: target.to,
              data: {
                kind: row.kind,
                partner_name: row.partner_name,
                house_title: row.house_title,
                district: row.district,
                house_count: Number(row.house_count) || 1,
                monthly_rent: Number(row.monthly_rent) || 0,
                principal: Number(row.principal) || 0,
                monthly_return: target.withFigures ? monthlyReturn : 0,
                agent_name: row.agent_name,
                placed_date: dateLabel(row.placed_at),
                first_return_date: firstReturnLabel(
                  row.earning_started_at ?? row.placed_at ?? row.created_at,
                ),
                return_rate: target.withFigures ? rateOrNull(row.return_rate) : null,
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
      await admin.from("funder_house_progress_notices").update(patch).eq("id", row.id);
    }
  }

  if (logRows.length) {
    const { error: logErr } = await admin.from("sms_delivery_log").insert(logRows);
    if (logErr) console.warn("[funder-progress] delivery log insert failed:", logErr.message);
  }

  return json(200, { processed: rows.length, sms_sent: smsSent, emails_sent: emailsSent });
});
