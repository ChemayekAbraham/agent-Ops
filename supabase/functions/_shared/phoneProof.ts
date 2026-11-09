// Phone proof for promissory-note linking (Partner Returns Phase 4, D3).
//
// After the cut-off a pre-cut-off note links to an account only when the account proved the note's phone
// or email (public._note_contact_proven). An OTP login leaves that proof in otp_login_audit (outcome
// 'success', resolved_user_id, phone). These helpers write the same kind of row, bound to a user id, and
// then run the owner-run linker so a held note links now.
//
// NO CALLER TODAY, ON PURPOSE. phone-signup, confirm-phone-account and self-update-phone only read an
// otp_verifications row, which is keyed by the last 9 digits and tied to no session or user: otp-login
// marks it verified whenever the real holder signs in, so another account calling within the window would
// "prove" a number it never received a code for. Those functions therefore record nothing (identical to
// origin), and a genuine partner whose note was held links by an OTP login or through Partner Ops.
//
// Call only where the function ITSELF sent a code to this exact number and checks it within the same
// request for the same authenticated caller (or a row stamped with that caller's id). Best effort: a
// failure is logged and never fails the caller's request (the note then stays held, the safe side).
// No Deno APIs beyond Request, no imports.

// deno-lint-ignore no-explicit-any
type Client = any;

/** Distinct stages so audits and dashboards can tell these proofs from OTP logins. */
export type PhoneProofStage = "phone_signup" | "phone_confirm" | "first_phone";

export interface PhoneProof {
  userId: string;
  /** The verified number as the caller stored it (digits or E.164); the SQL side compares last 9 digits. */
  phone: string;
  stage: PhoneProofStage;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The otp_login_audit row for a proof, or null when the input cannot be a proof (no user id, fewer than
 *  9 digits). Request metadata is captured the same way otp-login captures it. */
export function phoneProofRow(proof: PhoneProof, req: Request | null): Record<string, unknown> | null {
  const userId = typeof proof?.userId === "string" ? proof.userId.trim() : "";
  const digits = typeof proof?.phone === "string" ? proof.phone.replace(/\D/g, "") : "";
  if (!UUID_RE.test(userId) || digits.length < 9) return null;
  const h = (name: string) => req?.headers.get(name) ?? null;
  return {
    phone: proof.phone.trim(),
    resolved_user_id: userId,
    outcome: "success",
    stage: proof.stage,
    reason: "sms_code_verified",
    origin: h("origin") || null,
    ip_address: h("x-forwarded-for")?.split(",")[0].trim() || h("cf-connecting-ip") || null,
    user_agent: h("user-agent") || null,
    metadata: { proof: "promissory_note_contact", source: proof.stage },
  };
}

/** Records the proof row, then (only when it was written) runs link_promissory_notes_for_user for the
 *  user with the service role. Two round trips at most; never throws. */
export async function recordPhoneProofAndLink(
  admin: Client,
  proof: PhoneProof,
  req: Request | null,
): Promise<{ proofRecorded: boolean; linked: number | null }> {
  const row = phoneProofRow(proof, req);
  if (!row) return { proofRecorded: false, linked: null };
  try {
    const { error } = await admin.from("otp_login_audit").insert([row]);
    if (error) {
      console.warn(`[phone-proof] ${proof.stage}: proof write failed:`, error.message ?? error);
      return { proofRecorded: false, linked: null };
    }
  } catch (e) {
    console.warn(`[phone-proof] ${proof.stage}: proof write failed:`, e instanceof Error ? e.message : e);
    return { proofRecorded: false, linked: null };
  }
  try {
    const { data, error } = await admin.rpc("link_promissory_notes_for_user", { p_user: row.resolved_user_id });
    if (error) {
      console.warn(`[phone-proof] ${proof.stage}: note link failed:`, error.message ?? error);
      return { proofRecorded: true, linked: null };
    }
    return { proofRecorded: true, linked: typeof data === "number" ? data : null };
  } catch (e) {
    console.warn(`[phone-proof] ${proof.stage}: note link failed:`, e instanceof Error ? e.message : e);
    return { proofRecorded: true, linked: null };
  }
}
