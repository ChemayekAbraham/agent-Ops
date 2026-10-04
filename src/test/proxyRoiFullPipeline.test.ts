import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";

/**
 * END-TO-END pipeline test for ROI payouts routed through a MANAGED PROXY:
 *
 *   ┌─────────────────────┐   ┌──────────────┐   ┌──────────────────────┐
 *   │ Partner Ops sends   │ → │ COO approves │ → │ CFO sends the ROI    │
 *   │ Payout (queues row) │   │ (gates row)  │   │ payout (ledger post) │
 *   └─────────────────────┘   └──────────────┘   └──────────┬───────────┘
 *                                                            ▼
 *                                          Proxy agent's wallet is credited
 *                                          (NEVER the proxy partner's wallet)
 *                                                            │
 *                          ┌─────────────────────────────────┘
 *                          ▼
 *   ┌─────────────────────────────┐   ┌─────────────────────────────┐
 *   │ Proxy agent submits         │ → │ Fin Ops approves withdrawal │
 *   │ "Proxy payout delivery for  │   │ → wallet leg debits the     │
 *   │  <partner>" withdrawal      │   │ AGENT's wallet, tagged with │
 *   └─────────────────────────────┘   │ linked_party = partner       │
 *                                     └─────────────────────────────┘
 *
 * Fixture used here = production data:
 *   - Partner: SSENKAALI PIUS (portfolio WIP2604226578)
 *     id    = 0b109aad-212a-4fd0-ab03-3d7aee9cf397
 *     email = pexpert46@gmail.com
 *   - Active managed proxy: LUKODDA JOSEPH
 *     id    = b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c
 *     email = 256751424629@welile.user
 *
 * AIM (must all hold simultaneously):
 *   ✓ money goes to the proxy agent wallet (not the proxy partner)
 *   ✓ partner + proxy emails dispatched
 *   ✓ financial statements balance (Σcash_in == Σcash_out)
 *   ✓ after Fin Ops approval the money leaves the AGENT's wallet
 *     (and the partner wallet is still untouched)
 */

const PARTNER_ID = "0b109aad-212a-4fd0-ab03-3d7aee9cf397"; // SSENKAALI PIUS
const PARTNER_NAME = "SSENKAALI PIUS";
const PARTNER_EMAIL = "pexpert46@gmail.com";
const PROXY_ID = "b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c";   // LUKODDA JOSEPH
const PROXY_NAME = "LUKODDA JOSEPH";
const PROXY_EMAIL = "256751424629@welile.user";
const RR_ID = "rr-ssenkaali-1";
const PAYMENT_NUMBER = 4;
const ROI_AMOUNT = 200_000;
const WITHDRAWAL_ID = "wr-proxy-1";
const PORTFOLIO_CODE = "WIP2604226578";

const APPROVE_CTX = {
  agentEmail: PROXY_EMAIL,
  agentName: PROXY_NAME,
  partnerEmail: PARTNER_EMAIL,
  partnerName: PARTNER_NAME,
  portfolioCode: PORTFOLIO_CODE,
};

type LedgerEntry = {
  user_id: string;
  direction: "cash_in" | "cash_out";
  amount: number;
  category: string;
  ledger_scope: "wallet" | "platform";
  linked_party?: string;
  description?: string;
  source_table?: string;
  source_id?: string;
};

interface PayoutQueueRow {
  id: string;
  partner_id: string;
  amount: number;
  status:
    | "queued_by_partner_ops"
    | "coo_approved"
    | "cfo_sent"
    | "rejected";
  partner_ops_by?: string;
  coo_approved_by?: string;
  cfo_sent_by?: string;
}

interface WithdrawalRequest {
  id: string;
  user_id: string;        // owner = proxy PARTNER for v2 visibility/holds
  agent_id?: string;      // funding proxy AGENT
  initiated_by?: string;  // funding proxy AGENT audit trail
  beneficiary_id?: string;
  proxy_partner_id?: string;
  linked_party?: string | null;
  amount: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  payment_method: string;
  reference: string;
}

