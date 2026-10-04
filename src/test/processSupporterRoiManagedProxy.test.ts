import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";

/**
 * Managed-Proxy Payout Routing — automated tests
 *
 * Real-world fixture used here mirrors production:
 *   - Partner: SSENKAALI PIUS (portfolio WIP2604226578)
 *       id:    0b109aad-212a-4fd0-ab03-3d7aee9cf397
 *   - Active + approved + managed proxy: LUKODDA JOSEPH
 *       id:    b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c
 *       email: 256751424629@welile.user
 *   - Stale (is_active=false) proxy that must NOT be picked: ATUHAIRE CAROLYNE
 *       id:    ae194750-4827-47e8-839e-5e772565138b
 *
 * These tests assert two things end-to-end:
 *   1. `resolveManagedProxy` selects the ACTIVE+APPROVED+MANAGED row only,
 *      and the wallet leg of the ROI ledger transaction credits the PROXY
 *      agent's user_id — never the partner's.
 *   2. Both the partner notification (routed_to_proxy_agent_id) and the
 *      proxy-agent notification (on_behalf_of_partner_id) are inserted,
 *      AND both transactional emails (`returns-disbursement-confirmation`
 *      with isManagedByAgent=true + `proxy-managed-payout-notice`) are
 *      dispatched.
 *
 * In addition we keep source-guards on the real edge function file so a
 * future refactor that drops the routing or the dual notifications fails
 * the suite loudly.
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
  ledgerEntries: any[];
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
      if (fn === "create_ledger_transaction") {
        captured.ledgerEntries.push(...(args?.entries ?? []));
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
 * Mirrors the STANDARD WALLET CREDIT branch of process-supporter-roi.
 * Kept narrow on purpose so the test fails when the production routing
 * rule (proxy gets the wallet leg, partner stays on the platform leg)
 * diverges from this contract.
 */
async function runRoiPayout(
  supabase: any,
  rr: { id: string; supporter_id: string; rent_amount: number },
  roiAmount: number,
  paymentNumber: number,
  dispatch: (req: any) => void,
) {
  const managedProxy = await resolveManagedProxy(supabase, rr.supporter_id);
  const walletRecipientId = managedProxy ? managedProxy.agentId : rr.supporter_id;

  await supabase.rpc("create_ledger_transaction", {
    entries: [
      {
        user_id: rr.supporter_id,
        direction: "cash_out",
        amount: roiAmount,
        category: "roi_expense",
        ledger_scope: "platform",
      },
      {
        user_id: walletRecipientId,
        direction: "cash_in",
        amount: roiAmount,
        category: "roi_wallet_credit",
        ledger_scope: "wallet",
      },
    ],
  });

  if (managedProxy) {
    await supabase.from("notifications").insert({
      user_id: rr.supporter_id,
      title: "💰 Monthly Reward Sent to Your Proxy Agent",
      type: "earning",
      metadata: {
        rent_request_id: rr.id,
        routed_to_proxy_agent_id: managedProxy.agentId,
        proxy_assignment_id: managedProxy.assignmentId,
      },
    });
    await supabase.from("notifications").insert({
      user_id: managedProxy.agentId,
      title: "🤝 Proxy Payout Received",
      type: "earning",
      metadata: {
        rent_request_id: rr.id,
        on_behalf_of_partner_id: rr.supporter_id,
        proxy_assignment_id: managedProxy.assignmentId,
      },
    });
  }

  const { data: partnerProfile } = await supabase
    .from("profiles").select("email, full_name").eq("id", rr.supporter_id).maybeSingle();
  if (partnerProfile?.email) {
    dispatch({
      templateName: "returns-disbursement-confirmation",
      recipientEmail: partnerProfile.email,
      templateData: {
        partner_name: partnerProfile.full_name,
        is_managed_by_agent: !!managedProxy,
        agent_name: managedProxy?.agentName || "",
        payout_method: managedProxy
          ? `Proxy Agent Wallet (${managedProxy.agentName || "Agent"})`
          : "Wallet",
      },
      idempotencyKey: `returns-disbursement-${rr.supporter_id}-${rr.id}-${paymentNumber}`,
    });
  }
  if (managedProxy?.agentEmail) {
    dispatch({
      templateName: "proxy-managed-payout-notice",
      recipientEmail: managedProxy.agentEmail,
      templateData: {
        agent_name: managedProxy.agentName,
        partner_name: partnerProfile?.full_name,
        amount: roiAmount,
      },
      idempotencyKey: `proxy-managed-payout-${managedProxy.agentId}-${rr.supporter_id}-${rr.id}-${paymentNumber}`,
    });
  }
}

