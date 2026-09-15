// Payout destination borrowing consent — lets a mismatched payout destination
// (payout_destination_verifications.status = 'waiting') get verified by the
// destination owner confirming an SMS code, instead of only via a Financial
// Ops phone call (finops_decide_payout_destination). See the
// payout_destination_declarations table comment for the full rationale.
import { sha256Hex } from "./cash-verification-core.ts";
import { sendSMS, formatPhoneInternational } from "./sendSmsMultiProvider.ts";

const CONSENT_CODE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CONSENT_ATTEMPTS = 5;

function generateConsentCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += (b % 10).toString();
  return s;
}

function maskDestination(type: string, momoNumber: string | null, bankName: string | null, bankAccountNumber: string | null): string {
  if (type === "mobile_money") {
    const digits = (momoNumber || "").replace(/\D/g, "");
    return `mobile money number ending ${digits.slice(-4) || "????"}`;
  }
  const digits = (bankAccountNumber || "").replace(/\D/g, "");
  return `${bankName || "bank"} account ending ${digits.slice(-4) || "????"}`;
}

/**
 * Creates (or refreshes a still-pending) declaration for one
 * payout_destination_verifications row and SMSes a consent code to the
 * destination owner. `ownerPhone` is the destination's own momo_number for
 * mobile money, or a phone the withdrawer supplies for bank transfer.
 */
export async function requestPayoutDestinationConsent(admin: any, params: {
  destinationVerificationId: string;
  borrowerUserId: string;
  borrowerFullName: string;
  destinationType: "mobile_money" | "bank_transfer";
  destinationOwnerName: string;
  ownerPhone: string;
  nameMatchScore: number | null;
  momoNumber?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
}): Promise<{ declarationId: string; smsSent: boolean }> {
  const now = Date.now();

  const { data: existing } = await admin
    .from("payout_destination_declarations")
    .select("id")
    .eq("destination_verification_id", params.destinationVerificationId)
    .eq("status", "pending_owner_consent")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const code = generateConsentCode();
  const codeHash = await sha256Hex(code);
  const expiresAt = new Date(now + CONSENT_CODE_TTL_MS).toISOString();

  let declarationId: string;
  if (existing) {
    await admin.from("payout_destination_declarations").update({
      consent_code_hash: codeHash,
      consent_code_expires_at: expiresAt,
      consent_attempts: 0,
      owner_phone: params.ownerPhone,
      name_match_score: params.nameMatchScore,
    }).eq("id", existing.id);
    declarationId = existing.id;
  } else {
    const { data: inserted, error } = await admin.from("payout_destination_declarations").insert({
      destination_verification_id: params.destinationVerificationId,
      borrower_user_id: params.borrowerUserId,
      destination_type: params.destinationType,
      destination_owner_name: params.destinationOwnerName,
      name_match_score: params.nameMatchScore,
      owner_phone: params.ownerPhone,
      status: "pending_owner_consent",
      consent_code_hash: codeHash,
      consent_code_expires_at: expiresAt,
    }).select("id").single();
    if (error || !inserted) {
      throw new Error(`Failed to create payout destination declaration: ${error?.message ?? "unknown"}`);
    }
    declarationId = inserted.id;
  }

  const destinationLabel = maskDestination(
    params.destinationType,
    params.momoNumber ?? null,
    params.bankName ?? null,
    params.bankAccountNumber ?? null,
  );
  const message = `Welile: ${params.borrowerFullName} wants to receive Welile payouts on a ${destinationLabel} ` +
    `registered in your name (${params.destinationOwnerName}). If you agree, share this code with them: ${code}. ` +
    `If you did NOT authorise this, ignore this message.`;

  const smsSent = await sendSMS(formatPhoneInternational(params.ownerPhone), message, {
    admin,
    source: "payout-destination-declaration",
    reference_id: declarationId,
  });

  return { declarationId, smsSent };
}

/**
 * Verifies the code and, on success, flips the linked
 * payout_destination_verifications row straight to 'verified' — the
 * destination owner confirming by SMS is treated as equivalent to a
 * Financial Ops phone-call confirmation (finops_decide_payout_destination).
 */
export async function confirmPayoutDestinationConsent(
  admin: any,
  declarationId: string,
  code: string,
  /**
   * Optional correction to the name this destination is registered in, supplied
   * by the withdrawer at the moment the owner's code is confirmed. Ownership of
   * the SIM/account has just been proven by that code, so the name held on file
   * (often a mis-spelling captured when the destination was first seen) can be
   * corrected here. The previous value is preserved in decision_reason.
   */
  confirmedAccountName?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: row } = await admin
    .from("payout_destination_declarations")
    .select("*")
    .eq("id", declarationId)
    .maybeSingle();
  if (!row) return { ok: false, error: "Declaration not found." };
  if (row.status === "consented") return { ok: true };
  if (row.status !== "pending_owner_consent") {
    return { ok: false, error: "This declaration is no longer pending." };
  }
  if (!row.consent_code_expires_at || new Date(row.consent_code_expires_at).getTime() < Date.now()) {
    return { ok: false, error: "Code expired. Please request a new one." };
  }
  if ((row.consent_attempts ?? 0) >= MAX_CONSENT_ATTEMPTS) {
    return { ok: false, error: "Too many attempts. Please request a new code." };
  }

  const enteredHash = await sha256Hex((code || "").trim());
  if (enteredHash !== row.consent_code_hash) {
    await admin.from("payout_destination_declarations")
      .update({ consent_attempts: (row.consent_attempts ?? 0) + 1 })
      .eq("id", declarationId);
    return { ok: false, error: "Incorrect code." };
  }

  await admin.from("payout_destination_declarations")
    .update({ status: "consented", consented_at: new Date().toISOString() })
    .eq("id", declarationId);

  const correctedName = String(confirmedAccountName ?? "").trim();
  const previousName = String(row.destination_owner_name ?? "").trim();
  const nameCorrected = correctedName.length > 0 &&
    correctedName.toLowerCase() !== previousName.toLowerCase();

  const { error: verifyErr } = await admin
    .from("payout_destination_verifications")
    .update({
      status: "verified",
      decided_by: null,
      decided_at: new Date().toISOString(),
      call_outcome: "sms_consent",
      ...(nameCorrected ? { account_name: correctedName } : {}),
      decision_reason: nameCorrected
        ? `Auto-verified: the destination owner confirmed by SMS code sent to their own phone. ` +
          `Registered name corrected to "${correctedName}" (was "${previousName || "not recorded"}").`
        : "Auto-verified: the destination owner confirmed by SMS code sent to their own phone.",
    })
    .eq("id", row.destination_verification_id)
    .in("status", ["waiting", "rejected"]); // rejected is recoverable via owner
    // consent (see payout-destination-consent's request action) -- only a
    // 'verified' decision is never clobbered here.
  if (verifyErr) {
    console.error("[payoutDestinationDeclaration] failed to flip destination to verified:", verifyErr.message);
    return { ok: false, error: "Confirmed, but we couldn't update the destination. Please try again or contact support." };
  }

  return { ok: true };
}
