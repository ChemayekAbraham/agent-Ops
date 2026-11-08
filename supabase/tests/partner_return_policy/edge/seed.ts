// Scenario data shared by the handler tests (E1-E13) and the switch-off golden test (E11).
// deno-lint-ignore-file no-explicit-any
import {
  installPortfolioGate,
  loginEmailsRpc,
  POLICY_OFF,
  POLICY_OFF_AFTER_CUTOFF,
  POLICY_ON,
  policyRpc,
  reset,
  type Row,
  signIn,
  state,
  table,
} from "./harness.ts";
import { fakeUuid, uidOf } from "./fake_supabase.ts";
import { _resetPolicyCacheForTests } from "../../../functions/_shared/partnerReturnPolicy.ts";

export const OPS = "11111111-1111-4111-8111-111111111111";      // partner_ops staff
export const PARTNER = "22222222-2222-4222-8222-222222222222";  // a partner (supporter)
export const AGENT = "33333333-3333-4333-8333-333333333333";    // a field agent
export const MANAGER = "44444444-4444-4444-8444-444444444444";  // manager / COO (partner staff)
export const OPERATIONS = "55555555-5555-4555-8555-555555555555"; // operations (not partner staff)
export const PARTNER2 = "66666666-6666-4666-8666-666666666666";

export const PROFILE_EMAIL = "pat.profile@example.com";
export const LOGIN_EMAIL = "pat.login@example.com";

export interface World {
  /** Switch on in the database (the gate and get_partner_return_policy). */
  on?: boolean;
  /** The person's own rate/basis with the switch on. */
  person?: { rate: number; basis: string };
  /** Confirmed login emails by user id. */
  login?: Record<string, string>;
  /** Policy JSON answered by get_partner_return_policy (defaults from `on`). */
  policy?: unknown;
}

/** Common world: staff, partner, agent; gate; policy; login emails. */
export function world(w: World = {}) {
  reset();
  // The edge modules cache the policy for 60 s on a fixed clock: every scenario starts with a cold cache.
  _resetPolicyCacheForTests();
  const on = !!w.on;
  installPortfolioGate({ enabled: on, person: () => w.person ?? { rate: 10, basis: "new" } });
  policyRpc(w.policy ?? (on ? POLICY_ON : POLICY_OFF));
  loginEmailsRpc(w.login ?? {});
  signIn("jwt-ops", { id: OPS, email: "ops@welile.test" }, ["partner_ops"]);
  signIn("jwt-manager", { id: MANAGER, email: "mgr@welile.test" }, ["manager"]);
  signIn("jwt-operations", { id: OPERATIONS, email: "operations@welile.test" }, ["operations"]);
  signIn("jwt-agent", { id: AGENT, email: "agent@welile.test" }, ["agent"]);
  signIn("jwt-partner", { id: PARTNER, email: LOGIN_EMAIL }, ["supporter"]);
  table("profiles").push(
    { id: PARTNER, full_name: "Pat Partner", email: PROFILE_EMAIL, phone: "+256772000111", frozen_at: null },
    { id: AGENT, full_name: "Abel Agent", email: "agent@welile.test", phone: "+256772000222" },
    { id: OPS, full_name: "Olive Ops", email: "ops@welile.test" },
    { id: MANAGER, full_name: "Mona Manager", email: "mgr@welile.test" },
    { id: OPERATIONS, full_name: "Otto Operations", email: "operations@welile.test" },
  );
  table("treasury_controls");
  state.rpc.create_ledger_transaction = () => ({ data: "txg-1", error: null });
  state.rpc.generate_portfolio_code = () => ({ data: "WIP26110700001", error: null });
  return state;
}

/** Inserts a portfolio through the gate (what create_pending_portfolio does inside the database). */
export function gateInsert(row: Row, client: any): Row {
  const base = { id: fakeUuid(), created_at: state.clock(), ...row };
  const stored = state.onInsert.investor_portfolios
    ? state.onInsert.investor_portfolios(base, { client, state, batch: [base], index: 0, options: {} }) as Row
    : base;
  table("investor_portfolios").push(stored);
  return stored;
}

