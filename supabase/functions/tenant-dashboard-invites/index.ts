// Stage 4F/4G: SMARTPHONE_DISCOVERY and DASHBOARD_INVITE.
//
//   mode=discovery — smartphone_status = UNKNOWN. Invites the tenant to open
//     their dashboard; a successful open from a phone browser confirms the
//     device automatically (see tenant-dashboard-open). This is how ~62k
//     UNKNOWN tenants get resolved without anyone having to ask them.
//
//   mode=invite — smartphone_status = CONFIRMED_SMARTPHONE but the dashboard
//     has never been opened. Pushes activation.
//
//   { tenant_id } — call-centre single send (Stage 4H "Send Dashboard Link").
//     Deliberately routed through this function rather than given its own copy:
//     the call-centre UI must not carry a second version of the message.
//
// Both events are `marketing`, so the governor's global twice-weekly cap
// applies and these compete with relocation copy rather than stacking on it.
//
// A fresh token is minted per send. Only the token HASH is stored, so an
// existing link can never be recovered and re-sent — that is the intended
// trade for links that cannot be reconstructed from a database read. Old
// tokens stay valid until they expire, so an older SMS still works.
import "../_shared/smsFooterInterceptor.ts";
import "../_shared/noSignupPrompt.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateLinkToken, sha256Hex } from "../_shared/deviceClass.ts";
import { routeTenantNotification } from "../_shared/tenantChannelRouter.ts";
import { firstName, loadEvent, loadTenantStatusAppendices, renderTemplate } from "../_shared/tenantTemplates.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LINK_TTL_DAYS = 90;

interface Candidate {
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  smartphone_status: string;
  dashboard_activated: boolean;
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
    const singleTenantId = body.tenant_id ? String(body.tenant_id) : null;
    const mode = String(body.mode ?? (singleTenantId ? "invite" : "discovery"));

