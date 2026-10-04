// Heartbeat for the Gmail/IFTTT deposit-intake pipeline.
//
// gmail-poll-transactions already raises a `gmail_auth_failure` alert when
// IT runs and hits a 401/403 — but that only helps while the poller is
// still executing. If the cron job itself stops firing (unscheduled,
// pg_cron outage, platform issue), nothing raises anything, and the only
// way anyone would notice is by opening Financial Ops → Email Transactions
// and seeing a stale "Last successful poll" timestamp. This function is an
// independent watchdog: it checks `gmail_poll_state.last_polled_at` on its
// own schedule and alerts if the pipeline has gone quiet, regardless of
// why. Self-clears once polling resumes.

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

// Poller runs every 2 minutes (see gmail-poll-transactions-every-2min cron).
// 20 minutes gives ample room for transient Gmail/gateway retries before
// paging anyone.
const STALE_MINUTES = 20;

// Fixed sentinel so repeated checks upsert onto the same alert row instead
// of creating a new one every 15 minutes (deposit_match_alerts has
// UNIQUE(alert_type, subject_id)).
const HEARTBEAT_ALERT_SUBJECT_ID = "00000000-0000-0000-0000-000000000002";

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
  return token;
}

async function postSlack(text: string): Promise<{ ok: boolean; error?: string }> {
  if (!SLACK_WEBHOOK) return { ok: false, error: "OPS_SLACK_WEBHOOK_URL not configured" };
  try {
    const res = await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return { ok: false, error: `slack ${res.status}: ${await res.text()}` };
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
    const { data: state } = await admin
      .from("gmail_poll_state")
      .select("last_polled_at, last_status, last_error")
      .eq("id", 1)
      .maybeSingle();

    const lastPolledAt = state?.last_polled_at as string | null;
    const staleMinutes = lastPolledAt
      ? Math.round((Date.now() - new Date(lastPolledAt).getTime()) / 60000)
      : null; // null = never polled at all, which is its own kind of stale
    const isStale = staleMinutes === null || staleMinutes > STALE_MINUTES;

    // Look for an existing open heartbeat alert so we know whether this is
    // a brand-new outage (needs notifying) or one we've already reported.
    const { data: existing } = await admin
      .from("deposit_match_alerts")
      .select("id, notified_at, resolved_at")
      .eq("alert_type", "gmail_poll_stale")
      .eq("subject_id", HEARTBEAT_ALERT_SUBJECT_ID)
      .maybeSingle();

    if (!isStale) {
      // Healthy. Resolve any previously-open alert so it self-clears.
      if (existing && !existing.resolved_at) {
        await admin
          .from("deposit_match_alerts")
          .update({ resolved_at: new Date().toISOString() })
          .eq("id", existing.id);
      }
      return new Response(
        JSON.stringify({ ok: true, stale: false, stale_minutes: staleMinutes, last_status: state?.last_status ?? null }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const stamp = new Date().toISOString();
    const alreadyOpenAndNotified = existing && !existing.resolved_at && existing.notified_at;

    const details = {
      message: `No successful Gmail poll in ${staleMinutes ?? "an unknown amount of"} minutes (threshold ${STALE_MINUTES}m) — IFTTT-forwarded deposit SMS may be arriving with nothing capturing them.`,
      last_polled_at: lastPolledAt,
      stale_minutes: staleMinutes,
      last_status: state?.last_status ?? null,
      last_error: state?.last_error ?? null,
      threshold_minutes: STALE_MINUTES,
      observed_at: stamp,
    };

    const { data: upserted, error: upsertErr } = await admin
      .from("deposit_match_alerts")
      .upsert(
        {
          alert_type: "gmail_poll_stale",
          subject_id: HEARTBEAT_ALERT_SUBJECT_ID,
          subject_label: "Gmail/IFTTT deposit intake has gone quiet",
          severity: "critical",
          age_minutes: staleMinutes ?? 0,
          details,
          // Re-open (clear resolved_at) if it had previously self-cleared
          // and has now gone stale again; keep notified_at as-is unless
          // this is the first time we've seen it so we don't re-notify
          // every 15 minutes for the same ongoing outage.
          resolved_at: null,
          ...(existing ? {} : { notified_at: null }),
          updated_at: stamp,
        },
        { onConflict: "alert_type,subject_id" },
      )
      .select("id, notified_at")
      .single();
    if (upsertErr) throw new Error(`alert upsert failed: ${upsertErr.message}`);

    if (alreadyOpenAndNotified) {
      // Already reported this outage; don't spam ops every 15 minutes.
      return new Response(
        JSON.stringify({ ok: true, stale: true, stale_minutes: staleMinutes, already_notified: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // First time we've seen this outage (or it was previously resolved and
    // has recurred) — notify now instead of waiting on another function's
    // schedule, since pipeline downtime is time-sensitive.
    const { data: cfg } = await admin
      .from("deposit_match_alert_config")
      .select("notify_emails")
      .eq("id", 1)
      .maybeSingle();
    const recipients: string[] = (cfg?.notify_emails as string[] | null)?.filter(Boolean) ?? [];

    const subject = `Gmail deposit intake has gone quiet — ${staleMinutes ?? "never polled"}${staleMinutes !== null ? " min" : ""} since last successful poll`;
    const html = `<div style="font:14px system-ui;color:#111;max-width:760px">
  <h2 style="margin:0 0 6px;font:700 18px system-ui;color:#b91c1c">Gmail/IFTTT deposit intake is stale</h2>
  <p style="margin:0 0 4px;color:#555">
    <code>gmail-poll-transactions</code> has not completed a successful poll in
    <b>${esc(staleMinutes ?? "an unknown amount of time (never recorded)")}</b> minutes, past the
    ${STALE_MINUTES}-minute threshold. IFTTT-forwarded MoMo/Airtel deposit SMS may be arriving
    in Gmail right now with nothing capturing them.
  </p>
  <ul style="color:#555">
    <li>Last successful poll: <code>${esc(lastPolledAt ?? "never")}</code></li>
    <li>Last status: <code>${esc(state?.last_status ?? "unknown")}</code></li>
    <li>Last error: <code>${esc(state?.last_error ?? "none recorded")}</code></li>
  </ul>
  <p style="margin:0 0 4px;color:#555">
    Check the <code>gmail-poll-transactions-every-2min</code> cron job (is it still scheduled and
    succeeding?), then verify the Gmail connection in
    <b>Financial Ops → Email Transactions</b>.
  </p>
  <p style="margin:20px 0 0;color:#777;font-size:12px">
    This alert clears automatically once a poll succeeds again.
  </p>
</div>`;
    const text = `${subject}\nLast successful poll: ${lastPolledAt ?? "never"}\nLast status: ${state?.last_status ?? "unknown"}\nLast error: ${state?.last_error ?? "none recorded"}`;

    const emailResults: Record<string, string> = {};
    for (const to of recipients) {
      const messageId = crypto.randomUUID();
      const unsubscribeToken = await ensureUnsubscribeToken(admin, to);
      await admin.from("email_send_log").insert({
        message_id: messageId,
        template_name: "gmail-poll-heartbeat",
        recipient_email: to,
        status: "pending",
        metadata: { subject, stale_minutes: staleMinutes },
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
          label: "gmail-poll-heartbeat",
          idempotency_key: `gmail-poll-heartbeat:${stamp.slice(0, 10)}:${to}`,
          unsubscribe_token: unsubscribeToken,
          queued_at: stamp,
        },
      });
      emailResults[to] = enqErr ? `error: ${enqErr.message}` : "queued";
      if (enqErr) console.error("[gmail-poll-heartbeat] enqueue error", to, enqErr);
    }

    const slackResult = await postSlack(
      `:rotating_light: *Gmail/IFTTT deposit intake is stale* — ${staleMinutes ?? "never polled"} min since last successful poll (threshold ${STALE_MINUTES}m).\n` +
        `Last status: \`${state?.last_status ?? "unknown"}\`${state?.last_error ? ` — ${state.last_error}` : ""}\n` +
        `Check the gmail-poll-transactions-every-2min cron job and the Gmail connection in Financial Ops → Email Transactions.`,
    );

    const anyQueued = Object.values(emailResults).some((v) => v === "queued");
    if (anyQueued || slackResult.ok) {
      await admin
        .from("deposit_match_alerts")
        .update({ notified_at: stamp })
        .eq("id", upserted!.id);
    }

    await admin.from("system_events").insert({
      event_type: "gmail_poll_heartbeat_alert",
      metadata: { stale_minutes: staleMinutes, last_status: state?.last_status ?? null, recipients, email_results: emailResults, slack_ok: slackResult.ok, slack_error: slackResult.error ?? null },
    });

    return new Response(
      JSON.stringify({ ok: true, stale: true, stale_minutes: staleMinutes, notified: anyQueued, email_results: emailResults, slack: slackResult }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[gmail-poll-heartbeat]", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
