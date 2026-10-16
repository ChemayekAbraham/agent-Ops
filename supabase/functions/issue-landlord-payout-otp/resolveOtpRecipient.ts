// Strict OTP-recipient rule for landlord float payouts.
//
// The OTP proves the LANDlord consents, so it must reach the phone the
// landlord actually carries — the contact number on their landlord record
// (landlords.phone) — never the mobile money number, which is often a
// relative's or agent's line. The payout itself still goes to the verified
// mobile money number; only the OTP recipient changes.
//
// Fallback: if the landlord has no usable contact phone on file, the OTP goes
// to the approved payout number so the flow is not deadlocked, and the event
// metadata records that the fallback was used.

export interface OtpRecipientDecision {
  /** Normalized local-form number the OTP SMS is sent to. */
  recipient: string;
  /** Where the recipient came from. */
  source: "landlord_phone" | "payout_number_fallback";
}

/** Strip to digits and return local 0XXXXXXXXX form, or null if not a usable UG number. */
export function toLocalUgPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("256") && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.startsWith("0") && digits.length === 10) return digits;
  if (digits.length === 9) return `0${digits}`;
  return null;
}

/**
 * Decide which phone receives the OTP.
 *
 * @param landlordPhone  landlords.phone — the landlord's own contact number.
 * @param payoutPhone    verified_mobile_money_number — the approved payout number.
 */
export function resolveOtpRecipient(
  landlordPhone: string | null | undefined,
  payoutPhone: string,
): OtpRecipientDecision {
  const contact = toLocalUgPhone(landlordPhone);
  if (contact) return { recipient: contact, source: "landlord_phone" };
  const payout = toLocalUgPhone(payoutPhone);
  if (!payout) throw new Error("No usable phone number for OTP delivery");
  return { recipient: payout, source: "payout_number_fallback" };
}
