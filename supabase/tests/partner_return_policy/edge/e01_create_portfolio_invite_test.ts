// E1 create-portfolio-invite (design v2 sections 3.1.0, 3.1.1, 10.2).
import { call, emails, eq, invokes, loadHandler, ok_, rpcCalls, state, table, writes } from "./harness.ts";
import { _resetPolicyCacheForTests } from "../../../functions/_shared/partnerReturnPolicy.ts";
import { inviteBody, LOGIN_EMAIL, OPS, PARTNER, PROFILE_EMAIL, seedInvite, world } from "./seed.ts";

const invite = await loadHandler("create-portfolio-invite");

function setup(w: Parameters<typeof world>[0], existingPortfolio = true) {
  _resetPolicyCacheForTests();
  world(w);
  seedInvite({ existingPortfolio });
}
const newRow = () => table("investor_portfolios").find((r) => r.portfolio_code === "WIP26110799001");

Deno.test("E1.1 no rate typed: p_roi_percentage null, no policy read, the gate's 15 comes back (switch off)", async () => {
  setup({});
  const r = await call(invite, { jwt: "jwt-ops", body: inviteBody() });
  eq(r.status, 200, "status");
  eq(rpcCalls("create_pending_portfolio")[0].payload.p_roi_percentage, null, "p_roi_percentage");
  eq(rpcCalls("get_partner_return_policy").length, 0, "no policy read when nothing was typed");
  eq([r.body.roi_percentage, r.body.requested_roi_percentage, r.body.rate_awaits_cfo], [15, null, false], "rate keys");
  eq(newRow()?.rate_basis, "switch_off", "basis");
});

Deno.test("E1.2 typed 20, person's rate 15 (switch on, new screen saw it): stored 15, CFO request by the caller, rate_awaits_cfo", async () => {
  setup({ on: true, person: { rate: 15, basis: "existing_partner" }, login: { [PARTNER]: LOGIN_EMAIL } });
  const r = await call(invite, { jwt: "jwt-ops", body: inviteBody({ roi_percentage: 20, policy_enabled_seen: true }) });
  eq(r.status, 200, "status");
  eq(rpcCalls("get_partner_return_policy").length, 0, "the screen saw the switch on: no extra read");
  eq(rpcCalls("create_pending_portfolio")[0].payload.p_roi_percentage, 20, "typed rate forwarded");
  eq([r.body.roi_percentage, r.body.requested_roi_percentage, r.body.rate_awaits_cfo], [15, 20, true], "rate keys");
  eq(table("portfolio_rate_approvals").map((a) => [a.requested_rate, a.requested_by]), [[20, OPS]], "CFO request with the typist");
  const mail = invokes("send-transactional-email")[0];
  eq([mail.recipientEmail, mail.templateData.roi_percentage], [LOGIN_EMAIL, 15], "invite email: login email, stored rate");
});

Deno.test("E1.3 typed rate from a stale screen after switch-on: 409 POLICY_CHANGED before any write", async () => {
  setup({ on: true, person: { rate: 15, basis: "existing_partner" } });
  const r = await call(invite, { jwt: "jwt-ops", body: inviteBody({ roi_percentage: 15 }) });
  eq(r.status, 409, "status");
  eq(r.body, { error: "The Returns policy changed. Reload the page and check the rate.", code: "POLICY_CHANGED" }, "body");
  eq(rpcCalls("get_partner_return_policy").length, 1, "one uncached policy read");
  eq(rpcCalls("create_pending_portfolio").length + rpcCalls("create_ledger_transaction").length, 0, "no RPC writes");
  eq(writes().filter((w) => ["insert", "update", "upsert", "delete", "invoke", "fetch"].includes(w.kind)).length, 0, "no writes");
  eq(table("investor_portfolios").length, 1, "only the existing portfolio");
});

Deno.test("E1.3b the same old screen while the switch is off: proceeds (typed_switch_off keeps the typed rate)", async () => {
  setup({});
  const r = await call(invite, { jwt: "jwt-ops", body: inviteBody({ roi_percentage: 20 }) });
  eq(r.status, 200, "status");
  eq(rpcCalls("get_partner_return_policy").length, 1, "one policy read (rate typed, nothing seen)");
  eq([newRow()?.roi_percentage, newRow()?.rate_basis], [20, "typed_switch_off"], "stored");
  eq([r.body.roi_percentage, r.body.rate_awaits_cfo], [20, false], "response");
});

