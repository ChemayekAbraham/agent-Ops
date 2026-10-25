import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";

/**
 * Rent-facilitation reward for a partner under a managed proxy — automated tests
 *
 * CONTRACT (CFO decision, 25 Oct 2026): the reward is credited to the PARTNER'S OWN wallet. The managed proxy agent
 * is notified and delivers it later by initiating a withdrawal from the partner's wallet. (Portfolio Returns are
 * different: their approval credits the proxy agent's wallet. That path is not tested here.)
 *
 * How the contract holds in production:
 *   - process-supporter-roi posts every reward through ONE database call, post_rent_facilitation_reward
 *     (migration 20261024170000). The call takes no recipient: the database credits the rent request's supporter.
 *   - The wallet leg carries linked_party 'platform'. The production trigger trg_enforce_managed_proxy_roi_routing
 *     only enforces proxy routing when linked_party is a partner uuid, so it leaves this credit on the partner's
 *     wallet (verified read-only against production: every rent-reward credit since June landed on the partner;
 *     0 routing violations recorded).
 *
 * Real-world fixture mirroring production:
 *   - Partner: SSENKAALI PIUS (portfolio WIP2604226578)
 *   - Active + approved + managed proxy: LUKODDA JOSEPH
 *   - Stale (is_active=false) proxy that must NOT be picked: ATUHAIRE CAROLYNE
 *
 * The behavioural tests mirror the edge function's reward loop; the source guards pin the real edge function and the
 * migration so a change to either that breaks the contract fails this suite.
 */

const PARTNER_ID = "0b109aad-212a-4fd0-ab03-3d7aee9cf397"; // SSENKAALI PIUS
const PARTNER_NAME = "SSENKAALI PIUS";
const PARTNER_EMAIL = "pexpert46@gmail.com";
const ACTIVE_PROXY_ID = "b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c"; // LUKODDA JOSEPH
const ACTIVE_PROXY_NAME = "LUKODDA JOSEPH";
const ACTIVE_PROXY_EMAIL = "256751424629@welile.user";
const STALE_PROXY_ID = "ae194750-4827-47e8-839e-5e772565138b"; // ATUHAIRE CAROLYNE (is_active=false)
const RR_ID = "rr-ssenkaali-1";
const PAYMENT_NUMBER = 3;
const ROI_AMOUNT = 150_000;

type Row = Record<string, any>;

/** Fixture rows mirroring production. */
const FIXTURE = {
  proxy_agent_assignments: [
    {
      id: "stale-1",
      agent_id: STALE_PROXY_ID,
      beneficiary_id: PARTNER_ID,
      is_active: false,
      approval_status: "approved",
      is_managed_account: true,
      created_at: "2026-04-01T00:00:00Z",
    },
    {
      id: "active-1",
      agent_id: ACTIVE_PROXY_ID,
      beneficiary_id: PARTNER_ID,
      is_active: true,
      approval_status: "approved",
      is_managed_account: true,
      created_at: "2026-05-01T00:00:00Z",
    },
  ] as Row[],
  profiles: [
    { id: PARTNER_ID, full_name: PARTNER_NAME, email: PARTNER_EMAIL },
    { id: ACTIVE_PROXY_ID, full_name: ACTIVE_PROXY_NAME, email: ACTIVE_PROXY_EMAIL },
    { id: STALE_PROXY_ID, full_name: "ATUHAIRE CAROLYNE", email: "atuhairecarol78@gmail.com" },
  ] as Row[],
  wallets: [
    { id: "11111111-1111-1111-1111-111111111aaa", user_id: PARTNER_ID },
    { id: "22222222-2222-2222-2222-222222222bbb", user_id: ACTIVE_PROXY_ID },
  ] as Row[],
};

/** Captured side effects we assert against. */
interface Captured {
  rpcCalls: Array<{ fn: string; args: any }>;
  notifications: any[];
  emails: any[];
}

