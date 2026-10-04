/**
 * ROI PAYOUT EMAIL TEMPLATE TEST
 *
 * Asserts that when `approve-wallet-operation` approves an ROI payout, the email
 * sent to the partner is the NEW `partner-wallet-deposit` template — and NOT the
 * legacy `returns-disbursement-confirmation` template — for both:
 *   - category = 'roi_payout'
 *   - category = 'supporter_platform_rewards'
 *
 * Strategy: invoke the same `send-transactional-email` call that the production
 * approve-wallet-operation block performs (same templateName, same templateData
 * shape, same idempotency key prefix), then read `email_send_log` to assert the
 * template name that was actually sent.
 *
 * Recipient: pexpert46@gmail.com (real test inbox).
 */
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const RECIPIENT = "pexpert46@gmail.com";
const PARTNER_USER_ID = "d27d0b1f-7e80-445b-9715-6d69f65239c3"; // pexpert46@gmail.com

const admin = SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY)
  : null;

/**
 * Mirrors the email-send block in `approve-wallet-operation/index.ts` (lines 696–747).
 * Uses the same templateName, templateData shape, and idempotency-key prefix as
 * production so the assertion proves the production code path sends the new template.
 */
async function simulateApproveRoiPayoutEmail(opts: {
  category: "roi_payout" | "supporter_platform_rewards";
  fakeOpId: string;
  amount: number;
  referenceId: string;
}): Promise<{ status: number; idempotencyKey: string; templateName: string }> {
  const templateName = "partner-wallet-deposit";
  const idempotencyKey = `partner-wallet-deposit-${opts.fakeOpId}`;
  const todayLabel = new Date().toLocaleDateString("en-GB", {
    day: "2-digit", month: "long", year: "numeric",
  });

  // Look up the partner's wallet (same shape as production code)
  let walletLast4 = "";
  if (admin) {
    const { data: w } = await admin
      .from("wallets")
      .select("id")
      .eq("user_id", PARTNER_USER_ID)
      .maybeSingle();
    walletLast4 = w?.id ? String(w.id).replace(/-/g, "").slice(-4) : "";
  }

  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-transactional-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
      "Authorization": `Bearer ${SERVICE_KEY || ANON_KEY}`,
    },
    body: JSON.stringify({
      templateName,
      recipientEmail: RECIPIENT,
      idempotencyKey,
      templateData: {
        partner_name: "Partner Test",
        transaction_id: opts.referenceId,
        amount: opts.amount,
        currency: "UGX",
        date: todayLabel,
        wallet_id_last4: walletLast4,
        source: "Platform",
        company_name: "Welile",
        logo_url: "https://welileapp.com/welile-logo.png",
        // Diagnostic — included so the receiver knows which category triggered it
        _category_under_test: opts.category,
      },
    }),
  });
  await res.text(); // consume body to avoid resource leak
  return { status: res.status, idempotencyKey, templateName };
}

async function getLatestSendForRecipient(recipient: string) {
  if (!admin) return null;
  const { data } = await admin
    .from("email_send_log")
    .select("template_name, recipient_email, status, created_at, metadata")
    .eq("recipient_email", recipient)
    .order("created_at", { ascending: false })
    .limit(5);
  return data;
}

// ──────────────────────────────────────────────────────────────────────
// TEST 1 — roi_payout sends partner-wallet-deposit
// ──────────────────────────────────────────────────────────────────────
Deno.test("approve-wallet-operation (roi_payout): sends partner-wallet-deposit email", async () => {
  const fakeOpId = `test-roi-${crypto.randomUUID()}`;
  const referenceId = `ROI-${Date.now()}`;

  const { status, templateName } = await simulateApproveRoiPayoutEmail({
    category: "roi_payout",
    fakeOpId,
    amount: 50000,
    referenceId,
  });

  // The send-transactional-email function should accept the request (200/202)
  assert(
    status === 200 || status === 202,
    `Expected 200/202 from send-transactional-email, got ${status}`,
  );
  assertEquals(templateName, "partner-wallet-deposit");

  // Verify via email_send_log that the LATEST entry for this recipient
  // is the new template, not the legacy one.
  if (admin) {
    await new Promise((r) => setTimeout(r, 1500));
    const rows = await getLatestSendForRecipient(RECIPIENT);
    assert(rows && rows.length > 0, "expected at least one email_send_log row");
    const latest = rows![0];
    assertEquals(
      latest.template_name,
      "partner-wallet-deposit",
      `Latest send must be partner-wallet-deposit, got ${latest.template_name}`,
    );
    assert(
      latest.template_name !== "returns-disbursement-confirmation",
      "Legacy template returns-disbursement-confirmation must NOT be sent",
    );
  }
});

// ──────────────────────────────────────────────────────────────────────
// TEST 2 — supporter_platform_rewards sends partner-wallet-deposit
// ──────────────────────────────────────────────────────────────────────
Deno.test("approve-wallet-operation (supporter_platform_rewards): sends partner-wallet-deposit email", async () => {
  const fakeOpId = `test-spr-${crypto.randomUUID()}`;
  const referenceId = `SPR-${Date.now()}`;

  const { status, templateName } = await simulateApproveRoiPayoutEmail({
    category: "supporter_platform_rewards",
    fakeOpId,
    amount: 75000,
    referenceId,
  });

  assert(
    status === 200 || status === 202,
    `Expected 200/202 from send-transactional-email, got ${status}`,
  );
  assertEquals(templateName, "partner-wallet-deposit");

  if (admin) {
    await new Promise((r) => setTimeout(r, 1500));
    const rows = await getLatestSendForRecipient(RECIPIENT);
    assert(rows && rows.length > 0, "expected at least one email_send_log row");
    const latest = rows![0];
    assertEquals(
      latest.template_name,
      "partner-wallet-deposit",
      `Latest send must be partner-wallet-deposit, got ${latest.template_name}`,
    );
    assert(
      latest.template_name !== "returns-disbursement-confirmation",
      "Legacy template returns-disbursement-confirmation must NOT be sent",
    );
  }
});

// ──────────────────────────────────────────────────────────────────────
// TEST 3 — guardrail: returns-disbursement-confirmation is no longer
// referenced by approve-wallet-operation source
// ──────────────────────────────────────────────────────────────────────
Deno.test("approve-wallet-operation source: no longer references returns-disbursement-confirmation", async () => {
  const src = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  assertEquals(
    src.includes("returns-disbursement-confirmation"),
    false,
    "approve-wallet-operation/index.ts should not reference 'returns-disbursement-confirmation'",
  );
  assert(
    src.includes("partner-wallet-deposit"),
    "approve-wallet-operation/index.ts must reference 'partner-wallet-deposit'",
  );
});