import "../_shared/noSignupPrompt.ts";
import "../_shared/smsFooterInterceptor.ts";
// Cash deposit — Step 2: the depositor enters the receipt code that the
// verifier (weliletenants@gmail.com) read back to them after receiving the
// cash. We hash the entered code, compare it to the stored hash, enforce
// expiry + attempt limits, and on a match auto-credit the wallet via
// approve-deposit (system_auto_credit) and SMS the depositor a confirmation
// with the verified amount and their updated balance (Africa's Talking).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  evaluateAttempt,
  normalizeCode,
  sha256Hex,
} from "../_shared/cash-verification-core.ts";
import {
  resolveDepositorEmail,
  maskDepositCode,
  sendCashDepositWalletConfirmationEmail,
} from "../_shared/cashDepositCodeEmail.ts";
import {
  cashDepositReceiptFilename,
  renderCashDepositReceipt,
} from "../_shared/cashDepositReceiptPdf.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Normalize a Ugandan phone number to E.164 (+256…).
function formatPhoneInternational(phone: string): string {
  const digits = (phone ?? "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

// Yoola is the PRIMARY SMS gateway; Africa's Talking is the fallback. Phone for
// Yoola is digits only with country code, no leading "+".
async function sendViaYoola(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  // Trim — Yoola returns 403 "invalidkey" if the key has surrounding whitespace.
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) {
    console.warn("[cash-verify-code] Yoola not configured");
    return { ok: false, reason: "yoola_not_configured" };
  }
  const phoneYoola = formatPhoneInternational(phone).replace(/^\+/, "");
  if (!phoneYoola) return { ok: false, reason: "invalid_phone" };
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ phone: phoneYoola, message, api_key: apiKey, sender: "WELILE" }),
    });
    const raw = await res.text();
    let data: any;
    try { data = JSON.parse(raw); } catch { data = null; }
    const status = String(data?.status ?? "").toLowerCase();
    // Treat any successful HTTP response that Yoola did not explicitly reject as
    // "accepted" so Africa's Talking never double-sends after a real delivery.
    const ok =
      res.ok &&
      (status === "success" || status === "ok" || status === "sent" || status === "queued" ||
        (!data?.error && status === ""));
    console.log(`[cash-verify-code] Yoola to=${phoneYoola} ok=${ok} status=${res.status}`);
    return ok ? { ok: true } : { ok: false, reason: `yoola_${res.status}_${status || "rejected"}` };
  } catch (err) {
    console.error("[cash-verify-code] Yoola error:", err);
    return { ok: false, reason: "network_error" };
  }
}

// Africa's Talking — used only as a FALLBACK when Yoola is not accepted.
async function sendViaAfricasTalking(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[cash-verify-code] Missing AT credentials");
    return { ok: false, reason: "missing_credentials" };
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  const formattedPhone = formatPhoneInternational(phone);
  if (!formattedPhone) return { ok: false, reason: "invalid_phone" };
  try {
    const body = new URLSearchParams({
      username, from: "WELILE",
      to: formattedPhone,      message,
    });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
        Accept: "application/json",
      },
      body: body.toString(),
    });
    const rawText = await res.text();
    let data: any;
    try { data = JSON.parse(rawText); } catch {
      console.error(`[cash-verify-code] Non-JSON AT response: ${rawText}`);
      return { ok: false, reason: "non_json_response" };
    }
    const recipients = data?.SMSMessageData?.Recipients || [];
    const ok = recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
    return ok ? { ok: true } : { ok: false, reason: `at_status_${recipients[0]?.statusCode ?? "none"}` };
  } catch (err) {
    console.error("[cash-verify-code] AT error:", err);
    return { ok: false, reason: "network_error" };
  }
}

interface ProviderAttempt {
  provider: string;
  accepted: boolean;
  reason?: string;
  started_at: string;
  finished_at: string;
  attempted: boolean;
}
interface SmsOutcome {
  ok: boolean;
  reason?: string;
  provider?: string;
  attempts: ProviderAttempt[];
}
function wasSkipped(reason?: string): boolean {
  return reason === "missing_credentials" ||
    (typeof reason === "string" && reason.endsWith("not_configured"));
}

