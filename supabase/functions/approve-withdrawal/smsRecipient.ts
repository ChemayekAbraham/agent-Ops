// Chooses who receives a withdrawal SMS. Recipient choice only — never used
// for money movement or payout-destination checks.
//  1. Profile phone if it passes the strict check below.
//  2. Else, for mobile_money withdrawals only, the withdrawal's MoMo number
//     when it passes the same strict check.
//  3. Else the original profile phone (so the caller fails/logs as today).

// Strict Ugandan mobile check, used ONLY for choosing the withdrawal SMS
// recipient. Deliberately separate from the sender's own isUgandanPhone,
// which other SMS rely on and which accepts any +256 number with 9+ digits.
// Accepts only: 256 + 9 digits, 0 + 9 digits, or 9 digits, where the 9 digits
// start with 7 (Ugandan mobile). Anything longer, shorter or foreign is
// invalid, so e.g. an 11-digit "07888888888" is rejected and the SMS falls
// back to the withdrawal's MoMo number.
export function isStrictUgandanMobile(phone: string): boolean {
  const d = phone.replace(/\D/g, "");
  const local = d.startsWith("256") ? d.slice(3) : d.startsWith("0") ? d.slice(1) : d;
  return local.length === 9 && local.startsWith("7");
}
export function resolveWithdrawalSmsRecipient(
  profilePhone: string | null | undefined,
  withdrawal: { payout_method?: unknown; mobile_money_number?: unknown } | null | undefined,
  isValid: (phone: string) => boolean,
): { phone: string; fallback: boolean } {
  const p = typeof profilePhone === "string" ? profilePhone : "";
  if (p && isValid(p)) return { phone: p, fallback: false };
  const method = String(withdrawal?.payout_method ?? "").toLowerCase();
  const momo = typeof withdrawal?.mobile_money_number === "string"
    ? withdrawal.mobile_money_number.trim()
    : "";
  if (method === "mobile_money" && momo && isValid(momo)) {
    console.log(
      `[approve-withdrawal] SMS recipient fallback: profile phone invalid, using withdrawal MoMo number (ending ${momo.replace(/\D/g, "").slice(-3)})`,
    );
    return { phone: momo, fallback: true };
  }
  return { phone: p, fallback: false };
}