// ---------------------------------------------------------------------------------------------------
// create-portfolio-invite

export function seedInvite(opts: { existingPortfolio: boolean }) {
  if (opts.existingPortfolio) {
    table("investor_portfolios").push({
      id: "aaaaaaaa-0000-4000-8000-000000000001", investor_id: PARTNER, investment_amount: 500_000,
      duration_months: 12, roi_percentage: 15, rate_basis: "switch_off", status: "active",
    });
  }
  state.rpc.funder_float_available = () => ({ data: 50_000_000, error: null });
  state.rpc.create_pending_portfolio = (args: any, ctx) => {
    const row = gateInsert({
      investor_id: args.p_partner_id,
      investment_amount: args.p_amount,
      duration_months: args.p_duration_months,
      ...(args.p_roi_percentage === null || args.p_roi_percentage === undefined ? {} : { roi_percentage: args.p_roi_percentage }),
      roi_mode: args.p_roi_mode,
      portfolio_code: "WIP26110799001",
      payout_day: 15,
      next_roi_date: "2026-12-07",
      status: "awaiting_partner_details",
      requested_by_uid: uidOf(ctx.client),
    }, ctx.client);
    return { data: [{ portfolio_id: row.id, portfolio_code: row.portfolio_code }], error: null };
  };
  state.rpc.approve_pending_portfolio = (args: any) => {
    const p = table("investor_portfolios").find((r) => r.id === args.p_portfolio_id);
    if (p) p.status = "active";
    return { data: null, error: null };
  };
}

export const inviteBody = (extra: Row = {}) => ({
  partner_id: PARTNER, amount: 1_000_000, duration_months: 12, roi_mode: "monthly_payout", ...extra,
});

// ---------------------------------------------------------------------------------------------------
// create-investor-portfolio

export function seedInvestorPortfolio() {
  table("wallets").push(
    { user_id: PARTNER, balance: 5_000_000, withdrawable_balance: 5_000_000, float_balance: 0 },
    { user_id: AGENT, balance: 5_000_000, withdrawable_balance: 5_000_000, float_balance: 0 },
  );
  table("proxy_agent_assignments");
}

export const investorBody = (extra: Row = {}) => ({
  investment_amount: 1_000_000, duration_months: 12, roi_mode: "monthly_payout", portfolio_pin: "1234",
  investor_id: PARTNER, payout_day: 15, contribution_date: "2026-11-07", ...extra,
});

// ---------------------------------------------------------------------------------------------------
// agent-invest-for-partner / coo-invest-for-partner / coo-create-portfolio

export function seedInvestForPartner() {
  table("wallets").push(
    { id: "w-agent", user_id: AGENT, balance: 9_000_000, withdrawable_balance: 9_000_000, float_balance: 0 },
    { id: "w-partner", user_id: PARTNER, balance: 9_000_000, withdrawable_balance: 9_000_000, float_balance: 0 },
  );
  table("supporter_invites");
  // coo-invest / coo-create: a manager (partner staff) and a COO role holder for notifications
  table("user_roles").push({ id: fakeUuid(), user_id: MANAGER, role: "coo", enabled: true });
}

// ---------------------------------------------------------------------------------------------------
// notices

export function bookingNotice(extra: Row = {}): Row {
  return {
    id: fakeUuid(), note_id: "note-1", partner_id: PARTNER, kind: "funded", partner_name: "Pat Partner",
    phone: "+256772000111", email: PROFILE_EMAIL, house_count: 2, total_rent: 1_000_000,
    release_at: "2026-11-14T00:00:00Z", promised_funding_date: "2026-11-10", days_left: 3, houses: [],
    funded_at: null, created_at: "2026-11-07T08:00:00Z", sms_sent_at: null, email_sent_at: null, ...extra,
  };
}

