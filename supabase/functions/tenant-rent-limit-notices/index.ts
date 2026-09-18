// RENT_LIMIT_INCREASED / RENT_LIMIT_PROGRESS — Stage 3B.
//
// Two events on purpose, per the catalogue: the system must never tell a
// tenant their limit went up when it did not.
//
//   mode=increased (default) — reads credit_limit_change_log, which records
//     real changes to credit_access_limits.total_limit. A message can only be
//     sent for an increase the limit engine actually performed; the amount in
//     the SMS is the new limit as stored, never a projection.
//
//   mode=progress — the honest alternative for tenants who paid well but
//     whose limit did not move. Says the record is strengthening, and claims
//     nothing about a change. Classified `marketing`, so it competes for the
//     twice-weekly proposition budget rather than firing on every payment.
import "../_shared/smsFooterInterceptor.ts";
// Every message here goes to an existing tenant, so the platform-wide
// "Not on Welile yet? Sign up" prompt is both wrong for the audience and
// ~48 wasted characters that can push the SMS into a second billed segment.
import "../_shared/noSignupPrompt.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { routeTenantNotification } from "../_shared/tenantChannelRouter.ts";
import {
  dashboardSuffix,
  firstName,
  formatUGX,
  loadEvent,
  loadTenantStatusAppendices,
  renderTemplate,
} from "../_shared/tenantTemplates.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface IncreaseRow {
  change_id: string;
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  old_total_limit: number | null;
  new_total_limit: number;
  delta: number;
  changed_at: string;
}

interface DayStateRow {
  tenant_id: string;
  daily_expected: number;
  paid_on_day: number;
  outstanding: number;
  day_state: string;
}

