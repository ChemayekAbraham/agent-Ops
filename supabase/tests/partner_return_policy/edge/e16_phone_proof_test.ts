// E16 phone proof (fix round 3 F2, withdrawn in Phase 4 round 4 U1; design v2 D3, section 8.4).
// phone-signup, confirm-phone-account and self-update-phone only READ an otp_verifications row, which is
// keyed by the last 9 digits and tied to no session or user (otp-login marks it verified whenever the real
// holder signs in). That cannot prove the number belongs to the caller, so none of the three records a
// proof or runs the linker: every path, success or refusal, writes no otp_login_audit row and makes no
// link_promissory_notes_for_user call, and all three files are byte-identical to origin/lovable (E11.29-31
// golden). _shared/phoneProof.ts stays as an unused helper that no function imports (E16.10).
// deno-lint-ignore-file no-explicit-any
import { call, eq, inserted, loadHandler, ok_, rpcCalls, SERVICE_KEY, signIn, state, table } from "./harness.ts";
import { world } from "./seed.ts";
import { phoneProofRow, recordPhoneProofAndLink } from "../../../functions/_shared/phoneProof.ts";

const signup = await loadHandler("phone-signup");
const confirm = await loadHandler("confirm-phone-account");
const selfPhone = await loadHandler("self-update-phone");

const NEW_PHONE = "256772000999"; // digits as the browser sends them
const LAST9 = "772000999";
const OTHER_LAST9 = "772000888";
const NOW = Date.parse("2026-11-07T09:00:00.000Z"); // harness FIXED_NOW
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const proofs = () => inserted("otp_login_audit").flatMap((e) => e.stored!);
const links = () => rpcCalls("link_promissory_notes_for_user");
/** Nothing recorded, nothing linked: no otp_login_audit write of any kind, no linker call. */
function noProof(what: string) {
  eq([proofs().length, links().length, state.log.filter((e) => e.table === "otp_login_audit").length], [0, 0, 0], `${what}: no proof, no link`);
}

function otp(last9: string, verified: boolean, at: string | null) {
  table("otp_verifications").push({ phone: last9, verified, verified_at: at });
}

// ---- phone-signup -----------------------------------------------------------------------------------

const signupBody = (extra: Record<string, unknown> = {}) => ({
  email: `${LAST9}@welile.user`, password: "secret1", full_name: "Nora New", phone: NEW_PHONE, ...extra,
});

function signupWorld() {
  world({});
  state.rpc.link_promissory_notes_for_user = () => ({ data: 1, error: null });
}

Deno.test("E16.1 phone-signup: a verified code creates the account but records no proof and links nothing", async () => {
  signupWorld();
  otp(LAST9, true, ago(5));
  const r = await call(signup, { body: signupBody() });
  eq([r.status, r.body.success], [200, true], "created");
  ok_(state.authUsers.some((u) => u.id === r.body.user_id), "the auth user exists");
  noProof("signup with a verified code");
});

Deno.test("E16.2 phone-signup: refused (unverified, too old, missing, other number) -> no account, no proof, no link", async () => {
  for (const [what, seed] of [
    ["unverified", () => otp(LAST9, false, ago(5))],
    ["verified 31 minutes ago", () => otp(LAST9, true, ago(31))],
    ["no code at all", () => {}],
    ["code verified for another number", () => otp(OTHER_LAST9, true, ago(5))],
  ] as [string, () => void][]) {
    signupWorld();
    seed();
    const r = await call(signup, { body: signupBody() });
    eq(r.status, 403, `${what}: refused`);
    eq(state.log.filter((e) => e.kind === "auth" && e.name === "admin.createUser").length, 0, `${what}: no account`);
    noProof(what);
  }
});

Deno.test("E16.3 phone-signup: a refused signup (number already registered, createUser error, device cap) records nothing", async () => {
  signupWorld();
  otp(LAST9, true, ago(5));
  table("profiles").push({ id: "99999999-0000-4000-8000-000000000001", phone: `+${NEW_PHONE}` });
  eq((await call(signup, { body: signupBody() })).status, 409, "already registered");
  noProof("already registered");

  signupWorld();
  otp(LAST9, true, ago(5));
  state.authCreateUser = () => ({ data: { user: null }, error: { message: "Database error saving new user" } });
  eq((await call(signup, { body: signupBody() })).status, 500, "createUser error");
  noProof("createUser error");

  signupWorld();
  otp(LAST9, true, ago(5));
  state.rpc.signup_device_block_reason = () => ({ data: "Too many accounts on this device", error: null });
  eq((await call(signup, { body: signupBody({ device_fp: "a".repeat(64) }) })).status, 403, "device cap");
  noProof("device cap");
});

Deno.test("E16.4 phone-signup: a holder's verified code is not proof for another person's signup (U1: nothing recorded)", async () => {
  // The real holder signed in by OTP two minutes ago (otp-login marked the row verified). Someone else now
  // signs up with that number inside the 30-minute window. Origin lets the signup through; nothing may
  // record that this account proved the number or link the holder's notes to it.
  signupWorld();
  otp(LAST9, true, ago(2));
  const r = await call(signup, { body: signupBody({ full_name: "Sam Other" }) });
  eq(r.status, 200, "origin behaviour: the signup itself goes through");
  noProof("another person inside the window");
});

