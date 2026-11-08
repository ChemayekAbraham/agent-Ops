// E10 welile-ai-chat (design v2 section 3.5.5): the public policy is read in parallel with the caller
// check, cached 60 s per isolate, and the own-rate tool is offered only to a caller with a user JWT.
import { aiReplies, aiRequests, call, eq, loadHandler, ok_, POLICY_OFF, POLICY_ON, policyRpc, rpcCalls, signIn, state } from "./harness.ts";
import { reset } from "./fake_supabase.ts";
import { _resetPolicyCacheForTests } from "../../../functions/_shared/partnerReturnPolicy.ts";

const chat = await loadHandler("welile-ai-chat");
const PARTNER = "22222222-2222-4222-8222-222222222222";

function setup(policy: unknown = POLICY_OFF) {
  _resetPolicyCacheForTests();
  reset();
  policyRpc(policy);
  aiReplies.length = 0;
  aiRequests.length = 0;
  signIn("jwt-partner", { id: PARTNER, email: "pat@example.com" }, ["supporter"]);
  state.rpc.partner_quote_rate = () => ({ data: 20, error: null });
}
const ask = (content: string, jwt?: string) =>
  call(chat, { jwt, body: { messages: [{ role: "user", content }] }, headers: { "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 200)}` } });
const sseText = (body: unknown) => String(body);
const toolNames = (i: number) => (aiRequests[i]?.tools ?? []).map((t: { function: { name: string } }) => t.function.name);

Deno.test("E10.1 the policy read runs in parallel with getUser", async () => {
  setup();
  let policyStarted = false;
  let timedOut = false;
  const original = state.rpc.get_partner_return_policy;
  state.rpc.get_partner_return_policy = (a, c) => { policyStarted = true; return original(a, c); };
  // getUser answers only once the policy RPC has started (or gives up after 300 ms).
  state.getUserGate = async () => {
    for (let i = 0; i < 300 && !policyStarted; i++) await new Promise((r) => setTimeout(r, 1));
    if (!policyStarted) timedOut = true;
  };
  aiReplies.push({ choices: [{ message: { content: "Here is your answer." } }] });
  const r = await ask("What are my portfolio returns?", "jwt-partner");
  eq(r.status, 200, "status");
  ok_(!timedOut, "getUser had to wait for a sequential policy read");
});

Deno.test("E10.2 one policy RPC for two requests within 60 s", async () => {
  setup();
  aiReplies.push({ choices: [{ message: { content: "One." } }] }, { choices: [{ message: { content: "Two." } }] });
  await ask("What are my portfolio returns?", "jwt-partner");
  await ask("How much would I earn as a supporter partner returns?");
  eq(rpcCalls("get_partner_return_policy").length, 1, "cached");
});

Deno.test("E10.3 get_my_returns_rate is offered only with a user JWT", async () => {
  setup();
  aiReplies.push({ choices: [{ message: { content: "Signed in." } }] }, { choices: [{ message: { content: "Anonymous." } }] });
  await ask("What are my portfolio returns?", "jwt-partner");
  await ask("What are my portfolio returns?");
  ok_(toolNames(0).includes("get_my_returns_rate"), `signed in: ${toolNames(0)}`);
  ok_(!toolNames(1).includes("get_my_returns_rate"), `anonymous: ${toolNames(1)}`);
});

Deno.test("E10.4 the own-rate tool reads partner_quote_rate('me') as the caller", async () => {
  setup();
  aiReplies.push(
    { choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "get_my_returns_rate", arguments: "{}" } }] } }] },
    { choices: [{ message: { content: "A new portfolio would earn 20% a month for you." } }] },
  );
  const r = await ask("What rate would a new portfolio earn for me? my portfolio rate", "jwt-partner");
  eq(r.status, 200, "status");
  const q = rpcCalls("partner_quote_rate")[0];
  eq([q.payload, q.client!.role, q.client!.headers.Authorization], [{ p_quote_for: "me", p_partner_id: null }, "anon", "Bearer jwt-partner"], "caller's JWT");
  const toolMsg = aiRequests[1].messages.find((m: { role: string }) => m.role === "tool");
  eq(JSON.parse(toolMsg.content), { rate: 20 }, "tool result");
});

Deno.test("E10.5 the public guide quotes the live public rate: 15 off, 10 on, none when unreadable", async () => {
  for (const [policy, want] of [[POLICY_OFF, "15%"], [POLICY_ON, "10%"]] as const) {
    setup(policy);
    const r = await ask("How does a promissory note work?");
    ok_(sseText(r.body).includes(want), `${want}: ${sseText(r.body).slice(0, 400)}`);
  }
  setup(null);
  state.rpc.get_partner_return_policy = () => ({ data: null, error: { code: "PGRST202", message: "missing" } });
  const r = await ask("How does a promissory note work?");
  ok_(!/\d+(\.\d+)?% (per month|a month)/.test(sseText(r.body)), `no rate: ${sseText(r.body).slice(0, 400)}`);
});