function kampalaDate(offsetDays = 0): string {
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  return shifted.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { body = {}; }

    const mode = String(body.mode ?? "increased");
    const dryRun = body.dry_run === true;

    if (mode !== "increased" && mode !== "progress") {
      return new Response(
        JSON.stringify({ success: false, error: `Unknown mode "${mode}" — expected "increased" or "progress"` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const eventKey = mode === "increased" ? "RENT_LIMIT_INCREASED" : "RENT_LIMIT_PROGRESS";
    const event = await loadEvent(admin, eventKey);
    if (!event || !event.active) {
      return new Response(
        JSON.stringify({ success: true, message: "Event missing or inactive — nothing sent", sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!event.body_template) throw new Error(`${eventKey} has no body_template configured`);

    // Per-tenant dashboard links do not exist yet (Stage 4C). Until they do,
    // dashboardSuffix() returns "" and the templates simply end earlier.
    const origin = Deno.env.get("PUBLIC_SITE_ORIGIN") || "https://welileapp.com";
    const domainName = origin.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const linkForEvent = event.link_path ? `${origin}${event.link_path}` : null;
    const suffix = dashboardSuffix(linkForEvent);

    const results = { sent: 0, skipped: 0, failed: 0 };
    const skipReasons: Record<string, number> = {};
    const preview: unknown[] = [];
    let candidateCount = 0;

    if (mode === "increased") {
      const { data, error } = await admin.rpc("get_tenant_rent_limit_increase_candidates", {
        p_max_age_hours: Number(body.max_age_hours ?? 48),
        p_min_delta: Number(body.min_delta ?? 1000),
      });
      if (error) throw error;

      const rows = (data ?? []) as IncreaseRow[];
      candidateCount = rows.length;
      const statusAppendices = await loadTenantStatusAppendices(
        admin,
        rows.map((row) => row.tenant_id),
        domainName,
      );

      for (const row of rows) {
        const phone = String(row.tenant_phone ?? "").trim();
        if (!phone) continue;

        const vars = {
          name: firstName(row.tenant_name),
          new_limit: formatUGX(row.new_total_limit),
          dashboard_suffix: suffix,
          status_appendix: statusAppendices.get(row.tenant_id) ?? "",
        };

        if (dryRun) {
          if (preview.length < 10) {
            preview.push({
              tenant_id: row.tenant_id,
              old_limit: row.old_total_limit,
              new_limit: row.new_total_limit,
              delta: row.delta,
              message: renderTemplate(event.body_template, vars),
            });
          }
          continue;
        }

        try {
          const outcome = await routeTenantNotification({
            admin,
            tenantId: row.tenant_id,
            eventKey,
            // Keyed on the change row: one announcement per real increase.
            episodeKey: `limit:${row.change_id}`,
            vars,
            phone,
            tenantName: row.tenant_name,
            payload: {
              change_id: row.change_id,
              old_total_limit: row.old_total_limit,
              new_total_limit: row.new_total_limit,
              delta: row.delta,
              changed_at: row.changed_at,
            },
            linkPath: event.link_path,
          });

          if (outcome.smsSent || outcome.pushSent > 0 || outcome.inAppCreated) results.sent++;
          else if (outcome.reason === "provider_failed") results.failed++;
          else {
            results.skipped++;
            const key = outcome.reason ?? "unknown";
            skipReasons[key] = (skipReasons[key] ?? 0) + 1;
          }

          // Stamp the change row for anything that is not a transient
          // provider failure, so a retry cannot re-announce it later. A
          // failed send stays unstamped and is retried on the next run.
          const delivered = outcome.smsSent || outcome.pushSent > 0 || outcome.inAppCreated;
          if (delivered || (outcome.reason && outcome.reason !== "provider_failed")) {
            await admin.rpc("mark_credit_limit_change_notified", { p_change_id: row.change_id });
          }
        } catch (err) {
          results.failed++;
          console.error(`[${eventKey}] send failed for ${row.tenant_id}:`, err);
        }
      }
    } else {
      // Progress: tenants who cleared the day's obligation. Anyone whose limit
      // actually moved is excluded — they get RENT_LIMIT_INCREASED instead,
      // and two messages about the same good behaviour is noise.
      const day = String(body.as_of ?? kampalaDate(-1));

      const { data: stateData, error: stateError } = await admin.rpc("get_tenant_payment_day_state", {
        p_as_of: day,
        p_tenant_ids: null,
      });
      if (stateError) throw stateError;

      const cleared = ((stateData ?? []) as DayStateRow[]).filter((r) => r.day_state === "cleared");

      const { data: increasedData } = await admin
        .from("credit_limit_change_log")
        .select("user_id")
        .gt("delta", 0)
        .gte("changed_at", `${day}T00:00:00Z`);
      const increasedIds = new Set<string>(
        ((increasedData ?? []) as { user_id: string }[]).map((r) => r.user_id),
      );

      const eligible = cleared.filter((r) => !increasedIds.has(r.tenant_id));
      candidateCount = eligible.length;
      const statusAppendices = await loadTenantStatusAppendices(
        admin,
        eligible.map((row) => row.tenant_id),
        domainName,
      );

      // Phone and name are not in the day-state RPC; fetch for this slice only.
      const ids = eligible.map((r) => r.tenant_id);
      const profiles = new Map<string, { full_name: string | null; phone: string | null }>();
      for (let i = 0; i < ids.length; i += 200) {
        const { data: chunk } = await admin
          .from("profiles")
          .select("id, full_name, phone")
          .in("id", ids.slice(i, i + 200))
          .is("deleted_at", null);
        for (const p of (chunk ?? []) as { id: string; full_name: string | null; phone: string | null }[]) {
          profiles.set(p.id, { full_name: p.full_name, phone: p.phone });
        }
      }

      for (const row of eligible) {
        const profile = profiles.get(row.tenant_id);
        const phone = String(profile?.phone ?? "").trim();
        if (!phone) continue;

        const vars = {
          name: firstName(profile?.full_name),
          dashboard_suffix: suffix,
          status_appendix: statusAppendices.get(row.tenant_id) ?? "",
        };

        if (dryRun) {
          if (preview.length < 10) {
            preview.push({ tenant_id: row.tenant_id, message: renderTemplate(event.body_template, vars) });
          }
          continue;
        }

        try {
          const outcome = await routeTenantNotification({
            admin,
            tenantId: row.tenant_id,
            eventKey,
            episodeKey: `progress:${day}`,
            vars,
            phone,
            tenantName: profile?.full_name ?? null,
            payload: { day, paid_on_day: row.paid_on_day, outstanding: row.outstanding },
            linkPath: event.link_path,
          });

          if (outcome.smsSent || outcome.pushSent > 0 || outcome.inAppCreated) results.sent++;
          else if (outcome.reason === "provider_failed") results.failed++;
          else {
            results.skipped++;
            const key = outcome.reason ?? "unknown";
            skipReasons[key] = (skipReasons[key] ?? 0) + 1;
          }
        } catch (err) {
          results.failed++;
          console.error(`[${eventKey}] send failed for ${row.tenant_id}:`, err);
        }
      }
    }

    if (dryRun) {
      return new Response(
        JSON.stringify({ success: true, dry_run: true, mode, candidates: candidateCount, sample: preview }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(
      `[${eventKey}] mode=${mode} candidates=${candidateCount} sent=${results.sent} ` +
        `skipped=${results.skipped} failed=${results.failed}`,
    );

    return new Response(
      JSON.stringify({ success: true, mode, candidates: candidateCount, ...results, skip_reasons: skipReasons }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[tenant-rent-limit-notices] Fatal:", msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
