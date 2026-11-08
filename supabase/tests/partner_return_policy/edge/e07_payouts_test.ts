// E7 process-supporter-roi and E8 fund-tenants (design v2 sections 3.3.1, 3.3.2; v1 tables).
import { call, emails, eq, inserted, loadHandler, ok_, rpcCalls, state } from "./harness.ts";
import { LOGIN_EMAIL, PARTNER, POLICY_OFF_AFTER_CUTOFF, PROFILE_EMAIL, RR, RRS, seedFundTenants, seedRoi, world } from "./seed.ts";

const roi = await loadHandler("process-supporter-roi");
const fund = await loadHandler("fund-tenants");

const notes = () => inserted("notifications").flatMap((e) => e.stored!);
const events = (type: string) => rpcCalls("log_system_event").filter((e) => e.payload.p_event_type === type);

// ---- E7 process-supporter-roi --------------------------------------------------------------------

Deno.test("E7.1 wallet path: every downstream figure is the posted amount (10,000 at 10%), never rent x 15%", async () => {
  world({});
  seedRoi({ reinvest: false, posted: { status: "posted", amount: 10_000, rate: 10 } });
  const r = await call(roi, { body: {} });
  eq([r.status, r.body.results.credited, r.body.results.totalAmount], [200, 1, 10_000], "results");
  const post = rpcCalls("post_rent_facilitation_reward")[0].payload;
  ok_(!String(post.p_wallet_description).includes("%"), `rate-free ledger text: ${post.p_wallet_description}`);
  eq(post.p_wallet_description, "Monthly Returns (payment #2) on rent facilitation of UGX 1,000,000", "description");
  eq(rpcCalls("apply_roi_advance_recovery")[0].payload.p_roi_amount, 10_000, "advance recovery");
  eq(rpcCalls("apply_smartphone_roi_pledge")[0].payload.p_roi_amount, 10_000, "phone pledge");
  ok_(String(notes()[0].message).includes("UGX 10,000 (payment #2)"), notes()[0].message);
  eq(emails()[0].templateData.amount ?? emails()[0].templateData.returns_amount ?? emails()[0].templateData.payout_amount, 10_000, "processing email amount");
  eq(events("roi_distributed")[0].payload.p_metadata.amount, 10_000, "event amount");
});

Deno.test("E7.2 reinvest after the cut-off: the compound email states the PAID rate (10%) and amount, to the confirmed login email", async () => {
  world({ on: true, login: { [PARTNER]: LOGIN_EMAIL } });
  seedRoi({ reinvest: true, posted: { status: "posted", amount: 10_000, rate: 10, new_principal: 2_010_000, previous_principal: 2_000_000 } });
  const r = await call(roi, { body: {} });
  eq([r.status, r.body.results.reinvested], [200, 1], "reinvested");
  const mail = emails().find((m) => m.templateName === "partner-portfolio-compounded" || m.templateName === "partner-compound");
  ok_(mail, "compound email sent");
  eq([mail.recipientEmail, mail.templateData.roi_percentage, mail.templateData.roi_return, mail.templateData.return_amount], [LOGIN_EMAIL, 10, "10%", 10_000], "paid rate, never derived");
  ok_(String(notes()[0].title).includes("Returns Auto-Reinvested"), "title wording");
  eq(rpcCalls("partner_confirmed_login_emails").length, 1, "one login-email RPC per run");
});

Deno.test("E7.2b reinvest, posted without a rate (production before Phase 2): no rate line in the compound email", async () => {
  world({ login: { [PARTNER]: LOGIN_EMAIL } });
  seedRoi({ reinvest: true, posted: { status: "posted", amount: 300_000, new_principal: 2_300_000, previous_principal: 2_000_000 } });
  await call(roi, { body: {} });
  const mail = emails()[0];
  ok_(!("roi_percentage" in mail.templateData) && !("roi_return" in mail.templateData), "no rate");
  eq(mail.templateData.return_amount, 300_000, "amount");
});

Deno.test("E7.2c reinvest after the cut-off with no confirmed login email: no compound email (builder's choice; see report), in-app notice still sent", async () => {
  for (const w of [{ on: true, login: {} }, { policy: POLICY_OFF_AFTER_CUTOFF, login: {} }]) {
    world(w);
    seedRoi({ reinvest: true, posted: { status: "posted", amount: 10_000, rate: 10, new_principal: 2_010_000, previous_principal: 2_000_000 } });
    await call(roi, { body: {} });
    eq(emails().length, 0, "no email");
    eq(notes().length, 1, "in-app notice");
  }
});