export function pledgeNotice(extra: Row = {}): Row {
  return {
    id: fakeUuid(), note_id: "note-1", partner_name: "Pat Partner", phone: "+256772000111", email: PROFILE_EMAIL,
    amount: 1_000_000, attached_count: 2, attached_amount: 1_000_000, monthly_return: 150_000,
    annual_return: 1_800_000, tenants: [], sms_status: "pending", email_status: "pending", attempts: 0,
    created_at: "2026-11-07T08:00:00Z", promissory_notes: { agent_id: AGENT }, ...extra,
  };
}

export function progressNotice(extra: Row = {}): Row {
  return {
    id: fakeUuid(), partner_id: PARTNER, kind: "earning_started", partner_name: "Pat Partner", phone: "+256772000111",
    email: PROFILE_EMAIL, house_title: "Kira 2-room", district: "Wakiso", house_count: 1, monthly_rent: 300_000,
    principal: 1_000_000, monthly_return: 150_000, agent_name: "Abel Agent", placed_at: "2026-11-01T00:00:00Z",
    earning_started_at: "2026-11-05T00:00:00Z", created_at: "2026-11-07T08:00:00Z", sms_sent_at: null,
    email_sent_at: null, ...extra,
  };
}

// ---------------------------------------------------------------------------------------------------
// process-supporter-roi

export const RR = "77777777-7777-4777-8777-777777777777";

export function seedRoi(opts: { reinvest: boolean; posted: Row | null }) {
  table("rent_requests").push({
    id: RR, rent_amount: 1_000_000, supporter_id: PARTNER, funded_at: "2026-09-01T00:00:00Z",
    next_roi_due_date: "2026-11-01T00:00:00Z", total_roi_paid: 0, roi_payments_count: 1, status: "funded",
  });
  table("investment_withdrawal_requests");
  if (opts.reinvest) {
    table("investor_portfolios").push({
      id: "bbbbbbbb-0000-4000-8000-000000000001", investor_id: PARTNER, auto_reinvest: true, status: "active",
      investment_amount: 2_000_000, created_at: "2026-06-01T00:00:00Z", duration_months: 12,
    });
  }
  state.rpc.post_rent_facilitation_reward = () => ({ data: opts.posted, error: null });
}

// ---------------------------------------------------------------------------------------------------
// fund-tenants

export const RRS = ["88888888-8888-4888-8888-000000000001", "88888888-8888-4888-8888-000000000002", "88888888-8888-4888-8888-000000000003"];

export function seedFundTenants(rates: (number | null)[]) {
  table("wallets").push({ user_id: PARTNER, balance: 50_000_000 });
  RRS.forEach((id, i) => {
    table("rent_requests").push({
      id, status: "approved", rent_amount: 400_000 + i * 100_000, tenant_id: `tenant-${i}`, agent_id: AGENT,
      total_repayment: 500_000, duration_days: 30, daily_repayment: 0, created_at: "2026-11-01T00:00:00Z",
      landlords: { name: `Landlord ${i}`, phone: null, mobile_money_number: null },
    });
    if (rates[i] !== null && rates[i] !== undefined) {
      table("rent_facilitation_reward_rates").push({ rent_request_id: id, supporter_id: PARTNER, rate: rates[i] });
    }
  });
}

export { POLICY_OFF, POLICY_OFF_AFTER_CUTOFF, POLICY_ON };

// ---------------------------------------------------------------------------------------------------
// rate-bearing email senders (E15.5, E11): call world() first

export const PF = "aaaaaaaa-0000-4000-8000-0000000000a1";
/** The rate columns of a portfolio row (rate_basis NULL = a legacy row written before Phase 1). */
export interface RateRow { roi_percentage: number; rate_basis: string | null }

