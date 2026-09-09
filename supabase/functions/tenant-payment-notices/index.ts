// Payment-behaviour SMS: payment received, partial payment, missed payment.
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
//     tenants whose daily amount went unpaid that the balance carried forward.
//
// Every balance in every message comes from get_tenant_payment_day_state. This
// function never recomputes what a tenant owes -- the SMS layer consuming
// obligation state rather than deriving its own was an explicit instruction.
//
// Frequency, opt-outs and once-per-day idempotency are handled by
// notifyTenant + the notification engine, not here.
import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyTenant } from "../_shared/tenantNotify.ts";

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

function firstName(fullName: string | null): string {
  return String(fullName || "").trim().split(/\s+/)[0] || "there";
}

function ugx(n: unknown): string {
  return `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;
}

/** Kampala calendar date (UTC+3, no DST) — the obligation day boundary. */
function kampalaDate(offsetDays = 0): string {
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  return shifted.toISOString().slice(0, 10);
}

// Regulatory terminology throughout: "Rent Plan", never "loan"; "Returns",
// never "interest" or "ROI".
function clearedMessage(row: PaymentCandidate): string {
  const tail = Number(row.outstanding) > 0
    ? `Rent Plan balance: ${ugx(row.outstanding)}.`
    : `Your Rent Plan is fully repaid.`;
  return (
    `Hi ${firstName(row.tenant_name)}, Welile received ${ugx(row.paid_on_day)}. ` +
    `Today's rent is cleared. ${tail} ` +
    `Paying on time keeps improving your Welile rent access.`
  );
}

function partialMessage(row: PaymentCandidate): string {
  return (
    `Hi ${firstName(row.tenant_name)}, Welile received ${ugx(row.paid_on_day)} of ` +
    `today's ${ugx(row.daily_expected)} rent. ${ugx(row.remaining_today)} is still due today ` +
    `and carries forward. Rent Plan balance: ${ugx(row.outstanding)}.`
  );
}

function missedMessage(row: MissedCandidate, day: string): string {
  return (
    `Hi ${firstName(row.tenant_name)}, your ${ugx(row.daily_expected)} Welile rent for ${day} ` +
    `was not paid and has been carried forward. Rent Plan balance: ${ugx(row.outstanding)}. ` +
    `Pay via MTN/Airtel to Welile or through your agent.`
  );
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

    const results = { sent: 0, skipped: 0, failed: 0 };
    const skipReasons: Record<string, number> = {};
    const preview: unknown[] = [];

    async function dispatch(
      tenantId: string,
      eventKey: string,
      episodeKey: string,
      phone: string,
      name: string | null,
      message: string,
      payload: Record<string, unknown>,
    ) {
      if (dryRun) {
        if (preview.length < 10) {
          preview.push({ tenant_id: tenantId, event: eventKey, episode_key: episodeKey, message });
        }
        return;
      }
      try {
        const outcome = await notifyTenant({
          admin,
          tenantId,
          eventKey,
          episodeKey,
          phone,
          tenantName: name,
          message,
          payload,
        });
        if (outcome.sent) {
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

      for (const row of rows) {
        const phone = String(row.tenant_phone ?? "").trim();
        if (!phone) continue;

        const cleared = row.day_state === "cleared";
        // Episode is the obligation day, so a tenant who pays repeatedly gets
        // at most one "partial" and one "cleared" message for that day — and
        // a partial that later completes still earns the cleared confirmation.
        await dispatch(
          row.tenant_id,
          cleared ? "payment_received" : "payment_partial",
          `${cleared ? "paid" : "partial"}:${day}`,
          phone,
          row.tenant_name,
          cleared ? clearedMessage(row) : partialMessage(row),
          {
            day,
            day_state: row.day_state,
            daily_expected: row.daily_expected,
            paid_on_day: row.paid_on_day,
            remaining_today: row.remaining_today,
            outstanding: row.outstanding,
          },
        );
      }
    } else {
      // Default to the day that has just closed; today is still in progress
      // and a tenant who has not paid yet this morning has not missed anything.
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

      for (const row of rows) {
        const phone = String(row.tenant_phone ?? "").trim();
        if (!phone) continue;

        await dispatch(
          row.tenant_id,
          "payment_missed",
          `missed:${day}`,
          phone,
          row.tenant_name,
          missedMessage(row, day),
          {
            day,
            daily_expected: row.daily_expected,
            outstanding: row.outstanding,
            last_pay_date: row.last_pay_date,
            days_since_last_payment: row.days_since_last_payment,
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