// ---- confirm-phone-account ------------------------------------------------------------------------------

const PHONE_USER = "abababab-0000-4000-8000-000000000001";
function confirmWorld(user: Record<string, unknown> = {}) {
  world({});
  state.rpc.link_promissory_notes_for_user = () => ({ data: 0, error: null });
  state.authUsers.push({
    id: PHONE_USER, email: `${LAST9}@welile.user`, email_confirmed_at: null, created_at: ago(4),
    user_metadata: { phone: NEW_PHONE }, ...user,
  });
}

Deno.test("E16.5 confirm-phone-account: a successful confirmation records no proof and links nothing", async () => {
  for (const [what, extra] of [
    ["code verified before the account existed", {}],
    ["code verified after the account was created", { created_at: ago(10) }],
    ["no created_at on the account", { created_at: null }],
  ] as [string, Record<string, unknown>][]) {
    confirmWorld(extra);
    otp(LAST9, true, ago(5));
    const r = await call(confirm, { body: { user_id: PHONE_USER, phone: NEW_PHONE } });
    eq([r.status, r.body], [200, { success: true }], `${what}: confirmed`);
    noProof(what);
  }
});

Deno.test("E16.6 confirm-phone-account: already confirmed, failed or missing code, mismatched number, real email -> nothing recorded", async () => {
  const cases: [string, () => void, number][] = [
    ["already confirmed", () => { confirmWorld({ email_confirmed_at: ago(3) }); otp(LAST9, true, ago(5)); }, 200],
    ["unverified code", () => { confirmWorld(); otp(LAST9, false, ago(5)); }, 403],
    ["code too old", () => { confirmWorld(); otp(LAST9, true, ago(31)); }, 403],
    ["code for another number", () => { confirmWorld(); otp(OTHER_LAST9, true, ago(5)); }, 403],
    ["number does not match the account", () => { confirmWorld({ email: `${OTHER_LAST9}@welile.user`, user_metadata: { phone: `256${OTHER_LAST9}` } }); otp(LAST9, true, ago(5)); }, 403],
    ["real email account", () => { confirmWorld({ email: "nora@example.com" }); otp(LAST9, true, ago(5)); }, 403],
  ];
  for (const [what, seed, status] of cases) {
    seed();
    const r = await call(confirm, { body: { user_id: PHONE_USER, phone: NEW_PHONE } });
    eq(r.status, status, `${what}: status`);
    noProof(what);
  }
});

// ---- self-update-phone ------------------------------------------------------------------------------------

const CALLER = "cdcdcdcd-0000-4000-8000-000000000001";
const SAVED = "+256772000999";
function selfWorld(oldPhone: string | null) {
  world({});
  state.rpc.link_promissory_notes_for_user = () => ({ data: 1, error: null });
  signIn("jwt-caller", { id: CALLER, email: "cara@example.com", email_confirmed_at: ago(60 * 24 * 30), phone: oldPhone });
  table("profiles").push({ id: CALLER, full_name: "Cara Caller", phone: oldPhone });
  table("email_verification_challenges");
  table("audit_logs");
}

Deno.test("E16.7 self-update-phone, first phone: the number is saved but no proof is recorded and nothing is linked", async () => {
  selfWorld(null);
  otp(LAST9, true, ago(5));
  const r = await call(selfPhone, { jwt: "jwt-caller", body: { phone: "0772000999" } });
  eq([r.status, r.body.success, r.body.phone], [200, true, SAVED], "saved");
  eq(table("profiles").find((p) => p.id === CALLER)?.phone, SAVED, "profile phone");
  noProof("first phone");
});

Deno.test("E16.8 self-update-phone: no proof for a failed, old or other-number code, an unauthenticated call, or a phone CHANGE", async () => {
  for (const [what, seed] of [
    ["unverified code", () => otp(LAST9, false, ago(5))],
    ["code verified 11 minutes ago", () => otp(LAST9, true, ago(11))],
    ["code for another number", () => otp(OTHER_LAST9, true, ago(5))],
  ] as [string, () => void][]) {
    selfWorld(null);
    seed();
    const r = await call(selfPhone, { jwt: "jwt-caller", body: { phone: "0772000999" } });
    eq(r.status, 403, `${what}: refused`);
    noProof(what);
  }

  selfWorld(null);
  otp(LAST9, true, ago(5));
  eq((await call(selfPhone, { body: { phone: "0772000999" } })).status, 401, "no session");
  noProof("no session");

  // A phone change (old phone present) with a valid emailed approval code: saved, but no proof row.
  selfWorld("+256772000111");
  otp(LAST9, true, ago(5));
  const code = "123456";
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  table("phone_change_otp_challenges").push({
    id: "ch-1", user_id: CALLER, status: "pending", new_phone_last9: LAST9, otp_hash: hash, attempts: 0, max_attempts: 5,
    otp_expires_at: new Date(NOW + 5 * 60_000).toISOString(), created_at: ago(1),
  });
  const r = await call(selfPhone, { jwt: "jwt-caller", body: { phone: "0772000999", old_phone_code: code } });
  eq([r.status, r.body.success], [200, true], "changed");
  noProof("phone change");

  // The same change with a wrong approval code: refused, nothing recorded.
  selfWorld("+256772000111");
  otp(LAST9, true, ago(5));
  table("phone_change_otp_challenges").push({
    id: "ch-2", user_id: CALLER, status: "pending", new_phone_last9: LAST9, otp_hash: hash, attempts: 0, max_attempts: 5,
    otp_expires_at: new Date(NOW + 5 * 60_000).toISOString(), created_at: ago(1),
  });
  eq((await call(selfPhone, { jwt: "jwt-caller", body: { phone: "0772000999", old_phone_code: "000000" } })).status, 403, "wrong approval code");
  noProof("wrong approval code");
});

