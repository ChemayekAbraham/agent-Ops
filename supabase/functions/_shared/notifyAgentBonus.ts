import "./smsFooterInterceptor.ts";
import { attemptYoolaPrimary } from "./yoolaPrimary.ts";
// Shared notifier for the two-stage house listing reward.
// Sends an in-app notification (notifications table, realtime) AND an
// SMS/WhatsApp text via Africa's Talking to the agent's phone.
//
// Stage "listed"   → UGX 1,000 instant reward (paid when the house is listed)
// Stage "verified" → UGX 4,000 reward (paid after Landlord Ops verifies)
//
// Always best-effort: callers must never let a notification failure roll back
// money that has already moved. Wrap calls in try/catch or fire-and-forget.

type Stage = "listed" | "verified";

const STAGE_AMOUNT: Record<Stage, number> = {
  listed: 1000,
  verified: 4000,
};

function formatPhoneInternational(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "notifyAgentBonus" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[notifyAgentBonus] Missing Africa's Talking credentials");
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
      console.error("[notifyAgentBonus] Non-JSON AT response:", raw);
      return false;
    }
    const recipients = data?.SMSMessageData?.Recipients || [];
    const ok = recipients.some((r: any) => r.statusCode === 100 || r.statusCode === 101);
    console.log(`[notifyAgentBonus] sms to=${to} ok=${ok} http=${res.status}`);
    return ok;
  } catch (err) {
    console.error("[notifyAgentBonus] SMS send failed:", err);
    return false;
  }
}

interface NotifyArgs {
  agentId: string;
  stage: Stage;
  listingTitle?: string | null;
  listingId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function notifyAgentBonus(
  adminClient: any,
  { agentId, stage, listingTitle, listingId, metadata = {} }: NotifyArgs,
): Promise<void> {
  if (!agentId) return;
  const amount = STAGE_AMOUNT[stage];
  const title = (listingTitle || "your house").trim();

  const inAppTitle = stage === "listed"
    ? "UGX 1,000 listed reward credited! 💰"
    : "Listing verified — UGX 4,000 credited! 💰";

  const inAppMessage = stage === "listed"
    ? `UGX ${amount.toLocaleString()} has been credited to your withdrawable wallet for listing "${title}". The remaining UGX 4,000 is released once Landlord Ops verifies the house.`
    : `"${title}" has been verified by Landlord Ops. UGX ${amount.toLocaleString()} has been credited to your withdrawable wallet (plus the UGX 1,000 paid instantly when you listed it).`;

  // 1) In-app notification (realtime). Best-effort.
  try {
    await adminClient.from("notifications").insert({
      user_id: agentId,
      title: inAppTitle,
      message: inAppMessage,
      type: "earning",
      metadata: { ...metadata, listing_id: listingId ?? null, bonus_amount: amount, stage },
    });
  } catch (err) {
    console.error("[notifyAgentBonus] in-app insert failed:", err);
  }

  // 2) SMS / WhatsApp text. Best-effort — needs the agent's phone.
  try {
    const { data: profile } = await adminClient
      .from("profiles")
      .select("phone, full_name")
      .eq("id", agentId)
      .maybeSingle();

    const phone = profile?.phone as string | undefined;
    if (!phone) {
      console.warn(`[notifyAgentBonus] No phone for agent ${agentId} — SMS skipped`);
      return;
    }

    const first = (profile?.full_name || "").trim().split(/\s+/)[0] || "there";
    const smsMessage = stage === "listed"
      ? `Hi ${first}, UGX ${amount.toLocaleString()} has been credited to your Welile wallet for listing "${title}". UGX 4,000 more is released once Landlord Ops verifies it.`
      : `Hi ${first}, "${title}" has been verified! UGX ${amount.toLocaleString()} has been credited to your Welile withdrawable wallet. Thank you for listing on Welile.`;

    await sendSMS(phone, smsMessage);
  } catch (err) {
    console.error("[notifyAgentBonus] SMS step failed:", err);
  }
}