/**
 * Per-withdrawal tracking links + customer SMS wording for the merchant
 * payout lifecycle (claim / release). Pure TypeScript — no Deno or URL imports
 * — so it runs under both the edge runtime and vitest.
 *
 * TRACKING LINK
 * Every withdrawal already carries `withdrawal_requests.receipt_token`: an
 * unguessable 32-hex value from the column DEFAULT, protected by the unique
 * index `withdrawal_requests_receipt_token_key`. The public route `/r/:token`
 * resolves it through `get_payout_receipt_by_token`, which returns only
 * `{status, paid:false}` until the payout is settled and the full receipt after
 * — so the same link works as "track it" at claim time and "your receipt" at
 * completion, and never exposes the internal id, payout number or bank details
 * of an unpaid withdrawal.
 *
 * Before this module the claim SMS hard-coded `https://welileapp.com/ZQhyGb`
 * (the generic app/sign-up short link) and the release SMS
 * `https://welileapp.com/auth`, so every customer got the same "track your
 * transaction" URL.
 *
 * - Same withdrawal  -> same token (read from the row; generated at most once).
 * - Different withdrawals -> different tokens (unique index).
 * - Generation is idempotent: a missing token is set with
 *   `UPDATE ... WHERE receipt_token IS NULL`, then re-read, so two concurrent
 *   senders converge on whichever write won.
 */

export const WITHDRAWAL_TRACKING_BASE_URL = "https://welileapp.com/r/";
export const WELILE_SUPPORT_PHONE = "0748747134";

// get_payout_receipt_by_token rejects anything shorter than 16 chars.
const TOKEN_PATTERN = /^[A-Za-z0-9]{16,64}$/;

export function isValidTrackingToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

export function withdrawalTrackingUrl(token: string): string {
  if (!isValidTrackingToken(token)) {
    throw new Error("Invalid withdrawal tracking token");
  }
  return `${WITHDRAWAL_TRACKING_BASE_URL}${token}`;
}

/** 32 lowercase hex chars — same shape as the column DEFAULT. */
export function generateTrackingToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Minimal storage port so the idempotent logic is testable without a DB. */
export interface TrackingTokenStore {
  read(withdrawalId: string): Promise<string | null>;
  /** Set the token only if the row has none. Must not overwrite. */
  setIfMissing(withdrawalId: string, token: string): Promise<void>;
}

/**
 * Return the withdrawal's stable tracking token, creating it once if the row
 * somehow has none. Returns null when the withdrawal cannot be resolved —
 * callers then send the SMS without a link rather than a shared/placeholder one.
 */
export async function ensureWithdrawalTrackingToken(
  store: TrackingTokenStore,
  withdrawalId: string,
  generate: () => string = generateTrackingToken,
): Promise<string | null> {
  const existing = await store.read(withdrawalId);
  if (isValidTrackingToken(existing)) return existing;

  // Two attempts: a fresh token can only fail on the (astronomically unlikely)
  // unique-index collision; the re-read afterwards picks up a concurrent winner.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await store.setIfMissing(withdrawalId, generate());
    } catch {
      /* collision or transient error — re-read below decides */
    }
    const stored = await store.read(withdrawalId);
    if (isValidTrackingToken(stored)) return stored;
  }
  return null;
}

/** Supabase-backed store (service-role client). */
export function supabaseTrackingTokenStore(admin: any): TrackingTokenStore {
  return {
    async read(withdrawalId) {
      const { data, error } = await admin
        .from("withdrawal_requests")
        .select("receipt_token")
        .eq("id", withdrawalId)
        .maybeSingle();
      if (error) throw error;
      return (data as any)?.receipt_token ?? null;
    },
    async setIfMissing(withdrawalId, token) {
      const { error } = await admin
        .from("withdrawal_requests")
        .update({ receipt_token: token })
        .eq("id", withdrawalId)
        .is("receipt_token", null);
      if (error) throw error;
    },
  };
}

function formatUgx(amount: number): string {
  return `UGX ${(Number(amount) || 0).toLocaleString("en-US")}`;
}

function trackingLine(trackingUrl: string | null): string {
  // URL on its own line with nothing glued to it, so phones link it cleanly.
  return trackingUrl ? `Track your transaction:\n${trackingUrl}\n` : "";
}

/**
 * Claim-time SMS: an ASSIGNMENT acknowledgement only. It must not say or imply
 * the money has been sent or will arrive shortly — nothing has been paid yet.
 * The payment confirmation is a separate SMS sent by approve-withdrawal only
 * after settlement succeeds.
 */
export function buildWithdrawalAssignedSms(amount: number, trackingUrl: string | null): string {
  return (
    `WELILE: Your withdrawal of ${formatUgx(amount)} has been assigned for processing. ` +
    `You will receive another confirmation once payment has been sent.\n` +
    trackingLine(trackingUrl) +
    `For assistance, contact Welile Support on ${WELILE_SUPPORT_PHONE}.`
  );
}

/**
 * Released-claim SMS: the payout went back to the queue unpaid. Same rule —
 * no promise of when money arrives.
 */
export function buildWithdrawalReleasedSms(amount: number, trackingUrl: string | null): string {
  return (
    `WELILE: Your withdrawal of ${formatUgx(amount)} has not been paid yet and is being reassigned for processing. ` +
    `Your funds remain reserved for this withdrawal. You will receive a confirmation once payment has been sent.\n` +
    trackingLine(trackingUrl) +
    `For assistance, contact Welile Support on ${WELILE_SUPPORT_PHONE}.`
  );
}
