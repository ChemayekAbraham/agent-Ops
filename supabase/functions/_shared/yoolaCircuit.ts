// Yoola "out of credit" circuit breaker.
//
// When Yoola answers HTTP 402 / insufficient_fund, every further Yoola call is a
// guaranteed failure: it adds latency, and writes a `failed` yoola row to
// sms_delivery_log before the message falls back to Africa's Talking anyway
// (measured 2026-10-12: ~400 such rows/day, all inflating the SMS failure rate).
//
// Once tripped, callers skip Yoola and go straight to the next provider. After
// the cooldown ONE call is allowed through as a probe; if Yoola was topped up it
// succeeds and the breaker stays closed, otherwise it re-trips.
//
// State is per edge-function isolate (module scope) — no DB round trip on the
// send path. A cold isolate simply makes one probe call, which is acceptable.

const COOLDOWN_MS = 10 * 60 * 1000;

let skipUntil = 0;

/** True while Yoola is known to be out of credit and should be skipped. */
export function yoolaCircuitOpen(): boolean {
  return Date.now() < skipUntil;
}

/** Does this Yoola response mean the account is out of credit? */
export function isYoolaOutOfCredit(httpStatus: number, data: any, raw?: string): boolean {
  if (httpStatus === 402) return true;
  const text = `${data?.error ?? ""} ${data?.message ?? ""} ${data?.status ?? ""} ${raw ?? ""}`.toLowerCase();
  return text.includes("insufficient_fund") || text.includes("insufficient credit");
}

/** Open the breaker. Called when Yoola reports it is out of credit. */
export function tripYoolaCircuit(): void {
  skipUntil = Date.now() + COOLDOWN_MS;
}

/** Close the breaker. Called when Yoola accepts a send. */
export function resetYoolaCircuit(): void {
  skipUntil = 0;
}
