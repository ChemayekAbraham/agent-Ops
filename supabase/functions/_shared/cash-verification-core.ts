// Pure, dependency-free core logic for the cash-deposit receipt-code flow.
// Extracted so it can be unit-tested without a live database, network, or the
// Deno.serve handler. Both cash-deposit-request-code and
// cash-deposit-verify-code import from here so the tests exercise the real code.

// ── Code normalization ────────────────────────────────────────────────────
// Receipt codes are 4 numeric digits. Strip everything that is not a digit and
// keep at most the first 4, so pasted codes with spaces/dashes still validate.
export function normalizeCode(input: unknown): string {
  return String(input ?? "").replace(/\D+/g, "").slice(0, 4);
}

// ── Hashing ───────────────────────────────────────────────────────────────
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Verification decision ─────────────────────────────────────────────────
export type VerificationStatus = "awaiting_code" | "verified" | "expired";

export interface VerificationRecord {
  status: VerificationStatus;
  attempts: number;
  max_attempts: number;
  expires_at: string; // ISO timestamp
  code_hash: string;
}

export type Decision =
  | { kind: "already_verified" }
  | { kind: "expired" }
  | { kind: "too_many_attempts" }
  | { kind: "mismatch"; newAttempts: number; attemptsRemaining: number; lock: boolean }
  | { kind: "match"; newAttempts: number };

// Mirrors the exact decision sequence used by the verify-code handler:
// already-verified → expiry (status or 24h window) → attempt cap → hash compare.
export function evaluateAttempt(
  rec: VerificationRecord,
  enteredHash: string,
  nowMs: number,
): Decision {
  if (rec.status === "verified") return { kind: "already_verified" };

  const expired =
    rec.status === "expired" || new Date(rec.expires_at).getTime() < nowMs;
  if (expired) return { kind: "expired" };

  if (Number(rec.attempts) >= Number(rec.max_attempts)) {
    return { kind: "too_many_attempts" };
  }

  if (enteredHash !== rec.code_hash) {
    const newAttempts = Number(rec.attempts) + 1;
    const attemptsRemaining = Math.max(0, Number(rec.max_attempts) - newAttempts);
    return {
      kind: "mismatch",
      newAttempts,
      attemptsRemaining,
      lock: attemptsRemaining <= 0,
    };
  }

  return { kind: "match", newAttempts: Number(rec.attempts) + 1 };
}

// ── Atomic claim (double-credit guard) ────────────────────────────────────
// Models the DB-side conditional update used to guarantee only ONE concurrent
// verify transitions awaiting_code → verified (and therefore only one credit).
// The real handler relies on:
//   UPDATE ... SET status='verified' WHERE id=? AND status='awaiting_code'
// which is atomic in Postgres. This in-memory store reproduces that contract so
// the concurrency behavior can be asserted deterministically in tests.
export interface StoredVerification {
  id: string;
  status: VerificationStatus;
}

export class VerificationStore {
  private rows = new Map<string, StoredVerification>();

  seed(row: StoredVerification): void {
    this.rows.set(row.id, { ...row });
  }

  get(id: string): StoredVerification | undefined {
    const r = this.rows.get(id);
    return r ? { ...r } : undefined;
  }

  // Atomic compare-and-set: returns true only for the caller that actually
  // performed the transition. Concurrent callers observing a non-matching
  // status get false (they must NOT credit the wallet).
  claim(id: string, from: VerificationStatus, to: VerificationStatus): boolean {
    const row = this.rows.get(id);
    if (!row || row.status !== from) return false;
    row.status = to;
    return true;
  }
}