// Self-service resolution for a payout destination stuck in
// payout_destination_verifications.status = 'waiting': the withdrawing user
// asks the destination's real owner to confirm by SMS code, instead of
// waiting on a Financial Ops phone call. See
// _shared/payoutDestinationDeclaration.ts for the consent logic.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  requestPayoutDestinationConsent,
  confirmPayoutDestinationConsent,
} from "../_shared/payoutDestinationDeclaration.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ok = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (msg: string, status = 400, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error: msg, ...extra }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function validPhone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const digits = v.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return null;
  return v.trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!token) return err("Sign in to continue", 401);
    const { data: authData, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !authData?.user) return err("Sign in to continue", 401);
    const userId = authData.user.id;

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return err("Invalid request body"); }
    const action = String(body.action || "");

    /* ------------------------------------------------------- request ---- */
    if (action === "request") {
      const destinationId = typeof body.destination_verification_id === "string" ? body.destination_verification_id : "";
      if (!destinationId) return err("destination_verification_id is required");

      const { data: destination, error: destErr } = await admin
        .from("payout_destination_verifications")
        .select("id, user_id, destination_type, momo_number, bank_name, bank_account_number, account_name, status, name_match_score, decision_reason")
        .eq("id", destinationId)
        .maybeSingle();
      if (destErr || !destination) return err("Payout destination not found", 404);
      if (destination.user_id !== userId) return err("This payout destination doesn't belong to you", 403);
      if (destination.status === "verified") return ok({ already_verified: true });
      if (destination.status === "rejected") {
        // Only recoverable when the rejection was purely a name-mismatch call
        // (e.g. the no-merchant-role bulk sweep, whose own reason text invites
        // the withdrawer back through this exact flow) -- never for the
        // fraud-specific auto-rejects (double submission / duplicate National
        // ID), where SMS-proving phone control doesn't resolve the actual
        // concern and would let a real fraud signal be self-service-overridden.
        const reason = String(destination.decision_reason || "");
        const isFraudReject = /double submission|already recorded on another account/i.test(reason);
        if (isFraudReject) {
          return err("This destination was rejected and can't be resubmitted this way. Contact support.", 400);
        }
      } else if (destination.status !== "waiting") {
        return err("This destination is not awaiting verification.", 400);
      }
      if (!destination.account_name) {
        return err("This destination has no registered name on file. Please re-add it with the account holder's name.", 400);
      }

      const { data: profile } = await admin
        .from("profiles").select("full_name").eq("id", userId).maybeSingle();
      const borrowerFullName = String(profile?.full_name || "").trim();
      if (!borrowerFullName) return err("Your profile has no name on file.", 400);

      let ownerPhone: string | null = null;
      if (destination.destination_type === "mobile_money") {
        ownerPhone = validPhone(destination.momo_number);
        if (!ownerPhone) return err("This mobile money destination has no valid number on file.", 400);
      } else {
        ownerPhone = validPhone(body.owner_phone);
        if (!ownerPhone) {
          return err(
            "Enter the bank account owner's phone number so we can confirm they've allowed you to use this account.",
            409,
            { code: "owner_phone_required" },
          );
        }
      }

      const { declarationId } = await requestPayoutDestinationConsent(admin, {
        destinationVerificationId: destination.id,
        borrowerUserId: userId,
        borrowerFullName,
        destinationType: destination.destination_type,
        destinationOwnerName: String(destination.account_name),
        ownerPhone,
        nameMatchScore: destination.name_match_score ?? null,
        momoNumber: destination.momo_number,
        bankName: destination.bank_name,
        bankAccountNumber: destination.bank_account_number,
      });

      return ok({
        declaration_id: declarationId,
        message: "We've sent a code to the destination owner's phone. Ask them to share it with you, then confirm it here.",
      });
    }

    /* ------------------------------------------------------- confirm ---- */
    if (action === "confirm") {
      const declarationId = typeof body.declaration_id === "string" ? body.declaration_id : "";
      const code = typeof body.code === "string" ? body.code : "";
      if (!declarationId || !code) return err("declaration_id and code are required");

      const { data: declaration } = await admin
        .from("payout_destination_declarations")
        .select("id, borrower_user_id")
        .eq("id", declarationId)
        .maybeSingle();
      if (!declaration) return err("Declaration not found", 404);
      if (declaration.borrower_user_id !== userId) return err("This declaration doesn't belong to you", 403);

      // Optional correction to the name the destination is registered in. Only
      // accepted alongside a correct owner code, i.e. after ownership of that
      // number/account has just been proven.
      let confirmedName: string | null = null;
      if (typeof body.confirmed_account_name === "string" && body.confirmed_account_name.trim()) {
        const candidate = body.confirmed_account_name.trim().replace(/\s+/g, " ");
        if (candidate.length < 3 || candidate.length > 80 || !/^[A-Za-z][A-Za-z .'-]*$/.test(candidate)) {
          return err("Enter the name on the account as it is registered — letters only, at least 3 characters.");
        }
        confirmedName = candidate;
      }

      const result = await confirmPayoutDestinationConsent(admin, declarationId, code, confirmedName);
      if (!result.ok) return err(result.error, 400);

      return ok({ verified: true });
    }

    return err("Unknown action. Use 'request' or 'confirm'.");
  } catch (e: any) {
    console.error("[payout-destination-consent] unhandled", e?.message || e);
    return err(`Service error: ${e?.message || "unknown"}`, 500);
  }
});
