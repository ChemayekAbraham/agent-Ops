// Redirect uptime monitor + alerting.
//
// Continuously verifies that welilereceipts.com (and any other configured
// origin) returns a clean permanent 301/308 to the matching path on
// welileapp.com. Once a redirect has been healthy at least once, this function
// raises an alert the moment it regresses ("redirect_down") and a follow-up
// when it recovers ("redirect_restored").
//
// Alerts fan out to:
//   • redirect_monitor_alerts table (always — dashboard visible)
//   • manager push notifications via notify-managers (if notify_managers)
//   • email via send-transactional-email (to configured alert_emails)
//
// State transitions are debounced with a configurable failure_threshold and
// deduped via redirect_monitor.open_alert_id so a single outage does not spam.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function normPath(p: string): string {
  if (!p) return "/";
  const clean = p.split("?")[0].split("#")[0];
  return clean.length > 1 && clean.endsWith("/") ? clean.slice(0, -1) : clean;
}

interface HopResult {
  path: string;
  ok: boolean;
  firstStatus: number | null;
  isPermanent: boolean;
  finalUrl: string | null;
  finalStatus: number | null;
  location: string | null;
  error?: string;
}

async function traceRedirect(oldDomain: string, newDomain: string, path: string): Promise<HopResult> {
  const start = `https://${oldDomain}${path}`;
  const res: HopResult = {
    path, ok: false, firstStatus: null, isPermanent: false,
    finalUrl: null, finalStatus: null, location: null,
  };
  try {
    let current = start;
    let firstStatus: number | null = null;
    let firstLocation: string | null = null;
    for (let hop = 0; hop < 6; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      let resp: Response;
      try {
        resp = await fetch(current, { method: "GET", redirect: "manual", signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (hop === 0) {
        firstStatus = resp.status;
        firstLocation = resp.headers.get("location");
      }
      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        const loc = resp.headers.get("location");
        if (!loc) break;
        current = new URL(loc, current).toString();
        continue;
      }
      res.finalUrl = resp.url || current;
      res.finalStatus = resp.status;
      break;
    }
    res.firstStatus = firstStatus;
    res.location = firstLocation;
    res.isPermanent = firstStatus === 301 || firstStatus === 308;

    let finalHost: string | null = null;
    let finalPath: string | null = null;
    if (res.finalUrl) {
      const u = new URL(res.finalUrl);
      finalHost = u.hostname.replace(/^www\./, "");
      finalPath = normPath(u.pathname);
    }
    res.ok =
      res.isPermanent &&
      finalHost === newDomain &&
      res.finalStatus === 200 &&
      finalPath === normPath(path);
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
  }
  return res;
}

async function resolveManagerEmails(admin: any): Promise<string[]> {
  const { data: roleUsers } = await admin
    .from("user_roles")
    .select("user_id")
    .eq("role", "manager")
    .eq("enabled", true);
  const ids = [...new Set((roleUsers ?? []).map((r: any) => r.user_id))];
  if (ids.length === 0) return [];
  const { data: profs } = await admin
    .from("profiles")
    .select("email")
    .in("id", ids);
  return (profs ?? []).map((p: any) => p.email).filter((e: any): e is string => !!e);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const summary: any[] = [];

  try {
    const { data: monitors, error } = await admin
      .from("redirect_monitor")
      .select("*")
      .eq("enabled", true);
    if (error) throw error;

    for (const m of monitors ?? []) {
      const paths: string[] = Array.isArray(m.paths) ? m.paths : ["/"];
      const checks = await Promise.all(
        paths.map((p) => traceRedirect(m.old_domain, m.new_domain, p)),
      );
      const healthy = checks.every((c) => c.ok);
      const now = new Date().toISOString();

      const prevHealthy: boolean | null = m.currently_healthy;
      const everHealthy: boolean = m.ever_healthy || healthy;
      const consecutiveFailures = healthy ? 0 : (m.consecutive_failures ?? 0) + 1;
      const consecutiveHealthy = healthy ? (m.consecutive_healthy ?? 0) + 1 : 0;

      let openAlertId: string | null = m.open_alert_id ?? null;
      let alertRaised: string | null = null;

      const failingPaths = checks.filter((c) => !c.ok);

      // ---- DOWN: was healthy before, now failing past threshold, no open alert
      const eligibleToAlertDown =
        everHealthy &&
        !healthy &&
        consecutiveFailures >= (m.failure_threshold ?? 1) &&
        !openAlertId &&
        // only alert on a real regression (previously healthy or unknown-but-ever-healthy)
        (prevHealthy === true || prevHealthy === null);

      // ---- RESTORED: an alert is open and we are healthy again
      const eligibleToAlertRestored = healthy && !!openAlertId;

      if (eligibleToAlertDown) {
        const { data: alertRow } = await admin
          .from("redirect_monitor_alerts")
          .insert({
            old_domain: m.old_domain,
            new_domain: m.new_domain,
            alert_type: "redirect_down",
            severity: "critical",
            detail: { checks, consecutive_failures: consecutiveFailures, checked_at: now },
          })
          .select()
          .single();
        openAlertId = alertRow?.id ?? null;
        alertRaised = "redirect_down";

        const recipients = await deliverAlert(admin, supabaseUrl, serviceKey, m, {
          alertType: "redirect_down",
          checkedAt: now,
          consecutiveFailures,
          failingPaths,
        });
        if (alertRow?.id) {
          await admin
            .from("redirect_monitor_alerts")
            .update({ recipients, email_sent: recipients.length > 0, push_sent: !!m.notify_managers })
            .eq("id", alertRow.id);
        }
      } else if (eligibleToAlertRestored) {
        const { data: alertRow } = await admin
          .from("redirect_monitor_alerts")
          .insert({
            old_domain: m.old_domain,
            new_domain: m.new_domain,
            alert_type: "redirect_restored",
            severity: "info",
            detail: { checks, checked_at: now },
          })
          .select()
          .single();
        alertRaised = "redirect_restored";

        const recipients = await deliverAlert(admin, supabaseUrl, serviceKey, m, {
          alertType: "redirect_restored",
          checkedAt: now,
          consecutiveFailures: 0,
          failingPaths: [],
        });
        if (alertRow?.id) {
          await admin
            .from("redirect_monitor_alerts")
            .update({ recipients, email_sent: recipients.length > 0, push_sent: !!m.notify_managers })
            .eq("id", alertRow.id);
        }
        // resolve the open down alert
        if (openAlertId) {
          await admin
            .from("redirect_monitor_alerts")
            .update({ resolved_at: now })
            .eq("id", openAlertId);
        }
        openAlertId = null;
      }

      await admin
        .from("redirect_monitor")
        .update({
          currently_healthy: healthy,
          ever_healthy: everHealthy,
          consecutive_failures: consecutiveFailures,
          consecutive_healthy: consecutiveHealthy,
          last_healthy_at: healthy ? now : m.last_healthy_at,
          last_checked_at: now,
          last_status: { checks, healthy },
          open_alert_id: openAlertId,
        })
        .eq("id", m.id);

      summary.push({
        redirect: `${m.old_domain} -> ${m.new_domain}`,
        healthy,
        ever_healthy: everHealthy,
        consecutive_failures: consecutiveFailures,
        alert_raised: alertRaised,
        checks,
      });
    }

    return new Response(JSON.stringify({ ok: true, monitors: summary }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (e) {
    console.error("redirect-health-monitor failed:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});

// Fan alerts out to push (managers) + email (configured / manager fallback).
// Returns the list of email recipients actually targeted.
async function deliverAlert(
  admin: any,
  supabaseUrl: string,
  serviceKey: string,
  m: any,
  payload: { alertType: string; checkedAt: string; consecutiveFailures: number; failingPaths: HopResult[] },
): Promise<string[]> {
  const isDown = payload.alertType === "redirect_down";
  const title = isDown
    ? `🚨 Redirect down: ${m.old_domain}`
    : `✅ Redirect restored: ${m.old_domain}`;
  const body = isDown
    ? `${m.old_domain} is no longer 301-redirecting to ${m.new_domain}. SEO consolidation is at risk.`
    : `${m.old_domain} → ${m.new_domain} is redirecting correctly again.`;

  // 1. Manager push notifications
  if (m.notify_managers) {
    try {
      await fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ title, body, url: "/dashboard", type: isDown ? "error" : "success" }),
      });
    } catch (e) {
      console.error("notify-managers failed:", e);
    }
  }

  // 2. Email recipients: explicit list, else manager emails
  let recipients: string[] = Array.isArray(m.alert_emails) ? m.alert_emails.filter(Boolean) : [];
  if (recipients.length === 0) {
    recipients = await resolveManagerEmails(admin);
  }
  recipients = [...new Set(recipients)];

  const templateData = {
    alertType: payload.alertType,
    oldDomain: m.old_domain,
    newDomain: m.new_domain,
    checkedAt: payload.checkedAt,
    consecutiveFailures: payload.consecutiveFailures,
    failingPaths: payload.failingPaths.map((p) => ({
      path: p.path, firstStatus: p.firstStatus, finalStatus: p.finalStatus,
      location: p.location, error: p.error,
    })),
  };

  for (const email of recipients) {
    try {
      await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({
          templateName: "redirect-monitor-alert",
          recipientEmail: email,
          idempotencyKey: `redirect-${payload.alertType}-${m.old_domain}-${payload.checkedAt}-${email}`,
          templateData,
        }),
      });
    } catch (e) {
      console.error(`redirect alert email to ${email} failed:`, e);
    }
  }

  return recipients;
}