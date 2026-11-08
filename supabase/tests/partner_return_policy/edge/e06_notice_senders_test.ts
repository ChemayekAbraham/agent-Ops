// E6 notice senders read the rate stored on the queued row (design v2 section 3.2; owner decision D4).
import { call, eq, invokes, loadHandler, ok_, rpcCalls, state, table } from "./harness.ts";
import { bookingNotice, LOGIN_EMAIL, PARTNER, pledgeNotice, POLICY_OFF_AFTER_CUTOFF, PROFILE_EMAIL, progressNotice, world } from "./seed.ts";

const booking = await loadHandler("notify-house-booking");
const pledge = await loadHandler("notify-promissory-note-pledge");
const progress = await loadHandler("notify-funder-house-progress");

const smsBodies = () => state.log.filter((e) => e.kind === "fetch" && String(e.name).includes("yoolasms.com")).map((e) => String(e.payload?.message ?? ""));

Deno.test("E6.1 house booking: row rate 20 -> email 20% and monthly_return round(rent*0.2); null -> no rate, no figure", async () => {
  world({});
  table("promissory_house_booking_notices").push(bookingNotice({ return_rate: 20, total_rent: 1_234_567 }));
  let r = await call(booking, { body: {} });
  eq(r.status, 200, "status");
  let data = invokes("send-transactional-email")[0].data;
  eq([data.return_rate, data.monthly_return], [20, Math.round(1_234_567 * 0.2)], "rate 20");

  world({});
  table("promissory_house_booking_notices").push(bookingNotice({ return_rate: null }));
  r = await call(booking, { body: {} });
  data = invokes("send-transactional-email")[0].data;
  eq([data.return_rate, data.monthly_return], [null, 0], "no stored rate: no figure");

  world({});
  table("promissory_house_booking_notices").push(bookingNotice({ return_rate: "15.00", total_rent: 1_000_001 }));
  await call(booking, { body: {} });
  data = invokes("send-transactional-email")[0].data;
  eq([data.return_rate, data.monthly_return], [15, Math.round(1_000_001 * 0.15)], "numeric string from PostgREST");
});

Deno.test("E6.2 pledge: row rate 20 -> roi_percentage 20; null -> null and no 'You earn' when there is no monthly figure", async () => {
  world({});
  table("promissory_note_pledge_notices").push(pledgeNotice({ return_rate: 20, monthly_return: 200_000 }));
  await call(pledge, { body: {} });
  eq(invokes("send-transactional-email")[0].data.roi_percentage, 20, "rate");
  ok_(smsBodies()[0].includes("You earn UGX 200,000/month."), smsBodies()[0]);
  const sel = state.reads.find((x) => x.table === "promissory_note_pledge_notices");
  eq(sel?.select, "*, promissory_notes!inner(agent_id)", "select * (carries return_rate)");

  world({});
  table("promissory_note_pledge_notices").push(pledgeNotice({ return_rate: null, monthly_return: 0, annual_return: 0 }));
  await call(pledge, { body: {} });
  eq(invokes("send-transactional-email")[0].data.roi_percentage, null, "no rate");
  ok_(!smsBodies()[0].includes("You earn"), smsBodies()[0]);
});