interface World {
  ledger: LedgerEntry[];
  notifications: Array<{ user_id: string; title: string; metadata?: any }>;
  emails: Array<{ templateName: string; recipientEmail: string; templateData?: any }>;
  payoutQueue: PayoutQueueRow[];
  withdrawals: WithdrawalRequest[];
}

function freshWorld(): World {
  return {
    ledger: [],
    notifications: [],
    emails: [],
    payoutQueue: [],
    withdrawals: [],
  };
}

/** Sum cash_in − cash_out, scoped + optionally per-user. */
function netWallet(world: World, userId: string): number {
  return world.ledger
    .filter((e) => e.ledger_scope === "wallet" && e.user_id === userId)
    .reduce((s, e) => s + (e.direction === "cash_in" ? e.amount : -e.amount), 0);
}

function netPlatform(world: World): number {
  return world.ledger
    .filter((e) => e.ledger_scope === "platform")
    .reduce((s, e) => s + (e.direction === "cash_in" ? e.amount : -e.amount), 0);
}

/** Σ cash_in MUST equal Σ cash_out across the entire ledger. */
function isBalanced(world: World): boolean {
  const totalIn = world.ledger
    .filter((e) => e.direction === "cash_in")
    .reduce((s, e) => s + e.amount, 0);
  const totalOut = world.ledger
    .filter((e) => e.direction === "cash_out")
    .reduce((s, e) => s + e.amount, 0);
  return totalIn === totalOut;
}

// ────────────────────────────────────────────────────────────────────
// Pipeline stage simulators (mirror real production functions)
// ────────────────────────────────────────────────────────────────────

/** STAGE 1 — Partner Ops queues a payout for the partner. */
function partnerOpsQueuePayout(
  world: World,
  args: { partnerId: string; amount: number; staffId: string },
): PayoutQueueRow {
  const row: PayoutQueueRow = {
    id: `queue-${world.payoutQueue.length + 1}`,
    partner_id: args.partnerId,
    amount: args.amount,
    status: "queued_by_partner_ops",
    partner_ops_by: args.staffId,
  };
  world.payoutQueue.push(row);
  return row;
}

/** STAGE 2 — COO approves the queued payout. */
function cooApprovePayout(world: World, queueId: string, cooId: string) {
  const row = world.payoutQueue.find((r) => r.id === queueId);
  if (!row) throw new Error(`queue row ${queueId} not found`);
  if (row.status !== "queued_by_partner_ops") {
    throw new Error(`cannot approve row in status ${row.status}`);
  }
  row.status = "coo_approved";
  row.coo_approved_by = cooId;
}

/**
 * STAGE 3 — CFO sends the ROI payout. This is exactly the
 * `process-supporter-roi` managed-proxy branch: wallet leg → proxy agent,
 * platform leg → partner. Two notifications + two emails dispatch.
 */
