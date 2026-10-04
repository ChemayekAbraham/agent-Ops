// ── Yoola handset-delivery confirmation ──────────────────────────────────────
// Yoola's send endpoint returns "queued/success" even when the carrier later
// drops the message, so an HTTP acceptance is NOT proof the handset got it.
// Time-critical SMS (cash-deposit codes) must therefore poll Yoola's delivery
// report for a short window and fail over to Africa's Talking when Yoola does
// not confirm delivery in time.
const YOOLA_DELIVERY_URL = "https://yoolasms.com/api/v1/delivery_report";

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

/** Pull Yoola's message id out of whatever shape the send response had. */
export function extractYoolaMessageId(sendResponse: unknown): string | null {
  const r = sendResponse as any;
  if (!r || typeof r !== "object") return null;
  const recipient = Array.isArray(r?.per_recipient) ? r.per_recipient[0] : null;
  return firstString(
    r?.message_id,
    r?.messageId,
    r?.id,
    r?.data?.message_id,
    recipient?.message_id,
    recipient?.messageId,
  );
}

export type YoolaConfirmation = "delivered" | "failed" | "unconfirmed";

/**
 * Poll Yoola until the message is reported delivered/failed, or the window
 * runs out. `unconfirmed` (still queued/pending, no message id, lookup error)
 * is treated by callers exactly like a failure: fail over to the next provider.
 */
export async function confirmYoolaDelivery(
  messageId: string | null,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<{ outcome: YoolaConfirmation; detail: string | null }> {
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) return { outcome: "unconfirmed", detail: "yoola_not_configured" };
  if (!messageId) return { outcome: "unconfirmed", detail: "no_yoola_message_id" };

  const attempts = Math.max(1, Math.min(opts.attempts ?? 4, 8));
  const delayMs = Math.max(500, Math.min(opts.delayMs ?? 2500, 10_000));

  let last = "no_report";
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const res = await fetch(YOOLA_DELIVERY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ api_key: apiKey, message_id: messageId }),
      });
      const raw = await res.text();
      let report: any = null;
      try { report = JSON.parse(raw); } catch { report = null; }
      if (!res.ok || String(report?.status ?? "").toLowerCase() !== "success") {
        last = `lookup_failed_http_${res.status}`;
        continue;
      }
      const state = String(report?.sms_status ?? report?.delivery_status ?? report?.status_text ?? "")
        .trim()
        .toLowerCase();
      last = state || "no_status";
      if (["delivered", "success"].includes(state)) {
        return { outcome: "delivered", detail: state };
      }
      if (["failed", "rejected", "undelivered", "expired", "blocked"].includes(state)) {
        return { outcome: "failed", detail: `yoola_${state}` };
      }
      // queued / pending / sent → keep waiting.
    } catch (err) {
      last = `lookup_error_${(err as Error)?.message ?? "unknown"}`;
    }
  }
  return { outcome: "unconfirmed", detail: last };
}
