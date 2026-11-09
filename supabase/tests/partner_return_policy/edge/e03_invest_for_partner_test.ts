// E3 agent-invest-for-partner, E4 coo-invest-for-partner, and coo-create-portfolio (design v2
// sections 3.1.0, 3.1.3, 3.1.4, 3.1.5).
import { call, emails, eq, inserted, loadHandler, ok_, rpcCalls, signIn, state, table } from "./harness.ts";
import { _resetPolicyCacheForTests } from "../../../functions/_shared/partnerReturnPolicy.ts";
import { LOGIN_EMAIL, MANAGER, PARTNER, PROFILE_EMAIL, seedInvestForPartner, world } from "./seed.ts";

const agentInvest = await loadHandler("agent-invest-for-partner");
const cooInvest = await loadHandler("coo-invest-for-partner");
const cooCreate = await loadHandler("coo-create-portfolio");

function setup(w: Parameters<typeof world>[0]) {
  _resetPolicyCacheForTests();
  world(w);
  seedInvestForPartner();
}
const notificationsTo = (user: string) => inserted("notifications").flatMap((e) => e.stored!).filter((n) => n.user_id === user);
const indexOf = (pred: (e: (typeof state.log)[number]) => boolean) => state.log.findIndex(pred);
const failPortfolioInsert = () => {
  state.failInsert = (t) => (t === "investor_portfolios" ? { code: "23514", message: "new row violates check constraint" } : null);
};

// ---- E3 agent-invest-for-partner ------------------------------------------------------------------

Deno.test("E3.1 insert without a rate; the partner's own notification and email quote their stored 20; the agent gets no figure", async () => {
  setup({ on: true, person: { rate: 20, basis: "existing_partner" }, login: { [PARTNER]: LOGIN_EMAIL } });
  const r = await call(agentInvest, { jwt: "jwt-agent", body: { partner_id: PARTNER, amount: 1_000_000 } });
  eq(r.status, 200, "status");
  ok_(!("roi_percentage" in inserted("investor_portfolios")[0].payload), "no rate in the insert");
  const note = notificationsTo(PARTNER)[0];
  ok_(String(note.message).includes("You'll earn 20% (UGX 200,000) monthly for 12 months."), `partner notification: ${note.message}`);
  eq([note.metadata.monthly_reward, note.metadata.total_reward_12_months], [200_000, 2_400_000], "notification metadata");
  ok_(!("monthly_reward" in r.body) && !("roi_percentage" in r.body), "no figure to the agent for a personal rate");
  const mail = emails()[0];
  eq([mail.recipientEmail, mail.templateData.roi_percentage, mail.templateData.monthly_return_amount], [LOGIN_EMAIL, 20, 200_000], "email");
});

Deno.test("E3.2 switch off: today's response (monthly_reward 15%), profile email", async () => {
  setup({});
  const r = await call(agentInvest, { jwt: "jwt-agent", body: { partner_id: PARTNER, amount: 1_000_000 } });
  eq([r.status, r.body.monthly_reward], [200, 150_000], "monthly_reward");
  ok_(String(notificationsTo(PARTNER)[0].message).includes("You'll earn 15% (UGX 150,000) monthly"), "15% sentence");
  eq(emails()[0].recipientEmail, PROFILE_EMAIL, "profile email for a public row");
});

Deno.test("E3.3 portfolio insert fails after the ledger debit: 500 with the reference, an event, no notification or email", async () => {
  setup({});
  failPortfolioInsert();
  const r = await call(agentInvest, { jwt: "jwt-agent", body: { partner_id: PARTNER, amount: 1_000_000 } });
  eq(r.status, 500, "status");
  ok_(/^Funds were moved but the portfolio record failed\. Contact Ops with ref WPR\d+\.$/.test(r.body.error), r.body.error);
  ok_(typeof r.body.reference_id === "string" && r.body.error.includes(r.body.reference_id), "reference in the message");
  const ledgerAt = indexOf((e) => e.kind === "rpc" && e.name === "create_ledger_transaction");
  const insertAt = indexOf((e) => e.kind === "insert" && e.table === "investor_portfolios");
  ok_(ledgerAt >= 0 && ledgerAt < insertAt, "the ledger RPC ran before the failed insert");
  const ev = inserted("system_events").flatMap((e) => e.stored!);
  eq(ev.map((x) => [x.event_type, x.metadata.reference_id, x.metadata.amount]), [["agent_invest_portfolio_missing", r.body.reference_id, 1_000_000]], "event");
  eq(inserted("notifications").length, 0, "no notifications");
  eq(emails().length, 0, "no email");
});

// ---- E4 coo-invest-for-partner --------------------------------------------------------------------

