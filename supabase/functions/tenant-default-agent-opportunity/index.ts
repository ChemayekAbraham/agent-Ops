// Five consecutive missed days -> Welile agent earnings opportunity.
//
// From the 2026-09-09 tenant-ops meeting: when a tenant has missed payments
// for five days, tell them they can earn money as a Welile agent. Sent ONCE
// per default episode, never daily after day five — the once-per-episode
// guarantee comes from tenant_notification_log's unique episode index, keyed
// on the date the run of missed days began.
//
// Two guards keep this honest, both applied in
// get_tenant_five_day_default_candidates rather than here:
//
//   * max run — a tenant 30 days into default must not be told "5 days"
//   * episode start floor — the launch guard. Measured against production on
//     2026-09-09, an unguarded rule would have messaged 558 tenants at once,
//     of whom only ~38 were genuine fresh defaults; the rest were historical,
//     including 351 who had missed the entire 30-day window and 57 who had
//     never paid anything. Set EPISODE_START_FLOOR to the go-live date so
//     only episodes beginning under the engine are messaged.
import "../_shared/smsFooterInterceptor.ts";
// Every message here goes to an existing tenant, so the platform-wide
// "Not on Welile yet? Sign up" prompt is both wrong for the audience and
// ~48 wasted characters that can push the SMS into a second billed segment.
import "../_shared/noSignupPrompt.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { routeTenantNotification } from "../_shared/tenantChannelRouter.ts";
import { agentCta, firstName, loadEvent, renderTemplate } from "../_shared/tenantTemplates.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVENT_KEY = "FIVE_DAY_AGENT_OPPORTUNITY";

// Day five is the trigger; beyond day seven the "5 days" framing is false and
// the tenant belongs to collections follow-up, not this campaign.
const MIN_RUN = 5;
const MAX_RUN = 7;

/**
 * Only default episodes that STARTED on or after this date are messaged.
 * Prevents the first run from blasting every historical default. Override per
 * invocation with { episode_start_on_or_after } for a deliberate backfill.
 */
const EPISODE_START_FLOOR = "2026-09-09";

interface Candidate {
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  consecutive_missed_days: number;
  run_start_date: string;
  episode_key: string;
  outstanding: number;
}

/**
 * Template vars. The approved copy leads with the earnings opportunity and
 * does not recite the missed days back at the tenant — five consecutive
 * missed days stays the internal trigger, not the message.
 */
function buildVars(row: Candidate, link: string | null) {
  return {
    name: firstName(row.tenant_name),
    agent_cta: agentCta(link),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    // dry_run lets Tenant Ops see exactly who would be messaged before any
    // SMS spend — the first live run of a new campaign deserves that.
    const dryRun = body.dry_run === true;
    const minRun = Number(body.min_run ?? MIN_RUN);
    const maxRun = body.max_run === null ? null : Number(body.max_run ?? MAX_RUN);
    const episodeFloor =
      body.episode_start_on_or_after === null
        ? null
        : String(body.episode_start_on_or_after ?? EPISODE_START_FLOOR);

    const { data: candidates, error: candidatesError } = await admin.rpc(
      "get_tenant_five_day_default_candidates",
      {
        p_min_run: minRun,
        p_max_run: maxRun,
        p_episode_start_on_or_after: episodeFloor,
      },
    );
    if (candidatesError) throw candidatesError;

    const rows: Candidate[] = (candidates ?? []) as Candidate[];

    const event = await loadEvent(admin, EVENT_KEY);
    if (!event || !event.active) {
      return new Response(
        JSON.stringify({ success: true, message: "Event missing or inactive — nothing sent", candidates: rows.length, sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!event.body_template) {
      throw new Error(`${EVENT_KEY} has no body_template configured`);
    }

    // link_path points at the existing agent-earnings explainer until a
    // dedicated tenant-to-agent conversion page exists.
    const origin = Deno.env.get("PUBLIC_SITE_ORIGIN") || "https://welileapp.com";
    const link = event.link_path ? `${origin}${event.link_path}` : null;

    if (dryRun) {
      return new Response(
        JSON.stringify({
          success: true,
          dry_run: true,
          candidates: rows.length,
          episode_start_on_or_after: episodeFloor,
          min_run: minRun,
          max_run: maxRun,
          sample: rows.slice(0, 10).map((r) => ({
            tenant_id: r.tenant_id,
            name: r.tenant_name,
            missed_days: r.consecutive_missed_days,
            run_start_date: r.run_start_date,
            episode_key: r.episode_key,
            outstanding: r.outstanding,
            message: renderTemplate(event.body_template!, buildVars(r, link)),
          })),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const results = { sent: 0, skipped: 0, failed: 0, noPhone: 0 };
    const skipReasons: Record<string, number> = {};

    for (const row of rows) {
      const phone = String(row.tenant_phone ?? "").trim();
      if (!phone) {
        results.noPhone++;
        continue;
      }

      try {
        const outcome = await routeTenantNotification({
          admin,
          tenantId: row.tenant_id,
          eventKey: EVENT_KEY,
          episodeKey: row.episode_key,
          vars: buildVars(row, link),
          phone,
          tenantName: row.tenant_name,
          payload: {
            consecutive_missed_days: row.consecutive_missed_days,
            run_start_date: row.run_start_date,
            outstanding: row.outstanding,
            link,
          },
          linkPath: event.link_path,
        });

        if (outcome.smsSent || outcome.pushSent > 0 || outcome.inAppCreated) {
          results.sent++;
        } else if (outcome.reason === "provider_failed") {
          results.failed++;
        } else {
          results.skipped++;
          const key = outcome.reason ?? "unknown";
          skipReasons[key] = (skipReasons[key] ?? 0) + 1;
        }
      } catch (err) {
        results.failed++;
        console.error(`[${EVENT_KEY}] send failed for ${row.tenant_id}:`, err);
      }
    }

    console.log(
      `[${EVENT_KEY}] candidates=${rows.length} sent=${results.sent} skipped=${results.skipped} ` +
        `failed=${results.failed} noPhone=${results.noPhone} floor=${episodeFloor}`,
    );

    return new Response(
      JSON.stringify({ success: true, candidates: rows.length, ...results, skip_reasons: skipReasons }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[${EVENT_KEY}] Fatal:`, msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
