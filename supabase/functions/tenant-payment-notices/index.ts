// Payment-behaviour SMS: PAYMENT_FULL, PAYMENT_PARTIAL, PAYMENT_MISSED.
//
// From the 2026-09-09 tenant-ops meeting. Two modes, because the triggers have
// different shapes:
//
//   mode=payments (default) -- short sweep, run every few minutes. Picks up
//     tenants who paid since the last sweep and tells them where the day
//     actually stands: cleared, or partial with the remainder carried forward.
//     Partial payments getting their own message was the specific emphasis --
//     a short payment must never read as "nothing received".
//
//   mode=missed -- once daily, after the obligation day has closed. Tells
//     tenants whose daily amount went unpaid that the balance carried forward,
//     and how to pay directly.
//
// Every amount in every message comes from get_tenant_payment_day_state and
// every merchant code from payment_channels. This function computes no
// balances and hardcodes no codes: business logic determines the event, the
// engine only communicates what is already known to be true.
//
// Frequency, opt-outs, channel selection (SMS/push/in-app) and once-per-day
// idempotency are handled by routeTenantNotification, not here.
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
  loadPaymentChannels,
  loadTenantStatusAppendices,
  loadSupportContacts,
  loadTenantPaymentMessageVars,
  payDirectSentence,
  progressSentence,
  cycleSentence,
  accessSentence,
  nextLevelSentence,
  growthSentence,
  loadRentAccessCap,
  careSentence,
  renderTemplate,
  type NotificationEvent,
} from "../_shared/tenantTemplates.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_SWEEP_MINUTES = 20;

interface PaymentCandidate {
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  daily_expected: number;
  paid_on_day: number;
  remaining_today: number;
  outstanding: number;
  day_state: "cleared" | "partial";
}

interface MissedCandidate {
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  daily_expected: number;
  outstanding: number;
  last_pay_date: string | null;
  days_since_last_payment: number | null;
}