function makeSupabaseMock(captured: Captured) {
  function tableBuilder(table: keyof typeof FIXTURE | string) {
    const filters: Array<[string, unknown]> = [];
    let orderApplied = false;
    let limitApplied: number | null = null;
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn((c: string, v: unknown) => {
        filters.push([c, v]);
        return builder;
      }),
      order: vi.fn(() => {
        orderApplied = true;
        return builder;
      }),
      limit: vi.fn((n: number) => {
        limitApplied = n;
        return builder;
      }),
      maybeSingle: vi.fn(async () => {
        const rows = (FIXTURE as any)[table] ?? [];
        const filtered = rows.filter((r: Row) =>
          filters.every(([c, v]) => r[c] === v),
        );
        // honour DESC created_at when ordered
        const sorted = orderApplied
          ? [...filtered].sort((a, b) =>
              String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
            )
          : filtered;
        const sliced = limitApplied != null ? sorted.slice(0, limitApplied) : sorted;
        return { data: sliced[0] ?? null, error: null };
      }),
      insert: vi.fn(async (payload: any) => {
        if (table === "notifications") {
          const items = Array.isArray(payload) ? payload : [payload];
          captured.notifications.push(...items);
        }
        return { data: null, error: null };
      }),
    };
    return builder;
  }

  return {
    from: vi.fn((table: string) => tableBuilder(table)),
    rpc: vi.fn(async (fn: string, args: any) => {
      captured.rpcCalls.push({ fn, args });
      if (fn === "post_rent_facilitation_reward") {
        return { data: { status: "posted", mode: "wallet", amount: ROI_AMOUNT, payment_number: args.p_payment_number }, error: null };
      }
      return { data: null, error: null };
    }),
  };
}

/** Mirrors `resolveManagedProxy` in supabase/functions/_shared/partnership-emails.ts */
async function resolveManagedProxy(supabase: any, partnerId: string) {
  if (!partnerId) return null;
  const { data: assignment } = await supabase
    .from("proxy_agent_assignments")
    .select("id, agent_id, is_managed_account, is_active, approval_status")
    .eq("beneficiary_id", partnerId)
    .eq("is_active", true)
    .eq("is_managed_account", true)
    .eq("approval_status", "approved")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!assignment) return null;
  const { data: agentProfile } = await supabase
    .from("profiles")
    .select("id, full_name, email")
    .eq("id", assignment.agent_id)
    .maybeSingle();
  return {
    assignmentId: assignment.id,
    agentId: assignment.agent_id,
    agentName: agentProfile?.full_name ?? null,
    agentEmail: agentProfile?.email ?? null,
  };
}

/**
 * Mirrors the wallet-credit path of the process-supporter-roi reward loop: resolve the proxy (for the description and
 * the notices only), post through post_rent_facilitation_reward, then notify and email only after it posted.
 */
async function runRewardPayout(
  supabase: any,
  rr: { id: string; supporter_id: string; rent_amount: number },
  roiAmount: number,
  paymentNumber: number,
  dispatch: (req: any) => void,
) {
  const managedProxy = await resolveManagedProxy(supabase, rr.supporter_id);
  const walletRecipientId = rr.supporter_id;
  const walletDescription = managedProxy
    ? `15% monthly reward (payment #${paymentNumber}) on rent facilitation of UGX ${Number(rr.rent_amount).toLocaleString()} (managed by ${managedProxy.agentName || "proxy agent"})`
    : `15% monthly reward (payment #${paymentNumber}) on rent facilitation of UGX ${Number(rr.rent_amount).toLocaleString()}`;

  const { data: posted, error } = await supabase.rpc("post_rent_facilitation_reward", {
    p_rent_request_id: rr.id,
    p_payment_number: paymentNumber,
    p_reinvest_portfolio_id: null,
    p_wallet_description: walletDescription,
  });
  if (error || posted?.status !== "posted") return { walletRecipientId, posted: false };

  if (managedProxy) {
    await supabase.from("notifications").insert({
      user_id: rr.supporter_id,
      title: "⏳ Monthly Return Approved — Processing",
      type: "earning",
      metadata: {
        rent_request_id: rr.id,
        roi_amount: roiAmount,
        payment_number: paymentNumber,
        routed_to_proxy_agent_id: managedProxy.agentId,
        proxy_assignment_id: managedProxy.assignmentId,
      },
    });
    await supabase.from("notifications").insert({
      user_id: managedProxy.agentId,
      title: "🤝 Proxy Payout Ready for Delivery",
      type: "earning",
      metadata: {
        rent_request_id: rr.id,
        roi_amount: roiAmount,
        payment_number: paymentNumber,
        on_behalf_of_partner_id: rr.supporter_id,
        proxy_assignment_id: managedProxy.assignmentId,
      },
    });
  } else {
    await supabase.from("notifications").insert({
      user_id: rr.supporter_id,
      title: "⏳ Monthly Return Approved — Processing",
      type: "earning",
      metadata: { rent_request_id: rr.id, roi_amount: roiAmount, payment_number: paymentNumber },
    });
  }

  const { data: partnerProfile } = await supabase
    .from("profiles").select("email, full_name").eq("id", rr.supporter_id).maybeSingle();
  if (partnerProfile?.email) {
    dispatch({
      builder: "buildReturnsProcessingRequest",
      recipientEmail: partnerProfile.email,
      partnerId: rr.supporter_id,
      amount: roiAmount,
      payoutMethod: "Wallet",
      isManagedByAgent: !!managedProxy,
      agentName: managedProxy?.agentName || undefined,
    });
  }
  if (managedProxy?.agentEmail) {
    dispatch({
      builder: "buildProxyManagedPayoutRequest",
      recipientEmail: managedProxy.agentEmail,
      agentId: managedProxy.agentId,
      partnerId: rr.supporter_id,
      amount: roiAmount,
      reason: "Partner wallet credited. Please initiate delivery withdrawal.",
    });
  }
  return { walletRecipientId, posted: true };
}

