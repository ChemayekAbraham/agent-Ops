/*
 * Author: SSENKAALI PIUS
 * Email: ssenkaali.pius@welileapp.com
 * Date: 2026-11-13
 * Website: welileapp.com
 *
 * The landlord's confirmation SMS for option 2. Pure, so it can be unit tested.
 * Written as "code: 123456" on purpose: _shared/redactSmsCodes.ts recognises that shape, so the SMS log never
 * stores a usable code (the test proves it).
 */
export function formatUgx(amount: number): string {
  return "UGX " + Math.round(amount).toLocaleString("en-US");
}

export function landlordOtpMessage(input: { otp: string; amount: number; tenantFirstName: string | null }): string {
  const tenant = input.tenantFirstName?.trim() || "your tenant";
  return `WELILE code: ${input.otp}. Read it only to the Welile officer on the phone, to confirm you received ` +
    `${formatUgx(input.amount)} rent for ${tenant}.`;
}

export function maskPhone(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-3)}` : "***";
}
