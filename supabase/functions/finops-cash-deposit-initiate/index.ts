import "../_shared/noSignupPrompt.ts";
import "../_shared/smsFooterInterceptor.ts";
// Financial Ops initiated cash deposit — Step 1.
//
// A Financial Ops operator starts a cash deposit ON BEHALF of a depositor by
// entering the depositor's phone number and the cash amount. We resolve the
// depositor profile by phone, create the pending deposit_requests row plus its
// cash_deposit_verifications row, and SMS the 4-digit code (OTP) straight to
// the depositor's phone. The depositor then enters the code in the app
// (cash-deposit-verify-code) which is the ONLY path that credits the wallet —
// this function never credits anything.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sha256Hex } from "../_shared/cash-verification-core.ts";
import { sendSMS, formatPhoneInternational } from "../_shared/sendSmsMultiProvider.ts";
import {
  normalizeEmail,
  resolveDepositorEmail,
  sendCashDepositCodeEmail,
} from "../_shared/cashDepositCodeEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const ALLOWED_ROLES = [
  "financial_ops",
  "cfo",
  "super_admin",
  "manager",
  "operations",
];

function last9(raw: string): string {
  return String(raw || "").replace(/\D/g, "").slice(-9);
}

function generateReceiptCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += (b % 10).toString();
  return s;
}

