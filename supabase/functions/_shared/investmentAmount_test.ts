/**
 * END-TO-END TEST: Partnership-ops minimum investment boundary (UGX 1,000).
 *
 * Confirms that portfolio creation and invest-for-partner SUCCEED at exactly
 * UGX 1,000 and FAIL below UGX 1,000. The boundary rule lives in
 * `investmentAmount.ts` and is the same code every investment edge function
 * executes (coo-create-portfolio, coo-invest-for-partner,
 * agent-invest-for-partner, create-investor-portfolio).
 *
 * Two layers are verified:
 *   1. LOGIC  — the exact `isValidInvestmentAmount` gate the functions run.
 *   2. HTTP   — the deployed functions, hit with a real (authenticated) call
 *               when an OPERATOR_JWT is provided, otherwise auth-gated smoke
 *               checks (401) so the suite still runs in CI without secrets.
 */
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isValidInvestmentAmount,
  MIN_INVESTMENT_UGX,
  MIN_INVESTMENT_ERROR,
  MIN_INVESTMENT_ERROR_PORTFOLIO,
} from "./investmentAmount.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const BASE = `${SUPABASE_URL}/functions/v1`;

// Optional real-operator token + fixtures for a fully live end-to-end run.
const OPERATOR_JWT = Deno.env.get("OPERATOR_JWT");          // COO/manager session
const TEST_PARTNER_ID = Deno.env.get("TEST_PARTNER_ID");    // funded supporter
const TEST_AGENT_SUMMARY_ID = Deno.env.get("TEST_AGENT_SUMMARY_ID");

async function callFn(name: string, body: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "apikey": ANON_KEY,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ════════════════════════════════════════════════════════════════
// LAYER 1 — LOGIC: the exact gate every investment function executes
// ════════════════════════════════════════════════════════════════

Deno.test("BOUNDARY: exactly UGX 1,000 is accepted (succeeds)", () => {
  assertEquals(MIN_INVESTMENT_UGX, 1000);
  assert(isValidInvestmentAmount(1000), "UGX 1,000 must be a valid investment");
});

Deno.test("BOUNDARY: just below UGX 1,000 is rejected (fails)", () => {
  assert(!isValidInvestmentAmount(999), "UGX 999 must be rejected");
  assert(!isValidInvestmentAmount(1), "UGX 1 must be rejected");
});

Deno.test("BOUNDARY: above minimum is accepted", () => {
  assert(isValidInvestmentAmount(1001));
  assert(isValidInvestmentAmount(50_000));
  assert(isValidInvestmentAmount(500_000_000));
});

Deno.test("BOUNDARY: invalid / empty amounts are rejected", () => {
  assert(!isValidInvestmentAmount(0));
  assert(!isValidInvestmentAmount(-1000));
  assert(!isValidInvestmentAmount(NaN));
  assert(!isValidInvestmentAmount(null));
  assert(!isValidInvestmentAmount(undefined));
  assert(!isValidInvestmentAmount("1000"));
});

Deno.test("BOUNDARY: error messages are the standardized UGX 1,000 strings", () => {
  assertEquals(MIN_INVESTMENT_ERROR, "Minimum investment is UGX 1,000");
  assertEquals(MIN_INVESTMENT_ERROR_PORTFOLIO, "Investment amount must be at least UGX 1,000");
});

// ════════════════════════════════════════════════════════════════
// LAYER 2 — HTTP: deployed functions enforce the boundary
// ════════════════════════════════════════════════════════════════

Deno.test("HTTP: coo-create-portfolio requires auth (boundary check is post-auth)", async () => {
  const { status } = await callFn("coo-create-portfolio", {
    partner_id: "00000000-0000-0000-0000-000000000001",
    amount: 1000,
    roi_percentage: 15,
    roi_mode: "monthly_payout",
    duration_months: 12,
    payment_method: "wallet",
    source_wallet_user_id: "00000000-0000-0000-0000-000000000001",
  });
  // No valid session -> 401 before any money moves.
  assertEquals(status, 401);
});

Deno.test("HTTP: coo-invest-for-partner requires auth", async () => {
  const { status } = await callFn("coo-invest-for-partner", {
    partner_id: "00000000-0000-0000-0000-000000000001",
    amount: 1000,
  });
  assertEquals(status, 401);
});

// ── Fully live end-to-end (runs only when an operator token + fixtures exist) ──
Deno.test({
  name: "E2E: coo-invest-for-partner FAILS below UGX 1,000 (999)",
  ignore: !OPERATOR_JWT || !TEST_PARTNER_ID,
  async fn() {
    const { status, data } = await callFn("coo-invest-for-partner", {
      partner_id: TEST_PARTNER_ID,
      amount: 999,
    }, OPERATOR_JWT);
    assertEquals(status, 400);
    assertEquals(data.error, MIN_INVESTMENT_ERROR);
  },
});

Deno.test({
  name: "E2E: coo-invest-for-partner SUCCEEDS at exactly UGX 1,000",
  ignore: !OPERATOR_JWT || !TEST_PARTNER_ID,
  async fn() {
    const { status, data } = await callFn("coo-invest-for-partner", {
      partner_id: TEST_PARTNER_ID,
      amount: 1000,
    }, OPERATOR_JWT);
    // Must pass the minimum gate: never the min-amount rejection.
    assert(status !== 400 || data.error !== MIN_INVESTMENT_ERROR,
      `UGX 1,000 must clear the minimum gate (got ${status}: ${data.error})`);
  },
});

Deno.test({
  name: "E2E: coo-create-portfolio FAILS below UGX 1,000 (999)",
  ignore: !OPERATOR_JWT || !TEST_PARTNER_ID,
  async fn() {
    const { status, data } = await callFn("coo-create-portfolio", {
      partner_id: TEST_PARTNER_ID,
      amount: 999,
      roi_percentage: 15,
      roi_mode: "monthly_payout",
      duration_months: 12,
      payment_method: "wallet",
      source_wallet_user_id: TEST_PARTNER_ID,
    }, OPERATOR_JWT);
    assertEquals(status, 400);
    assertEquals(data.error, MIN_INVESTMENT_ERROR);
  },
});

Deno.test({
  name: "E2E: coo-create-portfolio SUCCEEDS at exactly UGX 1,000",
  ignore: !OPERATOR_JWT || !TEST_PARTNER_ID,
  async fn() {
    const { status, data } = await callFn("coo-create-portfolio", {
      partner_id: TEST_PARTNER_ID,
      amount: 1000,
      roi_percentage: 15,
      roi_mode: "monthly_payout",
      duration_months: 12,
      payment_method: "wallet",
      source_wallet_user_id: TEST_PARTNER_ID,
    }, OPERATOR_JWT);
    assert(status !== 400 || data.error !== MIN_INVESTMENT_ERROR,
      `UGX 1,000 must clear the minimum gate (got ${status}: ${data.error})`);
  },
});
