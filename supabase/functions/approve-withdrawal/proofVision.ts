/**
 * Vision extraction for merchant payout proof-of-payment screenshots.
 *
 * Calls the Lovable AI Gateway (same pattern as `supabase/functions/scan-receipt`)
 * to read a MTN MoMo / Airtel Money / bank PAYMENT CONFIRMATION screenshot —
 * not a shopping receipt — and pull the same fields `parsePayoutConfirmationSms`
 * extracts from pasted text, so the two can be cross-checked. Every field is
 * optional: the model is instructed to return null rather than guess, and a
 * field the model can't read confidently must never cause a hard block on its
 * own (see the cross-verification policy in `index.ts`).
 *
 * Never accepts a client-supplied image — the caller must pass bytes it
 * downloaded itself from the authoritative `payout_proof_path` in Storage.
 */

export interface ExtractedProofFields {
  transactionId?: string | null;
  amount?: number | null;
  date?: string | null;   // YYYY-MM-DD
  time?: string | null;   // HH:MM 24h
  phone?: string | null;
  confidence?: "high" | "low" | null;
}

export interface ProofVisionResult {
  fields: ExtractedProofFields | null;
  /** Set when `fields` is null — why extraction couldn't be trusted. Always
   *  treat this as "unverifiable", never as a hard-block reason by itself. */
  unverifiableReason?: string;
}

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

const SYSTEM_PROMPT = `You are analyzing a screenshot of a mobile-money (MTN MoMo / Airtel Money) or bank PAYMENT CONFIRMATION message — this is NOT a shopping receipt, do not look for purchased items. Extract ONLY what is visibly printed in the image. Return ONLY a valid JSON object, no markdown fences, no commentary.

The JSON must have these exact fields:
- transactionId: the transaction ID / TID / financial transaction ID / bank reference as printed (string), or null
- amount: the amount sent/paid, as a plain number with no currency symbol and no commas, or null
- date: the date shown, as YYYY-MM-DD, or null if not determinable
- time: the time shown, as 24-hour HH:MM, or null if not determinable
- phone: the recipient or sender phone number as shown (digits and leading + only), or null
- confidence: "high" if the image is clear and every field you returned is confidently legible, "low" if the image is blurry/cropped/partially unreadable

If a field is not clearly legible, return null for it — never guess. Always return valid JSON, nothing else.`;

/**
 * Extract fields from a payout proof-of-payment image. Never throws — a
 * gateway error, rate limit, or unparsable response all come back as
 * `{fields: null, unverifiableReason: ...}` so the caller can fall through to
 * the SMS-only gate instead of failing the whole settlement over AI-gateway
 * noise.
 */
export async function extractProofFieldsFromImage(
  base64Image: string,
  mimeType: string,
  apiKey: string,
): Promise<ProofVisionResult> {
  let response: Response;
  try {
    response = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extract the transaction ID, amount, date, time and phone number from this payment confirmation screenshot. Return only the JSON object.",
              },
              {
                type: "image_url",
                image_url: { url: `data:${mimeType || "image/jpeg"};base64,${base64Image}` },
              },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    return { fields: null, unverifiableReason: `gateway_request_failed: ${(e as Error).message}` };
  }

  if (!response.ok) {
    if (response.status === 429) return { fields: null, unverifiableReason: "gateway_rate_limited" };
    if (response.status === 402) return { fields: null, unverifiableReason: "gateway_quota_exceeded" };
    const errorText = await response.text().catch(() => "");
    console.error("[approve-withdrawal] proof vision gateway error:", response.status, errorText);
    return { fields: null, unverifiableReason: `gateway_error_${response.status}` };
  }

  let content = "";
  try {
    const data = await response.json();
    content = data.choices?.[0]?.message?.content || "";
  } catch (e) {
    return { fields: null, unverifiableReason: `gateway_response_unparsable: ${(e as Error).message}` };
  }

  let cleaned = content.trim();
  if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.warn("[approve-withdrawal] proof vision: could not parse JSON:", content);
    return { fields: null, unverifiableReason: "model_response_not_json" };
  }

  const amountRaw = parsed.amount;
  const amount =
    amountRaw === null || amountRaw === undefined
      ? null
      : Number.isFinite(Number(amountRaw))
        ? Math.round(Number(amountRaw))
        : null;

  return {
    fields: {
      transactionId: typeof parsed.transactionId === "string" ? parsed.transactionId : null,
      amount,
      date: typeof parsed.date === "string" ? parsed.date : null,
      time: typeof parsed.time === "string" ? parsed.time : null,
      phone: typeof parsed.phone === "string" ? parsed.phone : null,
      confidence: parsed.confidence === "high" || parsed.confidence === "low" ? parsed.confidence : null,
    },
  };
}