/** approve-pending-portfolio / resend-portfolio-invite: one pending portfolio of PARTNER. */
export function seedPendingPortfolio(rate: RateRow, extra: Row = {}) {
  table("investor_portfolios").push({
    id: PF, investor_id: PARTNER, investment_amount: 1_000_000, ...rate, roi_mode: "monthly_payout", duration_months: 12,
    payout_day: 15, portfolio_code: "WIP26110700009", next_roi_date: "2026-12-15", created_at: "2026-11-07T09:00:00Z",
    status: "pending_ops_approval", ...extra,
  });
  state.rpc.is_partner_ops = () => ({ data: true, error: null });
  state.rpc.funder_float_available = () => ({ data: 50_000_000, error: null });
  state.rpc.approve_pending_portfolio = (args: any) => {
    const p = table("investor_portfolios").find((r) => r.id === args.p_portfolio_id);
    if (p) p.status = "active";
    return { data: null, error: null };
  };
}

/** manager-portfolio-topup / coo-wallet-to-portfolio / approve-portfolio-topup: an active portfolio of
 *  PARTNER, the partner's wallet and a COO. */
export function seedTopupPortfolio(rate: RateRow) {
  table("investor_portfolios").push({
    id: PF, investor_id: PARTNER, agent_id: null, investment_amount: 1_000_000, status: "active", portfolio_code: "WIP26110700009",
    account_name: "Main", ...rate,
  });
  table("wallets").push({ user_id: PARTNER, balance: 5_000_000, withdrawable_balance: 5_000_000, float_balance: 0, advance_balance: 0 });
  table("user_roles").push({ id: fakeUuid(), user_id: MANAGER, role: "coo", enabled: true });
  table("proxy_agent_assignments");
  state.rpc.get_user_available_balance = () => ({ data: 5_000_000, error: null });
  state.rpc.create_ledger_transaction = (args: any) => {
    const out = (args?.entries ?? []).find((e: any) => e.direction === "cash_out" && e.ledger_scope === "wallet");
    const wallet = table("wallets").find((x) => x.user_id === out?.user_id);
    if (wallet) wallet.balance -= Number(out.amount);
    return { data: "txg-topup", error: null };
  };
}
export const topupBody = { portfolio_id: PF, amount: 100_000, payment_method: "wallet", reason: "Partner asked for a top-up" };

/** approve-portfolio-topup: the top-up waiting for verification. */
export function seedTopupOperation() {
  table("pending_wallet_operations").push({
    id: "op-1", amount: 200_000, user_id: PARTNER, transaction_group_id: "txg-op1", metadata: {},
    source_id: PF, source_table: "investor_portfolios", operation_type: "portfolio_topup", status: "awaiting_verification",
  });
}

/** process-supporter-roi's inline top-up merge is disabled in production; tests run a flag-on variant. */
export const inlineTopupMergeOn = (src: string) =>
  src.replace("const INLINE_TOPUP_MERGE_ENABLED = false;", "const INLINE_TOPUP_MERGE_ENABLED = true;");

/** Portfolios due today, each with one approved top-up waiting to merge. */
export function seedRoiTopups(rows: Array<{ id: string; investor: string; rate: number; rate_basis: string | null }>) {
  table("rent_requests");
  table("investment_withdrawal_requests");
  table("profiles").push({ id: PARTNER2, full_name: "Second Partner", email: "second.profile@example.com" });
  for (const r of rows) {
    table("investor_portfolios").push({
      id: r.id, investor_id: r.investor, agent_id: null, investment_amount: 1_000_000, portfolio_code: `WIP-${r.id.slice(-2)}`,
      account_name: null, status: "active", roi_percentage: r.rate, rate_basis: r.rate_basis,
      next_roi_date: "2026-11-01", created_at: "2026-06-01T00:00:00Z", payout_day: 1,
    });
    table("pending_wallet_operations").push({
      id: `op-${r.id.slice(-2)}`, amount: 100_000, transaction_group_id: "txg", metadata: {}, status: "approved",
      source_id: r.id, source_table: "investor_portfolios", operation_type: "portfolio_topup",
    });
  }
}