describe("process-supporter-roi · rent reward for a managed-proxy partner (SSENKAALI PIUS / WIP2604226578)", () => {
  let captured: Captured;
  let supabase: any;
  const run = () =>
    runRewardPayout(
      supabase,
      { id: RR_ID, supporter_id: PARTNER_ID, rent_amount: 1_000_000 },
      ROI_AMOUNT,
      PAYMENT_NUMBER,
      (req) => captured.emails.push(req),
    );

  beforeEach(() => {
    captured = { rpcCalls: [], notifications: [], emails: [] };
    supabase = makeSupabaseMock(captured);
  });

  it("resolveManagedProxy returns the ACTIVE managed proxy (LUKODDA JOSEPH) and ignores the stale row", async () => {
    const proxy = await resolveManagedProxy(supabase, PARTNER_ID);
    expect(proxy).not.toBeNull();
    expect(proxy!.agentId).toBe(ACTIVE_PROXY_ID);
    expect(proxy!.agentId).not.toBe(STALE_PROXY_ID);
    expect(proxy!.agentName).toBe(ACTIVE_PROXY_NAME);
    expect(proxy!.agentEmail).toBe(ACTIVE_PROXY_EMAIL);
  });

  it("the reward is credited to the PARTNER'S wallet, never the proxy's", async () => {
    const r = await run();
    expect(r.walletRecipientId).toBe(PARTNER_ID);
    expect(r.walletRecipientId).not.toBe(ACTIVE_PROXY_ID);
  });

  it("posts exactly once, through the atomic database function, which takes no recipient", async () => {
    await run();
    const posts = captured.rpcCalls.filter((c) => c.fn === "post_rent_facilitation_reward");
    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0].args).sort()).toEqual(
      ["p_payment_number", "p_reinvest_portfolio_id", "p_rent_request_id", "p_wallet_description"],
    );
    expect(posts[0].args.p_rent_request_id).toBe(RR_ID);
    expect(posts[0].args.p_reinvest_portfolio_id).toBeNull();
    // The edge function never posts ledger legs itself any more.
    expect(captured.rpcCalls.some((c) => c.fn === "create_ledger_transaction")).toBe(false);
  });

  it("the wallet credit names the managing agent in its description", async () => {
    await run();
    const post = captured.rpcCalls.find((c) => c.fn === "post_rent_facilitation_reward")!;
    expect(post.args.p_wallet_description).toContain(`managed by ${ACTIVE_PROXY_NAME}`);
  });

  it("notifies BOTH: the partner (with the proxy routing) and the proxy (to deliver on the partner's behalf)", async () => {
    await run();
    const partnerNotif = captured.notifications.find((n) => n.user_id === PARTNER_ID);
    const proxyNotif = captured.notifications.find((n) => n.user_id === ACTIVE_PROXY_ID);

    expect(partnerNotif).toBeDefined();
    expect(partnerNotif.title).toMatch(/Monthly Return Approved/i);
    expect(partnerNotif.metadata.routed_to_proxy_agent_id).toBe(ACTIVE_PROXY_ID);

    expect(proxyNotif).toBeDefined();
    expect(proxyNotif.title).toMatch(/Proxy Payout Ready for Delivery/i);
    expect(proxyNotif.metadata.on_behalf_of_partner_id).toBe(PARTNER_ID);
  });

  it("emails BOTH: the partner (isManagedByAgent=true) and the proxy delivery notice", async () => {
    await run();
    const partnerEmail = captured.emails.find((e) => e.builder === "buildReturnsProcessingRequest");
    const proxyEmail = captured.emails.find((e) => e.builder === "buildProxyManagedPayoutRequest");

    expect(partnerEmail).toBeDefined();
    expect(partnerEmail.recipientEmail).toBe(PARTNER_EMAIL);
    expect(partnerEmail.isManagedByAgent).toBe(true);
    expect(partnerEmail.agentName).toBe(ACTIVE_PROXY_NAME);
    expect(partnerEmail.payoutMethod).toBe("Wallet");

    expect(proxyEmail).toBeDefined();
    expect(proxyEmail.recipientEmail).toBe(ACTIVE_PROXY_EMAIL);
    expect(proxyEmail.partnerId).toBe(PARTNER_ID);
    expect(proxyEmail.amount).toBe(ROI_AMOUNT);
  });

  it("nothing is sent when the reward did not post (it is retried on the next run)", async () => {
    supabase.rpc = vi.fn(async (fn: string, args: any) => {
      captured.rpcCalls.push({ fn, args });
      return { data: null, error: { message: "simulated failure" } };
    });
    const r = await run();
    expect(r.posted).toBe(false);
    expect(captured.notifications).toHaveLength(0);
    expect(captured.emails).toHaveLength(0);
  });

  it("regression: with no managed proxy the partner is still the recipient and no proxy notice or email is sent", async () => {
    const restore = [...FIXTURE.proxy_agent_assignments];
    FIXTURE.proxy_agent_assignments = FIXTURE.proxy_agent_assignments.filter((r) => r.id !== "active-1");
    try {
      const r = await run();
      expect(r.walletRecipientId).toBe(PARTNER_ID);
      expect(captured.emails.some((e) => e.builder === "buildProxyManagedPayoutRequest")).toBe(false);
      expect(captured.notifications.find((n) => n.user_id === ACTIVE_PROXY_ID)).toBeUndefined();
    } finally {
      FIXTURE.proxy_agent_assignments = restore;
    }
  });
});

