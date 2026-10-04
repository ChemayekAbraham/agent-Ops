// Tests for the cash-deposit receipt-code verification core logic.
// Covers: hashing/normalization, 24h expiry, 6-attempt limiting, and
// prevention of double-credits under concurrent verifies.
import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateAttempt,
  normalizeCode,
  sha256Hex,
  VerificationRecord,
  VerificationStore,
} from "./cash-verification-core.ts";

const HOUR = 60 * 60 * 1000;

function record(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    status: "awaiting_code",
    attempts: 0,
    max_attempts: 6,
    expires_at: new Date(Date.now() + 24 * HOUR).toISOString(),
    code_hash: "deadbeef",
    ...overrides,
  };
}

// ── Hashing / normalization ───────────────────────────────────────────────
Deno.test("normalizeCode keeps only digits, max 4", () => {
  assertEquals(normalizeCode(" 12 34 "), "1234");
  assertEquals(normalizeCode("48-21"), "4821");
  assertEquals(normalizeCode("9075"), "9075");
  assertEquals(normalizeCode("123456"), "1234"); // truncated to 4
  assertEquals(normalizeCode("ab12cd34"), "1234"); // non-digits stripped
});

Deno.test("normalizeCode handles empty / nullish input without adding a prefix", () => {
  assertEquals(normalizeCode(""), "");
  assertEquals(normalizeCode(null), "");
  assertEquals(normalizeCode(undefined), "");
});

Deno.test("sha256Hex is deterministic, 64-hex chars, and collision-distinct", async () => {
  const a = await sha256Hex("RCTABC123");
  const b = await sha256Hex("RCTABC123");
  const c = await sha256Hex("RCTABC124");
  assertEquals(a, b);
  assertNotEquals(a, c);
  assertEquals(a.length, 64);
  assert(/^[0-9a-f]{64}$/.test(a));
});

Deno.test("normalized variants of the same code hash identically (end-to-end)", async () => {
  const stored = await sha256Hex(normalizeCode("1234"));
  const sloppy = await sha256Hex(normalizeCode("  12-34 "));
  assertEquals(sloppy, stored);
});

// ── 24h expiry behavior ───────────────────────────────────────────────────
Deno.test("evaluateAttempt rejects a code past the 24h window", async () => {
  const hash = await sha256Hex("RCTGOOD");
  const rec = record({ code_hash: hash, expires_at: new Date(Date.now() - 1000).toISOString() });
  // Even with the CORRECT hash, expiry takes precedence.
  assertEquals(evaluateAttempt(rec, hash, Date.now()).kind, "expired");
});

Deno.test("evaluateAttempt treats status='expired' as expired regardless of timestamp", async () => {
  const hash = await sha256Hex("RCTGOOD");
  const rec = record({ code_hash: hash, status: "expired" });
  assertEquals(evaluateAttempt(rec, hash, Date.now()).kind, "expired");
});

Deno.test("evaluateAttempt accepts a code just inside the 24h window", async () => {
  const hash = await sha256Hex("RCTGOOD");
  const now = Date.now();
  const rec = record({ code_hash: hash, expires_at: new Date(now + 60 * 1000).toISOString() });
  assertEquals(evaluateAttempt(rec, hash, now).kind, "match");
});

// ── 6-attempt limiting ────────────────────────────────────────────────────
Deno.test("evaluateAttempt counts down remaining attempts on each mismatch", () => {
  const rec = record({ attempts: 0, max_attempts: 6 });
  const d = evaluateAttempt(rec, "wronghash", Date.now());
  assertEquals(d.kind, "mismatch");
  if (d.kind === "mismatch") {
    assertEquals(d.newAttempts, 1);
    assertEquals(d.attemptsRemaining, 5);
    assertEquals(d.lock, false);
  }
});

Deno.test("evaluateAttempt locks on the 6th consecutive wrong attempt", () => {
  const rec = record({ attempts: 5, max_attempts: 6 });
  const d = evaluateAttempt(rec, "wronghash", Date.now());
  assertEquals(d.kind, "mismatch");
  if (d.kind === "mismatch") {
    assertEquals(d.newAttempts, 6);
    assertEquals(d.attemptsRemaining, 0);
    assertEquals(d.lock, true);
  }
});

Deno.test("evaluateAttempt rejects once attempts already reached the cap", () => {
  const rec = record({ attempts: 6, max_attempts: 6 });
  assertEquals(evaluateAttempt(rec, "wronghash", Date.now()).kind, "too_many_attempts");
});

Deno.test("full 6-attempt sequence: 5 mismatches then a lockout", () => {
  let attempts = 0;
  const max = 6;
  const outcomes: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = evaluateAttempt(record({ attempts, max_attempts: max }), "wronghash", Date.now());
    outcomes.push(d.kind);
    if (d.kind === "mismatch") attempts = d.newAttempts;
  }
  // attempts 1..5 remain "mismatch" (unlocked), attempt 6 is mismatch+lock,
  // and any further entry is rejected as too_many_attempts.
  assertEquals(outcomes.slice(0, 6).every((o) => o === "mismatch"), true);
  assertEquals(outcomes[6], "too_many_attempts");
});

Deno.test("a correct code before the cap verifies successfully", async () => {
  const hash = await sha256Hex("RCTGOOD");
  const rec = record({ code_hash: hash, attempts: 3, max_attempts: 6 });
  const d = evaluateAttempt(rec, hash, Date.now());
  assertEquals(d.kind, "match");
  if (d.kind === "match") assertEquals(d.newAttempts, 4);
});

// ── Double-credit prevention under concurrency ────────────────────────────
Deno.test("only one concurrent verify claims the deposit (no double credit)", async () => {
  const store = new VerificationStore();
  store.seed({ id: "dep-1", status: "awaiting_code" });

  let creditCount = 0;
  const verify = async () => {
    // Both requests pass the pure decision (correct hash) ...
    const hash = await sha256Hex("RCTGOOD");
    const rec = record({ code_hash: hash });
    assertEquals(evaluateAttempt(rec, hash, Date.now()).kind, "match");
    // ... but only the atomic claim transition may trigger a credit.
    const claimed = store.claim("dep-1", "awaiting_code", "verified");
    if (claimed) creditCount++;
    return claimed;
  };

  const results = await Promise.all([verify(), verify(), verify(), verify()]);
  assertEquals(results.filter(Boolean).length, 1);
  assertEquals(creditCount, 1);
  assertEquals(store.get("dep-1")?.status, "verified");
});

Deno.test("a verify on an already-verified deposit never credits again", () => {
  const store = new VerificationStore();
  store.seed({ id: "dep-2", status: "verified" });
  // Pure decision short-circuits to already_verified ...
  assertEquals(
    evaluateAttempt(record({ status: "verified" }), "anything", Date.now()).kind,
    "already_verified",
  );
  // ... and the atomic claim also refuses (status no longer awaiting_code).
  assertEquals(store.claim("dep-2", "awaiting_code", "verified"), false);
});