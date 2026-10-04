// Verify OTP for agent-initiated landlord payout, then trigger disbursement.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Structured audit-log writer. failure_reason is one of:
// invalid_code | expired | already_verified | too_many_attempts | timeout | disburse_failed | challenge_<status>
async function logEvent(
  admin: ReturnType<typeof createClient>,
  ch: { landlord_id?: string | null; landlord_phone?: string | null; amount?: number | null },
  challenge_id: string,
  agentId: string,
  opts: { event_type: string; failure_reason?: string | null; detail?: string | null; metadata?: Record<string, unknown> },
) {
  try {
    await admin.from("landlord_payout_otp_events").insert({
      challenge_id,
      agent_id: agentId,
      landlord_id: ch?.landlord_id ?? null,
      event_type: opts.event_type,
      failure_reason: opts.failure_reason ?? null,
      landlord_phone: ch?.landlord_phone ?? null,
      amount: ch?.amount ?? null,
      detail: opts.detail ?? null,
      metadata: opts.metadata ?? {},
    });
  } catch (e) {
    console.error("[verify-landlord-payout-otp] logEvent failed", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Missing authorization" }, 401);
    const { data: u, error: uErr } = await admin.auth.getUser(auth.replace("Bearer ", ""));
    if (uErr || !u?.user) return json({ error: "Invalid token" }, 401);
    const agentId = u.user.id;

    const { challenge_id, otp } = (await req.json().catch(() => ({}))) ?? {};
    if (!challenge_id || !otp || !/^\d{6}$/.test(String(otp))) {
      if (challenge_id) {
        await logEvent(admin, {}, String(challenge_id), agentId, {
          event_type: "incorrect_attempt",
          failure_reason: "invalid_code",
          detail: "Submitted code was missing or not a 6-digit number",
        });
      }
      return json({ error: "Invalid request" }, 400);
    }

    const { data: ch, error: chErr } = await admin
      .from("landlord_payout_otp_challenges")
      .select("*")
      .eq("id", challenge_id)
      .eq("agent_id", agentId)
      .maybeSingle();
    if (chErr || !ch) return json({ error: "Challenge not found" }, 404);

    // Idempotency: a verified challenge is NOT an error. Return the same
    // success payload every time so the client can safely re-verify after
    // network hiccups, remounts, refreshes, or duplicate submits without
    // ever seeing "Challenge already verified" while the OTP UI is still
    // rendered. Verification and disbursement are decoupled — the caller
    // must never be asked to re-verify a challenge that already reached
    // status='verified'.
    if (ch.status === "verified") {
      await logEvent(admin, ch, challenge_id, agentId, {
        event_type: "already_verified",
        failure_reason: "already_verified",
        detail: "Idempotent re-verify — challenge was already verified",
      });
      return json({
        success: true,
        already_verified: true,
        challenge_id,
        payout_id: ch.resulting_payout_id ?? null,
        verified_at: ch.verified_at,
      });
    }
    if (ch.status !== "pending") {
      await logEvent(admin, ch, challenge_id, agentId, {
        event_type: "failed",
        failure_reason: `challenge_${ch.status}`,
        detail: `Challenge already ${ch.status}`,
      });
      return json({ error: `Challenge already ${ch.status}`, status: ch.status }, 400);
    }
    if (new Date(ch.otp_expires_at).getTime() < Date.now()) {
      await admin.from("landlord_payout_otp_challenges").update({ status: "expired" }).eq("id", challenge_id);
      await logEvent(admin, ch, challenge_id, agentId, {
        event_type: "failed",
        failure_reason: "expired",
        detail: "OTP expired before verification",
      });
      return json({ error: "OTP expired. Request a new code." }, 400);
    }
    if (ch.attempts >= ch.max_attempts) {
      await admin.from("landlord_payout_otp_challenges").update({ status: "failed" }).eq("id", challenge_id);
      await logEvent(admin, ch, challenge_id, agentId, {
        event_type: "failed",
        failure_reason: "too_many_attempts",
        detail: "Too many attempts — challenge locked",
      });
      return json({ error: "Too many attempts. Start over." }, 400);
    }

    // Platform Controls pause: never mark a challenge verified while landlord
    // float withdrawals are paused (it would strand a "verified" challenge with
    // no payout). Fail closed if the flag cannot be read.
    const { data: paused, error: pausedErr } = await admin.rpc("landlord_float_withdrawals_paused");
    if (pausedErr || paused !== false) {
      await logEvent(admin, ch, challenge_id, agentId, {
        event_type: "failed",
        failure_reason: "withdrawals_paused",
        detail: "Landlord float withdrawals are paused from Platform Controls — OTP not consumed",
      });
      return json({
        error: "Landlord float withdrawals are currently paused. Nothing was sent. Try again once they are re-enabled.",
        code: "landlord_float_withdrawals_paused",
      }, 423);
    }

    const submitted_hash = await sha256(String(otp));
    if (submitted_hash !== ch.otp_hash) {
      const newAttempts = ch.attempts + 1;
      const exhausted = newAttempts >= ch.max_attempts;
      await admin
        .from("landlord_payout_otp_challenges")
        .update({ attempts: newAttempts, status: exhausted ? "failed" : "pending" })
        .eq("id", challenge_id);
      await logEvent(admin, ch, challenge_id, agentId, {
        event_type: exhausted ? "failed" : "incorrect_attempt",
        failure_reason: exhausted ? "too_many_attempts" : "invalid_code",
        detail: exhausted ? "Too many incorrect attempts" : `Incorrect OTP (attempt ${newAttempts}/${ch.max_attempts})`,
        metadata: { attempts: newAttempts, max_attempts: ch.max_attempts },
      });
      return json(
        { error: exhausted ? "Too many incorrect attempts." : "Incorrect OTP", attempts_left: ch.max_attempts - newAttempts },
        400,
      );
    }

    // Mark verified
    const verified_at = new Date().toISOString();
    await admin
      .from("landlord_payout_otp_challenges")
      .update({ status: "verified", verified_at })
      .eq("id", challenge_id);

    await admin.from("landlord_payout_otp_events").insert({
      challenge_id,
      agent_id: agentId,
      landlord_id: ch.landlord_id,
      event_type: "verified",
      landlord_phone: ch.landlord_phone,
      amount: ch.amount,
      detail: "OTP verified by landlord — disbursement triggered",
    });

    // Trigger disbursement (passes agent's own JWT so the existing function attributes correctly)
    let disburseRes: Response;
    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtrl.abort(), 25000);
    try {
      disburseRes = await fetch(`${SUPABASE_URL}/functions/v1/landlord-payout-disburse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
        },
        signal: timeoutCtrl.signal,
        body: JSON.stringify({
          rent_request_id: ch.rent_request_id ?? challenge_id, // fallback for ad-hoc payouts
          landlord_id: ch.landlord_id,
          tenant_id: ch.tenant_id,
          amount: ch.amount,
          landlord_phone: ch.landlord_phone,
          landlord_name: ch.landlord_name,
          mobile_money_provider: ch.mobile_money_provider,
          otp_verified_at: verified_at,
          agent_latitude: ch.agent_latitude,
          agent_longitude: ch.agent_longitude,
          property_latitude: ch.property_latitude,
          property_longitude: ch.property_longitude,
        }),
      });
    } catch (e) {
      clearTimeout(timeoutId);
      const isTimeout = e instanceof DOMException && e.name === "AbortError";
      await logEvent(admin, ch, challenge_id, agentId, {
        event_type: "failed",
        failure_reason: isTimeout ? "timeout" : "disburse_failed",
        detail: isTimeout ? "Disbursement request timed out" : "Disbursement request error",
      });
      return json(
        { error: isTimeout ? "Disbursement timed out. Please retry." : "Disbursement failed to start", challenge_id },
        504,
      );
    }
    clearTimeout(timeoutId);

    const disburseBody = await disburseRes.json().catch(() => ({}));
    if (!disburseRes.ok) {
      await logEvent(admin, ch, challenge_id, agentId, {
        event_type: "failed",
        failure_reason: "disburse_failed",
        detail: disburseBody?.error ?? "Disbursement failed to start",
      });
      return json(
        { error: disburseBody?.error ?? "Disbursement failed to start", challenge_id },
        disburseRes.status,
      );
    }

    // Link resulting payout back to challenge
    if (disburseBody?.payout_id) {
      await admin
        .from("landlord_payout_otp_challenges")
        .update({ resulting_payout_id: disburseBody.payout_id })
        .eq("id", challenge_id);
    }

    return json({
      success: true,
      challenge_id,
      payout_id: disburseBody?.payout_id ?? null,
      verified_at,
    });
  } catch (e) {
    console.error("[verify-landlord-payout-otp] error", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});