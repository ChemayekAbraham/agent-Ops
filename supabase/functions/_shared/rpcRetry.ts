// Shared retry helper for transient Postgres / pooler failures inside edge functions.
//
// Large financial operations (10M+ deposits, portfolio top-ups, portfolio
// creation) issue several Postgres RPCs in sequence. Any one of them can
// occasionally flake on a transient connection drop, pooler 5xx, or
// statement-level retryable error — and that surfaces to the user as a
// generic "Edge Function returned a non-2xx status code".
//
// withRetry classifies retryable errors and retries them with bounded
// backoff while emitting structured logs so we can see exactly which
// step failed and how long it took. Non-retryable errors (validation,
// constraint violations, insufficient balance, etc.) fail immediately.
export async function withRetry<T>(
  label: string,
  contextId: string,
  fn: () => Promise<{ data?: T; error: unknown } | { error: unknown }>,
  maxAttempts = 3,
): Promise<{ data?: T; error: unknown; attempts: number; ms: number }> {
  let lastErr: unknown = null;
  const t0 = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const stepStart = Date.now();
    try {
      const res = await fn() as { data?: T; error: unknown };
      const stepMs = Date.now() - stepStart;
      if (!res?.error) {
        if (attempt > 1) {
          console.log(
            `[rpcRetry] ${label} succeeded on attempt ${attempt}/${maxAttempts} ` +
            `(ctx=${contextId}, step_ms=${stepMs}, total_ms=${Date.now() - t0})`,
          );
        }
        return { data: res.data, error: null, attempts: attempt, ms: Date.now() - t0 };
      }
      lastErr = res.error;
      if (!isTransient(res.error) || attempt === maxAttempts) {
        console.warn(
          `[rpcRetry] ${label} attempt ${attempt}/${maxAttempts} failed (final) ` +
          `(ctx=${contextId}, step_ms=${stepMs}): ${describe(res.error)}`,
        );
        break;
      }
      console.warn(
        `[rpcRetry] ${label} attempt ${attempt}/${maxAttempts} transient failure, retrying ` +
        `(ctx=${contextId}, step_ms=${stepMs}): ${describe(res.error)}`,
      );
      await new Promise((r) => setTimeout(r, 250 * attempt));
    } catch (thrown) {
      lastErr = thrown;
      const stepMs = Date.now() - stepStart;
      if (attempt === maxAttempts) {
        console.warn(
          `[rpcRetry] ${label} attempt ${attempt}/${maxAttempts} threw (final) ` +
          `(ctx=${contextId}, step_ms=${stepMs}): ${describe(thrown)}`,
        );
        break;
      }
      console.warn(
        `[rpcRetry] ${label} attempt ${attempt}/${maxAttempts} threw, retrying ` +
        `(ctx=${contextId}, step_ms=${stepMs}): ${describe(thrown)}`,
      );
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  return { data: undefined, error: lastErr, attempts: maxAttempts, ms: Date.now() - t0 };
}

function describe(err: unknown): string {
  if (!err) return "unknown";
  const anyErr = err as { message?: string; code?: string };
  return `[code=${anyErr.code ?? "?"}] ${anyErr.message ?? String(err)}`;
}

function isTransient(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { message?: string; code?: string };
  const msg = String(anyErr.message ?? err);
  const code = String(anyErr.code ?? "");
  // Non-retryable Postgres error classes (validation, constraint, RLS, etc.)
  // should NEVER be retried — they will only burn time.
  // Class 23 = integrity constraint violation, 42 = syntax/access, P0 = PL/pgSQL raise.
  if (/^(23|42|P0)/.test(code)) return false;
  // Heuristics for transient connection / timeout / contention.
  if (
    /timeout|timed out|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection reset|connection closed|temporarily unavailable|deadlock|could not serialize/i
      .test(msg)
  ) return true;
  // Postgres connection / admin shutdown / deadlock / serialization codes.
  if (
    ["08000", "08003", "08006", "08001", "08004", "08007",
     "40001", "40P01", "53300", "57014", "57P01", "57P02", "57P03"].includes(code)
  ) return true;
  return false;
}
