// E5 import-partners (design v2 sections 3.1.0, 3.1.6).
import { call, eq, loadHandler, ok_, rpcCalls, state, table, writes } from "./harness.ts";
import { _resetPolicyCacheForTests } from "../../../functions/_shared/partnerReturnPolicy.ts";
import { OPERATIONS, PARTNER, world } from "./seed.ts";

const importPartners = await loadHandler("import-partners");

function setup(w: Parameters<typeof world>[0]) {
  _resetPolicyCacheForTests();
  world(w);
  state.rpc.profile_ids_by_emails = (args: { p_emails: string[] }) => {
    const want = new Set((args.p_emails ?? []).map((e) => e.toLowerCase()));
    return { data: table("profiles").filter((p) => p.email && want.has(String(p.email).toLowerCase())).map((p) => ({ id: p.id, email: String(p.email).toLowerCase() })), error: null };
  };
}

type Pf = { amount: number; durationMonths: number; roiMode: string; roiPercentage?: unknown; contributionDate?: string };
const pf = (amount: number, extra: Partial<Pf> = {}): Pf => ({ amount, durationMonths: 12, roiMode: "monthly_payout", ...extra });
const partner = (i: number, portfolios: Pf[]) => ({
  partner_name: `Paper Partner ${i}`,
  phone: `+2567010${String(i).padStart(5, "0")}`,
  email: `paper${i}@example.com`,
  portfolios,
});
const reads = (t: string) => state.reads.filter((r) => r.table === t).length;
const writesTo = (kind: "insert" | "upsert" | "update", t: string) => writes(kind).filter((w) => w.table === t);

Deno.test("E5.1 150 partners x 2 portfolios: batched call counts (section 3.1.6)", async () => {
  setup({});
  const partners = Array.from({ length: 150 }, (_, i) => partner(i, [pf(100_000), pf(200_000)]));
  const r = await call(importPartners, { jwt: "jwt-manager", body: { partners } });
  eq(r.status, 200, "status");
  eq([r.body.partnersCreated, r.body.portfoliosCreated, r.body.skippedDuplicates, r.body.errors.length], [150, 300, 0, 0], "totals");
  eq(reads("profiles"), 4, "phone lookups: 600 formats / 150");
  eq(rpcCalls("profile_ids_by_emails").length, 1, "email lookups by RPC: 150 emails / 500");
  eq(writes("auth").filter((w) => w.name === "admin.createUser").length, 150, "createUser only for new partners");
  eq(writesTo("upsert", "profiles").length, 1, "one bulk profiles upsert");
  eq(writesTo("upsert", "user_roles").length, 1, "one bulk roles upsert");
  eq(state.reads.filter((x) => x.table === "investor_portfolios").length, 2, "existing portfolios: 150 ids / 100");
  eq(reads("portfolio_rate_approvals"), 0, "no rate-request lookup without typed rates");
  eq(writesTo("insert", "investor_portfolios").length, 3, "300 rows / 100 per insert");
  eq(writesTo("insert", "audit_logs").length, 1, "one bulk audit insert");
  eq(writesTo("insert", "investor_portfolios").every((w) => w.options?.defaultToNull === false), true, "defaultToNull:false");
  eq(writesTo("update", "profiles").length, 0, "no per-partner profile updates for new partners");
  eq(rpcCalls("get_partner_return_policy").length, 0, "no policy read without typed rates");
});

Deno.test("E5.2 one partner, two portfolios differing only in the typed rate: results matched by client id", async () => {
  setup({});
  state.reverseInsertReturn = true; // the database may return rows in any order
  const r = await call(importPartners, {
    jwt: "jwt-manager",
    body: { partners: [partner(1, [pf(100_000, { roiPercentage: 20 }), pf(100_000, { roiPercentage: 25 })])] },
  });
  eq(r.status, 200, "status");
  const rows = r.body.portfolios.map((p: Record<string, unknown>) => [p.requested_roi_percentage, p.roi_percentage, p.rate_awaits_cfo]);
  eq(rows, [[20, 20, false], [25, 25, false]], "each row reports its own stored rate");
  const codes = r.body.portfolios.map((p: Record<string, unknown>) => p.portfolio_code);
  const stored = table("investor_portfolios");
  for (const [i, code] of codes.entries()) {
    eq(stored.find((s) => s.portfolio_code === code)?.roi_percentage, rows[i][1], `row ${i} matches the stored row`);
  }
});

Deno.test("E5.3 duplicates: by stored rate, by a requested rate, untyped, and within the file", async () => {
  setup({});
  table("profiles").push({ id: "dup-partner-id", full_name: "Dup", phone: "0701099999", email: null });
  table("user_roles").push({ id: "r-dup", user_id: "dup-partner-id", role: "supporter", enabled: true });
  table("investor_portfolios").push(
    { id: "E-1", investor_id: "dup-partner-id", investment_amount: 100_000, duration_months: 12, roi_percentage: 15, status: "active" },
    { id: "E-2", investor_id: "dup-partner-id", investment_amount: 300_000, duration_months: 12, roi_percentage: 15, status: "active" },
  );
  table("portfolio_rate_approvals").push({ id: "A-1", portfolio_id: "E-2", requested_rate: 20, status: "rejected", source: "new_portfolio" });
  const r = await call(importPartners, {
    jwt: "jwt-manager",
    body: {
      partners: [{
        partner_name: "Dup", phone: "+256701099999", email: null,
        portfolios: [
          pf(100_000),                          // untyped, same key as E-1 -> duplicate
          pf(100_000, { roiPercentage: 15 }),   // stored 15 -> duplicate
          pf(300_000, { roiPercentage: 20 }),   // a request for 20 exists on E-2 -> duplicate
          pf(300_000, { roiPercentage: 30 }),   // new
          pf(500_000),                          // new
          pf(500_000),                          // same key earlier in the file -> duplicate
        ],
      }],
    },
  });
  eq(r.status, 200, "status");
  eq([r.body.partnersMatched, r.body.portfoliosCreated, r.body.skippedDuplicates], [1, 2, 4], "totals");
  eq(r.body.portfolios.map((p: Record<string, unknown>) => [p.amount, p.requested_roi_percentage]), [[300_000, 30], [500_000, null]], "inserted rows");
  eq(reads("portfolio_rate_approvals"), 1, "one rate-request lookup");
});

