// Shared merchant-dispatch engine (Uber-style).
//
// Broadcasts a claimable withdrawal to every ELIGIBLE, ONLINE merchant
// (cash-out) agent via in-app push ONLY, writes a per-agent audit row to
// withdrawal_notification_log, and stamps the dispatch window on the request.
//
// Eligibility (per business rules):
//   • cashout_agents.is_active = true
//   • cashout_agents.is_online = true
//   • wallet.float_balance >= amount  (agent can actually settle it)
//   • not already reserved on another still-open withdrawal (one active tx)
//
// Used by both notify-merchants-new-withdrawal (round 1) and
// redispatch-withdrawals (rounds 2..N).

import { merchantHandlesPayout, getWithdrawalPayoutRoute } from "./payoutRouting.ts";

export const DISPATCH_TTL_SECONDS = 60;
export const MAX_DISPATCH_ROUNDS = 3;

const OPEN_STATUSES = [
  "pending",
  "requested",
  "manager_approved",
  "cfo_approved",
  "fin_ops_approved",
];

export interface DispatchResult {
  ok: boolean;
  skipped?: string;
  round?: number;
  eligible?: number;
  pushTargets?: number;
  expiresAt?: string;
}

export async function dispatchWithdrawal(
  admin: any,
  supabaseUrl: string,
  serviceKey: string,
  withdrawalId: string,
  round: number,
): Promise<DispatchResult> {
  // 1. Load the request.
  const { data: w } = await admin
    .from("withdrawal_requests")
    .select(
      "id, user_id, amount, payout_method, bank_name, mobile_money_provider, reason, status, created_at, dispatch_claimed_by, metadata",
    )
    .eq("id", withdrawalId)
    .maybeSingle();

  if (!w) return { ok: false, skipped: "not_found" };
  if (w.dispatch_claimed_by) return { ok: false, skipped: "already_claimed" };
  if (!OPEN_STATUSES.includes(w.status)) return { ok: false, skipped: `status_${w.status}` };

  const amount = Number(w.amount) || 0;

  // Landlord-float payouts are settled from float already deducted at disburse
  // time, so the merchant does not need matching float on hand.
  const isLandlordFloat =
    typeof w.reason === "string" && w.reason.startsWith("Landlord float payout");

  // Detect proxy-initiated partner returns / ROI payouts. The proxy-agent
  // flow stamps metadata.initiated_by = "proxy" or "proxy_agent", and the
  // reason typically contains "proxy", "roi", or "return". These payouts
  // are handled by merchant agents assigned to the
  // `proxy_partner_withdrawal` category and deserve a DISTINCT push so
  // the agent knows this is a Partner Returns payout, not a regular
  // customer wallet withdrawal.
  const reasonLc = typeof w.reason === "string" ? w.reason.toLowerCase() : "";
  const meta = (w.metadata ?? {}) as Record<string, unknown>;
  const initiator = typeof meta.initiated_by === "string"
    ? (meta.initiated_by as string).toLowerCase()
    : "";
  const isPartnerReturns =
    initiator.includes("proxy") ||
    reasonLc.includes("proxy") ||
    reasonLc.includes("roi") ||
    reasonLc.includes("return") ||
    reasonLc.includes("partner");

  // 2. Active + online merchant agents.
  const { data: agents } = await admin
    .from("cashout_agents")
    .select("agent_id, config, handles_cash, handles_bank, handles_mtn, handles_airtel")
    .eq("is_active", true)
    .eq("is_online", true);
  const allOnline = (agents || []).filter((a: any) => a.agent_id);

  // 2a. Channel + exact provider/bank gate. A merchant must NEVER be routed a
  // payout for a bank or mobile-money network the CFO has not assigned to them,
  // even when the parent channel (e.g. Bank Transfer) is enabled.
  const routeEligible = allOnline.filter((a: any) => merchantHandlesPayout(a, w));
  let agentIds: string[] = Array.from(
    new Set(routeEligible.map((a: any) => a.agent_id)),
  );
  if (agentIds.length === 0) {
    const route = getWithdrawalPayoutRoute(w);
    return {
      ok: true,
      round,
      eligible: 0,
      skipped: `no_agent_for_${route.channel}_${route.provider ?? "unknown"}`,
    };
  }

  // For Partner Returns / ROI proxy payouts, prefer agents who have the
  // `proxy_partner_withdrawal` category explicitly enabled. If none of
  // those are online, fall back to the full online pool so the payout
  // is not stranded.
  if (isPartnerReturns) {
    const categoryEnabled = routeEligible
      .filter((a: any) => {
        const cats = (a.config?.categories ?? {}) as Record<string, unknown>;
        return cats.proxy_partner_withdrawal === true;
      })
      .map((a: any) => a.agent_id as string);
    if (categoryEnabled.length > 0) {
      agentIds = Array.from(new Set(categoryEnabled));
    }
  }
  if (agentIds.length === 0) return { ok: true, round, eligible: 0, skipped: "no_online_agents" };

  // 3. Float sufficiency (skip for landlord-float payouts).
  if (!isLandlordFloat && amount > 0) {
    const { data: wallets } = await admin
      .from("wallets")
      .select("user_id, float_balance")
      .in("user_id", agentIds);
    const floatByUser = new Map<string, number>(
      (wallets || []).map((r: any) => [r.user_id, Number(r.float_balance) || 0]),
    );
    agentIds = agentIds.filter((id) => (floatByUser.get(id) ?? 0) >= amount);
  }
  if (agentIds.length === 0) return { ok: true, round, eligible: 0, skipped: "no_float" };

  // 4. Exclude agents already reserved on another still-open withdrawal.
  const { data: busy } = await admin
    .from("withdrawal_requests")
    .select("dispatch_claimed_by")
    .in("dispatch_claimed_by", agentIds)
    .in("status", OPEN_STATUSES);
  const busyIds = new Set((busy || []).map((b: any) => b.dispatch_claimed_by));
  agentIds = agentIds.filter((id) => !busyIds.has(id));
  if (agentIds.length === 0) return { ok: true, round, eligible: 0, skipped: "all_busy" };

  // 5. Recipient profiles + requester context.
  const { data: profs } = await admin
    .from("profiles")
    .select("id, full_name, phone")
    .in("id", agentIds);
  const profById = new Map<string, any>((profs || []).map((p: any) => [p.id, p]));

  const { data: requester } = await admin
    .from("profiles")
    .select("full_name")
    .eq("id", w.user_id)
    .maybeSingle();
  const { data: loc } = await admin
    .from("user_locations")
    .select("city, address, latitude, longitude")
    .eq("user_id", w.user_id)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const amountLabel = `UGX ${amount.toLocaleString()}`;
  const serviceArea = loc?.city || loc?.address || "Service area";

  const pushTitle = isPartnerReturns
    ? "New Partner Returns payout to deliver"
    : "New withdrawal to claim";
  const pushBody = isPartnerReturns
    ? `${amountLabel} · Partner ROI · ${serviceArea}. Proxy agent initiated — tap to process.`
    : `${amountLabel} · ${serviceArea}. Tap to claim before it expires.`;

  // 6. Expire the previous round's still-pending log rows.
  if (round > 1) {
    await admin
      .from("withdrawal_notification_log")
      .update({ response: "expired", expired_at: new Date().toISOString() })
      .eq("withdrawal_id", w.id)
      .eq("response", "pending");
  }

  // 7. In-app push to every eligible agent (fire-and-forget).
  fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      userIds: agentIds,
      payload: {
        title: pushTitle,
        body: pushBody,
        url: "/agent/cash-payouts",
        type: isPartnerReturns ? "dispatch_partner_returns" : "dispatch",
      },
    }),
  }).catch(() => {});

  // 8. Log a push row per eligible agent (drives the in-app dispatch overlay).
  const nowIso = new Date().toISOString();
  const pushRows = agentIds.map((id) => ({
    withdrawal_id: w.id,
    recipient_id: id,
    recipient_email: profById.get(id)?.email ?? null,
    recipient_phone: profById.get(id)?.phone ?? null,
    amount,
    channel: "push",
    status: "sent",
    response: "pending",
    dispatch_round: round,
    created_at: nowIso,
  }));
  await admin.from("withdrawal_notification_log").insert(pushRows);

  // 9. Stamp the dispatch window on the request.
  const expiresAt = new Date(Date.now() + DISPATCH_TTL_SECONDS * 1000).toISOString();
  await admin
    .from("withdrawal_requests")
    .update({
      auto_dispatched: true,
      dispatched_at: nowIso,
      dispatch_round: round,
      dispatch_expires_at: expiresAt,
    })
    .eq("id", w.id);

  return {
    ok: true,
    round,
    eligible: agentIds.length,
    pushTargets: agentIds.length,
    expiresAt,
  };
}

export { OPEN_STATUSES };