Deno.test("E4.1 debit first, then the insert without a rate; the partner's notification quotes the stored rate", async () => {
  setup({ on: true, person: { rate: 20, basis: "existing_partner" }, login: { [PARTNER]: LOGIN_EMAIL } });
  const r = await call(cooInvest, { jwt: "jwt-manager", body: { partner_id: PARTNER, amount: 1_000_000 } });
  eq(r.status, 200, "status");
  const ledgerAt = indexOf((e) => e.kind === "rpc" && e.name === "create_ledger_transaction");
  const insertAt = indexOf((e) => e.kind === "insert" && e.table === "investor_portfolios");
  ok_(ledgerAt >= 0 && ledgerAt < insertAt, "ledger RPC precedes the insert (funding trigger finds the debit)");
  ok_(!("roi_percentage" in inserted("investor_portfolios")[0].payload), "no rate in the insert");
  ok_(String(notificationsTo(PARTNER)[0].message).includes("You'll earn 20% (UGX 200,000) monthly"), "stored rate");
  eq(r.body.monthly_reward, 200_000, "monthly_reward to the manager (partner staff)");
  // E5 (D4): a personal rate goes to the confirmed login email; without one the email has no figures (E15.5a).
  eq([emails()[0].recipientEmail, emails()[0].templateData.roi_percentage], [LOGIN_EMAIL, 20], "email to the login email with the rate");
});

Deno.test("E4.2 insert fails after the debit: 500 with the reference, coo_invest_portfolio_missing event, no notification", async () => {
  setup({});
  failPortfolioInsert();
  const r = await call(cooInvest, { jwt: "jwt-manager", body: { partner_id: PARTNER, amount: 1_000_000 } });
  eq(r.status, 500, "status");
  ok_(r.body.error.startsWith("Funds were moved but the portfolio record failed. Contact Ops with ref WCI"), r.body.error);
  eq(inserted("system_events").flatMap((e) => e.stored!).map((x) => x.event_type), ["coo_invest_portfolio_missing"], "event");
  eq(inserted("notifications").length + emails().length, 0, "no notification or email");
});

// ---- coo-create-portfolio (section 3.1.5) ---------------------------------------------------------

const cooBody = (extra: Record<string, unknown> = {}) => ({
  partner_id: PARTNER, amount: 1_000_000, roi_mode: "monthly_payout", duration_months: 12,
  payment_method: "wallet", source_wallet_user_id: PARTNER, ...extra,
});

Deno.test("coo-create-portfolio: typed rate with the actor header; CFO request records the typist; D11 keys", async () => {
  setup({ on: true, person: { rate: 15, basis: "existing_partner" } });
  const r = await call(cooCreate, { jwt: "jwt-manager", body: cooBody({ roi_percentage: 20, policy_enabled_seen: true }) });
  eq(r.status, 200, "status");
  const ins = inserted("investor_portfolios")[0];
  eq([ins.client!.role, ins.client!.headers["x-welile-actor"], ins.payload.roi_percentage], ["service", MANAGER, 20], "insert");
  eq(table("portfolio_rate_approvals").map((a) => a.requested_by), [MANAGER], "requester");
  eq([r.body.roi_percentage, r.body.requested_roi_percentage, r.body.rate_awaits_cfo], [15, 20, true], "keys");
  const audit = inserted("audit_logs").flatMap((e) => e.stored!)[0];
  eq([audit.metadata.roi_percentage, audit.metadata.requested_roi_percentage], [15, 20], "audit");
});

Deno.test("coo-create-portfolio: no rate typed -> no rate sent, no policy read; old screen typed after switch-on -> 409", async () => {
  setup({ on: true, person: { rate: 15, basis: "existing_partner" } });
  let r = await call(cooCreate, { jwt: "jwt-manager", body: cooBody() });
  eq(r.status, 200, "status");
  ok_(!("roi_percentage" in inserted("investor_portfolios")[0].payload), "no rate");
  eq(rpcCalls("get_partner_return_policy").length, 0, "no policy read");

  setup({ on: true, person: { rate: 15, basis: "existing_partner" } });
  r = await call(cooCreate, { jwt: "jwt-manager", body: cooBody({ roi_percentage: 15 }) });
  eq([r.status, r.body.code], [409, "POLICY_CHANGED"], "409");
  eq(rpcCalls("create_ledger_transaction").length + inserted("investor_portfolios").length, 0, "nothing written");
});

Deno.test("coo-create-portfolio: cto (not partner staff) gets rate_note on a personal row", async () => {
  setup({ on: true, person: { rate: 15, basis: "existing_partner" } });
  signIn("jwt-cto", { id: "99999999-9999-4999-8999-999999999999", email: "cto@welile.test" }, ["cto"]);
  const r = await call(cooCreate, { jwt: "jwt-cto", body: cooBody() });
  eq(r.status, 200, "status");
  ok_(!("roi_percentage" in r.body), "no stored rate");
  eq(r.body.rate_note, "Rates that differ from the person's rate go to the CFO.", "note");
});