Deno.test("E5.4 a failing chunk is retried row by row (own error per partner)", async () => {
  setup({});
  state.failInsert = (t, rows) =>
    t === "investor_portfolios" && rows.some((x) => x.roi_mode === "bad_mode") ? { code: "23514", message: "invalid roi_mode" } : null;
  const portfolios = Array.from({ length: 101 }, (_, i) => pf(100_000 + i * 1000, i === 7 ? { roiMode: "bad_mode" } : {}));
  const r = await call(importPartners, { jwt: "jwt-manager", body: { partners: [partner(1, portfolios)] } });
  eq(r.status, 200, "status");
  eq([r.body.portfoliosCreated, r.body.errors.length], [100, 1], "one row lost, the rest imported");
  eq(r.body.errors[0].partner, "Paper Partner 1", "error names the partner");
  const ins = writesTo("insert", "investor_portfolios");
  eq([ins.length, ins.filter((w) => w.error).length], [102, 2], "bulk(fail) + 100 singles (1 fail) + bulk(1)");
});

Deno.test("E5.5 mixed backdated and typed rows: defaultToNull:false keeps column defaults; the gate decides untyped rows", async () => {
  setup({});
  const r = await call(importPartners, {
    jwt: "jwt-manager",
    body: {
      partners: [partner(1, [
        pf(100_000, { contributionDate: "2025-03-01", roiPercentage: 20 }),
        pf(200_000),
        pf(300_000, { contributionDate: "2025-04-01" }),
        pf(400_000, { roiPercentage: 12.5 }),
      ])],
    },
  });
  eq(r.status, 200, "status");
  const ins = writesTo("insert", "investor_portfolios");
  eq([ins.length, ins[0].options], [1, { defaultToNull: false }], "one insert with defaultToNull:false");
  const stored = ins[0].stored!;
  eq(stored.map((s) => [s.investment_amount, s.roi_percentage, s.rate_basis]), [
    [100_000, 20, "typed_switch_off"], [200_000, 15, "switch_off"], [300_000, 15, "switch_off"], [400_000, 12.5, "typed_switch_off"],
  ], "stored rates");
  eq(stored.map((s) => s.created_at.slice(0, 10)), ["2025-03-01", "2026-11-07", "2025-04-01", "2026-11-07"], "created_at default for rows without a date");
  ok_(stored.every((s) => s.id && typeof s.id === "string"), "client-made ids");
});

Deno.test("E5.6 409 once per request for a stale screen; none when the screen saw the switch", async () => {
  setup({ on: true });
  let r = await call(importPartners, { jwt: "jwt-manager", body: { partners: [partner(1, [pf(100_000, { roiPercentage: 15 }), pf(200_000, { roiPercentage: 15 })])] } });
  eq([r.status, r.body.code], [409, "POLICY_CHANGED"], "409");
  eq(rpcCalls("get_partner_return_policy").length, 1, "one read");
  eq(writes().filter((w) => ["insert", "upsert", "update", "auth"].includes(w.kind) && w.name !== "getUser").length, 0, "nothing written");

  setup({ on: true, person: { rate: 10, basis: "new" } });
  r = await call(importPartners, {
    jwt: "jwt-manager",
    body: { policy_enabled_seen: true, partners: [partner(1, [pf(100_000, { roiPercentage: 15 })])] },
  });
  eq(r.status, 200, "status");
  eq(rpcCalls("get_partner_return_policy").length, 0, "no read");
  const row = r.body.portfolios[0];
  eq([row.roi_percentage, row.requested_roi_percentage, row.rate_awaits_cfo, r.body.rates_awaiting_cfo], [10, 15, true, 1], "CFO fields");
  eq(row.message, "Not on the books at the cut-off: Returns start at the new-partner rate; the typed rate waits for the CFO.", "D16 message");
});

Deno.test("E5.7 D11: operations (not partner staff) gets no per-row rate on personal rows, and a rate_note", async () => {
  setup({ on: true, person: { rate: 15, basis: "existing_partner" } });
  const r = await call(importPartners, { jwt: "jwt-operations", body: { partners: [partner(1, [pf(100_000)])] } });
  eq(r.status, 200, "status");
  ok_(!("roi_percentage" in r.body.portfolios[0]) && !("rate_awaits_cfo" in r.body.portfolios[0]), "no rate keys");
  eq(r.body.rate_note, "Rates that differ from the person's rate go to the CFO.", "note");
  ok_(OPERATIONS && PARTNER, "ids");
});