function cfoSendRoiPayout(
  world: World,
  args: {
    queueId: string;
    cfoId: string;
    rr: { id: string; supporter_id: string; rent_amount: number };
    roiAmount: number;
    paymentNumber: number;
    managedProxy: { agentId: string; agentName: string; agentEmail: string; assignmentId: string };
    partner: { id: string; name: string; email: string };
  },
) {
  const row = world.payoutQueue.find((r) => r.id === args.queueId);
  if (!row) throw new Error("queue row missing");
  if (row.status !== "coo_approved") {
    throw new Error(`CFO cannot send before COO approval (status=${row.status})`);
  }
  const { rr, roiAmount, paymentNumber, managedProxy, partner } = args;

  // Wallet credit goes to proxy AGENT — never the partner.
  world.ledger.push(
    {
      user_id: partner.id,
      direction: "cash_out",
      amount: roiAmount,
      category: "roi_expense",
      ledger_scope: "platform",
      source_table: "supporter_roi_payments",
      source_id: rr.id,
      description: `Platform ROI payout #${paymentNumber}`,
    },
    {
      user_id: managedProxy.agentId,
      direction: "cash_in",
      amount: roiAmount,
      category: "roi_wallet_credit",
      ledger_scope: "wallet",
      source_table: "supporter_roi_payments",
      source_id: rr.id,
      linked_party: "platform",
      description: `Proxy payout on behalf of partner ${partner.id} (managed by ${managedProxy.agentName})`,
    },
  );

  // Notifications
  world.notifications.push({
    user_id: partner.id,
    title: "💰 Monthly Reward Sent to Your Proxy Agent",
    metadata: {
      rent_request_id: rr.id,
      routed_to_proxy_agent_id: managedProxy.agentId,
      proxy_assignment_id: managedProxy.assignmentId,
    },
  });
  world.notifications.push({
    user_id: managedProxy.agentId,
    title: "🤝 Proxy Payout Received",
    metadata: {
      rent_request_id: rr.id,
      on_behalf_of_partner_id: partner.id,
      proxy_assignment_id: managedProxy.assignmentId,
    },
  });

  // Emails
  world.emails.push({
    templateName: "returns-disbursement-confirmation",
    recipientEmail: partner.email,
    templateData: {
      partner_name: partner.name,
      amount: roiAmount,
      is_managed_by_agent: true,
      agent_name: managedProxy.agentName,
      payout_method: `Proxy Agent Wallet (${managedProxy.agentName})`,
    },
  });
  world.emails.push({
    templateName: "proxy-managed-payout-notice",
    recipientEmail: managedProxy.agentEmail,
    templateData: {
      agent_name: managedProxy.agentName,
      partner_name: partner.name,
      amount: roiAmount,
    },
  });

  row.status = "cfo_sent";
  row.cfo_sent_by = args.cfoId;
}

/**
 * STAGE 4 — The proxy agent submits a withdrawal request to deliver the
 * money to the partner. Status stays "pending" until Fin Ops approves;
 * no ledger movement yet.
 */
function proxyAgentSubmitWithdrawal(
  world: World,
  args: {
    agentId: string;
    partnerId: string;
    partnerName: string;
    amount: number;
    paymentMethod: string;
    reference: string;
  },
): WithdrawalRequest {
  const wr: WithdrawalRequest = {
    id: WITHDRAWAL_ID,
    user_id: args.partnerId,
    agent_id: args.agentId,
    initiated_by: args.agentId,
    beneficiary_id: args.partnerId,
    proxy_partner_id: args.partnerId,
    linked_party: null,
    amount: args.amount,
    reason: `[Proxy initiated by agent ${args.agentId}] Proxy payout delivery for ${args.partnerName}`,
    status: "pending",
    payment_method: args.paymentMethod,
    reference: args.reference,
  };
  world.withdrawals.push(wr);
  return wr;
}

/**
 * STAGE 5 — Fin Ops approves the withdrawal. Mirrors `approve-withdrawal`
 * for an `isProxyPayout=true` row: debits the AGENT's withdrawable bucket,
 * tags the entry with `linked_party = partner`, flips status to approved,
 * and — exactly like production — dispatches the
 * `returns-disbursement-confirmation` email to BOTH:
 *   • the proxy PARTNER (beneficiary) with is_managed_by_agent=true
 *   • the proxy AGENT (funder) with a "Proxy payout for <partner>" payout_method
 * See supabase/functions/approve-withdrawal/index.ts lines 1175–1213.
 */