// Provider chain: Yoola (primary) → Africa's Talking (fallback). Tried one at a
// time — AT only fires if Yoola is unconfigured or did not accept the message.
// Every attempt is timestamped so the delivery log proves there is never a
// simultaneous double-send.
async function sendSMS(phone: string, message: string): Promise<SmsOutcome> {
  const attempts: ProviderAttempt[] = [];
  const run = async (provider: string, fn: () => Promise<{ ok: boolean; reason?: string }>) => {
    const started_at = new Date().toISOString();
    const r = await fn();
    const finished_at = new Date().toISOString();
    attempts.push({ provider, accepted: r.ok, reason: r.reason, started_at, finished_at, attempted: !wasSkipped(r.reason) });
    return r;
  };
  const yoola = await run("yoola", () => sendViaYoola(phone, message));
  if (yoola.ok) return { ok: true, provider: "yoola", attempts };
  console.warn("[cash-verify-code] Yoola not accepted — falling back to Africa's Talking");
  const at = await run("africastalking", () => sendViaAfricasTalking(phone, message));
  if (at.ok) return { ok: true, provider: "africastalking", attempts };
  const reason = (yoola.reason && yoola.reason !== "yoola_not_configured") ? yoola.reason : at.reason;
  return { ok: false, reason, attempts };
}

async function logSmsAttempts(
  admin: any,
  ctx: { phone: string; message: string; userId?: string | null; name?: string | null; referenceId?: string | null; source: string },
  outcome: SmsOutcome,
): Promise<void> {
  try {
    if (!outcome.attempts.length) return;
    const rows = outcome.attempts.map((a, i) => ({
      recipient_phone: ctx.phone,
      recipient_user_id: ctx.userId ?? null,
      recipient_name: ctx.name ?? null,
      message: ctx.message,
      provider: a.provider,
      status: a.accepted ? "accepted" : (a.attempted ? "failed" : "skipped"),
      error: a.accepted ? null : (a.reason ?? null),
      reference_id: ctx.referenceId ?? null,
      source: ctx.source,
      provider_response: {
        attempt_sequence: i + 1,
        total_attempts: outcome.attempts.length,
        started_at: a.started_at,
        finished_at: a.finished_at,
        reason: a.reason ?? null,
        final_provider: outcome.provider ?? null,
        final_accepted: outcome.ok,
      },
    }));
    await admin.from("sms_delivery_log").insert(rows);
  } catch (e) {
    console.warn("[cash-verify-code] sms_delivery_log insert failed (non-critical):", e);
  }
}

const fmtUGX = (n: number) =>
  `UGX ${Math.round(Number(n) || 0).toLocaleString("en-UG")}`;

// Resolve the depositor's saved phone number from the most reliable source
// available, in priority order:
//   1. profiles.phone (the user's saved number)
//   2. auth.users.phone (verified phone on the auth record)
//   3. auth.users.user_metadata.phone / phone_number (sign-up metadata)
// Returns the first non-empty value that normalizes to a valid E.164 number.
async function resolveDepositorPhone(
  admin: any,
  userId: string,
  authUser: { phone?: string | null; user_metadata?: Record<string, unknown> | null },
): Promise<{ phone: string; fullName: string | null; source: string }> {
  const candidates: Array<{ value: unknown; source: string }> = [];

  let fullName: string | null = null;
  try {
    const { data: profile } = await admin
      .from("profiles").select("full_name, phone").eq("id", userId).maybeSingle();
    fullName = (profile as any)?.full_name ?? null;
    candidates.push({ value: (profile as any)?.phone, source: "profiles.phone" });
  } catch (_) { /* non-fatal */ }

  candidates.push({ value: authUser?.phone, source: "auth.phone" });
  const meta = (authUser?.user_metadata ?? {}) as Record<string, unknown>;
  candidates.push({ value: meta?.phone, source: "auth.metadata.phone" });
  candidates.push({ value: meta?.phone_number, source: "auth.metadata.phone_number" });

  for (const c of candidates) {
    const raw = typeof c.value === "string" ? c.value.trim() : "";
    if (!raw) continue;
    const formatted = formatPhoneInternational(raw);
    if (formatted && formatted.replace(/[^0-9]/g, "").length >= 11) {
      return { phone: formatted, fullName, source: c.source };
    }
  }
  return { phone: "", fullName, source: "none" };
}

