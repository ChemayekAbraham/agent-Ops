// TENANT_RELOCATION — Stage 3A.
//
// The relocation proposition was identified in the 2026-09-09 review as not
// implemented, even though tenants are meant to know Welile can support them
// through a move. Deliberately NOT conditional on defaulting: this is a
// value-proposition message to active tenants.
//
// Frequency is not enforced here. The event is classified `marketing` in the
// catalog, so the governor applies the global twice-per-rolling-7-days cap
// across all proposition copy. Scheduling this twice weekly and letting the
// governor arbitrate is the intended design — if another marketing campaign
// already used a tenant's two slots, this one yields rather than stacking.
import "../_shared/smsFooterInterceptor.ts";
// Every message here goes to an existing tenant, so the platform-wide
// "Not on Welile yet? Sign up" prompt is both wrong for the audience and
// ~48 wasted characters that can push the SMS into a second billed segment.
import "../_shared/noSignupPrompt.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { routeTenantNotification } from "../_shared/tenantChannelRouter.ts";
import { firstName, loadEvent, renderTemplate } from "../_shared/tenantTemplates.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVENT_KEY = "TENANT_RELOCATION";

interface Candidate {
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  outstanding: number;
}

/** Kampala calendar date (UTC+3, no DST). */
function kampalaDate(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
    const dryRun = body.dry_run === true;

    const event = await loadEvent(admin, EVENT_KEY);
    if (!event || !event.active) {
      return new Response(
        JSON.stringify({ success: true, message: "Event missing or inactive — nothing sent", sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!event.body_template) {
      throw new Error(`${EVENT_KEY} has no body_template configured`);
    }

    const { data, error } = await admin.rpc("get_tenant_relocation_candidates", {
      p_limit: Number(body.limit ?? 2000),
      p_offset: Number(body.offset ?? 0),
    });
    if (error) throw error;

    const rows = (data ?? []) as Candidate[];
    const day = kampalaDate();
    const results = { sent: 0, skipped: 0, failed: 0 };
    const skipReasons: Record<string, number> = {};
    const preview: unknown[] = [];

    for (const row of rows) {
      const phone = String(row.tenant_phone ?? "").trim();
      if (!phone) continue;

      const vars = { name: firstName(row.tenant_name) };

      if (dryRun) {
        if (preview.length < 10) {
          const message = renderTemplate(event.body_template, vars);
          preview.push({ tenant_id: row.tenant_id, name: row.tenant_name, message });
        }
        continue;
      }

      try {
        const outcome = await routeTenantNotification({
          admin,
          tenantId: row.tenant_id,
          eventKey: EVENT_KEY,
          // One per calendar day; the weekly ceiling is the governor's job.
          episodeKey: `relocation:${day}`,
          vars,
          phone,
          tenantName: row.tenant_name,
          payload: { day, outstanding: row.outstanding },
          linkPath: null,
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
        console.error(`[${EVENT_KEY}] send failed for ${row.tenant_id}:`, err);
      }
    }

    if (dryRun) {
      return new Response(
        JSON.stringify({ success: true, dry_run: true, candidates: rows.length, sample: preview }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(
      `[${EVENT_KEY}] candidates=${rows.length} sent=${results.sent} skipped=${results.skipped} failed=${results.failed}`,
    );

    return new Response(
      JSON.stringify({ success: true, candidates: rows.length, ...results, skip_reasons: skipReasons }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[${EVENT_KEY}] Fatal:`, msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
