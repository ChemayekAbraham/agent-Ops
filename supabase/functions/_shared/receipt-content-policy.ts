/**
 * Receipt content policy — the single source of truth for the commission
 * disclosure rule on payout receipts:
 *
 *   • CUSTOMER receipts  → NEVER include the merchant agent's commission.
 *   • MERCHANT receipts  → ALWAYS include the commission the agent earned.
 *   • INTERNAL copies    → (FinOps / CFO / records archive) treated like the
 *                          customer copy: no commission.
 *
 * Both the customer-facing PDF (payoutReceiptPdf.ts) and the transactional
 * email builder call into this so the invariant is enforced identically on
 * every channel. A mirror of this module lives at
 * supabase/functions/_shared/receipt-content-policy.ts for the Deno runtime —
 * keep the two in sync.
 */

export type ReceiptAudience = 'customer' | 'merchant' | 'internal';

/** True only for the merchant agent's own copy — the sole receipt that may carry commission. */
export function audienceIncludesCommission(audience: ReceiptAudience): boolean {
  return audience === 'merchant';
}

/**
 * Normalizes a raw commission figure to what is allowed for the audience.
 * Returns a positive number for merchant receipts, otherwise null (stripped).
 */
export function commissionForAudience(
  audience: ReceiptAudience,
  rawCommission?: number | null,
): number | null {
  if (!audienceIncludesCommission(audience)) return null;
  const n = typeof rawCommission === 'number' ? rawCommission : Number(rawCommission);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface ReceiptContentValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validates that a receipt's rendered content matches the commission policy for
 * its audience. `commissionIncluded` is whether commission is actually present
 * in the receipt body about to be emitted.
 */
export function validateReceiptContent(
  audience: ReceiptAudience,
  commissionIncluded: boolean,
): ReceiptContentValidation {
  const mustInclude = audienceIncludesCommission(audience);
  if (mustInclude && !commissionIncluded) {
    return { ok: false, error: 'Merchant receipt must include the commission earned, but it is missing.' };
  }
  if (!mustInclude && commissionIncluded) {
    return {
      ok: false,
      error: `A ${audience} receipt must never include merchant commission, but commission is present.`,
    };
  }
  return { ok: true };
}

/** Throwing variant — use at the point a receipt is generated/sent. */
export function assertReceiptContent(audience: ReceiptAudience, commissionIncluded: boolean): void {
  const result = validateReceiptContent(audience, commissionIncluded);
  if (!result.ok) throw new Error(`[receipt-content-policy] ${result.error}`);
}