// Append an audit-trail event. Never throws — auditing must not break the flow.
async function logEvent(
  admin: any,
  row: {
    verification_id?: string | null;
    deposit_request_id?: string | null;
    user_id?: string | null;
    event_type: string;
    attempt_no?: number | null;
    attempts_remaining?: number | null;
    amount?: number | null;
    detail?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  try {
    await admin.from("cash_deposit_verification_events").insert({
      verification_id: row.verification_id ?? null,
      deposit_request_id: row.deposit_request_id ?? null,
      user_id: row.user_id ?? null,
      event_type: row.event_type,
      attempt_no: row.attempt_no ?? null,
      attempts_remaining: row.attempts_remaining ?? null,
      amount: row.amount ?? null,
      detail: row.detail ?? null,
      metadata: row.metadata ?? {},
    } as any);
  } catch (e) {
    console.error("[cash-verify-code] audit log failed", row.event_type, e);
  }
}

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // ── Auth ──
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: authData, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !authData?.user) {
      return json(401, { error: "Unauthorized" });
    }
    const user = authData.user;

    const body = await req.json().catch(() => ({}));
    const depositId = typeof body?.deposit_request_id === "string" ? body.deposit_request_id : "";
    const enteredCode = normalizeCode(body?.code);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(depositId)) {
      return json(400, { error: "invalid_request", message: "Missing deposit reference" });
    }
    if (!enteredCode || enteredCode.length !== 4) {
      return json(400, { error: "invalid_code", message: "Enter the 4-digit receipt code" });
    }

    // ── Operator mode: Financial Ops (or finance leadership) enters the code on
    // the depositor's behalf after the depositor reads it back over the counter.
    const onBehalf = body?.on_behalf === true;
    if (onBehalf) {
      const { data: roleRows } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);
      const roles = (roleRows ?? []).map((r: any) => String(r.role));
      const allowed = ["financial_ops", "cfo", "manager", "super_admin", "operations", "ceo", "coo"];
      if (!roles.some((r) => allowed.includes(r))) {
        return json(403, { error: "not_authorized", message: "Only Financial Ops can enter a code on behalf of a depositor." });
      }
    }

    // ── Load the verification row (scoped to this user unless operator mode) ──
    let verQuery = admin
      .from("cash_deposit_verifications")
      .select("id, deposit_request_id, user_id, amount, code_hash, attempts, max_attempts, status, expires_at, emailed_to")
      .eq("deposit_request_id", depositId);
    if (!onBehalf) verQuery = verQuery.eq("user_id", user.id);
    const { data: ver, error: verErr } = await verQuery.maybeSingle();

    if (verErr || !ver) {
      return json(404, { error: "not_found", message: "No pending cash deposit found for this code." });
    }
    // Everything downstream is attributed to the DEPOSITOR, never the operator.
    const depositorId = String(ver.user_id);

    // ── Pure decision: already-verified → expiry → attempt cap → hash ──
    const enteredHash = await sha256Hex(enteredCode);
    const decision = evaluateAttempt(ver as any, enteredHash, Date.now());

    if (decision.kind === "already_verified") {
      await logEvent(admin, {
        verification_id: ver.id, deposit_request_id: depositId, user_id: depositorId,
        event_type: "already_verified", amount: Number(ver.amount),
        detail: "Verify attempted on an already-verified deposit.",
      });
      return json(200, { ok: true, already_verified: true, message: "This deposit was already verified." });
    }

    if (decision.kind === "expired") {
      if (ver.status !== "expired") {
        await admin.from("cash_deposit_verifications").update({ status: "expired" }).eq("id", ver.id);
      }
      // Auto-reject the still-pending deposit so it leaves the queue instead of
      // lingering forever once its code window has closed.
      await admin
        .from("deposit_requests")
        .update({
          status: "rejected",
          rejection_reason: "Cash deposit rejected automatically — the receipt code expired before it was entered.",
        } as any)
        .eq("id", depositId)
        .eq("status", "pending");
      await logEvent(admin, {
        verification_id: ver.id, deposit_request_id: depositId, user_id: depositorId,
        event_type: "expired", attempt_no: Number(ver.attempts), amount: Number(ver.amount),
        detail: "Code entry rejected — verification window has expired; deposit auto-rejected.",
        metadata: { expires_at: ver.expires_at, auto_rejected: true },
      });
      // Email the depositor that their code expired and the deposit was rejected.
      try {
        await fetch(`${supabaseUrl}/functions/v1/notify-cash-deposit-expired`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ deposit_request_id: depositId }),
        });
      } catch (notifyErr) {
        console.error("[cash-verify-code] expiry email notify failed", notifyErr);
      }
      return json(410, { error: "expired", rejected: true, message: "This code has expired. This deposit has been rejected — please start a new cash deposit." });
    }

    if (decision.kind === "too_many_attempts") {
      await admin.from("cash_deposit_verifications").update({ status: "expired" }).eq("id", ver.id);
      await logEvent(admin, {
        verification_id: ver.id, deposit_request_id: depositId, user_id: depositorId,
        event_type: "locked_out", attempt_no: Number(ver.attempts), attempts_remaining: 0,
        amount: Number(ver.amount),
        detail: "Verification locked — maximum attempts already reached.",
        metadata: { max_attempts: Number(ver.max_attempts) },
      });
      return json(429, { error: "too_many_attempts", message: "Too many incorrect attempts. Please start a new cash deposit." });
    }

    if (decision.kind === "mismatch") {
      // STRICT REJECTION: a single wrong code immediately rejects the deposit.
      // No retries — the verification is closed and the pending deposit request
      // is explicitly marked 'rejected' so it leaves the pending queue.
      const newAttempts = Number(ver.attempts) + 1;
      await admin
        .from("cash_deposit_verifications")
        .update({ attempts: newAttempts, status: "expired" })
        .eq("id", ver.id);
      // Mark the deposit request rejected (only while still pending — never
      // touch an already-credited / verified row).
      await admin
        .from("deposit_requests")
        .update({
          status: "rejected",
          rejection_reason: "Cash deposit rejected automatically — wrong receipt code entered.",
        } as any)
        .eq("id", depositId)
        .eq("status", "pending");
      await logEvent(admin, {
        verification_id: ver.id, deposit_request_id: depositId, user_id: depositorId,
        event_type: "rejected",
        attempt_no: newAttempts, attempts_remaining: 0, amount: Number(ver.amount),
        detail: "Incorrect code — deposit rejected automatically on first wrong attempt.",
        metadata: { max_attempts: Number(ver.max_attempts), auto_rejected: true },
      });
      return json(400, {
        error: "code_mismatch",
        rejected: true,
        message: "Incorrect code. This deposit has been rejected — please start a new cash deposit.",
        attempts_remaining: 0,
      });
    }

    // ── Match! Mark verified BEFORE crediting (idempotency guard) ──
    const { data: claimed, error: claimErr } = await admin
      .from("cash_deposit_verifications")
      .update({
        status: "verified",
        attempts: Number(ver.attempts) + 1,
        verified_at: new Date().toISOString(),
      })
      .eq("id", ver.id)
      .eq("status", "awaiting_code")
      .select("id")
      .maybeSingle();

    if (claimErr || !claimed) {
      // Another concurrent verify already claimed it.
      await logEvent(admin, {
        verification_id: ver.id, deposit_request_id: depositId, user_id: depositorId,
        event_type: "already_verified", amount: Number(ver.amount),
        detail: "Concurrent verification already claimed this deposit.",
      });
      return json(200, { ok: true, already_verified: true, message: "This deposit was already verified." });
    }

    await logEvent(admin, {
      verification_id: ver.id, deposit_request_id: depositId, user_id: depositorId,
      event_type: "verified", attempt_no: Number(ver.attempts) + 1, amount: Number(ver.amount),
      detail: onBehalf
        ? "Receipt code matched — entered by a Financial Ops operator on the depositor's behalf."
        : "Receipt code matched — verification successful.",
      metadata: { entered_by: user.id, on_behalf: onBehalf },
    });

    // Stamp the verified RCT code onto the deposit request for traceability.
    // Safety net: a deposit auto-rejected by an earlier expired code window is
    // revived here so the credit path below can run (otherwise the deposit
    // shows as verified but is never credited and cannot be banked).
    await admin
      .from("deposit_requests")
      .update({ status: "pending", rejection_reason: null, rejected_at: null } as any)
      .eq("id", depositId)
      .eq("status", "rejected");

    await admin
      .from("deposit_requests")
      .update({ transaction_id: enteredCode })
      .eq("id", depositId)
      .eq("status", "pending");

    // ── Auto-credit via approve-deposit (service role, system credit) ──
    const approveRes = await fetch(`${supabaseUrl}/functions/v1/approve-deposit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        deposit_request_id: depositId,
        action: "approve",
        system_auto_credit: true,
      }),
    });
    const approveJson = await approveRes.json().catch(() => ({}));
    // "already_processed" only means approve-deposit found no PENDING row. A
    // deposit its first attempt marked 'failed' reads the same way, so the
    // retry used to log "credited" and SMS the depositor with nothing posted
    // (doc 144). Only an 'approved' deposit_requests row counts as credited.
    const { data: afterApprove } = await admin
      .from("deposit_requests")
      .select("status")
      .eq("id", depositId)
      .maybeSingle();
    const creditedForReal = (afterApprove as any)?.status === "approved";
    if (!approveRes.ok || !creditedForReal ||
        (approveJson?.error && !approveJson?.success && !approveJson?.already_processed)) {
      // Crediting failed — roll the verification back so the user can retry.
      await admin
        .from("cash_deposit_verifications")
        .update({ status: "awaiting_code", verified_at: null })
        .eq("id", ver.id);
      console.error("[cash-verify-code] approve-deposit failed", approveRes.status, approveJson);
      await logEvent(admin, {
        verification_id: ver.id, deposit_request_id: depositId, user_id: depositorId,
        event_type: "credit_failed", amount: Number(ver.amount),
        detail: "Code verified but wallet crediting failed — verification rolled back.",
        metadata: {
          approve_status: approveRes.status,
          approve_response: approveJson,
          deposit_status: (afterApprove as any)?.status ?? null,
        },
      });
      return json(502, {
        error: "credit_failed",
        message: "Code verified, but crediting your wallet failed. Please try again.",
      });
    }

    await logEvent(admin, {
      verification_id: ver.id, deposit_request_id: depositId, user_id: depositorId,
      event_type: "credited", amount: Number(ver.amount),
      detail: "Wallet credited successfully after verification.",
      metadata: { receipt_code: enteredCode },
    });

    // ── New balance for the confirmation email ──
    let newBalance: number | null = null;
    try {
      const { data: bal } = await admin.rpc("get_user_available_balance", { p_user_id: depositorId });
      if (bal != null) newBalance = Number(bal);
    } catch (_) { /* non-fatal */ }

    // ── Confirmation SMS to the depositor (verified amount + new balance) ──
    try {
      const { phone, source } = await resolveDepositorPhone(admin, depositorId, onBehalf ? {} : {
        phone: user.phone,
        user_metadata: (user as any).user_metadata,
      });
      if (phone) {
        const balanceLine = newBalance != null ? ` New balance ${fmtUGX(newBalance)}.` : "";
        const smsBody =
          `Welile: Cash deposit confirmed. ${fmtUGX(ver.amount)} credited to your Welile Wallet ` +
          `(receipt code ${enteredCode}).${balanceLine}` +
          `\n\nAccess your dashboard to view your wallet, transactions, and account details:\n` +
          `https://welileapp.com/ZQhyGb`;
        const sent = await sendSMS(phone, smsBody);
        await logSmsAttempts(admin, {
          phone,
          message: smsBody,
          userId: depositorId,
          referenceId: ver.id ?? null,
          source: "cash-deposit-verify-code",
        }, sent);
        console.log(`[cash-verify-code] confirmation SMS to ${phone} (via ${source}) sent=${sent.ok}`);
        if (!sent.ok) console.error("[cash-verify-code] confirmation SMS not sent");
      } else {
        console.error("[cash-verify-code] no phone on file for confirmation SMS");
      }
    } catch (smsErr) {
      // Non-fatal: the money is already credited.
      console.error("[cash-verify-code] confirmation SMS failed", smsErr);
    }

    // ── Confirmation email after, and only after, successful wallet credit ──
    // Prefer the address that received the code, then fall back to the saved
    // account email. Email delivery remains non-fatal because money has moved.
    try {
      const email = await resolveDepositorEmail(admin, depositorId, (ver as any).emailed_to);
      if (email) {
        const [{ data: profile }, { data: depositRequest }] = await Promise.all([
          admin.from("profiles").select("full_name").eq("id", depositorId).maybeSingle(),
          admin.from("deposit_requests").select("transaction_date, approved_at").eq("id", depositId).maybeSingle(),
        ]);
        const depositedAt = (depositRequest as any)?.transaction_date ||
          (depositRequest as any)?.approved_at || new Date().toISOString();
        const referenceNumber = `DEP-${depositId.slice(0, 8).toUpperCase()}`;
        const { data: recordedLedgerRows, error: recordedLedgerError } = await admin
          .from("general_ledger")
          .select("amount, direction, category")
          .or(`source_id.eq.${depositId},reference_id.eq.${depositId}`);
        if (recordedLedgerError) {
          console.error("[cash-verify-code] receipt breakdown lookup failed", recordedLedgerError);
        }
        const recordedRows = Array.isArray(recordedLedgerRows) ? recordedLedgerRows : [];
        const sumRecorded = (categories: string[], direction: "cash_in" | "cash_out"): number | null => {
          const matches = recordedRows.filter((row: any) =>
            categories.includes(String(row?.category ?? "")) && row?.direction === direction
          );
          if (matches.length === 0) return null;
          return matches.reduce((sum: number, row: any) => sum + Number(row?.amount ?? 0), 0);
        };
        const facilitatedRentVolume = sumRecorded([
          "rent_disbursement", "pool_rent_deployment", "rent_payment_for_tenant",
          "agent_float_used_for_rent",
        ], "cash_out");
        const platformServiceFees = sumRecorded([
          "access_fee_collected", "registration_fee_collected", "tenant_access_fee",
          "tenant_request_fee", "platform_service_income", "service_fee_revenue",
          "landlord_platform_fee", "management_fee",
        ], "cash_in");
        const transactionExpenses = sumRecorded([
          "platform_expense", "transaction_platform_expenses",
        ], "cash_out");
        let receiptDownloadUrl: string | null = null;
        try {
          const receiptBytes = await renderCashDepositReceipt({
            depositorName: (profile as any)?.full_name ?? "Welile customer",
            amount: Number(ver.amount),
            newBalance,
            depositedAt,
            referenceNumber,
            maskedDepositCode: maskDepositCode(enteredCode),
            facilitatedRentVolume,
            platformServiceFees,
            transactionExpenses,
          });
          const receiptFilename = cashDepositReceiptFilename(referenceNumber);
          const receiptPath = `${depositorId}/${depositId}/${receiptFilename}`;
          const { error: receiptUploadError } = await admin.storage
            .from("cash-deposit-receipts")
            .upload(receiptPath, receiptBytes, {
              contentType: "application/pdf",
              upsert: true,
            });
          if (receiptUploadError) throw receiptUploadError;
          const { data: signedReceipt, error: receiptSignError } = await admin.storage
            .from("cash-deposit-receipts")
            .createSignedUrl(receiptPath, 60 * 60 * 24 * 30, {
              download: receiptFilename,
            });
          if (receiptSignError) throw receiptSignError;
          receiptDownloadUrl = signedReceipt?.signedUrl ?? null;
          if (!receiptDownloadUrl) throw new Error("Receipt link was not created");
        } catch (receiptError) {
          console.error("[cash-verify-code] PDF receipt preparation failed", receiptError);
          await logEvent(admin, {
            verification_id: ver.id,
            deposit_request_id: depositId,
            user_id: depositorId,
            event_type: "confirmation_receipt_failed",
            amount: Number(ver.amount),
            detail: "Wallet was credited, but the PDF receipt could not be prepared.",
            metadata: { reference_number: referenceNumber, error: String((receiptError as Error)?.message ?? receiptError) },
          });
        }
        const result = await sendCashDepositWalletConfirmationEmail(admin, {
          email,
          amount: Number(ver.amount),
          newBalance,
          depositorName: (profile as any)?.full_name ?? null,
          receiptCode: enteredCode,
          depositRequestId: depositId,
          depositedAt,
          referenceNumber,
          receiptDownloadUrl,
          facilitatedRentVolume,
          platformServiceFees,
          transactionExpenses,
          codeExpiredAt: ver.expires_at,
        });
        await logEvent(admin, {
          verification_id: ver.id,
          deposit_request_id: depositId,
          user_id: depositorId,
          event_type: result.sent ? "confirmation_email_sent" : "confirmation_email_failed",
          amount: Number(ver.amount),
          detail: result.sent
            ? "Wallet credit confirmation emailed to the depositor."
            : "Wallet was credited, but the confirmation email was not accepted.",
          metadata: {
            recipient_email: email,
            reference_number: referenceNumber,
            receipt_included: Boolean(receiptDownloadUrl),
            error: result.error,
          },
        });
      } else {
        console.warn("[cash-verify-code] no email on file for wallet confirmation");
      }
    } catch (emailErr) {
      console.error("[cash-verify-code] wallet confirmation email failed", emailErr);
    }

    return json(200, {
      ok: true,
      verified: true,
      amount: Number(ver.amount),
      new_balance: newBalance,
      message: "Cash deposit verified and credited.",
    });
  } catch (e) {
    console.error("[cash-verify-code] error", e);
    return json(500, { error: "server_error", message: String((e as Error)?.message ?? e) });
  }
});