// E2 create-investor-portfolio (design v2 sections 3.1.0, 3.1.2, owner decisions D1, D11).
import { call, deterministic, emails, eq, inserted, loadHandler, ok_, POLICY_OFF, POLICY_ON, rpcCalls, table } from "./harness.ts";
import { _resetPolicyCacheForTests, cachedPublicPolicy } from "../../../functions/_shared/partnerReturnPolicy.ts";
import { AGENT, investorBody, LOGIN_EMAIL, MANAGER, PARTNER, PROFILE_EMAIL, seedInvestorPortfolio, world } from "./seed.ts";

const create = await loadHandler("create-investor-portfolio");

function setup(w: Parameters<typeof world>[0], cachedPolicy?: unknown) {
  _resetPolicyCacheForTests();
  world(w);
  seedInvestorPortfolio();
  if (cachedPolicy !== undefined) {
    // Prime the isolate cache (60 s) with an answer that may differ from the database: the stale case.
    return deterministic(() => cachedPublicPolicy({ rpc: () => Promise.resolve({ data: cachedPolicy, error: null }) }));
  }
}
const portfolioInsert = () => inserted("investor_portfolios")[0];

Deno.test("E2.1 field agent, row basis 'new', cached policy still says OFF: no rate and no token in the response", async () => {
  await setup({ on: true, person: { rate: 10, basis: "new" } }, POLICY_OFF);
  const r = await call(create, { jwt: "jwt-agent", body: investorBody({ roi_percentage: 20 }) });
  eq(r.status, 200, "status");
  eq(portfolioInsert().payload.roi_percentage, 20, "stale cache: the typed rate is forwarded (it can only reach the CFO)");
  eq([portfolioInsert().stored![0].roi_percentage, portfolioInsert().stored![0].rate_basis], [10, "new"], "the gate decided");
  eq(table("portfolio_rate_approvals").map((a) => [a.requested_rate, a.requested_by]), [[20, AGENT]], "CFO request, actor header");
  ok_(!("roi_percentage" in r.body.portfolio), "no roi_percentage to the field agent");
  ok_(!("activation_token" in r.body.portfolio), "no activation token (the page would show the partner's rate)");
  ok_(!("requested_roi_percentage" in r.body.portfolio) && !("rate_note" in r.body.portfolio), "no other rate keys");
  const mail = emails()[0];
  eq(mail.recipientEmail, PROFILE_EMAIL, "no login email: profile email");
  ok_(!("roi_percentage" in mail.templateData) && !("monthly_return_amount" in mail.templateData), "figure-free");
  eq(rpcCalls("partner_confirmed_login_emails").length, 1, "one login-email RPC for a personal row");
});

Deno.test("E2.1b D1: field agent with the switch on (cache agrees): typed rate dropped, gate decides, no CFO request", async () => {
  await setup({ on: true, person: { rate: 10, basis: "new" }, login: { [PARTNER]: LOGIN_EMAIL } }, POLICY_ON);
  const r = await call(create, { jwt: "jwt-agent", body: investorBody({ roi_percentage: 20 }) });
  eq(r.status, 200, "status");
  ok_(!("roi_percentage" in portfolioInsert().payload), "no rate sent");
  eq(table("portfolio_rate_approvals").length, 0, "no CFO request");
  const mail = emails()[0];
  eq([mail.recipientEmail, mail.templateData.roi_percentage, mail.templateData.monthly_return_amount], [LOGIN_EMAIL, 10, 100_000], "login email with figures");
});

Deno.test("E2.2 switch off: today's response (rate and activation token), profile email with figures", async () => {
  await setup({});
  const r = await call(create, { jwt: "jwt-agent", body: investorBody() });
  eq(r.status, 200, "status");
  eq(r.body.portfolio.roi_percentage, 15, "rate in the response");
  ok_("activation_token" in r.body.portfolio, "activation token kept");
  eq(portfolioInsert().stored![0].rate_basis, "switch_off", "basis");
  const mail = emails()[0];
  eq([mail.recipientEmail, mail.templateData.roi_percentage, mail.templateData.monthly_return_amount], [PROFILE_EMAIL, 15, 150_000], "email as today");
  eq(rpcCalls("partner_confirmed_login_emails").length, 0, "no login-email read for a public row");
});

Deno.test("E2.3 back office typed rate: the service-role insert carries x-welile-actor; the CFO request records the typist", async () => {
  await setup({ on: true, person: { rate: 15, basis: "existing_partner" } });
  const r = await call(create, {
    jwt: "jwt-manager",
    body: investorBody({ roi_percentage: 20, invite_id: "invite-1", policy_enabled_seen: true }),
  });
  eq(r.status, 200, "status");
  const ins = portfolioInsert();
  eq([ins.client!.role, ins.client!.headers["x-welile-actor"]], ["service", MANAGER], "actor header on the insert");
  eq(table("portfolio_rate_approvals").map((a) => [a.requested_rate, a.requested_by]), [[20, MANAGER]], "requester");
  eq([r.body.portfolio.roi_percentage, r.body.portfolio.requested_roi_percentage, r.body.portfolio.rate_awaits_cfo], [15, 20, true], "D11 keys for partner staff");
  eq(rpcCalls("get_partner_return_policy").length, 1, "only the cached display read (screen saw the switch)");
});

Deno.test("E2.3b back office typed rate from an old screen after switch-on: 409, nothing written", async () => {
  await setup({ on: true, person: { rate: 15, basis: "existing_partner" } }, POLICY_ON);
  const r = await call(create, { jwt: "jwt-manager", body: investorBody({ roi_percentage: 15, invite_id: "invite-1" }) });
  eq([r.status, r.body.code], [409, "POLICY_CHANGED"], "409");
  eq(inserted("investor_portfolios").length + rpcCalls("generate_portfolio_code").length, 0, "nothing written");
});

Deno.test("E2.4 operations (not partner staff) on a personal row: rate_note, no rate keys", async () => {
  await setup({ on: true, person: { rate: 15, basis: "existing_partner" } });
  const r = await call(create, { jwt: "jwt-operations", body: investorBody({ investor_id: undefined }) });
  eq(r.status, 200, "status");
  // investor_id absent -> basis new_no_investor (public); use a partner row for the personal case:
  ok_("roi_percentage" in r.body.portfolio, "public basis (no investor): the rate is public");
  await setup({ on: true, person: { rate: 15, basis: "existing_partner" } });
  const r2 = await call(create, { jwt: "jwt-operations", body: investorBody({ invite_id: "invite-1" }) });
  eq(r2.status, 200, "status");
  ok_(!("roi_percentage" in r2.body.portfolio) && !("rate_awaits_cfo" in r2.body.portfolio), "no rate keys");
  eq(r2.body.portfolio.rate_note, "Rates that differ from the person's rate go to the CFO.", "note");
});

Deno.test("E2.5 a string rate is not a typed rate (origin's number-only typing)", async () => {
  await setup({}, POLICY_OFF);
  const r = await call(create, { jwt: "jwt-agent", body: investorBody({ roi_percentage: "20" }) });
  eq(r.status, 200, "status");
  ok_(!("roi_percentage" in portfolioInsert().payload), "no rate sent");
  eq(r.body.portfolio.roi_percentage, 15, "gate's 15");
});