function finOpsApproveWithdrawal(
  world: World,
  withdrawalId: string,
  finOpsId: string,
  ctx: {
    agentEmail: string;
    agentName: string;
    partnerEmail: string;
    partnerName: string;
    portfolioCode: string;
  },
) {
  const wr = world.withdrawals.find((w) => w.id === withdrawalId);
  if (!wr) throw new Error("withdrawal not found");
  if (wr.status !== "pending") {
    throw new Error(`already in status ${wr.status}`);
  }
  const isProxyPayout = !!wr.proxy_partner_id || !!wr.agent_id || wr.reason.includes("Proxy payout delivery for");
  const fundingUserId = isProxyPayout ? (wr.agent_id || wr.initiated_by || wr.user_id) : wr.user_id;
  const beneficiaryUserId = isProxyPayout ? (wr.proxy_partner_id || wr.beneficiary_id || wr.user_id) : wr.user_id;

  // Available withdrawable for the funding wallet = sum of its wallet legs so far.
  const agentAvailable = netWallet(world, fundingUserId);
  if (agentAvailable < wr.amount) {
    throw new Error(
      `Insufficient proxy agent wallet balance. Available UGX ${agentAvailable}, requested UGX ${wr.amount}`,
    );
  }

  // Wallet debit on the AGENT (funder), tagged to the partner.
  world.ledger.push({
    user_id: fundingUserId, // agent — NEVER partner
    direction: "cash_out",
    amount: wr.amount,
    category: "wallet_withdrawal",
    ledger_scope: "wallet",
    linked_party: beneficiaryUserId, // partner
    source_table: "withdrawal_requests",
    source_id: wr.id,
    description: `Proxy partner payout from withdrawable – ${wr.payment_method} ref: ${wr.reference.toUpperCase()}`,
  });
  // Platform offset — money has left the platform.
  world.ledger.push({
    user_id: fundingUserId,
    direction: "cash_in",
    amount: wr.amount,
    category: "wallet_withdrawal_offset",
    ledger_scope: "platform",
    linked_party: beneficiaryUserId,
    source_table: "withdrawal_requests",
    source_id: wr.id,
  });

  wr.status = "approved";

  world.notifications.push({
    user_id: wr.user_id,
    title: "✅ Withdrawal Paid",
    metadata: { withdrawal_id: wr.id, approved_by: finOpsId },
  });

  // ── Disbursement Confirmed emails (real production behaviour) ──────────
  // 1) PARTNER (beneficiary) — is_managed_by_agent flag set, agent named.
  world.emails.push({
    templateName: "returns-disbursement-confirmation",
    recipientEmail: ctx.partnerEmail,
    templateData: {
      partner_name: ctx.partnerName,
      partner_id: beneficiaryUserId,
      amount: wr.amount,
      transaction_id: wr.reference.toUpperCase(),
      portfolio_code: ctx.portfolioCode,
      payout_method: `${wr.payment_method} — via Proxy Agent`,
      is_managed_by_agent: true,
      agent_name: ctx.agentName,
    },
  });
  // 2) PROXY AGENT (funder) — same template, payout_method names the partner.
  world.emails.push({
    templateName: "returns-disbursement-confirmation",
    recipientEmail: ctx.agentEmail,
    templateData: {
      partner_name: ctx.agentName,
      partner_id: fundingUserId,
      amount: wr.amount,
      transaction_id: wr.reference.toUpperCase(),
      portfolio_code: ctx.portfolioCode,
      payout_method: `${wr.payment_method} — Proxy payout for ${ctx.partnerName}`,
      is_managed_by_agent: true,
      agent_name: ctx.agentName,
    },
  });
}

// ────────────────────────────────────────────────────────────────────
// The actual end-to-end test
// ────────────────────────────────────────────────────────────────────

