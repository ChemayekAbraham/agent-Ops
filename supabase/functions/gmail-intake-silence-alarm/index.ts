// Silence alarm for the MoMo SMS -> IFTTT -> Gmail deposit-intake chain.
//
// gmail-poll-heartbeat only proves the POLLER is alive. When the phone that
// forwards MoMo SMS goes offline the poller keeps running happily and simply
// finds nothing, so no alert fires. This function watches the thing that
// actually matters: how long since a deposit ("in") email was last ingested
// into gmail_transactions. If that exceeds the threshold during active hours
// it emails AND SMSes the configured people, and repeats hourly until intake
// resumes, then sends one recovery notice.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";
import { requireServiceRole } from "../_shared/requireServiceRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FROM = "Welile Reports <info@welile.com>";
const SENDER_DOMAIN = "notify.welile.com";

// Fixed sentinel so repeated checks upsert onto one alert row
// (deposit_match_alerts has UNIQUE(alert_type, subject_id)).
const SUBJECT_ID = "00000000-0000-0000-0000-000000000003";
const ALERT_TYPE = "gmail_intake_silent";
const EAT_OFFSET_HOURS = 3;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

function eatHour(d: Date): number {
  return (d.getUTCHours() + EAT_OFFSET_HOURS) % 24;
}

