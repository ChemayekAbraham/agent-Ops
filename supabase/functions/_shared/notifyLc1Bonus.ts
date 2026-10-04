import "./smsFooterInterceptor.ts";
import { attemptYoolaPrimary } from "./yoolaPrimary.ts";
// Shared notifier for the two-stage LC1 chairperson registration reward.
// Sends an in-app notification (notifications table, realtime) AND an
// SMS/WhatsApp text via Africa's Talking to the registering agent's phone.
//
// Stage "registered" → no money moves (registration only, acknowledgement text)
// Stage "verified"   → UGX 5,000 full reward (paid after Landlord Ops verifies)
//
// Always best-effort: callers must never let a notification failure roll back
// money that has already moved. Wrap calls in try/catch or fire-and-forget.

type Stage = "registered" | "verified";

const STAGE_AMOUNT: Record<Stage, number> = {
  registered: 0,
  verified: 5000,
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
  if (await attemptYoolaPrimary(phone, message, { source: "notifyLc1Bonus" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[notifyLc1Bonus] Missing Africa's Talking credentials");
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
      console.error("[notifyLc1Bonus] Non-JSON AT response:", raw);
      return false;
    }
    const recipients = data?.SMSMessageData?.Recipients || [];
    const ok = recipients.some((r: any) => r.statusCode === 100 || r.statusCode === 101);
    console.log(`[notifyLc1Bonus] sms to=${to} ok=${ok} http=${res.status}`);
    return ok;
  } catch (err) {
    console.error("[notifyLc1Bonus] SMS send failed:", err);
    return false;
  }
}

interface NotifyArgs {
  agentId: string;
  stage: Stage;
  lc1Name?: string | null;
  lc1Id?: string | null;
  metadata?: Record<string, unknown>;
}

export async function notifyLc1Bonus(
  adminClient: any,
  { agentId, stage, lc1Name, lc1Id, metadata = {} }: NotifyArgs,
): Promise<void> {
  if (!agentId) return;
  const amount = STAGE_AMOUNT[stage];
  const name = (lc1Name || "the LC1 chairperson").trim();

  const inAppTitle = stage === "registered"
    ? "LC1 chairperson submitted for verification"
    : "LC1 verified — UGX 5,000 credited! 💰";

  const inAppMessage = stage === "registered"
    ? `LC1 chairperson "${name}" was registered and sent to Landlord Ops. Your UGX 5,000 reward is credited once they verify the chairperson.`
    : `LC1 chairperson "${name}" has been verified by Landlord Ops. UGX ${amount.toLocaleString()} has been credited to your withdrawable wallet.`;

  // 1) In-app notification (realtime). Best-effort.
  try {
    await adminClient.from("notifications").insert({
      user_id: agentId,
      title: inAppTitle,
      message: inAppMessage,
      type: "earning",
      metadata: { ...metadata, lc1_id: lc1Id ?? null, bonus_amount: amount, stage },
    });
  } catch (err) {
    console.error("[notifyLc1Bonus] in-app insert failed:", err);
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
      console.warn(`[notifyLc1Bonus] No phone for agent ${agentId} — SMS skipped`);
      return;
    }

    const first = (profile?.full_name || "").trim().split(/\s+/)[0] || "there";
    const smsMessage = stage === "registered"
      ? `Hi ${first}, LC1 chairperson "${name}" was registered. Your UGX 5,000 reward is credited once Landlord Ops verifies them.`
      : `Hi ${first}, LC1 chairperson "${name}" has been verified! UGX ${amount.toLocaleString()} has been credited to your Welile withdrawable wallet. Thank you.`;

    await sendSMS(phone, smsMessage);
  } catch (err) {
    console.error("[notifyLc1Bonus] SMS step failed:", err);
  }
}