describe("ROI payout full pipeline · Partner Ops → COO → CFO → Proxy Withdraw → Fin Ops", () => {
  let world: World;
  const managedProxy = {
    agentId: PROXY_ID,
    agentName: PROXY_NAME,
    agentEmail: PROXY_EMAIL,
    assignmentId: "active-assignment-1",
  };
  const partner = { id: PARTNER_ID, name: PARTNER_NAME, email: PARTNER_EMAIL };

  beforeEach(() => {
    world = freshWorld();
  });

  it("runs the full pipeline and satisfies every AIM", async () => {
    // ── STAGE 1: Partner Ops queues the payout ──────────────────────────
    const queue = partnerOpsQueuePayout(world, {
      partnerId: PARTNER_ID,
      amount: ROI_AMOUNT,
      staffId: "partner-ops-1",
    });
    expect(queue.status).toBe("queued_by_partner_ops");
    // Nothing should have hit the ledger yet.
    expect(world.ledger).toHaveLength(0);

    // ── STAGE 2: COO approves ───────────────────────────────────────────
    cooApprovePayout(world, queue.id, "coo-1");
    expect(queue.status).toBe("coo_approved");
    expect(world.ledger).toHaveLength(0);

    // Pipeline guard: CFO MUST refuse to send before COO approval.
    const queue2 = partnerOpsQueuePayout(world, {
      partnerId: PARTNER_ID, amount: 1, staffId: "partner-ops-1",
    });
    expect(() =>
      cfoSendRoiPayout(world, {
        queueId: queue2.id,
        cfoId: "cfo-1",
        rr: { id: "rr-x", supporter_id: PARTNER_ID, rent_amount: 1 },
        roiAmount: 1,
        paymentNumber: 1,
        managedProxy,
        partner,
      }),
    ).toThrow(/COO approval/);

    // ── STAGE 3: CFO sends the ROI payout ───────────────────────────────
    cfoSendRoiPayout(world, {
      queueId: queue.id,
      cfoId: "cfo-1",
      rr: { id: RR_ID, supporter_id: PARTNER_ID, rent_amount: 1_500_000 },
      roiAmount: ROI_AMOUNT,
      paymentNumber: PAYMENT_NUMBER,
      managedProxy,
      partner,
    });
    expect(queue.status).toBe("cfo_sent");

    // AIM #1 — money lands in the proxy agent's wallet, NEVER the partner.
    expect(netWallet(world, PROXY_ID)).toBe(ROI_AMOUNT);
    expect(netWallet(world, PARTNER_ID)).toBe(0);
    const partnerWalletLegs = world.ledger.filter(
      (e) => e.ledger_scope === "wallet" && e.user_id === PARTNER_ID,
    );
    expect(partnerWalletLegs).toHaveLength(0);

    // AIM #2 — both ROI emails dispatched.
    expect(world.emails.find((e) => e.templateName === "returns-disbursement-confirmation"))
      .toMatchObject({
        recipientEmail: PARTNER_EMAIL,
        templateData: { is_managed_by_agent: true, agent_name: PROXY_NAME },
      });
    expect(world.emails.find((e) => e.templateName === "proxy-managed-payout-notice"))
      .toMatchObject({ recipientEmail: PROXY_EMAIL });

    // AIM #3 — financial statements balance after CFO post.
    expect(isBalanced(world)).toBe(true);
    expect(netPlatform(world)).toBe(-ROI_AMOUNT); // platform recognised the expense

    // ── STAGE 4: Proxy agent submits the withdrawal to deliver to partner
    const wr = proxyAgentSubmitWithdrawal(world, {
      agentId: PROXY_ID,
      partnerId: PARTNER_ID,
      partnerName: PARTNER_NAME,
      amount: ROI_AMOUNT,
      paymentMethod: "MoMo",
      reference: "REF-PIUS-001",
    });
    expect(wr.status).toBe("pending");
    expect(wr.user_id).toBe(PARTNER_ID);     // owner/beneficiary = partner
    expect(wr.agent_id).toBe(PROXY_ID);      // funding wallet = agent
    expect(wr.proxy_partner_id).toBe(PARTNER_ID);
    expect(wr.linked_party).toBeNull();
    expect(wr.reason).toContain("Proxy payout delivery for");
    // No new ledger rows on submit.
    expect(world.ledger.length).toBe(2);

    // ── STAGE 5: Fin Ops approves the withdrawal ────────────────────────
    finOpsApproveWithdrawal(world, wr.id, "finops-1", APPROVE_CTX);
    expect(wr.status).toBe("approved");

    // AIM #4 — money deducted from the AGENT's wallet, not the partner.
    expect(netWallet(world, PROXY_ID)).toBe(0);   // ROI in, ROI out
    expect(netWallet(world, PARTNER_ID)).toBe(0); // never touched at all
    const agentDebit = world.ledger.find(
      (e) =>
        e.ledger_scope === "wallet" &&
        e.direction === "cash_out" &&
        e.category === "wallet_withdrawal",
    );
    expect(agentDebit).toBeDefined();
    expect(agentDebit!.user_id).toBe(PROXY_ID);
    expect(agentDebit!.linked_party).toBe(PARTNER_ID); // earmarked to partner

    // AIM #2 (Fin Ops stage) — the Disbursement Confirmed email is sent to
    // BOTH the proxy PARTNER (beneficiary) and the proxy AGENT (funder).
    // This mirrors approve-withdrawal/index.ts lines 1175–1213.
    const disbursementEmails = world.emails.filter(
      (e) => e.templateName === "returns-disbursement-confirmation",
    );
    // 1 from CFO send (partner) + 2 from Fin Ops approval (partner + agent) = 3.
    expect(disbursementEmails).toHaveLength(3);

    const finalPartnerEmail = disbursementEmails.at(-2)!;
    const finalAgentEmail = disbursementEmails.at(-1)!;
    expect(finalPartnerEmail).toMatchObject({
      recipientEmail: PARTNER_EMAIL,
      templateData: {
        is_managed_by_agent: true,
        agent_name: PROXY_NAME,
        portfolio_code: PORTFOLIO_CODE,
        amount: ROI_AMOUNT,
      },
    });
    expect(finalPartnerEmail.templateData.payout_method).toMatch(/via Proxy Agent/);
    expect(finalAgentEmail).toMatchObject({
      recipientEmail: PROXY_EMAIL,
      templateData: { is_managed_by_agent: true, agent_name: PROXY_NAME },
    });
    expect(finalAgentEmail.templateData.payout_method)
      .toMatch(new RegExp(`Proxy payout for ${PARTNER_NAME}`));

    // AIM #3 again — financial statements still balance end-to-end.
    expect(isBalanced(world)).toBe(true);
    // Net platform after withdrawal = -ROI (expense) + ROI (cash out offset) = 0.
    expect(netPlatform(world)).toBe(0);

    // Sanity: the entire 4-leg journey, in order.
    expect(world.ledger.map((e) => `${e.ledger_scope}:${e.direction}:${e.user_id === PROXY_ID ? "AGENT" : "PARTNER"}`))
      .toEqual([
        "platform:cash_out:PARTNER", // CFO ROI expense
        "wallet:cash_in:AGENT",      // CFO ROI credit → proxy agent
        "wallet:cash_out:AGENT",     // Fin Ops debit → proxy agent
        "platform:cash_in:AGENT",    // platform offset
      ]);
  });

  it("Fin Ops cannot approve if the agent's wallet lacks the funds (proxy partner not pre-funded)", () => {
    // No CFO payout happened first → agent has zero balance.
    const wr = proxyAgentSubmitWithdrawal(world, {
      agentId: PROXY_ID,
      partnerId: PARTNER_ID,
      partnerName: PARTNER_NAME,
      amount: ROI_AMOUNT,
      paymentMethod: "MoMo",
      reference: "REF-X",
    });
    expect(() =>
      finOpsApproveWithdrawal(world, wr.id, "finops-1", APPROVE_CTX),
    ).toThrow(/Insufficient proxy agent wallet balance/);
    expect(wr.status).toBe("pending");
    expect(world.ledger).toHaveLength(0);
  });

  it("regression: the partner wallet is NEVER credited or debited at any pipeline stage", async () => {
    const queue = partnerOpsQueuePayout(world, {
      partnerId: PARTNER_ID, amount: ROI_AMOUNT, staffId: "partner-ops-1",
    });
    cooApprovePayout(world, queue.id, "coo-1");
    cfoSendRoiPayout(world, {
      queueId: queue.id, cfoId: "cfo-1",
      rr: { id: RR_ID, supporter_id: PARTNER_ID, rent_amount: 1_000_000 },
      roiAmount: ROI_AMOUNT, paymentNumber: PAYMENT_NUMBER,
      managedProxy, partner,
    });
    const wr = proxyAgentSubmitWithdrawal(world, {
      agentId: PROXY_ID, partnerId: PARTNER_ID, partnerName: PARTNER_NAME,
      amount: ROI_AMOUNT, paymentMethod: "MoMo", reference: "REF-Z",
    });
    finOpsApproveWithdrawal(world, wr.id, "finops-1", APPROVE_CTX);

    const partnerWalletLegs = world.ledger.filter(
      (e) => e.ledger_scope === "wallet" && e.user_id === PARTNER_ID,
    );
    expect(partnerWalletLegs).toHaveLength(0);
    // And the partner's net wallet is exactly zero.
    expect(netWallet(world, PARTNER_ID)).toBe(0);
  });
});