Deno.test("E7.2d reinvest before the first switch-on (F1): the compound email goes to origin's profile email with the paid rate, login email or not; no login-email RPC", async () => {
  for (const login of [{ [PARTNER]: LOGIN_EMAIL }, {}] as Record<string, string>[]) {
    world({ login });
    seedRoi({ reinvest: true, posted: { status: "posted", amount: 150_000, rate: 15, new_principal: 2_150_000, previous_principal: 2_000_000 } });
    await call(roi, { body: {} });
    const mail = emails().find((m) => m.templateName === "partner-portfolio-compounded" || m.templateName === "partner-compound");
    eq([mail?.recipientEmail, mail?.templateData.roi_percentage, mail?.templateData.return_amount], [PROFILE_EMAIL, 15, 150_000], `no cut-off, login ${JSON.stringify(login)}`);
    eq([rpcCalls("partner_confirmed_login_emails").length, rpcCalls("get_partner_return_policy").length], [0, 1], "one policy read, no login read");
  }
});

Deno.test("E7.2e reinvest with an unreadable policy: fails closed (after-cut-off rules: login email, or no compound email)", async () => {
  for (const [login, want] of [[{ [PARTNER]: LOGIN_EMAIL }, [LOGIN_EMAIL]], [{}, []]] as [Record<string, string>, string[]][]) {
    world({ login });
    state.rpc.get_partner_return_policy = () => ({ data: null, error: { code: "PGRST202", message: "missing" } });
    seedRoi({ reinvest: true, posted: { status: "posted", amount: 150_000, rate: 15, new_principal: 2_150_000, previous_principal: 2_000_000 } });
    await call(roi, { body: {} });
    eq(emails().map((m) => m.recipientEmail), want, `login ${JSON.stringify(login)}`);
  }
});

Deno.test("E7.3 posted without an amount: no side effects, the error and an event are recorded", async () => {
  world({});
  seedRoi({ reinvest: false, posted: { status: "posted", rate: 10 } });
  const r = await call(roi, { body: {} });
  eq(r.status, 200, "status");
  eq(notes().length + emails().length, 0, "no notices");
  eq(rpcCalls("apply_roi_advance_recovery").length + rpcCalls("apply_smartphone_roi_pledge").length, 0, "no recovery or pledge");
  ok_(r.body.results.errors.some((e: string) => e.includes(`${RR}: reward #2 posted without an amount`)), "error recorded");
  eq(events("rent_reward_amount_missing").length, 1, "event");
  eq(r.body.results.totalAmount, 0, "nothing counted");
});

Deno.test("E7.4 RENT_REWARD_RATE_MISSING defers (logged), never an error or a guessed rate", async () => {
  world({});
  seedRoi({ reinvest: false, posted: null });
  state.rpc.post_rent_facilitation_reward = () => ({ data: null, error: { code: "P0001", message: "RENT_REWARD_RATE_MISSING: no stored rate" } });
  const r = await call(roi, { body: {} });
  eq([r.body.results.rewardsDeferred, r.body.results.errors.length], [1, 0], "deferred");
  eq(events("rent_reward_deferred")[0].payload.p_metadata.reason, "rate_missing", "reason");
  eq(notes().length, 0, "no notice");
});

// ---- E8 fund-tenants ------------------------------------------------------------------------------

const supporterNote = () => notes().find((n) => n.user_id === PARTNER && String(n.title).startsWith("Funding Complete"));

Deno.test("E8.1 three fundings stored at 15: 'Your 15% monthly reward', expected_roi = round(total*0.15)", async () => {
  world({});
  seedFundTenants([15, 15, 15]);
  const r = await call(fund, { jwt: "jwt-partner", body: { rent_request_ids: RRS } });
  eq(r.status, 200, "status");
  ok_(String(supporterNote()?.message).endsWith("Your 15% monthly reward will be credited automatically."), supporterNote()?.message);
  eq(r.body.details.expected_roi, Math.round(r.body.details.total_funded * 0.15), "expected_roi");
  eq(state.reads.filter((x) => x.table === "rent_facilitation_reward_rates").length, 1, "one select for 3 requests");
});

Deno.test("E8.2 mixed stored rates: no % and expected_roi null", async () => {
  world({});
  seedFundTenants([15, 10, 15]);
  const r = await call(fund, { jwt: "jwt-partner", body: { rent_request_ids: RRS } });
  ok_(String(supporterNote()?.message).endsWith("Your monthly Returns will be credited automatically."), supporterNote()?.message);
  eq(r.body.details.expected_roi, null, "expected_roi");
});

Deno.test("E8.3 a missing stored rate or a select error: no %", async () => {
  world({});
  seedFundTenants([15, null, 15]);
  let r = await call(fund, { jwt: "jwt-partner", body: { rent_request_ids: RRS } });
  ok_(!String(supporterNote()?.message).includes("%"), "missing rate");
  eq(r.body.details.expected_roi, null, "expected_roi");

  world({});
  seedFundTenants([15, 15, 15]);
  state.failSelect = (t) => (t === "rent_facilitation_reward_rates" ? { code: "42P01", message: "relation does not exist" } : null);
  r = await call(fund, { jwt: "jwt-partner", body: { rent_request_ids: RRS } });
  eq(r.status, 200, "status");
  ok_(!String(supporterNote()?.message).includes("%"), "select error");
});
