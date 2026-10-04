// Shared SMS exception check. A phone listed in public.sms_message_exceptions for
// the given message type (or 'all') must NOT receive that SMS.
// CTO manages this list from the CTO Dashboard → SMS Exceptions tab.

function toIntl(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return digits ? `+${digits}` : "";
}

/** Returns true when the phone is blocked for this message type. */
export async function isPhoneBlocked(
  admin: { from: (t: string) => any },
  phone: string,
  messageType: string,
): Promise<boolean> {
  const intl = toIntl(phone);
  if (!intl) return false;
  try {
    const { data } = await admin
      .from("sms_message_exceptions")
      .select("phone")
      .in("message_type", ["all", messageType]);
    const blocked = new Set((data ?? []).map((r: any) => toIntl(r.phone)));
    return blocked.has(intl);
  } catch (_e) {
    // Fail open — never let a lookup error stop a critical SMS.
    return false;
  }
}