/**
 * Source guards — pin the real edge function so a future refactor that
 * breaks the pipeline contract fails this suite.
 */
describe("source guards · approve-withdrawal proxy debit contract", () => {
  const src = readFileSync("supabase/functions/approve-withdrawal/index.ts", "utf8");

  it("recognises proxy payouts via the 'Proxy payout delivery for' reason prefix", () => {
    expect(src).toMatch(/['"]Proxy payout delivery for['"]/);
  });

  it("debits the funding user (proxy agent) with wallet_withdrawal category", () => {
    expect(src).toMatch(/category:\s*['"]wallet_withdrawal['"]/);
    expect(src).toMatch(/user_id:\s*fundingUserId/);
  });

  it("does not let a stale cached wallet veto Fin Ops proxy approval", () => {
    expect(src).toMatch(/const totalSpendable\s*=\s*ledgerAvailable/);
    expect(src).not.toMatch(/isProxyPayout[\s\S]{0,120}Math\.min\(cachedSpendable, ledgerAvailable\)/);
  });

  it("tags the debit leg with linked_party = beneficiary partner", () => {
    expect(src).toMatch(/linked_party:\s*isProxyPayout\s*\?/);
  });

  it("dispatches Disbursement Confirmed (returns-disbursement-confirmation) to the PARTNER on Fin Ops approval", () => {
    expect(src).toMatch(/buildReturnsDisbursementRequest\(\{[\s\S]*recipientEmail:\s*partnerProfile\.email/);
    expect(src).toMatch(/isManagedByAgent:\s*isProxyPayout\s*&&\s*fundingUserId\s*!==\s*partnerId/);
  });

  it("ALSO dispatches Disbursement Confirmed to the PROXY AGENT in the same flow", () => {
    // The second buildReturnsDisbursementRequest call recipients agentEmail
    // and tags payout_method with "Proxy payout for".
    const agentBlockRe =
      /buildReturnsDisbursementRequest\(\{[\s\S]*?recipientEmail:\s*agentEmail[\s\S]*?payoutMethod:\s*`[^`]*Proxy payout for/;
    expect(src).toMatch(agentBlockRe);
  });

  it("only sends the Disbursement Confirmed email for genuine proxy ROI payouts (guarded)", () => {
    // The send is skipped for self-withdrawals and non-ROI-backed withdrawals.
    expect(src).toMatch(/Skipping returns-disbursement email: not a proxy payout/);
    expect(src).toMatch(/has no investor portfolio/);
    expect(src).toMatch(/has no ROI ledger credits/);
  });
});