const fmtUGX = (n: number) => `UGX ${Math.round(n).toLocaleString("en-UG")}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: authData, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !authData?.user) return json(401, { error: "Unauthorized" });
    const operator = authData.user;

    // ── Authorisation: Financial Ops staff only ──
    const { data: roleRows } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", operator.id);
    const roles = (roleRows ?? []).map((r: any) => String(r.role));
    if (!roles.some((r) => ALLOWED_ROLES.includes(r))) {
      return json(403, {
        error: "not_authorized",
        message: "Only Financial Ops staff can start a cash deposit on behalf of a depositor.",
      });
    }

    const body = await req.json().catch(() => ({}));
    const amount = Number(body?.amount);
    const phoneRaw = typeof body?.phone === "string" ? body.phone.trim() : "";
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(400, { error: "invalid_amount", message: "Enter a valid amount" });
    }
    if (amount < 500) {
      return json(400, { error: "amount_too_small", message: "Minimum cash deposit is UGX 500" });
    }
    const phone9 = last9(phoneRaw);
    if (phone9.length !== 9) {
      return json(400, { error: "invalid_phone", message: "Enter a valid Ugandan phone number" });
    }

    // ── SERVER-SIDE PURPOSE LOCK (2026-10-02) ─────────────────────────
    // Financial Ops cash deposits are recorded ONLY as operational_float.
    // Any deposit_purpose sent by the client is ignored — the UI no longer
    // offers a choice, and this is the server-side backstop so a crafted
    // request cannot record a Financial Ops deposit as personal_deposit
    // (which would route it to the depositor's withdrawable balance on
    // approval instead of company float).
    const requestedPurpose = typeof body?.deposit_purpose === "string" ? body.deposit_purpose : null;
    const depositPurpose = "operational_float";
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 300) : "";
    const cashOwnerName = typeof body?.cash_owner_name === "string"
      ? body.cash_owner_name.trim().replace(/\s+/g, " ").slice(0, 120)
      : "";
    if (cashOwnerName.length < 3) {
      return json(400, {
        error: "owner_name_required",
        message: "Enter the full name of the person whose cash this is.",
      });
    }
    const cashLocation = String(body?.cash_location) === "bank" ? "bank" : "cash_at_hand";
    const cashLocationLabel = cashLocation === "bank" ? "Deposited on bank" : "Cash at hand";
    // Email is an ALTERNATIVE delivery channel for the same code. It never
    // credits anything — the depositor still has to enter the code in the app.
    const wantsEmail = body?.send_email === true;
    const emailOverride = normalizeEmail(body?.email);
    if (body?.email !== undefined && body?.email !== null && String(body.email).trim() !== "" && !emailOverride) {
      return json(400, { error: "invalid_email", message: "Enter a valid email address" });
    }

    // ── Resolve the depositor by phone ──
    const candidates = [phone9, `0${phone9}`, `256${phone9}`, `+256${phone9}`];
    const { data: profileRows } = await admin
      .from("profiles")
      .select("id, full_name, phone")
      .in("phone", candidates);
    const depositor = (profileRows ?? []).find((p: any) => last9(p.phone) === phone9) ?? null;
    if (!depositor) {
      return json(404, {
        error: "user_not_found",
        message: "No Welile account found with that phone number.",
      });
    }

    // ── Block stacking: one live awaiting-code session per depositor ──
    const { data: live } = await admin
      .from("cash_deposit_verifications")
      .select("id, expires_at")
      .eq("user_id", (depositor as any).id)
      .eq("status", "awaiting_code")
      .gt("expires_at", new Date().toISOString())
      .limit(1);
    if (live && live.length > 0) {
      return json(409, {
        error: "code_in_progress",
        message: "This depositor already has a live cash deposit code. Wait for it to expire or be used.",
      });
    }

    const purposeLabel = "Operational Float";
    const notes = [
      `Purpose: ${purposeLabel}`,
      `Cash owner: ${cashOwnerName}`,
      "Channel: Cash (code verified)",
      `Custody: ${cashLocationLabel}`,
      "Started by Financial Ops (SMS code)",
      reason,
    ].filter(Boolean).join(" | ");

    const placeholderRef = `CASHREQ-${crypto.randomUUID().slice(0, 18)}`;
    const { data: inserted, error: insErr } = await admin
      .from("deposit_requests")
      .insert({
        user_id: (depositor as any).id,
        amount,
        status: "pending",
        provider: "cash_deposit",
        transaction_id: placeholderRef,
        transaction_date: new Date().toISOString(),
        notes,
        deposit_purpose: depositPurpose,
        purpose_audit: {
          chosen_purpose: depositPurpose,
          chosen_at: new Date().toISOString(),
          chosen_by: operator.id,
          entry_point: "finops_cash_code_sms",
          cash_location: cashLocation,
          cash_owner_name: cashOwnerName,
          agent_personal_confirmed_at: new Date().toISOString(),
          ...(requestedPurpose && requestedPurpose !== depositPurpose
            ? { requested_purpose_ignored: requestedPurpose }
            : {}),
        },
      } as any)
      .select("id")
      .single();
    if (insErr || !inserted) {
      console.error("[finops-cash-initiate] deposit insert failed", insErr);
      return json(400, { error: "create_failed", message: insErr?.message || "Could not start the deposit" });
    }
    const depositId = (inserted as any).id as string;

    const code = generateReceiptCode();
    const codeHash = await sha256Hex(code);
    const { data: verRow, error: vErr } = await admin
      .from("cash_deposit_verifications")
      .insert({
        deposit_request_id: depositId,
        user_id: (depositor as any).id,
        amount,
        // Only the hash is stored: the code is never kept in readable form.
        code_hash: codeHash,
        emailed_to: null,
        status: "awaiting_code",
      } as any)
      .select("id, expires_at, max_attempts")
      .single();
    if (vErr) {
      console.error("[finops-cash-initiate] verification insert failed", vErr);
      await admin.from("deposit_requests").delete().eq("id", depositId);
      return json(400, { error: "create_failed", message: vErr.message });
    }

    // ── SMS the code to the depositor ──
    const smsPhone = formatPhoneInternational((depositor as any).phone || `0${phone9}`);
    const message =
      `Welile cash deposit code: ${code}. ` +
      `Amount ${fmtUGX(amount)}. Enter this code in the Welile app to confirm your cash deposit. ` +
      `Valid for 10 minutes. Do not share it with anyone who has not received your cash.`;
    let smsSent = false;
    try {
      smsSent = await sendSMS(smsPhone, message, {
        admin,
        source: "finops-cash-deposit-initiate",
        reference_id: depositId,
        recipient_user_id: (depositor as any).id,
        recipient_name: (depositor as any).full_name ?? null,
        // Cash-deposit codes are time-critical: require Yoola to confirm handset
        // delivery, otherwise fail over to Africa's Talking.
        requireDeliveryConfirmation: true,
      });
    } catch (e) {
      console.error("[finops-cash-initiate] sms failed", e);
    }

    // ── Email the same code (operator asked for it, or SMS was refused) ──
    let emailSent = false;
    let emailAddress: string | null = null;
    let emailError: string | null = null;
    if (wantsEmail || !smsSent) {
      emailAddress = await resolveDepositorEmail(admin, (depositor as any).id, emailOverride);
      if (!emailAddress) {
        emailError = "No email address on file for this depositor.";
      } else {
        const res = await sendCashDepositCodeEmail(admin, {
          email: emailAddress,
          code,
          amount,
          depositorName: (depositor as any).full_name ?? null,
          cashOwnerName,
          depositRequestId: depositId,
          expiresAt: (verRow as any)?.expires_at,
        });
        emailSent = res.sent;
        emailError = res.error;
        if (emailSent) {
          await admin
            .from("cash_deposit_verifications")
            .update({ emailed_to: emailAddress } as any)
            .eq("id", (verRow as any)?.id);
        }
      }
    }

    const deliveredChannels = [smsSent ? "SMS" : null, emailSent ? "email" : null].filter(Boolean);

    try {
      await admin.from("cash_deposit_verification_events").insert({
        verification_id: (verRow as any)?.id ?? null,
        deposit_request_id: depositId,
        user_id: (depositor as any).id,
        event_type: "code_issued",
        amount,
        detail: deliveredChannels.length
          ? `Receipt code issued by Financial Ops and sent to the depositor by ${deliveredChannels.join(" and ")} (10-minute expiry).`
          : "Receipt code issued by Financial Ops. SMS and email delivery were not accepted — read the code from the Cash Deposit Codes panel.",
        metadata: {
          delivery: deliveredChannels.length
            ? deliveredChannels.map((c) => String(c).toLowerCase()).join("+")
            : "fin_ops_panel",
          initiated_by: operator.id,
          depositor_phone: smsPhone,
          depositor_email: emailAddress,
          email_sent: emailSent,
          email_error: emailError,
          expires_at: (verRow as any)?.expires_at ?? null,
          max_attempts: (verRow as any)?.max_attempts ?? null,
          deposit_purpose: depositPurpose,
          cash_location: cashLocation,
          cash_owner_name: cashOwnerName,
        },
      } as any);
    } catch (e) {
      console.warn("[finops-cash-initiate] audit log failed", e);
    }

    return json(200, {
      ok: true,
      deposit_request_id: depositId,
      verification_id: (verRow as any)?.id ?? null,
      sms_sent: smsSent,
      email_sent: emailSent,
      depositor_email: emailAddress,
      email_error: emailError,
      depositor_name: cashOwnerName,
      wallet_holder_name: (depositor as any).full_name ?? null,
      depositor_phone: smsPhone,
      expires_at: (verRow as any)?.expires_at ?? null,
    });
  } catch (e) {
    console.error("[finops-cash-initiate] error", e);
    return json(500, { error: "server_error", message: String((e as Error)?.message ?? e) });
  }
});