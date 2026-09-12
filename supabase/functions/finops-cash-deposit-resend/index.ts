import "../_shared/noSignupPrompt.ts";
import "../_shared/smsFooterInterceptor.ts";
// Financial Ops — resend/reissue a cash deposit code.
//
// The old path used the `fin_ops_reissue_cash_code` RPC, which rotated the code
// in the database but had NO way to send an SMS — so the UI claimed "New code
// sent by SMS" while the depositor never received anything. This function
// rotates the code AND actually delivers it, reporting real delivery status.
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

const ALLOWED_ROLES = ["financial_ops", "cfo", "coo", "super_admin", "manager", "operations"];

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

    const body = await req.json().catch(() => ({}));
    const accountResend = body?.account_resend === true;
    const depositRequestId = typeof body?.deposit_request_id === "string" ? body.deposit_request_id.trim() : "";
    let verificationId = typeof body?.verification_id === "string" ? body.verification_id.trim() : "";

    if (!accountResend) {
      const { data: roleRows } = await admin
        .from("user_roles").select("role").eq("user_id", operator.id);
      const roles = (roleRows ?? []).map((r: any) => String(r.role));
      if (!roles.some((r) => ALLOWED_ROLES.includes(r))) {
        return json(403, {
          error: "not_authorized",
          message: "Only Financial Ops staff can resend a cash deposit code.",
        });
      }
    } else if (!depositRequestId) {
      return json(400, { error: "invalid_request", message: "The deposit reference is missing." });
    }

    if (!verificationId && !accountResend) {
      return json(400, { error: "invalid_request", message: "verification_id is required" });
    }
    // Email is an ALTERNATIVE delivery channel for the same code; it credits nothing.
    const wantsEmail = accountResend || body?.send_email === true;
    const emailOverride = accountResend ? null : normalizeEmail(body?.email);
    if (body?.email !== undefined && body?.email !== null && String(body.email).trim() !== "" && !emailOverride) {
      return json(400, { error: "invalid_email", message: "Enter a valid email address" });
    }

    let verificationQuery = admin
      .from("cash_deposit_verifications")
      .select("id, deposit_request_id, user_id, amount, status")
      .limit(1);
    verificationQuery = accountResend
      ? verificationQuery.eq("deposit_request_id", depositRequestId).eq("user_id", operator.id)
      : verificationQuery.eq("id", verificationId);
    const { data: verificationRows, error: vErr } = await verificationQuery;
    const ver = verificationRows?.[0] ?? null;
    if (vErr) return json(400, { error: "lookup_failed", message: vErr.message });
    if (!ver) {
      return json(404, {
        error: "verification_not_found",
        message: accountResend
          ? "No cash deposit code was found for this signed-in account."
          : "That deposit code session no longer exists.",
      });
    }
    verificationId = String((ver as any).id);
    if ((ver as any).status === "verified") {
      return json(409, { error: "already_verified", message: "This deposit has already been verified." });
    }

    if (accountResend) {
      const { data: deposit, error: depositError } = await admin
        .from("deposit_requests")
        .select("status, rejection_reason")
        .eq("id", (ver as any).deposit_request_id)
        .eq("user_id", operator.id)
        .maybeSingle();
      if (depositError || !deposit) {
        return json(404, { error: "deposit_not_found", message: "This deposit does not belong to your account." });
      }
      const status = String((deposit as any).status ?? "");
      const rejectionReason = String((deposit as any).rejection_reason ?? "").toLowerCase();
      const expiredRejection = status === "rejected" && rejectionReason.includes("code expired");
      if (status !== "pending" && !expiredRejection) {
        return json(409, { error: "deposit_not_resendable", message: "A new code cannot be issued for this deposit." });
      }
    }

    const { data: profile } = await admin
      .from("profiles").select("id, full_name, phone").eq("id", (ver as any).user_id).maybeSingle();
    const rawPhone = (profile as any)?.phone ?? "";
    const hasPhone = Boolean(rawPhone) && String(rawPhone).replace(/\D/g, "").length >= 9;
    if (!hasPhone && !wantsEmail) {
      return json(400, {
        error: "no_phone",
        message: "The depositor has no usable phone number on file, so the code cannot be delivered by SMS.",
      });
    }
    const smsPhone = hasPhone ? formatPhoneInternational(rawPhone) : null;

    const code = generateReceiptCode();
    const codeHash = await sha256Hex(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { error: upErr } = await admin
      .from("cash_deposit_verifications")
      .update({
        // Only the hash is stored: the code is never kept in readable form.
        code_hash: codeHash,
        code_plain: null,
        status: "awaiting_code",
        attempts: 0,
        expires_at: expiresAt,
      } as any)
      .eq("id", verificationId);
    if (upErr) return json(400, { error: "reissue_failed", message: upErr.message });

    // Reviving a code session must also revive the deposit request itself.
    // A previously expired window auto-rejects the deposit; if we leave it
    // rejected, the new code verifies but `approve-deposit` refuses to credit
    // it (and Financial Ops later cannot mark it as banked).
    await admin
      .from("deposit_requests")
      .update({
        status: "pending",
        rejection_reason: null,
        rejected_at: null,
      } as any)
      .eq("id", (ver as any).deposit_request_id)
      .eq("status", "rejected");

    const amount = Number((ver as any).amount ?? 0);
    const message =
      `Welile cash deposit code: ${code}. ` +
      `Amount ${fmtUGX(amount)}. Enter this code in the Welile app to confirm your cash deposit. ` +
      `Valid for 10 minutes. Do not share it with anyone who has not received your cash.`;

    let smsSent = false;
    let smsError: string | null = null;
    if (smsPhone) try {
      smsSent = await sendSMS(smsPhone!, message, {
        admin,
        source: "finops-cash-deposit-resend",
        reference_id: (ver as any).deposit_request_id,
        recipient_user_id: (ver as any).user_id,
        recipient_name: (profile as any)?.full_name ?? null,
        // Time-critical code: require Yoola handset confirmation, else fail
        // over to Africa's Talking.
        requireDeliveryConfirmation: true,
      });
    } catch (e) {
      smsError = String((e as Error)?.message ?? e);
      console.error("[finops-cash-resend] sms failed", e);
    }

    // ── Email the same code (operator asked, or SMS was refused) ──
    let emailSent = false;
    let emailAddress: string | null = null;
    let emailError: string | null = null;
    if (wantsEmail || !smsSent) {
      emailAddress = await resolveDepositorEmail(admin, (ver as any).user_id, emailOverride);
      if (!emailAddress) {
        emailError = "No email address on file for this depositor.";
      } else {
        const res = await sendCashDepositCodeEmail(admin, {
          email: emailAddress,
          code,
          amount,
          depositorName: (profile as any)?.full_name ?? null,
          depositRequestId: (ver as any).deposit_request_id,
          expiresAt,
        });
        emailSent = res.sent;
        emailError = res.error;
        if (emailSent) {
          await admin
            .from("cash_deposit_verifications")
            .update({ emailed_to: emailAddress } as any)
            .eq("id", verificationId);
        }
      }
    }

    const deliveredChannels = [smsSent ? "SMS" : null, emailSent ? "email" : null].filter(Boolean);

    try {
      await admin.from("cash_deposit_verification_events").insert({
        verification_id: verificationId,
        deposit_request_id: (ver as any).deposit_request_id,
        user_id: (ver as any).user_id,
        event_type: "code_reissued",
        amount,
        detail: deliveredChannels.length
          ? `Code reissued by Financial Ops and delivered to the depositor by ${deliveredChannels.join(" and ")} (10-minute expiry).`
          : `Code reissued by Financial Ops but delivery was NOT accepted${smsError ? `: ${smsError}` : ""}${emailError ? ` (email: ${emailError})` : ""}.`,
        metadata: {
          delivery: deliveredChannels.length
            ? deliveredChannels.map((c) => String(c).toLowerCase()).join("+")
            : "failed",
          reissued_by: operator.id,
          account_self_resend: accountResend,
          depositor_phone: smsPhone,
          depositor_email: emailAddress,
          email_sent: emailSent,
          email_error: emailError,
          expires_at: expiresAt,
          sms_error: smsError,
        },
      } as any);
    } catch (e) {
      console.warn("[finops-cash-resend] audit log failed", e);
    }

    if (!smsSent && !emailSent) {
      return json(502, {
        error: "code_not_delivered",
        message: `A new code was generated but delivery was not accepted${smsPhone ? ` (SMS to ${smsPhone}${smsError ? `: ${smsError}` : ""})` : ""}${emailError ? ` (email: ${emailError})` : ""}. Read the code from the Cash Deposit Codes list instead.`,
        verification_id: verificationId,
        expires_at: expiresAt,
      });
    }

    return json(200, {
      ok: true,
      sms_sent: smsSent,
      email_sent: emailSent,
      depositor_phone: smsPhone,
      depositor_email: emailAddress,
      email_error: emailError,
      expires_at: expiresAt,
    });
  } catch (e) {
    console.error("[finops-cash-resend] error", e);
    return json(500, { error: "server_error", message: String((e as Error)?.message ?? e) });
  }
});
