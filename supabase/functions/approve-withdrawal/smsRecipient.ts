// Chooses who receives a withdrawal SMS. Recipient choice only — never used
// for money movement or payout-destination checks.
//  1. Profile phone if the sender's own validity check accepts it (unchanged).
//  2. Else, for mobile_money withdrawals only, the withdrawal's MoMo number
//     when it passes the same check.
//  3. Else the original profile phone (so the caller fails/logs as today).
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
