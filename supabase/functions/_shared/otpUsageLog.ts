/**
 * Durable per-attempt log for OTP usage-by-category reporting
 * (get_otp_usage_by_category, docs/HANDOVER/80). Best-effort: a logging
 * failure must never block an OTP send or verification.
 */
export type OtpUsageEventType = "sent" | "send_failed" | "verify_success" | "verify_failed";

export async function logOtpUsage(
  admin: { from: (table: string) => any },
  category: string,
  eventType: OtpUsageEventType,
  phone?: string | null,
  sourceFunction?: string,
): Promise<void> {
  try {
    await admin.from("otp_usage_events").insert({
      category,
      event_type: eventType,
      phone: phone ?? null,
      source_function: sourceFunction ?? null,
    });
  } catch (e) {
    console.warn("[otp-usage-log] insert failed (non-critical):", e);
  }
}
