// E9 activate-promissory-note / lookup-promissory-note thin wrappers (design v2 sections 3.4.1, 3.4.2, 8.6).
import { call, eq, loadHandler, ok_, rpcCalls, signIn, state, writes } from "./harness.ts";
import { reset } from "./fake_supabase.ts";
import { ANON_KEY } from "./harness.ts";

const activate = await loadHandler("activate-promissory-note");
const lookup = await loadHandler("lookup-promissory-note");

const VERA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NOTE = {
  id: "note-1", partner_name: "Vera Supporter", amount: 1_000_000, contribution_type: "once_off", deduction_day: null,
  status: "pending", total_collected: 0, created_at: "2026-11-06", whatsapp_hint: "*********111", email_hint: "v***@example.com",
  whatsapp_number: "", email: "", linked_to_me: false, return_rate: 15, monthly_return: 150_000,
};

function setup() {
  reset();
  signIn("jwt-vera", { id: VERA, email: "vera@example.com" });
  state.rpc.activate_promissory_note = (args, ctx) => {
    if (!ctx.uid) {
      return { data: null, error: { code: "42501", message: "permission denied for function activate_promissory_note" } };
    }
    return {
      data: {
        success: true, already_active: false, note_id: "note-1", amount: 1_000_000, status: "activated",
        return_rate: 15, monthly_return: 150_000, your_rate: 10, token_seen: args.p_token,
      },
      error: null,
    };
  };
  state.rpc.lookup_promissory_note = (args, ctx) => {
    const auth = ctx.client.headers.Authorization ?? "";
    if (auth === "Bearer jwt-expired") return { data: null, error: { code: "PGRST301", message: "JWT expired" } };
    if (args.p_token !== "tok") return { data: null, error: null };
    return { data: { ...NOTE, linked_to_me: !!ctx.uid }, error: null };
  };
}
const noWrites = () => writes().filter((w) => ["insert", "update", "upsert", "delete"].includes(w.kind)).length === 0;

Deno.test("E9.1 no JWT: 401 and no RPC", async () => {
  setup();
  const r = await call(activate, { body: { token: "tok", user_id: VERA } });
  eq([r.status, r.body.code], [401, "AUTH_REQUIRED"], "401");
  eq(rpcCalls("activate_promissory_note").length, 0, "no rpc");
});

Deno.test("E9.2 anon key as the bearer: the RPC refuses (42501 permission denied for function) -> 401", async () => {
  setup();
  const r = await call(activate, { jwt: ANON_KEY, body: { token: "tok" } });
  eq([r.status, r.body.error], [401, "Please sign in to activate this note"], "401");
  eq(rpcCalls("activate_promissory_note").length, 1, "one rpc");
});

Deno.test("E9.3 body.user_id is ignored: only p_token reaches the RPC, which runs as the caller (anon key + caller JWT, never service role)", async () => {
  setup();
  const r = await call(activate, { jwt: "jwt-vera", body: { token: "tok", user_id: "someone-else" } });
  eq(r.status, 200, "status");
  const c = rpcCalls("activate_promissory_note")[0];
  eq(c.payload, { p_token: "tok" }, "args");
  eq([c.client!.role, c.client!.headers.Authorization], ["anon", "Bearer jwt-vera"], "client");
  ok_(state.clients.every((x) => x.role !== "service"), "no service-role client");
  eq([r.body.success, r.body.return_rate, r.body.monthly_return, r.body.your_rate], [true, 15, 150_000, 10], "passthrough");
  ok_(noWrites(), "the wrapper writes nothing itself");
});

Deno.test("E9.4 each RPC error maps to its status", async () => {
  const cases: [string, string, number, string][] = [
    ["P0002", "NOTE_NOT_FOUND", 404, "NOTE_NOT_FOUND"],
    ["42501", "NOTE_LINKED_ELSEWHERE: this note is already linked to another account", 403, "NOTE_LINKED_ELSEWHERE"],
    ["42501", "NOTE_CONTACT_MISMATCH: this note was written for another phone number or email; Partner Ops can link it", 403, "NOTE_CONTACT_MISMATCH"],
    ["22023", "NOTE_NOT_OPEN: note is already fulfilled", 400, "NOTE_NOT_OPEN"],
    ["42501", "AUTH_REQUIRED: please sign in to activate this note", 401, "AUTH_REQUIRED"],
    ["55P03", "canceling statement due to lock timeout", 409, "NOTE_CHANGED"],
    ["XX000", "internal", 500, "ACTIVATION_FAILED"],
  ];
  for (const [code, message, status, body] of cases) {
    setup();
    state.rpc.activate_promissory_note = () => ({ data: null, error: { code, message } });
    const r = await call(activate, { jwt: "jwt-vera", body: { token: "tok" } });
    eq([r.status, r.body.code], [status, body], message);
    ok_(!JSON.stringify(r.body).includes("internal"), "no raw message");
  }
  setup();
  const missing = await call(activate, { jwt: "jwt-vera", body: {} });
  eq(missing.status, 400, "missing token");
});

Deno.test("E9.5 lookup forwards the caller's Authorization; anon key when signed out", async () => {
  setup();
  let r = await call(lookup, { jwt: "jwt-vera", body: { token: "tok" } });
  eq([r.status, r.body.note.linked_to_me], [200, true], "signed in");
  eq(rpcCalls("lookup_promissory_note")[0].client!.headers.Authorization, "Bearer jwt-vera", "forwarded");
  setup();
  r = await call(lookup, { body: { token: "tok" } });
  eq([r.status, r.body.note.linked_to_me], [200, false], "anon");
  eq(rpcCalls("lookup_promissory_note")[0].client!.headers.Authorization, `Bearer ${ANON_KEY}`, "anon key");
  ok_(state.clients.every((x) => x.role !== "service"), "no service-role client");
});

Deno.test("E9.6 lookup with an expired JWT is retried once with the anon key", async () => {
  setup();
  const r = await call(lookup, { jwt: "jwt-expired", body: { token: "tok" } });
  eq(r.status, 200, "status");
  eq(rpcCalls("lookup_promissory_note").map((c) => c.client!.headers.Authorization), ["Bearer jwt-expired", `Bearer ${ANON_KEY}`], "two calls");
});

Deno.test("E9.7 lookup envelope: { note } with the old page's keys present and empty; null -> 404; other error -> 500", async () => {
  setup();
  let r = await call(lookup, { body: { token: "tok" } });
  eq([r.body.note.whatsapp_number, r.body.note.email], ["", ""], "compat keys empty");
  ok_("whatsapp_hint" in r.body.note && "return_rate" in r.body.note && "monthly_return" in r.body.note, "new keys");
  r = await call(lookup, { body: { token: "nope" } });
  eq(r.status, 404, "unknown token");
  setup();
  state.rpc.lookup_promissory_note = () => ({ data: null, error: { code: "XX000", message: "boom" } });
  r = await call(lookup, { body: { token: "tok" } });
  eq([r.status, JSON.stringify(r.body).includes("boom")], [500, false], "500 without the raw message");
  r = await call(lookup, { body: {} });
  eq(r.status, 400, "missing token");
});
