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

    // The account's OWN registered phone (signup/login channel) — never the
    // payout destination the user is entering right now.
    const { data: profile } = await admin.from("profiles").select("phone").eq("id", userId).maybeSingle();
    const accountPhone = String(profile?.phone ?? "").trim();
    if (!accountPhone || !isUgandanPhone(accountPhone)) {
      return json({
        error: "no_account_phone",
        message: "Your account has no verified phone number on file. Add one in Settings before withdrawing.",
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
          account_phone: accountPhone,
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
          account_phone: accountPhone,
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

    const smsSent = await sendSMS(
      accountPhone,
      `Your withdrawal verification code is ${otp}. Valid 10 minutes. Do not share this code with anyone, including Welile staff or agents.`,
      {
        admin,
        source: "wallet_withdrawal_otp",
        reference_id: challengeId,
        recipient_user_id: userId,
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

    return json({
      success: true,
      challenge_id: challengeId,
      masked_phone: maskPhone(accountPhone),
      expires_at: otp_expires_at,
      sms_sent: smsSent,
    });
  } catch (e) {
    console.error("[issue-wallet-withdrawal-otp] error", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});
