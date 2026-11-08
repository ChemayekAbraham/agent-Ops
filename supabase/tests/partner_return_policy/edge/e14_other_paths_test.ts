// Other Phase 4 edge paths: process-investment-interest retired with 410 (owner decision D6) and
// submit-partner-form quoting the PUBLIC new-partner rate (design v2 sections 3.3.4, 3.8).
import { call, eq, loadHandler, POLICY_OFF, POLICY_ON, policyRpc, state, table } from "./harness.ts";
import { reset } from "./fake_supabase.ts";
import { _resetPolicyCacheForTests } from "../../../functions/_shared/partnerReturnPolicy.ts";

const retired = await loadHandler("process-investment-interest");
const partnerForm = await loadHandler("submit-partner-form");

Deno.test("D6 process-investment-interest answers 410 before creating any client", async () => {
  for (const method of ["POST", "GET"]) {
    reset();
    const r = await call(retired, { method, body: method === "POST" ? { any: "thing" } : undefined });
    eq([r.status, r.body], [410, { error: "This function is retired." }], method);
    eq([state.clients.length, state.log.length], [0, 0], "no client, no call");
  }
});

const AGENT = "33333333-3333-4333-8333-333333333333";
function seedForm(policy: unknown) {
  _resetPolicyCacheForTests();
  reset();
  if (policy === "missing") state.rpc.get_partner_return_policy = () => ({ data: null, error: { code: "PGRST202", message: "missing" } });
  else policyRpc(policy);
  table("agent_form_tokens").push({ id: "t1", token: "tok", agent_id: AGENT, is_active: true, expires_at: "2027-01-01T00:00:00Z", uses_count: 0, max_uses: 10 });
}
const form = () => call(partnerForm, {
  body: {
    token: "tok", agent_id: AGENT, full_name: "Pat Partner Test", phone: "0772000999", email: "pat.new@example.com",
    residence: "Kira", investment_amount: 1_000_000, payout_method: "mobile_money", mobile_money_number: "0772000999",
  },
});

Deno.test("submit-partner-form: monthly figure at the public rate (15 off, 10 on), null when the policy is unreadable", async () => {
  for (const [policy, want] of [[POLICY_OFF, 150_000], [POLICY_ON, 100_000], ["missing", null]] as const) {
    seedForm(policy);
    const r = await form();
    eq([r.status, r.body.monthly_roi], [200, want], `policy ${typeof policy === "string" ? policy : (policy as { enabled: boolean }).enabled}`);
  }
});
