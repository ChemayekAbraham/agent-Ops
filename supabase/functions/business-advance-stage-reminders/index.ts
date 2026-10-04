import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PUBLIC_TRACK_BASE = "https://welileapp.com/business-advance/track";

/**
 * Per-status reminder rules. Each entry tells us:
 *  - which timestamp marks when the *current* stage was entered,
 *  - the key/label of the stage the tenant is waiting on,
 *  - the typical SLA (eta_hours) — once exceeded we ping the tenant once.
 */
const REMINDER_RULES: Record<string, {
  enteredField: string;
  stageKey: string;
  stageLabel: string;
  etaHours: number;
}> = {
  pending:                 { enteredField: 'created_at',              stageKey: 'agent_ops',   stageLabel: 'Agent Ops review',   etaHours: 6  },
  agent_ops_approved:      { enteredField: 'agent_ops_reviewed_at',   stageKey: 'tenant_ops',  stageLabel: 'Tenant Ops review',  etaHours: 24 },
  tenant_ops_approved:     { enteredField: 'tenant_ops_reviewed_at',  stageKey: 'landlord_ops',stageLabel: 'Landlord Ops review',etaHours: 48 },
  landlord_ops_approved:   { enteredField: 'landlord_ops_reviewed_at',stageKey: 'coo',         stageLabel: 'COO final sign-off', etaHours: 24 },
  coo_approved:            { enteredField: 'coo_approved_at',         stageKey: 'disbursed',   stageLabel: 'Disbursement',       etaHours: 12 },
};

function formatPhone(phone: string): string {
  const d = phone.replace(/[^0-9]/g, "");
  if (d.startsWith("256")) return `+${d}`;
  if (d.startsWith("0")) return `+256${d.slice(1)}`;
  if (d.length === 9) return `+256${d}`;
  return `+${d}`;
}

async function sendSMS(phone: string, message: string) {
  if (await attemptYoolaPrimary(phone, message, { source: "business-advance-stage-reminders" })) return { ok: true, status: 200, raw: "yoola" };
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) return { ok: false, status: 0, raw: "missing-at-creds" };
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  const body = new URLSearchParams({ username, from: "WELILE", to: formatPhone(phone), message });
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", apiKey, Accept: "application/json" },
    body: body.toString(),
  });
  const raw = await res.text();
  return { ok: res.ok, status: res.status, raw };
}

