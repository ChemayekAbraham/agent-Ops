// Verify the OTP issued by issue-wallet-withdrawal-otp, then submit the
// withdrawal via submit_withdrawal_request as the SAME calling user (so
// auth.uid() inside that SECURITY DEFINER RPC resolves correctly and every
// authoritative check it already performs — balance, format, destination
// verification status — still runs in full). OTP success alone never
// bypasses those checks; it only proves the caller currently controls the
// account's own registered phone before the request is even attempted.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function logEvent(
  admin: ReturnType<typeof createClient>,
  challengeId: string,
  userId: string,
  opts: { event_type: string; failure_reason?: string | null; detail?: string | null; metadata?: Record<string, unknown> },
) {
  try {
    await admin.from("wallet_withdrawal_otp_events").insert({
      challenge_id: challengeId,
      user_id: userId,
      event_type: opts.event_type,
      failure_reason: opts.failure_reason ?? null,
      detail: opts.detail ?? null,
      metadata: opts.metadata ?? {},
    });
  } catch (e) {
    console.error("[verify-wallet-withdrawal-otp] logEvent failed", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);
    const { data: u, error: uErr } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
    if (uErr || !u?.user) return json({ error: "Invalid token" }, 401);
    const userId = u.user.id;

    const { challenge_id, otp } = (await req.json().catch(() => ({}))) ?? {};
    if (!challenge_id || !otp || !/^\d{6}$/.test(String(otp))) {
      return json({ error: "Invalid request" }, 400);
    }

    const { data: ch, error: chErr } = await admin
      .from("wallet_withdrawal_otp_challenges")
      .select("*")
      .eq("id", challenge_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (chErr || !ch) return json({ error: "Challenge not found" }, 404);

    // Idempotent re-verify: the OTP already succeeded once. Re-run the
    // lookup of the resulting withdrawal instead of re-submitting (which
    // would either double-submit or, thanks to submit_withdrawal_request's
    // own client_request_id uniqueness, harmlessly no-op — but we can just
    // answer directly without a second RPC round-trip).
    if (ch.status === "verified") {
      if (ch.resulting_withdrawal_id) {
        const { data: wr } = await admin
          .from("withdrawal_requests")
          .select("id, payout_code")
          .eq("id", ch.resulting_withdrawal_id)
          .maybeSingle();
        return json({
          success: true,
          code: "already_submitted",
          request_id: ch.resulting_withdrawal_id,
          payout_code: wr?.payout_code ?? null,
        });
      }
      return json({ success: true, code: "already_verified", request_id: null });
    }
    if (ch.status !== "pending") {
      return json({ error: `Challenge already ${ch.status}` }, 400);
    }
    if (new Date(ch.otp_expires_at).getTime() < Date.now()) {
      await admin.from("wallet_withdrawal_otp_challenges").update({ status: "expired" }).eq("id", challenge_id);
      await logEvent(admin, challenge_id, userId, { event_type: "failed", failure_reason: "expired" });
      return json({ error: "OTP expired. Request a new code." }, 400);
    }
    if (ch.attempts >= ch.max_attempts) {
      await admin.from("wallet_withdrawal_otp_challenges").update({ status: "failed" }).eq("id", challenge_id);
      await logEvent(admin, challenge_id, userId, { event_type: "failed", failure_reason: "too_many_attempts" });
      return json({ error: "Too many attempts. Request a new code." }, 400);
    }

    const submittedHash = await sha256(String(otp));
    if (submittedHash !== ch.otp_hash) {
      const newAttempts = ch.attempts + 1;
      const exhausted = newAttempts >= ch.max_attempts;
      await admin
        .from("wallet_withdrawal_otp_challenges")
        .update({ attempts: newAttempts, status: exhausted ? "failed" : "pending" })
        .eq("id", challenge_id);
      await logEvent(admin, challenge_id, userId, {
        event_type: exhausted ? "failed" : "incorrect_attempt",
        failure_reason: exhausted ? "too_many_attempts" : "invalid_code",
        metadata: { attempts: newAttempts, max_attempts: ch.max_attempts },
      });
      return json(
        { error: exhausted ? "Too many incorrect attempts. Request a new code." : "Incorrect code", attempts_left: ch.max_attempts - newAttempts },
        400,
      );
    }

    // Correct code. Mark verified, then submit as the calling user — a
    // userClient (anon key + forwarded Authorization) so auth.uid() resolves
    // inside submit_withdrawal_request exactly as if the user had called it
    // directly, and every one of its own checks (balance, format, payout
    // destination verification) still applies in full.
    const verified_at = new Date().toISOString();
    await admin
      .from("wallet_withdrawal_otp_challenges")
      .update({ status: "verified", verified_at })
      .eq("id", challenge_id);
    await logEvent(admin, challenge_id, userId, { event_type: "verified" });

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: rpcData, error: rpcError } = await userClient.rpc("submit_withdrawal_request", {
      p_amount: ch.amount,
      p_payout_method: ch.payout_method,
      p_mobile_money_number: ch.mobile_money_number,
      p_mobile_money_name: ch.mobile_money_name,
      p_mobile_money_provider: ch.mobile_money_provider,
      p_bank_name: ch.bank_name,
      p_bank_account_number: ch.bank_account_number,
      p_bank_account_name: ch.bank_account_name,
      p_client_request_id: ch.client_request_id,
      p_reason: ch.reason,
    });

    if (rpcError) {
      console.error("[verify-wallet-withdrawal-otp] submit_withdrawal_request error", rpcError);
      await logEvent(admin, challenge_id, userId, {
        event_type: "submit_failed",
        failure_reason: "rpc_error",
        detail: rpcError.message,
      });
      // The OTP itself was correct — surface the RPC's own error rather than
      // a generic failure so the user (or a retry) sees the real reason.
      return json({ error: rpcError.message }, 400);
    }

    const result = (rpcData ?? {}) as {
      success?: boolean;
      code?: string;
      message?: string;
      request_id?: string;
      payout_code?: string | null;
      available?: number;
    };

    if (result?.request_id) {
      await admin
        .from("wallet_withdrawal_otp_challenges")
        .update({ resulting_withdrawal_id: result.request_id })
        .eq("id", challenge_id);
    }

    await logEvent(admin, challenge_id, userId, {
      event_type: result?.success ? "submitted" : "submit_rejected",
      failure_reason: result?.success ? null : (result?.code ?? "rejected"),
      detail: result?.message ?? null,
    });

    return json(result);
  } catch (e) {
    console.error("[verify-wallet-withdrawal-otp] error", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});