/**
 * Source guards — pin the real edge function and the migration so a change that breaks the contract fails here.
 */
describe("source guards · rent reward for a managed-proxy partner", () => {
  const src = readFileSync("supabase/functions/process-supporter-roi/index.ts", "utf8").replace(/\r\n/g, "\n");
  const migration = readFileSync("supabase/migrations/20261024170000_rent_reward_atomic_post.sql", "utf8").replace(/\r\n/g, "\n");
  const walletBranch = migration.slice(migration.indexOf("  ELSE\n    INSERT INTO public.supporter_roi_payments"), migration.indexOf("  UPDATE public.rent_requests"));

  it("calls resolveManagedProxy with the partner id", () => {
    expect(src).toMatch(/resolveManagedProxy\s*\(\s*supabase\s*,\s*rr\.supporter_id\s*\)/);
  });

  it("the edge function's wallet recipient is the partner, not the proxy agent", () => {
    expect(src).toMatch(/const walletRecipientId = rr\.supporter_id;/);
    expect(src).not.toMatch(/managedProxy\s*\?\s*managedProxy\.agentId\s*:\s*rr\.supporter_id/);
  });

  it("the edge function posts through post_rent_facilitation_reward with no recipient argument", () => {
    const call = src.slice(src.indexOf("rpc('post_rent_facilitation_reward'"), src.indexOf("const outcome = classifyRentRewardPost"));
    expect(call).toContain("p_rent_request_id: rr.id");
    expect(call).not.toMatch(/user_id|recipient|agentId/);
  });

  it("the migration credits the supporter's own wallet, withdrawable bucket, linked_party 'platform'", () => {
    expect(walletBranch).toContain("'category', 'roi_wallet_credit'");
    expect(walletBranch).toMatch(/'user_id', rr\.supporter_id, 'direction', 'cash_in', 'amount', v_amount, 'category', 'roi_wallet_credit'/);
    expect(walletBranch).toContain("'wallet_bucket', 'withdrawable'");
    // 'platform' (not a partner uuid) keeps trg_enforce_managed_proxy_roi_routing from requiring the proxy wallet.
    expect(walletBranch).toMatch(/'source_table', 'supporter_roi_payments', 'source_id', rr\.id, 'linked_party', 'platform'/);
  });

  it("inserts both partner and proxy notifications with routing metadata", () => {
    expect(src).toMatch(/routed_to_proxy_agent_id\s*:\s*managedProxy\.agentId/);
    expect(src).toMatch(/on_behalf_of_partner_id\s*:\s*rr\.supporter_id/);
  });

  it("dispatches the partner email with the isManagedByAgent flag", () => {
    expect(src).toMatch(/isManagedByAgent\s*:\s*!!\s*managedProxy/);
  });

  it("dispatches the proxy delivery notice when the proxy has an email", () => {
    expect(src).toMatch(/managedProxy\?\.agentEmail/);
    expect(src).toMatch(/buildProxyManagedPayoutRequest\s*\(/);
  });
});
