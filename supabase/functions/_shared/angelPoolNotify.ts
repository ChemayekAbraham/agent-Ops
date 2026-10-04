import "./smsFooterInterceptor.ts";
import { attemptYoolaPrimary } from "./yoolaPrimary.ts";
// Shared helpers for Angel Pool onboarding notifications.
//
// 1) isPlaceholderEmail() — detects synthetic addresses we mint for users who
//    have no real inbox (e.g. "777375187@noapp.welile.user",
//    "256751424629@welile.user"). These should NEVER be enqueued for email:
//    they pollute the send log with "sent" rows that can never be delivered.
//
// 2) sendAngelPoolSms() — best-effort Africa's Talking SMS confirmation so the
//    investor still gets an onboarding update even when there is no real email.
//
// Both are best-effort: callers must never let a notification failure roll back
// money that has already moved.

export function isPlaceholderEmail(email?: string | null): boolean {
  if (!email) return true;
  const e = email.trim().toLowerCase();
  if (!e || !e.includes("@")) return true;
  // Any address on the synthetic welile.user domain (incl. subdomains).
  return /(@|\.)welile\.user$/.test(e) || e.endsWith("@noapp.welile.user");
}

/**
 * Best-effort: persist a skipped Angel Pool onboarding email to the
 * `angel_pool_email_skips` audit table so executives can review them.
 * Never throws — a logging failure must not roll back money that has moved.
 */
export async function recordEmailSkip(
  adminClient: any,
  args: {
    investorId?: string | null;
    referenceId?: string | null;
    recipientEmail?: string | null;
    reason: string;
    fundingSource?: string | null;
    sourceFunction: string;
  },
): Promise<void> {
  try {
    await adminClient.from("angel_pool_email_skips").insert({
      investor_id: args.investorId ?? null,
      reference_id: args.referenceId ?? null,
      recipient_email: args.recipientEmail ?? null,
      reason: args.reason,
      funding_source: args.fundingSource ?? null,
      source_function: args.sourceFunction,
    });
  } catch (err) {
    console.error("[angelPoolNotify] recordEmailSkip failed:", err);
  }
}

function formatPhoneInternational(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "angelPoolNotify" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[angelPoolNotify] Missing Africa's Talking credentials");
    return false;
  }
  const to = formatPhoneInternational(phone);
  if (!to) return false;

  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";

  try {
    const body = new URLSearchParams({ username, from: "WELILE", to, message });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
        Accept: "application/json",
      },
      body: body.toString(),
    });
    const raw = await res.text();
    let data: any;
    try { data = JSON.parse(raw); } catch {
      console.error("[angelPoolNotify] Non-JSON AT response:", raw);
      return false;
    }
    const recipients = data?.SMSMessageData?.Recipients || [];
    const ok = recipients.some((r: any) => r.statusCode === 100 || r.statusCode === 101);
    console.log(`[angelPoolNotify] sms to=${to} ok=${ok} http=${res.status}`);
    return ok;
  } catch (err) {
    console.error("[angelPoolNotify] SMS send failed:", err);
    return false;
  }
}

interface AngelPoolSmsArgs {
  investorId: string;
  shares: number;
  amount: number;
  referenceId: string;
}

/**
 * Best-effort Angel Pool purchase confirmation SMS. Resolves the investor's
 * phone + name from profiles. Returns true when the SMS was accepted.
 */
export async function sendAngelPoolSms(
  adminClient: any,
  { investorId, shares, amount, referenceId }: AngelPoolSmsArgs,
): Promise<{ sent: boolean; reason?: string; phone?: string }> {
  if (!investorId) return { sent: false, reason: "no_investor_id" };

  const { data: profile } = await adminClient
    .from("profiles")
    .select("phone, full_name")
    .eq("id", investorId)
    .maybeSingle();

  const phone = profile?.phone as string | undefined;
  if (!phone) {
    console.warn(`[angelPoolNotify] No phone for investor ${investorId} — SMS skipped`);
    return { sent: false, reason: "no_phone_on_file" };
  }

  const first = (profile?.full_name || "").trim().split(/\s+/)[0] || "there";
  const message =
    `Hi ${first}, your Welile Angel Pool purchase is confirmed: ` +
    `${shares} share(s) for UGX ${amount.toLocaleString()}. ` +
    `Ref ${referenceId}. Thank you for partnering with Welile.`;

  const ok = await sendSMS(phone, message);
  return { sent: ok, reason: ok ? undefined : "send_failed", phone };
}