/** Kampala calendar date (UTC+3, no DST) — the obligation day boundary. */
function kampalaDate(offsetDays = 0): string {
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  return shifted.toISOString().slice(0, 10);
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

    const mode = String(body.mode ?? "payments");
    const dryRun = body.dry_run === true;

    if (mode !== "payments" && mode !== "missed") {
      return new Response(
        JSON.stringify({ success: false, error: `Unknown mode "${mode}" — expected "payments" or "missed"` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Load every template this run may need up front; a missing template is a
    // configuration error, not something to paper over per tenant.
    const neededKeys = mode === "payments"
      ? ["PAYMENT_FULL", "PAYMENT_PARTIAL"]
      : ["PAYMENT_MISSED"];

    const events = new Map<string, NotificationEvent>();
    for (const key of neededKeys) {
      const event = await loadEvent(admin, key);
      if (!event) throw new Error(`${key} has no catalog row`);
      if (!event.body_template) throw new Error(`${key} has no body_template configured`);
      events.set(key, event);
    }

    const activeKeys = neededKeys.filter((k) => events.get(k)!.active);
    if (activeKeys.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "All events for this mode are inactive — nothing sent", sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const channels = await loadPaymentChannels(admin);
    // Care numbers are configuration (tenant_support_contacts), never literals.
    const supportContacts = await loadSupportContacts(admin);
    const careNote = careSentence(supportContacts);

    // Per-tenant dashboard links do not exist yet (Stage 4C); until they do
    // dashboardSuffix() returns "" and these messages end after the balance.
    const suffix = dashboardSuffix(null);
    const origin = Deno.env.get("PUBLIC_SITE_ORIGIN") || "https://welileapp.com";
    const domainName = origin.replace(/^https?:\/\//, "").replace(/\/+$/, "");

    const results = { sent: 0, skipped: 0, failed: 0 };
    const skipReasons: Record<string, number> = {};
    const preview: unknown[] = [];

    // Stage 6: routed through routeTenantNotification, which decides SMS vs
    // push vs in-app per tenant_notification_channel_policy — all three are
    // "critical" for the payment events, so every eligible channel fires
    // rather than one being chosen over another (see the policy seed's
    // comment on financial events).
    async function dispatch(
      tenantId: string,
      eventKey: string,
      episodeKey: string,
      phone: string,
      name: string | null,
      vars: Record<string, string | number | null | undefined>,
      payload: Record<string, unknown>,
    ) {
      if (!events.get(eventKey)?.active) {
        results.skipped++;
        skipReasons["event_inactive"] = (skipReasons["event_inactive"] ?? 0) + 1;
        return;
      }
      if (dryRun) {
        if (preview.length < 10) {
          const message = renderTemplate(events.get(eventKey)!.body_template!, vars);
          preview.push({ tenant_id: tenantId, event: eventKey, episode_key: episodeKey, message });
        }
        return;
      }
      try {
        const outcome = await routeTenantNotification({
          admin,
          tenantId,
          eventKey,
          episodeKey,
          vars,
          phone,
          tenantName: name,
          payload,
          linkPath: null,
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
        console.error(`[tenant-payment-notices] ${eventKey} failed for ${tenantId}:`, err);
      }
    }

    let candidateCount = 0;

    if (mode === "payments") {
      const sinceMinutes = Number(body.since_minutes ?? DEFAULT_SWEEP_MINUTES);
      const day = kampalaDate(0);

      const { data, error } = await admin.rpc("get_tenant_payment_notice_candidates", {
        p_since_minutes: sinceMinutes,
      });
      if (error) throw error;

      const rows = (data ?? []) as PaymentCandidate[];
      candidateCount = rows.length;
      const statusAppendices = await loadTenantStatusAppendices(
        admin,
        rows.map((row) => row.tenant_id),
        domainName,
      );
      // Plan progress and top-up eligibility for the same tenants, read from the
      // authoritative plan/collection data. Nothing here changes payment state.
      const planVars = await loadTenantPaymentMessageVars(
        admin,
        rows.map((row) => row.tenant_id),
      );
      const accessCap = await loadRentAccessCap(admin);

      for (const row of rows) {
        const phone = String(row.tenant_phone ?? "").trim();
        if (!phone) continue;

        const cleared = row.day_state === "cleared";
        const eventKey = cleared ? "PAYMENT_FULL" : "PAYMENT_PARTIAL";

        const vars = {
          name: firstName(row.tenant_name),
          amount_paid: formatUGX(row.paid_on_day),
          amount_due: formatUGX(row.daily_expected),
          remaining_balance: formatUGX(row.remaining_today),
          balance: formatUGX(row.outstanding),
          dashboard_suffix: suffix,
          status_appendix: statusAppendices.get(row.tenant_id) ?? "",
          // Exact money amounts only — a tenant is never told a percentage.
          plan_progress: progressSentence(planVars.get(row.tenant_id)),
          cycle_timing: cycleSentence(planVars.get(row.tenant_id)),
          access_now: accessSentence(planVars.get(row.tenant_id)),
          next_level: nextLevelSentence(planVars.get(row.tenant_id)),
          growth_note: growthSentence(accessCap),
          pay_direct: payDirectSentence(channels),
          care_note: careNote,
        };

        // Episode is the obligation day, so a tenant who pays repeatedly gets
        // at most one "partial" and one "cleared" message for that day — and
        // a partial that later completes still earns the cleared confirmation.
        await dispatch(
          row.tenant_id,
          eventKey,
          `${cleared ? "paid" : "partial"}:${day}`,
          phone,
          row.tenant_name,
          vars,
          {
            day,
            day_state: row.day_state,
            daily_expected: row.daily_expected,
            paid_on_day: row.paid_on_day,
            remaining_today: row.remaining_today,
            outstanding: row.outstanding,
            eligibility: planVars.get(row.tenant_id) ?? null,
          },
        );
      }
    } else {
      // Default to the day that has just closed; today is still in progress
      // and a tenant who has not paid yet this morning has missed nothing.
      const day = String(body.as_of ?? kampalaDate(-1));

      const { data, error } = await admin.rpc("get_tenant_missed_obligation_candidates", {
        p_as_of: day,
        p_max_days_since_last_payment:
          body.max_days_since_last_payment === null
            ? null
            : Number(body.max_days_since_last_payment ?? 30),
        p_require_prior_payment: body.require_prior_payment !== false,
      });
      if (error) throw error;

      const rows = (data ?? []) as MissedCandidate[];
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
          amount_due: formatUGX(row.daily_expected),
          balance: formatUGX(row.outstanding),
          pay_direct: payDirectSentence(channels),
          dashboard_suffix: suffix,
          status_appendix: statusAppendices.get(row.tenant_id) ?? "",
        };

        await dispatch(
          row.tenant_id,
          "PAYMENT_MISSED",
          `missed:${day}`,
          phone,
          row.tenant_name,
          vars,
          {
            day,
            daily_expected: row.daily_expected,
            outstanding: row.outstanding,
            last_pay_date: row.last_pay_date,
            days_since_last_payment: row.days_since_last_payment,
            mtn_code: channels.mtn,
            airtel_code: channels.airtel,
          },
        );
      }
    }

    if (dryRun) {
      return new Response(
        JSON.stringify({ success: true, dry_run: true, mode, candidates: candidateCount, sample: preview }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(
      `[tenant-payment-notices] mode=${mode} candidates=${candidateCount} sent=${results.sent} ` +
        `skipped=${results.skipped} failed=${results.failed}`,
    );

    return new Response(
      JSON.stringify({ success: true, mode, candidates: candidateCount, ...results, skip_reasons: skipReasons }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[tenant-payment-notices] Fatal:", msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