// ---- the unused shared helper ------------------------------------------------------------------------------

Deno.test("E16.9 phoneProofRow: no row without a user id or 9 digits; request metadata as otp-login records it", () => {
  eq(phoneProofRow({ userId: "", phone: NEW_PHONE, stage: "phone_signup" }, null), null, "no user id");
  eq(phoneProofRow({ userId: CALLER, phone: "77200", stage: "phone_signup" }, null), null, "short number");
  const req = new Request("http://edge.test/fn", { headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.2", "user-agent": "UA", origin: "https://welile.test" } });
  const row = phoneProofRow({ userId: CALLER, phone: ` ${SAVED} `, stage: "first_phone" }, req)!;
  eq([row.phone, row.ip_address, row.user_agent, row.origin], [SAVED, "10.0.0.1", "UA", "https://welile.test"], "metadata");
  ok_(SERVICE_KEY, "service key in use");
});

Deno.test("E16.10 no function records phone proof: nothing imports _shared/phoneProof.ts; the 3 phone functions neither write otp_login_audit nor link", async () => {
  const root = new URL("../../../functions/", import.meta.url);
  const offenders: string[] = [];
  const walk = async (dir: URL, rel: string) => {
    for await (const e of Deno.readDir(dir)) {
      const r = rel + e.name;
      if (e.isDirectory) {
        await walk(new URL(e.name + "/", dir), r + "/");
        continue;
      }
      if (!/\.(ts|tsx)$/.test(e.name) || /_test\.ts$/.test(e.name) || r === "_shared/phoneProof.ts") continue;
      const src = await Deno.readTextFile(new URL(e.name, dir));
      if (/phoneProof(\.ts)?["']/.test(src) || /recordPhoneProofAndLink/.test(src)) offenders.push(r);
    }
  };
  await walk(root, "");
  eq(offenders, [], "no function imports the phone proof helper (allowed only where the function itself sends and checks the code for the same signed-in caller)");
  for (const fn of ["phone-signup", "confirm-phone-account", "self-update-phone"]) {
    const src = await Deno.readTextFile(new URL(`${fn}/index.ts`, root));
    ok_(!/otp_login_audit/.test(src), `${fn}: no otp_login_audit write`);
    ok_(!/link_promissory_notes_for_user/.test(src), `${fn}: no linker call`);
  }
});

Deno.test("E16.11 recordPhoneProofAndLink (unused helper): proof write before the service-role link; a failed write skips the link; errors never throw", async () => {
  const log: string[] = [];
  const mk = (insErr: unknown, rpcRes: unknown) => ({
    from: (t: string) => ({
      insert: (rows: any[]) => {
        log.push(`insert ${t} ${rows.length}`);
        return Promise.resolve({ error: insErr });
      },
    }),
    rpc: (n: string, a: any) => {
      log.push(`rpc ${n} ${a.p_user}`);
      return typeof rpcRes === "function" ? (rpcRes as () => unknown)() : Promise.resolve(rpcRes);
    },
  });
  const proof = { userId: CALLER, phone: SAVED, stage: "first_phone" as const };
  eq(await recordPhoneProofAndLink(mk(null, { data: 2, error: null }), proof, null), { proofRecorded: true, linked: 2 }, "ok");
  eq(log, ["insert otp_login_audit 1", `rpc link_promissory_notes_for_user ${CALLER}`], "order");
  log.length = 0;
  eq(await recordPhoneProofAndLink(mk({ message: "denied" }, { data: 2, error: null }), proof, null), { proofRecorded: false, linked: null }, "write failed");
  eq(log, ["insert otp_login_audit 1"], "no link after a failed write");
  log.length = 0;
  eq(await recordPhoneProofAndLink(mk(null, () => { throw new Error("boom"); }), proof, null), { proofRecorded: true, linked: null }, "link throws");
  log.length = 0;
  eq(await recordPhoneProofAndLink(mk(null, null), { ...proof, userId: "" }, null), { proofRecorded: false, linked: null }, "bad input");
  eq(log, [], "bad input: no calls");
});