function inActiveHours(now: Date, start: number, end: number): boolean {
  const h = eatHour(now);
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

async function ensureUnsubscribeToken(admin: ReturnType<typeof createClient>, email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const { data: existing } = await admin.from("email_unsubscribe_tokens").select("token").eq("email", normalized).maybeSingle();
  if (existing?.token) return existing.token as string;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  await admin.from("email_unsubscribe_tokens").upsert({ token, email: normalized }, { onConflict: "email", ignoreDuplicates: true });
  return token;
}

async function notify(
  admin: ReturnType<typeof createClient>,
  emails: string[],
  smsPhones: string[],
  subject: string,
  html: string,
  smsText: string,
  idemKey: string,
) {
  const emailResults: Record<string, string> = {};
  for (const to of emails) {
    const messageId = crypto.randomUUID();
    const unsubscribeToken = await ensureUnsubscribeToken(admin, to);
    await admin.from("email_send_log").insert({
      message_id: messageId,
      template_name: "gmail-intake-silence-alarm",
      recipient_email: to,
      status: "pending",
      metadata: { subject },
    });
    const { error } = await admin.rpc("enqueue_email", {
      queue_name: "transactional_emails",
      payload: {
        message_id: messageId,
        to,
        from: FROM,
        sender_domain: SENDER_DOMAIN,
        subject,
        html,
        text: smsText,
        purpose: "transactional",
        label: "gmail-intake-silence-alarm",
        idempotency_key: `${idemKey}:${to}`,
        unsubscribe_token: unsubscribeToken,
        queued_at: new Date().toISOString(),
      },
    });
    emailResults[to] = error ? `error: ${error.message}` : "queued";
  }

  const smsResults: Record<string, string> = {};
  for (const phone of smsPhones) {
    try {
      const ok = await sendSMS(phone, smsText, {
        admin,
        source: "gmail-intake-silence-alarm",
        reference_id: null,
        recipient_user_id: null,
        recipient_name: null,
        idempotencyKey: `${idemKey}:sms:${phone}`,
      });
      smsResults[phone] = ok ? "sent" : "failed";
    } catch (e) {
      smsResults[phone] = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { emailResults, smsResults };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  // Cron-only: it emails and SMSes staff, so the public anon key must not be enough.
  const refused = await requireServiceRole(req, corsHeaders);
  if (refused) return refused;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const { data: cfg } = await admin.from("gmail_intake_silence_config").select("*").eq("id", 1).maybeSingle();
    if (!cfg || !cfg.enabled) return json({ ok: true, skipped: "disabled" });

    const threshold = Number(cfg.threshold_minutes);
    const renotifyMinutes = Number(cfg.renotify_minutes);
    const emails: string[] = (cfg.notify_emails as string[] | null)?.filter(Boolean) ?? [];
    const smsEmails: string[] = (cfg.notify_sms_phones as string[] | null)?.filter(Boolean) ?? [];

    const now = new Date();
    const { data: last } = await admin
      .from("gmail_transactions")
      .select("created_at")
      .eq("direction", "in")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastAt = (last?.created_at as string | null) ?? null;
    const silentMinutes = lastAt ? Math.round((now.getTime() - new Date(lastAt).getTime()) / 60000) : null;
    const isSilent = silentMinutes === null || silentMinutes > threshold;

    const { data: existing } = await admin
      .from("deposit_match_alerts")
      .select("id, notified_at, resolved_at")
      .eq("alert_type", ALERT_TYPE)
      .eq("subject_id", SUBJECT_ID)
      .maybeSingle();
    const open = !!existing && !existing.resolved_at;

    if (!isSilent) {
      if (!open) return json({ ok: true, silent: false, silent_minutes: silentMinutes });
      await admin.from("deposit_match_alerts").update({ resolved_at: now.toISOString() }).eq("id", existing!.id);
      const smsText =
        `Welile: deposit emails are flowing again (last one ${silentMinutes} min ago). ` +
        `Backlog SMS may still arrive: credit by TID only and check before crediting manually.`;
      const html = `<div style="font:14px system-ui;color:#111;max-width:640px"><h2 style="margin:0 0 6px;color:#15803d">Deposit intake is flowing again</h2>
<p style="color:#555">The last deposit email was ingested ${esc(silentMinutes)} minutes ago. Backlogged SMS can still arrive in bursts. Credit by TID only, and check whether a TID was already credited before crediting it by hand.</p></div>`;
      const res = await notify(admin, emails, smsEmails, "Deposit intake recovered", html, smsText, `gmail-intake-silence:recovered:${now.toISOString().slice(0, 13)}`);
      return json({ ok: true, silent: false, recovered: true, ...res });
    }

    if (!inActiveHours(now, Number(cfg.active_start_hour_eat), Number(cfg.active_end_hour_eat))) {
      return json({ ok: true, silent: true, silent_minutes: silentMinutes, skipped: "outside_active_hours" });
    }

    const stamp = now.toISOString();
    const details = {
      message: `No deposit email ingested for ${silentMinutes ?? "an unknown number of"} minutes (threshold ${threshold}m).`,
      last_ingested_at: lastAt,
      silent_minutes: silentMinutes,
      threshold_minutes: threshold,
      observed_at: stamp,
    };
    const { data: upserted, error: upsertErr } = await admin
      .from("deposit_match_alerts")
      .upsert(
        {
          alert_type: ALERT_TYPE,
          subject_id: SUBJECT_ID,
          subject_label: "No MoMo deposit emails arriving (forwarding phone/IFTTT may be down)",
          severity: "critical",
          age_minutes: silentMinutes ?? 0,
          details,
          resolved_at: null,
          ...(open ? {} : { notified_at: null }),
          updated_at: stamp,
        },
        { onConflict: "alert_type,subject_id" },
      )
      .select("id, notified_at")
      .single();
    if (upsertErr) throw new Error(`alert upsert failed: ${upsertErr.message}`);

    const notifiedAt = open ? (existing!.notified_at as string | null) : null;
    const dueForNotify = !notifiedAt || now.getTime() - new Date(notifiedAt).getTime() >= renotifyMinutes * 60000;
    if (!dueForNotify) return json({ ok: true, silent: true, silent_minutes: silentMinutes, already_notified: true });

    const hrs = silentMinutes === null ? "unknown" : silentMinutes >= 120 ? `${Math.round(silentMinutes / 60)} hours` : `${silentMinutes} min`;
    const smsText =
      `Welile ALERT: no MoMo deposit SMS has reached the system for ${hrs}. ` +
      `Check the forwarding phone (power, network, IFTTT). Agents' float deposits are NOT auto-crediting. ` +
      `If you credit manually, use the TID.`;
    const subject = `ALERT: no deposit emails for ${hrs}`;
    const html = `<div style="font:14px system-ui;color:#111;max-width:640px">
<h2 style="margin:0 0 6px;color:#b91c1c">No MoMo deposit emails are arriving</h2>
<p style="color:#555">The last deposit email was ingested at <code>${esc(lastAt ?? "never")}</code> (${esc(hrs)} ago), past the ${threshold}-minute threshold.
The poller itself is running, so the break is upstream: the phone that receives MoMo SMS, its network or power, IFTTT, or Gmail forwarding.</p>
<ol style="color:#555"><li>Check the forwarding phone is on, charged and has data.</li><li>Check the IFTTT applet is enabled and its activity log shows recent runs.</li><li>Check the Gmail inbox for recent MoMo forwards.</li></ol>
<p style="color:#555">Until it recovers, agents' float deposits will not auto-credit. Credit by TID only: when the phone reconnects, a backlog may arrive and a TID already credited by hand must not be credited twice.</p>
<p style="color:#777;font-size:12px">Repeats every ${renotifyMinutes} minutes while silent and clears automatically when intake resumes.</p></div>`;

    const res = await notify(admin, emails, smsEmails, subject, html, smsText, `gmail-intake-silence:${stamp.slice(0, 13)}`);
    const anyOk =
      Object.values(res.emailResults).some((v) => v === "queued") || Object.values(res.smsResults).some((v) => v === "sent");
    if (anyOk) await admin.from("deposit_match_alerts").update({ notified_at: stamp }).eq("id", upserted!.id);

    return json({ ok: true, silent: true, silent_minutes: silentMinutes, notified: anyOk, ...res });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[gmail-intake-silence-alarm]", message);
    return json({ error: message }, 500);
  }
});