    if (mode !== "discovery" && mode !== "invite") {
      return new Response(
        JSON.stringify({ success: false, error: `Unknown mode "${mode}" — expected "discovery" or "invite"` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const eventKey = mode === "discovery" ? "SMARTPHONE_DISCOVERY" : "DASHBOARD_INVITE";
    const event = await loadEvent(admin, eventKey);
    if (!event || !event.active) {
      return new Response(
        JSON.stringify({ success: true, message: "Event missing or inactive — nothing sent", sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!event.body_template) throw new Error(`${eventKey} has no body_template configured`);

    // These templates are meaningless without a link, so a missing origin is a
    // hard error rather than a message with the link silently removed.
    const origin = Deno.env.get("PUBLIC_SITE_ORIGIN") || "https://welileapp.com";
    const domainName = origin.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!event.body_template.includes("{{dashboard_link}}")) {
      throw new Error(`${eventKey} template must contain {{dashboard_link}}`);
    }

    let rows: Candidate[] = [];

    if (singleTenantId) {
      // Call-centre path: send on request, bypassing the segment filter, but
      // still requiring a real tenant with a phone number.
      const { data: profile, error: profileError } = await admin
        .from("profiles")
        .select("id, full_name, phone, smartphone_status, dashboard_activated, deleted_at")
        .eq("id", singleTenantId)
        .maybeSingle();
      if (profileError) throw profileError;

      if (!profile || profile.deleted_at || !String(profile.phone ?? "").trim()) {
        return new Response(
          JSON.stringify({ success: false, error: "Tenant not found, deleted, or has no phone number" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      rows = [{
        tenant_id: profile.id,
        tenant_name: profile.full_name,
        tenant_phone: profile.phone,
        smartphone_status: profile.smartphone_status,
        dashboard_activated: profile.dashboard_activated,
      }];
    } else {
      const { data, error } = await admin.rpc("get_tenant_dashboard_link_candidates", {
        p_mode: mode,
        p_limit: Number(body.limit ?? 2000),
      });
      if (error) throw error;
      rows = (data ?? []) as Candidate[];
    }

    const day = kampalaDate();
    const results = { sent: 0, skipped: 0, failed: 0 };
    const skipReasons: Record<string, number> = {};
    const preview: unknown[] = [];
    const statusAppendices = await loadTenantStatusAppendices(
      admin,
      rows.map((row) => row.tenant_id),
      domainName,
    );

    for (const row of rows) {
      const phone = String(row.tenant_phone ?? "").trim();
      if (!phone) continue;

      if (dryRun) {
        if (preview.length < 10) {
          preview.push({
            tenant_id: row.tenant_id,
            smartphone_status: row.smartphone_status,
            dashboard_activated: row.dashboard_activated,
            // Placeholder token: a dry run must not mint real credentials.
            message: renderTemplate(event.body_template, {
              name: firstName(row.tenant_name),
              dashboard_link: `${origin}/t/<token>`,
              status_appendix: statusAppendices.get(row.tenant_id) ?? "",
            }),
          });
        }
        continue;
      }

      try {
        const token = generateLinkToken();
        const tokenHash = await sha256Hex(token);

        const { data: linkId, error: linkError } = await admin.rpc("issue_tenant_dashboard_link", {
          p_tenant_id: row.tenant_id,
          p_token_hash: tokenHash,
          p_purpose: singleTenantId ? "call_centre" : mode,
          p_ttl_days: LINK_TTL_DAYS,
          p_created_by: null,
        });
        if (linkError) throw linkError;

        const dashboardLink = `${origin}/t/${token}`;
        const vars = {
          name: firstName(row.tenant_name),
          dashboard_link: dashboardLink,
          status_appendix: statusAppendices.get(row.tenant_id) ?? "",
        };

        // Stage 6: DASHBOARD_INVITE/SMARTPHONE_DISCOVERY both have push/
        // in-app disabled in the channel policy (a tenant reaching this
        // sender has, by definition, no confirmed device or has never
        // opened the dashboard — push/in-app are unusable for them), so this
        // resolves to the same SMS-only send as before. Routed anyway for
        // the shared governor/logging path and so notificationLogId is
        // available for the deterministic attribution below.
        const outcome = await routeTenantNotification({
          admin,
          tenantId: row.tenant_id,
          eventKey,
          episodeKey: `${mode}:${day}`,
          vars,
          phone,
          tenantName: row.tenant_name,
          // The raw token is never logged — only the row it belongs to.
          payload: {
            day,
            link_id: linkId,
            smartphone_status: row.smartphone_status,
            call_centre: Boolean(singleTenantId),
          },
          linkPath: `/t/${token}`,
        });

        const delivered = outcome.smsSent || outcome.pushSent > 0 || outcome.inAppCreated;
        if (delivered) {
          results.sent++;
          // Deterministic attribution (Stage 5): this link now points back to
          // the exact SMS that carried it, so a later open attributes to this
          // row instead of a "most recent send" heuristic.
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

          // A link minted for a send that never reached the tenant — refused
          // by the governor, or rejected by the provider — is dead weight;
          // revoke it so it cannot be used later by someone reading the log.
          if (linkId) {
            await admin
              .from("tenant_dashboard_links")
              .update({ revoked_at: new Date().toISOString() })
              .eq("id", linkId);
          }
        }
      } catch (err) {
        results.failed++;
        console.error(`[${eventKey}] send failed for ${row.tenant_id}:`, err);
      }
    }

    if (dryRun) {
      return new Response(
        JSON.stringify({ success: true, dry_run: true, mode, candidates: rows.length, sample: preview }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(
      `[${eventKey}] mode=${mode} candidates=${rows.length} sent=${results.sent} ` +
        `skipped=${results.skipped} failed=${results.failed}`,
    );

    return new Response(
      JSON.stringify({ success: true, mode, candidates: rows.length, ...results, skip_reasons: skipReasons }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[tenant-dashboard-invites] Fatal:", msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
