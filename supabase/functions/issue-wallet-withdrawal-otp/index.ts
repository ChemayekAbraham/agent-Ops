// Issue an OTP to the account's own registered phone (profiles.phone) before
// a mobile-money or bank-transfer wallet withdrawal is allowed to submit.
//
// Closes the account-takeover gap: submit_withdrawal_request previously let
// anyone with an open session type in ANY payout number/name and submit it.
// The only existing guard (trg_enforce_withdrawal_payout_account_lock) only
// blocks CHANGING an already-registered number — a first-ever destination on
// an account sailed straight through to Financial Ops' call-based
// verification, which only proves the typed-in number is live and answered,
// not that whoever answered is the account's real owner. Sending this code to
// the account's OWN phone (not the payout destination being entered) proves
// whoever is submitting still controls the account's original channel.
//
// Cash pickups are exempt — no destination-redirection surface (physical
// code collected in person).
//
// Gate ORDER matters and is deliberate: check Financial-Ops destination
// verification FIRST, before generating or sending anything. That check
// (ensure_payout_destination) is a ONE-TIME state per destination — once Ops
// verifies a number/account it stays verified for every future withdrawal to
// it. The OTP, by contrast, is required on EVERY single withdrawal regardless
// of destination history. Checking the one-time gate first means an
// unverified destination is rejected immediately with no SMS sent (and no
// wasted verification code) instead of the user completing a whole OTP
// round-trip only to have submit_withdrawal_request reject it afterwards on
// the destination check. This call also doubles as first-time registration:
// a brand-new destination is inserted into payout_destination_verifications
// (status 'waiting') right here, exactly as it would be inside
// submit_withdrawal_request — so it still enters Financial Ops' queue even
// though the OTP path never reaches that RPC until verification succeeds.
import "../_shared/noSignupPrompt.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS, isUgandanPhone } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OTP_TTL_SECONDS = 600; // 10 minutes — this gates the user's own money in
// one continuous flow, not an asynchronous third-party confirmation like the
// landlord payout OTP, so a much shorter window is appropriate.