Deno.test("E6.3 house progress after the cut-off: email to the confirmed login email with figures; none -> profile email, figure-free; one RPC per batch", async () => {
  world({ on: true, login: { [PARTNER]: LOGIN_EMAIL } });
  table("funder_house_progress_notices").push(
    progressNotice({ return_rate: 20, monthly_return: 200_000 }),
    progressNotice({ return_rate: 20, monthly_return: 200_000, kind: "tenant_placed" }),
  );
  await call(progress, { body: {} });
  const mails = invokes("send-transactional-email");
  eq(mails.map((m) => [m.to, m.data.return_rate, m.data.monthly_return]), [[LOGIN_EMAIL, 20, 200_000], [LOGIN_EMAIL, 20, 200_000]], "login email");
  eq(rpcCalls("partner_confirmed_login_emails").length, 1, "one RPC for the batch");

  world({ on: true, login: {} });
  table("funder_house_progress_notices").push(progressNotice({ return_rate: 20, monthly_return: 200_000 }));
  await call(progress, { body: {} });
  const m = invokes("send-transactional-email")[0];
  eq([m.to, m.data.return_rate, m.data.monthly_return], [PROFILE_EMAIL, null, 0], "figure-free to the profile email");
  ok_(smsBodies()[0].includes("about UGX 200,000/month"), "SMS keeps the profile phone and figure (accepted residual, D4)");

  world({});
  table("funder_house_progress_notices").push(progressNotice({ return_rate: null, monthly_return: 0 }));
  await call(progress, { body: {} });
  ok_(smsBodies()[0].includes("your Returns have started; see your dashboard."), smsBodies()[0]);
});

Deno.test("E6.3b house progress before the first switch-on (F1): origin's recipient (the row's email) and figures, login email or not; no login-email RPC", async () => {
  for (const login of [{ [PARTNER]: LOGIN_EMAIL }, {}] as Record<string, string>[]) {
    world({ login });
    table("funder_house_progress_notices").push(
      progressNotice({ return_rate: 15, monthly_return: 150_000 }),
      progressNotice({ return_rate: 15, monthly_return: 150_000, kind: "tenant_placed" }),
    );
    await call(progress, { body: {} });
    eq(invokes("send-transactional-email").map((m) => [m.to, m.data.return_rate, m.data.monthly_return]),
      [[PROFILE_EMAIL, 15, 150_000], [PROFILE_EMAIL, 15, 150_000]], `no cut-off, login ${JSON.stringify(login)}`);
    eq([rpcCalls("partner_confirmed_login_emails").length, rpcCalls("get_partner_return_policy").length], [0, 1], "one policy read, no login read");
  }
});

Deno.test("E6.3c house progress switched off again after the cut-off: personal rules hold", async () => {
  world({ policy: POLICY_OFF_AFTER_CUTOFF, login: { [PARTNER]: LOGIN_EMAIL } });
  table("funder_house_progress_notices").push(progressNotice({ return_rate: 15, monthly_return: 150_000 }));
  await call(progress, { body: {} });
  eq(invokes("send-transactional-email").map((m) => [m.to, m.data.return_rate]), [[LOGIN_EMAIL, 15]], "login email");
  world({ policy: POLICY_OFF_AFTER_CUTOFF });
  table("funder_house_progress_notices").push(progressNotice({ return_rate: 15, monthly_return: 150_000 }));
  await call(progress, { body: {} });
  eq(invokes("send-transactional-email").map((m) => [m.to, m.data.return_rate, m.data.monthly_return]), [[PROFILE_EMAIL, null, 0]], "figure-free");
});

Deno.test("E6.3d house progress with an unreadable policy: fails closed (the after-cut-off rules)", async () => {
  world({ login: { [PARTNER]: LOGIN_EMAIL } });
  state.rpc.get_partner_return_policy = () => ({ data: null, error: { code: "PGRST202", message: "missing" } });
  table("funder_house_progress_notices").push(progressNotice({ return_rate: 15, monthly_return: 150_000 }));
  await call(progress, { body: {} });
  eq(invokes("send-transactional-email").map((m) => m.to), [LOGIN_EMAIL], "login email");
});

Deno.test("E6.4 already-emailed rows make no login-email RPC", async () => {
  world({ on: true, login: { [PARTNER]: LOGIN_EMAIL } });
  table("funder_house_progress_notices").push(progressNotice({ email_sent_at: "2026-11-07T00:00:00Z" }));
  await call(progress, { body: {} });
  eq(rpcCalls("partner_confirmed_login_emails").length, 0, "no RPC");
});