Deno.test("E1.3c unreadable policy with a typed rate: 409 (fail closed)", async () => {
  setup({});
  state.rpc.get_partner_return_policy = () => ({ data: null, error: { code: "PGRST202", message: "missing" } });
  const r = await call(invite, { jwt: "jwt-ops", body: inviteBody({ roi_percentage: 20 }) });
  eq(r.status, 409, "status");
});

Deno.test("E1.4 switch-off row: the invite goes to the profile email with the rate, no login-email read", async () => {
  setup({ login: { [PARTNER]: LOGIN_EMAIL } });
  const r = await call(invite, { jwt: "jwt-ops", body: inviteBody({ roi_percentage: 20, policy_enabled_seen: false }) });
  eq(r.status, 200, "status");
  const mail = invokes("send-transactional-email")[0];
  eq([mail.recipientEmail, mail.templateData.roi_percentage], [PROFILE_EMAIL, 20], "email");
  eq(rpcCalls("partner_confirmed_login_emails").length, 0, "no login-email RPC for a public row");
});

Deno.test("E1.5 personal row: login email with figures; no login email -> profile email without the rate", async () => {
  setup({ on: true, person: { rate: 15, basis: "existing_partner" }, login: { [PARTNER]: LOGIN_EMAIL } });
  await call(invite, { jwt: "jwt-ops", body: inviteBody() });
  let mail = invokes("send-transactional-email")[0];
  eq([mail.recipientEmail, mail.templateData.roi_percentage], [LOGIN_EMAIL, 15], "with login");

  setup({ on: true, person: { rate: 15, basis: "existing_partner" }, login: {} });
  await call(invite, { jwt: "jwt-ops", body: inviteBody() });
  mail = invokes("send-transactional-email")[0];
  eq(mail.recipientEmail, PROFILE_EMAIL, "fallback recipient");
  ok_(!("roi_percentage" in mail.templateData), "no rate in the figure-free email");
  eq(rpcCalls("partner_confirmed_login_emails").length, 1, "one login-email RPC");
});

Deno.test("E1.6 an invalid typed rate is refused with the Returns wording", async () => {
  for (const bad of ["abc", 0, 150, -1]) {
    setup({});
    const r = await call(invite, { jwt: "jwt-ops", body: inviteBody({ roi_percentage: bad }) });
    eq([r.status, r.body.error], [400, "Monthly Returns rate must be above 0% and at most 100%"], `rate ${bad}`);
    eq(rpcCalls("create_pending_portfolio").length, 0, "no RPC");
  }
  setup({});
  const r = await call(invite, { jwt: "jwt-ops", body: inviteBody({ roi_mode: "weekly" }) });
  eq(r.body.error, "Invalid Returns mode", "mode wording");
});

Deno.test("E1.7 D11: a caller outside partner staff gets rate_note on a personal row", async () => {
  setup({ on: true, person: { rate: 15, basis: "existing_partner" } });
  const r = await call(invite, { jwt: "jwt-operations", body: inviteBody() });
  eq(r.status, 200, "status");
  ok_(!("roi_percentage" in r.body) && !("requested_roi_percentage" in r.body) && !("rate_awaits_cfo" in r.body), "no rate keys");
  eq(r.body.rate_note, "Rates that differ from the person's rate go to the CFO.", "note");
});

Deno.test("E1.8 first portfolio (direct confirmation): agreement email to the login email with the stored rate and figures", async () => {
  setup({ on: true, person: { rate: 20, basis: "employee" }, login: { [PARTNER]: LOGIN_EMAIL } }, false);
  const r = await call(invite, { jwt: "jwt-ops", body: inviteBody() });
  eq([r.status, r.body.mode], [200, "direct_confirmation"], "direct branch");
  const mail = emails()[0];
  eq([mail.recipientEmail, mail.templateData.roi_percentage, mail.templateData.monthly_return_amount], [LOGIN_EMAIL, 20, 200_000], "agreement email");

  setup({ on: true, person: { rate: 20, basis: "employee" }, login: {} }, false);
  await call(invite, { jwt: "jwt-ops", body: inviteBody() });
  const bare = emails()[0];
  eq(bare.recipientEmail, PROFILE_EMAIL, "fallback recipient");
  for (const k of ["roi_percentage", "monthly_return_amount", "total_projected_return"]) ok_(!(k in bare.templateData), `${k} absent`);
});