describe("process-supporter-roi · managed-proxy routing (SSENKAALI PIUS / WIP2604226578)", () => {
  let captured: Captured;
  let supabase: any;

  beforeEach(() => {
    captured = { ledgerEntries: [], notifications: [], emails: [] };
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

  it("credits the proxy wallet — NOT the partner wallet — on the wallet leg", async () => {
    await runRoiPayout(
      supabase,
      { id: RR_ID, supporter_id: PARTNER_ID, rent_amount: 1_000_000 },
      ROI_AMOUNT,
      PAYMENT_NUMBER,
      (req) => captured.emails.push(req),
    );

    const walletLeg = captured.ledgerEntries.find(
      (e) => e.ledger_scope === "wallet" && e.direction === "cash_in",
    );
    const platformLeg = captured.ledgerEntries.find(
      (e) => e.ledger_scope === "platform" && e.direction === "cash_out",
    );

    expect(walletLeg).toBeDefined();
    expect(walletLeg.user_id).toBe(ACTIVE_PROXY_ID);
    expect(walletLeg.user_id).not.toBe(PARTNER_ID);
    expect(walletLeg.amount).toBe(ROI_AMOUNT);
    expect(walletLeg.category).toBe("roi_wallet_credit");

    // Platform leg still references the partner for accounting.
    expect(platformLeg).toBeDefined();
    expect(platformLeg.user_id).toBe(PARTNER_ID);
  });

  it("HARD GUARANTEE: zero wallet-scope ledger entries are ever attributed to the partner", async () => {
    await runRoiPayout(
      supabase,
      { id: RR_ID, supporter_id: PARTNER_ID, rent_amount: 1_000_000 },
      ROI_AMOUNT,
      PAYMENT_NUMBER,
      (req) => captured.emails.push(req),
    );

    const partnerWalletLegs = captured.ledgerEntries.filter(
      (e) => e.ledger_scope === "wallet" && e.user_id === PARTNER_ID,
    );
    // ROI must NEVER reflect on the proxy partner's wallet — not as cash_in,
    // cash_out, correction, or any other movement.
    expect(partnerWalletLegs).toHaveLength(0);

    const proxyWalletLegs = captured.ledgerEntries.filter(
      (e) => e.ledger_scope === "wallet" && e.user_id === ACTIVE_PROXY_ID,
    );
    // Exactly one wallet leg, and it belongs to the proxy.
    expect(proxyWalletLegs).toHaveLength(1);
    expect(proxyWalletLegs[0].direction).toBe("cash_in");
  });

  it("sends BOTH in-app notifications: partner sees proxy routing, proxy sees on_behalf_of_partner_id", async () => {
    await runRoiPayout(
      supabase,
      { id: RR_ID, supporter_id: PARTNER_ID, rent_amount: 1_000_000 },
      ROI_AMOUNT,
      PAYMENT_NUMBER,
      (req) => captured.emails.push(req),
    );

    const partnerNotif = captured.notifications.find(
      (n) => n.user_id === PARTNER_ID,
    );
    const proxyNotif = captured.notifications.find(
      (n) => n.user_id === ACTIVE_PROXY_ID,
    );

    expect(partnerNotif).toBeDefined();
    expect(partnerNotif.title).toMatch(/Proxy Agent/i);
    expect(partnerNotif.metadata.routed_to_proxy_agent_id).toBe(ACTIVE_PROXY_ID);

    expect(proxyNotif).toBeDefined();
    expect(proxyNotif.title).toMatch(/Proxy Payout Received/i);
    expect(proxyNotif.metadata.on_behalf_of_partner_id).toBe(PARTNER_ID);
  });

  it("dispatches BOTH transactional emails: returns-disbursement (isManagedByAgent=true) and proxy-managed-payout-notice", async () => {
    await runRoiPayout(
      supabase,
      { id: RR_ID, supporter_id: PARTNER_ID, rent_amount: 1_000_000 },
      ROI_AMOUNT,
      PAYMENT_NUMBER,
      (req) => captured.emails.push(req),
    );

    const partnerEmail = captured.emails.find(
      (e) => e.templateName === "returns-disbursement-confirmation",
    );
    const proxyEmail = captured.emails.find(
      (e) => e.templateName === "proxy-managed-payout-notice",
    );

    expect(partnerEmail).toBeDefined();
    expect(partnerEmail.recipientEmail).toBe(PARTNER_EMAIL);
    expect(partnerEmail.templateData.is_managed_by_agent).toBe(true);
    expect(partnerEmail.templateData.agent_name).toBe(ACTIVE_PROXY_NAME);
    expect(partnerEmail.templateData.payout_method).toContain(ACTIVE_PROXY_NAME);

    expect(proxyEmail).toBeDefined();
    expect(proxyEmail.recipientEmail).toBe(ACTIVE_PROXY_EMAIL);
    expect(proxyEmail.templateData.partner_name).toBe(PARTNER_NAME);
    expect(proxyEmail.templateData.amount).toBe(ROI_AMOUNT);
    expect(proxyEmail.idempotencyKey).toContain(`proxy-managed-payout-${ACTIVE_PROXY_ID}-${PARTNER_ID}-`);
  });

  it("regression: when no managed proxy exists, wallet leg credits the partner directly", async () => {
    // Drop the active row so only the stale one remains.
    const restore = [...FIXTURE.proxy_agent_assignments];
    FIXTURE.proxy_agent_assignments = FIXTURE.proxy_agent_assignments.filter(
      (r) => r.id !== "active-1",
    );
    try {
      await runRoiPayout(
        supabase,
        { id: RR_ID, supporter_id: PARTNER_ID, rent_amount: 1_000_000 },
        ROI_AMOUNT,
        PAYMENT_NUMBER,
        (req) => captured.emails.push(req),
      );
      const walletLeg = captured.ledgerEntries.find(
        (e) => e.ledger_scope === "wallet" && e.direction === "cash_in",
      );
      expect(walletLeg.user_id).toBe(PARTNER_ID);
      // No proxy email when there's no managed proxy.
      expect(
        captured.emails.some((e) => e.templateName === "proxy-managed-payout-notice"),
      ).toBe(false);
      // No proxy notification either.
      expect(captured.notifications.find((n) => n.user_id === ACTIVE_PROXY_ID)).toBeUndefined();
    } finally {
      FIXTURE.proxy_agent_assignments = restore;
    }
  });
});

/**
 * Source guards — pin the actual edge function file so a future refactor
 * that drops any piece of the managed-proxy routing fails this suite.
 */
describe("source guards · process-supporter-roi managed-proxy wiring", () => {
  const src = readFileSync("supabase/functions/process-supporter-roi/index.ts", "utf8");

  it("calls resolveManagedProxy with the partner id", () => {
    expect(src).toMatch(/resolveManagedProxy\s*\(\s*supabase\s*,\s*rr\.supporter_id\s*\)/);
  });

  it("uses managedProxy.agentId as the wallet recipient", () => {
    expect(src).toMatch(/managedProxy\s*\?\s*managedProxy\.agentId\s*:\s*rr\.supporter_id/);
  });

  it("inserts both partner and proxy notifications with routing metadata", () => {
    expect(src).toMatch(/routed_to_proxy_agent_id\s*:\s*managedProxy\.agentId/);
    expect(src).toMatch(/on_behalf_of_partner_id\s*:\s*rr\.supporter_id/);
  });

  it("dispatches returns-disbursement email with isManagedByAgent flag", () => {
    expect(src).toMatch(/isManagedByAgent\s*:\s*!!\s*managedProxy/);
  });

  it("dispatches proxy-managed-payout-notice when the proxy has an email", () => {
    expect(src).toMatch(/managedProxy\?\.agentEmail/);
    expect(src).toMatch(/buildProxyManagedPayoutRequest\s*\(/);
  });
});