function generateOtp(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return "•••••";
  const last3 = digits.slice(-3);
  return `+••• ••• ${last3}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Missing authorization" }, 401);
    const { data: u, error: uErr } = await admin.auth.getUser(auth.replace("Bearer ", ""));
    if (uErr || !u?.user) return json({ error: "Invalid token" }, 401);
    const userId = u.user.id;

    const body = await req.json().catch(() => ({}));
    const {
      amount,
      payout_method,
      mobile_money_number,
      mobile_money_name,
      mobile_money_provider,
      bank_name,
      bank_account_number,
      bank_account_name,
      reason,
      client_request_id,
    } = body ?? {};

    const method = String(payout_method ?? "").toLowerCase();
    if (!["mobile_money", "bank_transfer"].includes(method)) {
      return json({ error: "OTP verification only applies to mobile_money and bank_transfer withdrawals" }, 400);
    }
    if (!client_request_id) return json({ error: "client_request_id is required" }, 400);

    // Same authoritative bounds submit_withdrawal_request will re-check — an
    // OTP is never issued for a request that cannot possibly succeed. This is
    // a defense-in-depth mirror, not a replacement: the RPC re-validates
    // everything again when the code is verified.
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt !== Math.floor(amt)) {
      return json({ error: "Amount must be a positive whole number" }, 400);
    }
    if (amt < 1000) return json({ error: "Minimum withdrawal is UGX 1,000" }, 400);
    if (amt > 50000000) return json({ error: "Maximum withdrawal per request is UGX 50,000,000" }, 400);

    let provider: string | null = null;
    if (method === "mobile_money") {
      provider = String(mobile_money_provider ?? "").toLowerCase();
      if (!["mtn", "airtel"].includes(provider)) return json({ error: "Mobile money provider must be MTN or Airtel" }, 400);
      const num = String(mobile_money_number ?? "").trim();
      const nm = String(mobile_money_name ?? "").trim();
      if (!num || !nm) return json({ error: "Mobile money number and account name are required" }, 400);
      if (!/^\+?[0-9 ]{9,15}$/.test(num)) return json({ error: "Mobile money number must be 9-15 digits" }, 400);
    } else {
      const bn = String(bank_name ?? "").trim();
      const ban = String(bank_account_number ?? "").trim();
      const bac = String(bank_account_name ?? "").trim();
      if (!bn || !ban || !bac) return json({ error: "Bank name, account number, and account holder name are required" }, 400);
    }

    // ── Gate 2 first: Financial-Ops destination verification (one-time). ──
    // ensure_payout_destination both checks AND registers — a brand-new
    // destination gets inserted as 'waiting' right here, entering the Ops
    // queue immediately even though this OTP path never reaches
    // submit_withdrawal_request until the code is verified.
    const { data: destData, error: destErr } = await admin.rpc("ensure_payout_destination", {
      p_user_id: userId,
      p_method: method,
      p_momo_number: method === "mobile_money" ? String(mobile_money_number).trim() : null,
      p_momo_name: method === "mobile_money" ? String(mobile_money_name).trim() : null,
      p_provider: method === "mobile_money" ? provider : null,
      p_bank_name: method === "bank_transfer" ? String(bank_name).trim() : null,
      p_bank_account_number: method === "bank_transfer" ? String(bank_account_number).trim() : null,
      p_bank_account_name: method === "bank_transfer" ? String(bank_account_name).trim() : null,
    });
    if (destErr) {
      console.error("[issue-wallet-withdrawal-otp] ensure_payout_destination error", destErr);
      return json({ error: destErr.message ?? "Could not check payout destination" }, 500);
    }
    const destRow = Array.isArray(destData) ? destData[0] : destData;
    const destStatus = destRow?.status ?? "waiting";

    // A destination that Ops has not looked at yet is NOT a blocker when the
    // user has already submitted their National ID + photos and this number is
    // the one locked to that identity. This mirrors
    // public.withdrawal_destination_gate ('identity_captured_pending_review'),
    // so the OTP path and the submit path agree. Only a REJECTED destination,
    // or a user who never submitted identity details, is refused here.
    let identityPendingOk = false;
    if (destStatus !== "verified" && destStatus !== "rejected" && method === "mobile_money") {
      const digits = String(mobile_money_number ?? "").replace(/[^0-9]/g, "");
      const tail = digits.slice(-9);
      const { data: bindings } = await admin
        .from("user_identity_bindings")
        .select("national_id, linked_national_id, national_id_photo_path, selfie_photo_path, locked_payout_number, status")
        .eq("user_id", userId)
        .neq("status", "revoked");
      identityPendingOk = (bindings ?? []).some((b: Record<string, string | null>) => {
        const locked = String(b.locked_payout_number ?? "").replace(/[^0-9]/g, "");
        return (
          tail.length === 9 &&
          locked.endsWith(tail) &&
          String(b.national_id ?? b.linked_national_id ?? "").trim() !== "" &&
          String(b.national_id_photo_path ?? "").trim() !== "" &&
          String(b.selfie_photo_path ?? "").trim() !== ""
        );
      });
    }

    if (destStatus !== "verified" && !identityPendingOk) {
      // No SMS sent, no challenge created — the withdrawal cannot succeed
      // yet regardless of the code, so don't spend either on it.
      return json({
        error: destStatus === "rejected" ? "destination_rejected" : "identity_not_submitted",
        message: destStatus === "rejected"
          ? `This payout destination was rejected by Financial Ops. Reason: ${destRow?.decision_reason ?? "not stated"}. Contact support.`
          : "Submit your National ID details and payout phone number first, then you can withdraw. No verification code was sent.",
        destination_status: destStatus,
      }, 400);
    }


    // ── Gate 1 next: OTP delivered to the WITHDRAWAL (payout) phone number the
    // user is sending the money to, so the code lands on the handset that owns
    // the destination. The account's registered phone is only a fallback when
    // the payout number is not a usable Ugandan number (e.g. bank transfer).
    // Routing is by phone NUMBER only — never by MTN/Airtel provider choice;
    // the shared sender picks the carrier route itself.
    const { data: profile } = await admin.from("profiles").select("phone").eq("id", userId).maybeSingle();
    const accountPhone = String(profile?.phone ?? "").trim();
    const payoutPhone = method === "mobile_money" ? String(mobile_money_number ?? "").trim() : "";
    const otpPhone = isUgandanPhone(payoutPhone) ? payoutPhone : accountPhone;
    if (!otpPhone || !isUgandanPhone(otpPhone)) {
      return json({
        error: "no_account_phone",
        message: "We could not find a usable phone number to send the code to. Check the withdrawal number, or add a phone number in Settings.",
      }, 400);
    }

    // Resend / re-issue path: one challenge per (user, client_request_id).
    const { data: existing } = await admin
      .from("wallet_withdrawal_otp_challenges")
      .select("*")
      .eq("user_id", userId)
      .eq("client_request_id", client_request_id)
      .maybeSingle();

    if (existing?.status === "verified") {
      // Idempotent — a duplicate issue call after verification must never
      // re-send a code or reset the already-completed challenge.
      return json({ success: true, already_verified: true, challenge_id: existing.id });
    }

    const otp = generateOtp();
    const otp_hash = await sha256(otp);
    const otp_expires_at = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();

    let challengeId: string;
    if (existing) {
      await admin
        .from("wallet_withdrawal_otp_challenges")
        .update({
          amount: amt,
          payout_method: method,
          mobile_money_number: method === "mobile_money" ? String(mobile_money_number).trim() : null,
          mobile_money_name: method === "mobile_money" ? String(mobile_money_name).trim() : null,
          mobile_money_provider: method === "mobile_money" ? provider : null,
          bank_name: method === "bank_transfer" ? String(bank_name).trim() : null,
          bank_account_number: method === "bank_transfer" ? String(bank_account_number).trim() : null,
          bank_account_name: method === "bank_transfer" ? String(bank_account_name).trim() : null,
          reason: reason ? String(reason).slice(0, 200) : null,
          account_phone: otpPhone,
          otp_hash,
          otp_expires_at,
          attempts: 0,
          status: "pending",
        })
        .eq("id", existing.id);
      challengeId = existing.id;
    } else {
      const { data: inserted, error: insErr } = await admin
        .from("wallet_withdrawal_otp_challenges")
        .insert({
          user_id: userId,
          client_request_id,
          amount: amt,
          payout_method: method,
          mobile_money_number: method === "mobile_money" ? String(mobile_money_number).trim() : null,
          mobile_money_name: method === "mobile_money" ? String(mobile_money_name).trim() : null,
          mobile_money_provider: method === "mobile_money" ? provider : null,
          bank_name: method === "bank_transfer" ? String(bank_name).trim() : null,
          bank_account_number: method === "bank_transfer" ? String(bank_account_number).trim() : null,
          bank_account_name: method === "bank_transfer" ? String(bank_account_name).trim() : null,
          reason: reason ? String(reason).slice(0, 200) : null,
          account_phone: otpPhone,
          otp_hash,
          otp_expires_at,
        })
        .select("id")
        .single();
      if (insErr || !inserted) {
        console.error("[issue-wallet-withdrawal-otp] insert failed", insErr);
        return json({ error: insErr?.message ?? "Could not create OTP challenge" }, 500);
      }
      challengeId = inserted.id;
    }

    // Dispatch the SMS in the background: the delivery-report wait plus the
    // Africa's Talking failover used to be held open inside the request, which
    // made "Send code" feel slow. The challenge row already exists, so the UI
    // can move to the code entry step immediately.
    const deliver = (async () => {
      const smsSent = await sendSMS(
        otpPhone,
        // Kept short on purpose: the previous wording plus the support footer ran
        // to two SMS parts, which Yoola accepted but never confirmed delivering.
        `Welile withdrawal code: ${otp}. Valid 10 min. Do not share it.`,
        {
          admin,
          source: "wallet_withdrawal_otp",
          reference_id: challengeId,
          recipient_user_id: userId,
          // Time-critical: if Yoola does not confirm the handset received it, fail
          // over to Africa's Talking instead of leaving the user without a code.
          requireDeliveryConfirmation: true,
          deliveryConfirmation: { attempts: 2, delayMs: 1500 },
        },
      );

      await admin.from("wallet_withdrawal_otp_events").insert({
        challenge_id: challengeId,
        user_id: userId,
        event_type: existing ? "resent" : "sent",
        detail: smsSent ? "OTP sent via SMS" : "OTP created but SMS delivery failed",
        failure_reason: smsSent ? null : "sms_not_delivered",
        metadata: { sms_sent: smsSent },
      });
    })().catch((err) => console.error("[issue-wallet-withdrawal-otp] sms dispatch failed", err));

    const waitUntil = (globalThis as any)?.EdgeRuntime?.waitUntil;
    if (typeof waitUntil === "function") waitUntil(deliver);
    else await deliver;

    return json({
      success: true,
      challenge_id: challengeId,
      masked_phone: maskPhone(otpPhone),
      expires_at: otp_expires_at,
      sms_sent: true,
    });
  } catch (e) {
    console.error("[issue-wallet-withdrawal-otp] error", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});
