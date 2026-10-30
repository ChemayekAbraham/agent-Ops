/**
 * Read the total on a staff-requisition receipt (image or PDF).
 *
 * The caller downloads the file from Storage. This module never accepts a
 * client-supplied image. A failed or unconfident read returns no total —
 * the caller must not invent one.
 */

export interface ReceiptVisionFields {
  totalAmount: number | null;
  currency: string | null;
  confidence: "high" | "low" | null;
}

export interface ReceiptVisionResult {
  fields: ReceiptVisionFields | null;
  unverifiableReason?: string;
}

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

const SYSTEM_PROMPT = `You read a receipt, invoice, or payment slip and extract ONLY the final total amount. Return ONLY a valid JSON object, no markdown fences, no commentary.

The JSON must have these exact fields:
- totalAmount: the grand total, amount paid, or amount due as a plain number with no currency symbol and no commas, or null
- currency: "UGX" when the amount is Uganda shillings or no currency is printed, otherwise the currency code printed on the document, or null
- confidence: "high" only when the total is clearly legible, otherwise "low"

Use the final total, not a subtotal, tax line, or a single item price. If the total is blurry, cropped, missing, or you are unsure which figure is the total, return totalAmount null and confidence "low". Never guess a number.`;

export function isUgxCurrency(currency: string | null | undefined): boolean {
  if (currency == null || String(currency).trim() === "") return true;
  const c = String(currency).trim().toUpperCase().replace(/\./g, "");
  return c === "UGX" || c === "USH" || c === "UGSH" || c === "SHS" || c.includes("SHILLING");
}

export async function extractReceiptTotal(
  base64: string,
  mimeType: string,
  apiKey: string,
): Promise<ReceiptVisionResult> {
  if (!apiKey) return { fields: null, unverifiableReason: "vision_not_configured" };
  if (!base64) return { fields: null, unverifiableReason: "empty_file" };

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
              { type: "text", text: "Extract the final total from this receipt. Return only the JSON object." },
              {
                type: "image_url",
                image_url: { url: `data:${mimeType || "image/jpeg"};base64,${base64}` },
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
  } catch {
    return { fields: null, unverifiableReason: "model_response_not_json" };
  }

  const amountRaw = parsed.totalAmount;
  const totalAmount = amountRaw === null || amountRaw === undefined
    ? null
    : Number.isFinite(Number(amountRaw))
      ? Math.round(Number(amountRaw))
      : null;
  const currency = typeof parsed.currency === "string" ? parsed.currency.slice(0, 16) : null;
  const confidence = parsed.confidence === "high" || parsed.confidence === "low" ? parsed.confidence : null;

  if (totalAmount !== null && totalAmount < 0) {
    return { fields: null, unverifiableReason: "negative_total" };
  }
  if (totalAmount !== null && !isUgxCurrency(currency)) {
    return {
      fields: { totalAmount, currency, confidence: "low" },
      unverifiableReason: "currency_not_ugx",
    };
  }

  return { fields: { totalAmount, currency: currency ?? "UGX", confidence } };
}

export function mimeForReceiptPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
