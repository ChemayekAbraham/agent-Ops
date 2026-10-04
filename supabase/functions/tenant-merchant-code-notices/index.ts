// MERCHANT_CODE_REMINDER — Stage 3C.
//
// From the 2026-09-06 meeting: promote direct payment so tenants are not
// wholly dependent on an agent being available. Sent to tenants carrying an
// unpaid or partly-paid obligation for the day, so the instruction arrives
// when it is actually useful.
//
// Merchant codes come from the payment_channels table, never from this file.
// They were previously hardcoded in src/components/payments/DepositFlow.tsx,
// which means a code change had to be made in two places that could silently
// disagree — and an SMS quoting a stale merchant code sends money to the
// wrong place.
//
// Also supports a single-tenant call-centre invocation: pass { tenant_id } to
// send payment instructions to one tenant on request.
import "../_shared/smsFooterInterceptor.ts";
// Every message here goes to an existing tenant, so the platform-wide
// "Not on Welile yet? Sign up" prompt is both wrong for the audience and
// ~48 wasted characters that can push the SMS into a second billed segment.
import "../_shared/noSignupPrompt.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { routeTenantNotification } from "../_shared/tenantChannelRouter.ts";
import {
  firstName,
  loadEvent,
  loadPaymentChannels,
  payChannelsPhrase,
  renderTemplate,
} from "../_shared/tenantTemplates.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVENT_KEY = "MERCHANT_CODE_REMINDER";

interface Candidate {
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  daily_expected: number;
  remaining_today: number;
  outstanding: number;
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

    const event = await loadEvent(admin, EVENT_KEY);
    if (!event || !event.active) {
      return new Response(
        JSON.stringify({ success: true, message: "Event missing or inactive — nothing sent", sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!event.body_template) throw new Error(`${EVENT_KEY} has no body_template configured`);

    const channels = await loadPaymentChannels(admin);
    if (!channels.mtn && !channels.airtel) {
      // The entire point of the message is the codes. Without them it would
      // render as "Pay Welile directly using MTN  or Airtel ."
      return new Response(
        JSON.stringify({
          success: false,
          error: "No active payment channels configured — refusing to send payment instructions without merchant codes",
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data, error } = await admin.rpc("get_tenant_merchant_code_candidates", {
      p_max_days_since_last_payment:
        body.max_days_since_last_payment === null
          ? null
          : Number(body.max_days_since_last_payment ?? 30),
      p_require_prior_payment: body.require_prior_payment !== false,
    });
    if (error) throw error;

    let rows = (data ?? []) as Candidate[];
    if (singleTenantId) {
      // Call-centre path: the operator asked for this tenant specifically, so
      // the behavioural filter is bypassed — but the tenant must still have an
      // active plan, which is what the selector establishes.
      rows = rows.filter((r) => r.tenant_id === singleTenantId);
      if (rows.length === 0) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Tenant not found among tenants with an active Rent Plan and a payable obligation",
          }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const day = kampalaDate();
    const results = { sent: 0, skipped: 0, failed: 0 };
    const skipReasons: Record<string, number> = {};
    const preview: unknown[] = [];

    for (const row of rows) {
      const phone = String(row.tenant_phone ?? "").trim();
      if (!phone) continue;

      const vars = {
        name: firstName(row.tenant_name),
        pay_channels: payChannelsPhrase(channels),
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
          eventKey: EVENT_KEY,
          episodeKey: `merchant:${day}`,
          vars,
          phone,
          tenantName: row.tenant_name,
          payload: {
            day,
            remaining_today: row.remaining_today,
            outstanding: row.outstanding,
            mtn_code: channels.mtn,
            airtel_code: channels.airtel,
            call_centre: Boolean(singleTenantId),
          },
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
        JSON.stringify({
          success: true, dry_run: true, candidates: rows.length,
          channels, sample: preview,
        }),
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