async function sendEmail(to: string, subject: string, title: string, bodyText: string, trackUrl: string) {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const gmailKey = Deno.env.get("GOOGLE_MAIL_API_KEY");
  if (!lovableKey || !gmailKey) return { ok: false, status: 0, raw: "missing-gmail-creds" };

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#ffffff;padding:24px;color:#0f172a">
  <div style="max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="background:#0f172a;color:#fff;padding:18px 22px;font-weight:600;font-size:14px;letter-spacing:.3px">WELILE · Business Advance</div>
    <div style="padding:22px">
      <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a">${title}</h1>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#334155">${bodyText}</p>
      <a href="${trackUrl}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;font-size:14px">Check live status</a>
      <p style="margin:24px 0 0;font-size:12px;color:#94a3b8">You'll get another update the moment this stage moves.</p>
    </div>
  </div></body></html>`;

  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
    '',
    html,
  ].join('\r\n');
  const b64 = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(
    "https://connector-gateway.lovable.dev/google_mail/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": gmailKey,
      },
      body: JSON.stringify({ raw: b64 }),
    },
  );
  const text = await res.text();
  return { ok: res.ok, status: res.status, raw: text };
}

function hoursSince(iso: string) {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const summary = { scanned: 0, eligible: 0, reminded: 0, errors: 0 };

  try {
    const { data: advances, error: advErr } = await admin
      .from("business_advances")
      .select(
        "id, tenant_id, business_name, principal, status, created_at, agent_ops_reviewed_at, tenant_ops_reviewed_at, landlord_ops_reviewed_at, coo_approved_at"
      )
      .in("status", Object.keys(REMINDER_RULES));

    if (advErr) throw advErr;
    summary.scanned = advances?.length ?? 0;

    for (const adv of advances ?? []) {
      const rule = REMINDER_RULES[adv.status as string];
      if (!rule) continue;
      const enteredAt = (adv as any)[rule.enteredField] as string | null;
      if (!enteredAt) continue;
      const elapsed = hoursSince(enteredAt);
      if (elapsed < rule.etaHours) continue;

      summary.eligible += 1;

      // Already reminded for this (advance, stage)?
      const { data: prior } = await admin
        .from("business_advance_notification_log")
        .select("id")
        .eq("advance_id", adv.id)
        .eq("new_status", `reminder:${rule.stageKey}`)
        .limit(1);
      if (prior && prior.length > 0) continue;

      const { data: tenant } = await admin
        .from("profiles")
        .select("phone, email, full_name, business_advance_notify_sms, business_advance_notify_email")
        .eq("id", adv.tenant_id)
        .maybeSingle();

      if (!tenant) continue;

      const amt = `UGX ${Math.round(Number(adv.principal) || 0).toLocaleString()}`;
      const title = `Still waiting on ${rule.stageLabel}`;
      const body = `Heads up — your Business Advance (${adv.business_name}, ${amt}) has been at "${rule.stageLabel}" for ${Math.round(elapsed)}h. We're following up internally and will alert you the moment it moves.`;
      const trackUrl = tenant.phone
        ? `${PUBLIC_TRACK_BASE}?phone=${encodeURIComponent(tenant.phone)}`
        : PUBLIC_TRACK_BASE;

      const logAttempt = async (entry: {
        channel: 'sms' | 'email';
        recipient: string | null;
        outcome: 'sent' | 'failed' | 'skipped' | 'opted_out';
        http_status?: number | null;
        error_message?: string | null;
        provider_response?: string | null;
      }) => {
        try {
          await admin.from('business_advance_notification_log').insert({
            advance_id: adv.id,
            tenant_id: adv.tenant_id,
            new_status: `reminder:${rule.stageKey}`,
            channel: entry.channel,
            recipient: entry.recipient,
            outcome: entry.outcome,
            http_status: entry.http_status ?? null,
            error_message: entry.error_message ?? null,
            provider_response: entry.provider_response ? entry.provider_response.slice(0, 4000) : null,
            metadata: {
              kind: 'stage_reminder',
              stage_key: rule.stageKey,
              stage_label: rule.stageLabel,
              eta_hours: rule.etaHours,
              elapsed_hours: Math.round(elapsed),
              title,
            },
          });
        } catch (e) {
          console.warn('[stage-reminders] log insert failed', (e as Error)?.message);
        }
      };

      let didSend = false;

      // SMS (WhatsApp-shareable text fallback)
      const smsOptIn = (tenant as any).business_advance_notify_sms !== false;
      if (tenant.phone && smsOptIn) {
        const text = `${title}\n${body}\nTrack: ${trackUrl}`;
        const r = await sendSMS(tenant.phone, text);
        await logAttempt({
          channel: 'sms',
          recipient: tenant.phone,
          outcome: r.ok ? 'sent' : 'failed',
          http_status: r.status,
          error_message: r.ok ? null : `Provider returned status ${r.status}`,
          provider_response: r.raw,
        });
        if (r.ok) didSend = true;
      } else if (tenant.phone && !smsOptIn) {
        await logAttempt({ channel: 'sms', recipient: tenant.phone, outcome: 'opted_out' });
      } else {
        await logAttempt({ channel: 'sms', recipient: null, outcome: 'skipped', error_message: 'No phone on profile' });
      }

      // Email
      const emailAddr = (tenant as any).email as string | undefined;
      const emailOptIn = (tenant as any).business_advance_notify_email !== false;
      if (emailAddr && /.+@.+\..+/.test(emailAddr) && emailOptIn) {
        try {
          const r = await sendEmail(emailAddr, title, title, body, trackUrl);
          await logAttempt({
            channel: 'email',
            recipient: emailAddr,
            outcome: r.ok ? 'sent' : 'failed',
            http_status: r.status,
            error_message: r.ok ? null : `Gmail gateway returned ${r.status}`,
            provider_response: r.raw,
          });
          if (r.ok) didSend = true;
        } catch (e) {
          await logAttempt({
            channel: 'email',
            recipient: emailAddr,
            outcome: 'failed',
            error_message: (e as Error)?.message ?? 'unknown',
          });
        }
      } else if (emailAddr && !emailOptIn) {
        await logAttempt({ channel: 'email', recipient: emailAddr, outcome: 'opted_out' });
      } else {
        await logAttempt({
          channel: 'email',
          recipient: emailAddr ?? null,
          outcome: 'skipped',
          error_message: !emailAddr ? 'No email on profile' : 'Invalid email format',
        });
      }

      // Best-effort in-app event so the realtime tracker can surface the nudge too
      try {
        await admin.from("system_events").insert({
          event_type: "business_advance.stage_reminder",
          user_id: adv.tenant_id,
          related_entity_type: "business_advances",
          related_entity_id: adv.id,
          metadata: {
            stage_key: rule.stageKey,
            stage_label: rule.stageLabel,
            eta_hours: rule.etaHours,
            elapsed_hours: Math.round(elapsed),
            title,
            body,
          },
        });
      } catch (e) {
        console.warn("[stage-reminders] system_event insert failed", (e as Error)?.message);
      }

      if (didSend) summary.reminded += 1;
    }

    return new Response(JSON.stringify({ ok: true, ...summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[stage-reminders] fatal:", err);
    summary.errors += 1;
    return new Response(JSON.stringify({ error: (err as Error)?.message ?? "internal_error", ...summary }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});