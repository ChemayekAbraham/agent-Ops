// PUSH_MIGRATION — Stage 6K.
//
// Invites a tenant to turn on push notifications. Deliberately narrow: only
// CONFIRMED_SMARTPHONE tenants whose dashboard is already activated and who
// have NO active push subscription (get_tenant_push_migration_candidates).
// Feature-phone, UNKNOWN, dashboard-inactive and already-push-enabled
// tenants are excluded by the selector — that is what makes this a targeted
// migration campaign rather than another mass SMS.
//
// Mints a fresh per-tenant dashboard link, same pattern as
// tenant-dashboard-invites: this tenant's dashboard is already activated so
// they have used a link before, but any earlier token may be expired or
// revoked, and only the token's hash is ever stored, so a live one cannot be
// recovered and resent.
//
// push_enabled is false in this event's channel policy — push cannot be
// attempted for a tenant this campaign is, by definition, targeting because
// they have no push device yet.
import "../_shared/smsFooterInterceptor.ts";
// Every message here goes to an existing, dashboard-activated tenant, so the
// platform-wide "Not on Welile yet? Sign up" prompt does not apply.
import "../_shared/noSignupPrompt.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { errorMessage } from "../_shared/errorMessage.ts";
import { generateLinkToken, sha256Hex } from "../_shared/deviceClass.ts";
import { routeTenantNotification } from "../_shared/tenantChannelRouter.ts";
import { loadEvent, renderTemplate } from "../_shared/tenantTemplates.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVENT_KEY = "PUSH_MIGRATION";
const LINK_TTL_DAYS = 90;

interface Candidate {
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
}

function firstName(fullName: string | null): string {
  return String(fullName || "").trim().split(/\s+/)[0] || "there";
}

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
    if (!event.body_template) throw new Error(`${EVENT_KEY} has no body_template configured`);

    const { data, error } = await admin.rpc("get_tenant_push_migration_candidates", {
      p_limit: Number(body.limit ?? 2000),
    });
    if (error) throw error;

    const rows = (data ?? []) as Candidate[];
    const origin = Deno.env.get("PUBLIC_SITE_ORIGIN") || "https://welileapp.com";
    const day = kampalaDate();

    const results = { sent: 0, skipped: 0, failed: 0 };
    const skipReasons: Record<string, number> = {};
    const preview: unknown[] = [];

    for (const row of rows) {
      const phone = String(row.tenant_phone ?? "").trim();
      if (!phone) continue;

      if (dryRun) {
        if (preview.length < 10) {
          const message = renderTemplate(event.body_template, {
            name: firstName(row.tenant_name),
            dashboard_link: `${origin}/t/<token>`,
          });
          preview.push({ tenant_id: row.tenant_id, message });
        }
        continue;
      }

      try {
        const token = generateLinkToken();
        const tokenHash = await sha256Hex(token);

        const { data: linkId, error: linkError } = await admin.rpc("issue_tenant_dashboard_link", {
          p_tenant_id: row.tenant_id,
          p_token_hash: tokenHash,
          p_purpose: "invite",
          p_ttl_days: LINK_TTL_DAYS,
          p_created_by: null,
        });
        if (linkError) throw linkError;

        const dashboardLink = `${origin}/t/${token}`;
        const outcome = await routeTenantNotification({
          admin,
          tenantId: row.tenant_id,
          eventKey: EVENT_KEY,
          episodeKey: `push_migration:${day}`,
          vars: { name: firstName(row.tenant_name), dashboard_link: dashboardLink },
          phone,
          tenantName: row.tenant_name,
          payload: { day, link_id: linkId },
          linkPath: `/t/${token}`,
        });

        const delivered = outcome.smsSent || outcome.pushSent > 0 || outcome.inAppCreated;
        if (delivered) {
          results.sent++;
          if (linkId && outcome.notificationLogId) {
            await admin.rpc("attach_notification_to_dashboard_link", {
              p_link_id: linkId,
              p_notification_log_id: outcome.notificationLogId,
            });
          }
        } else {
          if (outcome.reason === "provider_failed") results.failed++;
          else {
            results.skipped++;
            const key = outcome.reason ?? "unknown";
            skipReasons[key] = (skipReasons[key] ?? 0) + 1;
          }
          if (linkId) {
            await admin
              .from("tenant_dashboard_links")
              .update({ revoked_at: new Date().toISOString() })
              .eq("id", linkId);
          }
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
    const msg = errorMessage(error);
    console.error(`[${EVENT_KEY}] Fatal:`, msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
