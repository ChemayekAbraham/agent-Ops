// Shared "national ID borrowing" consent gate — used by register-tenant and
// tenant-self-onboarding whenever a submitted national_id_name doesn't match
// the registrant's own full_name. The claimed ID owner must confirm by SMS
// code before registration proceeds; see the national_id_declarations table
// comment for why this is deliberately isolated from commission/referral logic.
import { sha256Hex } from "./cash-verification-core.ts";
import { sendSMS } from "./sendSmsMultiProvider.ts";

// Below this token-overlap score (from payout_name_match_report), the two
// names are treated as different people rather than a typo/nickname variant.
const MATCH_SCORE_THRESHOLD = 0.34;
const CONSENT_CODE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CONSENT_ATTEMPTS = 5;

function generateConsentCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += (b % 10).toString();
  return s;
}

/** Runs the shared token-overlap name scorer. Returns 1 when either name is blank (nothing to compare). */
export async function scoreNameMatch(admin: any, nameA: string, nameB: string): Promise<number> {
  const a = (nameA || "").trim();
  const b = (nameB || "").trim();
  if (!a || !b) return 1;
  const { data, error } = await admin.rpc("payout_name_match_report", { p_a: a, p_b: b });
  if (error) {
    console.warn("[nationalIdDeclaration] payout_name_match_report failed, failing open:", error.message);
    return 1; // fail open — never block registration on a scoring-function error
  }
  const score = Number((data as any)?.score);
  return Number.isFinite(score) ? score : 1;
}

export function isLikelyDifferentPerson(score: number): boolean {
  return score < MATCH_SCORE_THRESHOLD;
}

/** A still-consented declaration covering this borrower phone + national ID, if any. */
export async function findConsentedDeclaration(admin: any, borrowerPhone: string, nationalId: string) {
  const { data } = await admin
    .from("national_id_declarations")
    .select("id, id_owner_profile_id, id_owner_phone")
    .eq("borrower_phone", borrowerPhone)
    .eq("national_id", nationalId)
    .eq("status", "consented")
    .order("consented_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

/**
 * Creates (or refreshes a still-pending) declaration and SMSes a consent code
 * to the claimed ID owner. Returns the declaration id the client must echo
 * back alongside the code on the follow-up request.
 */
export async function requestDeclarationConsent(admin: any, params: {
  borrowerPhone: string;
  borrowerFullName: string;
  nationalId: string;
  nationalIdName: string;
  idOwnerPhone: string;
  idOwnerProfileId: string | null;
  matchScore: number;
}): Promise<{ declarationId: string; smsSent: boolean }> {
  const now = Date.now();

  const { data: existing } = await admin
    .from("national_id_declarations")
    .select("id, consent_code_expires_at")
    .eq("borrower_phone", params.borrowerPhone)
    .eq("national_id", params.nationalId)
    .eq("id_owner_phone", params.idOwnerPhone)
    .eq("status", "pending_owner_consent")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const code = generateConsentCode();
  const codeHash = await sha256Hex(code);
  const expiresAt = new Date(now + CONSENT_CODE_TTL_MS).toISOString();

  let declarationId: string;
  if (existing) {
    // Always mint a fresh code on (re)request — the registrant is standing
    // there asking for it, so an older undelivered SMS is not useful to wait on.
    await admin.from("national_id_declarations").update({
      consent_code_hash: codeHash,
      consent_code_expires_at: expiresAt,
      consent_attempts: 0,
      national_id_name: params.nationalIdName,
      name_match_score: params.matchScore,
      id_owner_profile_id: params.idOwnerProfileId,
    }).eq("id", existing.id);
    declarationId = existing.id;
  } else {
    const { data: inserted, error } = await admin.from("national_id_declarations").insert({
      borrower_phone: params.borrowerPhone,
      borrower_full_name: params.borrowerFullName,
      national_id: params.nationalId,
      national_id_name: params.nationalIdName,
      name_match_score: params.matchScore,
      id_owner_profile_id: params.idOwnerProfileId,
      id_owner_phone: params.idOwnerPhone,
      status: "pending_owner_consent",
      consent_code_hash: codeHash,
      consent_code_expires_at: expiresAt,
    }).select("id").single();
    if (error || !inserted) {
      throw new Error(`Failed to create national ID declaration: ${error?.message ?? "unknown"}`);
    }
    declarationId = inserted.id;
  }

  const message = `Welile: ${params.borrowerFullName} is registering a Welile account using your National ID` +
    (params.nationalIdName ? ` (${params.nationalIdName})` : "") +
    `. If you gave them permission to use it, share this code with them: ${code}. ` +
    `If you did NOT authorise this, ignore this message.`;

  const smsSent = await sendSMS(params.idOwnerPhone, message, {
    admin,
    source: "national-id-declaration",
    reference_id: declarationId,
  });

  return { declarationId, smsSent };
}

export async function confirmDeclarationConsent(
  admin: any,
  declarationId: string,
  code: string,
): Promise<{ ok: true; idOwnerProfileId: string | null; idOwnerPhone: string } | { ok: false; error: string }> {
  const { data: row } = await admin
    .from("national_id_declarations")
    .select("*")
    .eq("id", declarationId)
    .maybeSingle();
  if (!row) return { ok: false, error: "Declaration not found." };
  if (row.status === "consented") {
    return { ok: true, idOwnerProfileId: row.id_owner_profile_id ?? null, idOwnerPhone: row.id_owner_phone };
  }
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
    await admin.from("national_id_declarations")
      .update({ consent_attempts: (row.consent_attempts ?? 0) + 1 })
      .eq("id", declarationId);
    return { ok: false, error: "Incorrect code." };
  }

  await admin.from("national_id_declarations")
    .update({ status: "consented", consented_at: new Date().toISOString() })
    .eq("id", declarationId);

  return { ok: true, idOwnerProfileId: row.id_owner_profile_id ?? null, idOwnerPhone: row.id_owner_phone };
}

export async function linkBorrowerProfile(admin: any, declarationId: string, borrowerProfileId: string) {
  await admin.from("national_id_declarations")
    .update({ borrower_profile_id: borrowerProfileId })
    .eq("id", declarationId);
}
