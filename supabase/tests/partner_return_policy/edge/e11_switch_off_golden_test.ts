// E11 switch-off golden test (design v2 sections 0 R5, 8.4, 10.2): the origin/lovable copy of each changed
// function (fixtures/origin, made by fixtures/make_origin.sh) and the new file run against the same fake
// database with the policy OFF and the gate storing 15 (or the typed rate). The ordered logs of writes,
// RPC payloads, invokes, emails and SMS, the responses and the final tables must be identical, except
// the differences design v2 section 8.4 lists; each allowed difference is named where it is applied.
// deno-lint-ignore-file no-explicit-any
import {
  aiReplies,
  aiRequests,
  call,
  canon,
  deterministic,
  fetchRoutes,
  type Handler,
  loadHandler,
  loadHandlerVariant,
  type LogEntry,
  type Row,
  SERVICE_KEY,
  signIn,
  state,
  table,
} from "./harness.ts";
import { _resetPolicyCacheForTests } from "../../../functions/_shared/partnerReturnPolicy.ts";
import {
  AGENT,
  bookingNotice,
  inlineTopupMergeOn,
  inviteBody,
  investorBody,
  LOGIN_EMAIL,
  MANAGER,
  PARTNER,
  PARTNER2,
  PF,
  PROFILE_EMAIL,
  pledgeNotice,
  progressNotice,
  RRS,
  seedFundTenants,
  seedInvestForPartner,
  seedInvestorPortfolio,
  seedInvite,
  seedPendingPortfolio,
  seedRoi,
  seedRoiTopups,
  seedTopupOperation,
  seedTopupPortfolio,
  topupBody,
  world,
} from "./seed.ts";

/** Reads added by Phase 4 (no writes): left out of the comparison. */
const PHASE4_READ_RPCS = new Set(["get_partner_return_policy", "partner_confirmed_login_emails", "profile_ids_by_emails"]);

interface Snapshot { status: number; body: any; log: any[]; tables: Record<string, Row[]>; loginReads: number }
type Allow = (o: Snapshot, n: Snapshot) => void;

function normalize(log: LogEntry[]): any[] {
  return log
    .filter((e) => e.kind !== "auth" || e.name !== "getUser")
    .filter((e) => !(e.kind === "rpc" && PHASE4_READ_RPCS.has(String(e.name))))
    .map((e) => {
      const base: Row = { kind: e.kind, target: e.table ?? e.name, client: e.client?.role ?? null };
      if (e.kind === "insert" && e.table === "investor_portfolios") {
        // R3: the new code omits roi_percentage and lets the gate decide; compare what was STORED.
        return { ...base, stored: e.stored ?? null, error: e.error ?? null };
      }
      return { ...base, payload: e.payload ?? null, filters: e.filters ?? null, options: e.options ?? null, error: e.error ?? null };
    });
}

/** fn: a function name, or a loader for a variant (e.g. a disabled flag turned on in both copies). */
type Fn = string | ((which: "origin" | "new") => Promise<Handler>);

async function run(fn: Fn, which: "origin" | "new", seed: () => void, req: Parameters<typeof call>[1]): Promise<Snapshot> {
  _resetPolicyCacheForTests();
  seed();
  const h = typeof fn === "string" ? await loadHandler(fn, which) : await fn(which);
  const r = await call(h, req);
  const loginReads = state.log.filter((e) => e.kind === "rpc" && e.name === "partner_confirmed_login_emails").length;
  return { status: r.status, body: r.body, log: normalize(state.log), tables: structuredClone(state.tables), loginReads };
}

function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  const ca = JSON.stringify(canon(a)), cb = JSON.stringify(canon(b));
  if (ca === cb) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a as Row), ...Object.keys(b as Row)])) {
      const d = firstDiff((a as Row)[k], (b as Row)[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return `${path}: origin ${ca?.slice(0, 400)} | new ${cb?.slice(0, 400)}`;
}

/** The confirmed login emails while no cut-off exists (F1). Every golden runs twice: once with login
 *  emails that DIFFER from the profile emails and once with none, so any sender that routes by login
 *  email (or drops figures) before the first switch-on shows up as a difference. */
type LoginMode = "login differs" | "no login";
let loginMode: LoginMode = "login differs";
const LOGIN_DIFFERS = { [PARTNER]: LOGIN_EMAIL, [PARTNER2]: "second.login@example.com" };

const applied: Record<string, string[]> = {};
async function golden(name: string, fn: Fn, seed: () => void, req: Parameters<typeof call>[1], allows: [string, Allow][] = []) {
  let last: { o: Snapshot; n: Snapshot } | null = null;
  for (const mode of ["login differs", "no login"] as LoginMode[]) {
    loginMode = mode;
    const o = await run(fn, "origin", seed, req);
    const n = await run(fn, "new", seed, req);
    for (const [, allow] of allows) allow(o, n);
    applied[name] = allows.map(([why]) => why);
    const d = firstDiff({ status: o.status, body: o.body, log: o.log, tables: o.tables }, { status: n.status, body: n.body, log: n.log, tables: n.tables });
    if (d) throw new Error(`${name} (${mode}): origin and new differ beyond section 8.4\n  ${d}`);
    if (n.loginReads !== 0) throw new Error(`${name} (${mode}): ${n.loginReads} login-email read(s) before the first switch-on (F1: none)`);
    last = { o, n };
  }
  loginMode = "login differs";
  return last!;
}

// ---- allowed differences (design v2 section 8.4) ----------------------------------------------------

const dropKeys = (obj: any, keys: string[]) => { if (obj && typeof obj === "object") for (const k of keys) delete obj[k]; };
/** Staff creators: responses gain rate keys (partner staff only). */
const responseRateKeys = (path: (b: any) => any = (b) => b): Allow => (o, n) => {
  for (const k of ["roi_percentage", "requested_roi_percentage", "rate_awaits_cfo", "rate_note"]) {
    const ob = path(o.body), nb = path(n.body);
    if (ob && nb && !(k in ob)) delete nb[k];
  }
};
/** Audit / pending-op metadata gains requested_roi_percentage next to the stored rate. */
const metadataRequestedRate = (table_: string): Allow => (_o, n) => {
  for (const e of n.log) if (e.target === table_ && e.payload?.metadata) delete e.payload.metadata.requested_roi_percentage;
  for (const r of n.tables[table_] ?? []) if (r.metadata) delete r.metadata.requested_roi_percentage;
};
const forEntries = (s: Snapshot, pred: (e: any) => boolean, f: (e: any) => void) => s.log.filter(pred).forEach(f);
/** R3: origin typed 15 itself (basis typed_switch_off); the new code sends no rate and the gate stores 15
 *  as switch_off. Same rate, both bases public. */
const r3Basis: [string, Allow] = ["R3: origin typed 15 itself -> typed_switch_off; new sends no rate -> switch_off (same 15, both public)", (o, n) => {
  const fix = (rows: Row[]) => rows.forEach((r) => { if (r.rate_basis === "typed_switch_off" && r.roi_percentage === 15) r.rate_basis = "switch_off"; });
  for (const s of [o, n]) {
    forEntries(s, (e) => e.target === "investor_portfolios" && e.stored, (e) => fix(e.stored));
    fix(s.tables.investor_portfolios ?? []);
  }
}];

// ---- seeds -------------------------------------------------------------------------------------------

/** Switch off, no cut-off; login emails per the current mode (see golden). */
const off = () => world({ login: loginMode === "login differs" ? LOGIN_DIFFERS : {} });

Deno.test("E11.1 create-portfolio-invite (invite branch, old screen sends 15)", async () => {
  await golden("create-portfolio-invite/invite", "create-portfolio-invite",
    () => { off(); seedInvite({ existingPortfolio: true }); },
    { jwt: "jwt-ops", body: inviteBody({ roi_percentage: 15 }) },
    [["staff creators: response gains rate keys", responseRateKeys()]]);
});

Deno.test("E11.2 create-portfolio-invite (first portfolio, direct confirmation, typed 20)", async () => {
  await golden("create-portfolio-invite/direct", "create-portfolio-invite",
    () => { off(); seedInvite({ existingPortfolio: false }); },
    { jwt: "jwt-ops", body: inviteBody({ roi_percentage: 20 }) },
    [["staff creators: response gains rate keys", responseRateKeys()]]);
});

Deno.test("E11.2b create-portfolio-invite with a blank rate: origin 400, new accepted at the gate's 15 (section 8.4, deliberate)", async () => {
  const o = await run("create-portfolio-invite", "origin", () => { off(); seedInvite({ existingPortfolio: true }); }, { jwt: "jwt-ops", body: inviteBody() });
  const n = await run("create-portfolio-invite", "new", () => { off(); seedInvite({ existingPortfolio: true }); }, { jwt: "jwt-ops", body: inviteBody() });
  if (o.status !== 400 || n.status !== 200 || n.body.roi_percentage !== 15) throw new Error(`blank rate: origin ${o.status}, new ${n.status} ${JSON.stringify(n.body)}`);
});

Deno.test("E11.3 create-investor-portfolio (field agent, no rate / typed 20)", async () => {
  for (const extra of [{}, { roi_percentage: 20 }]) {
    await golden(`create-investor-portfolio/agent ${JSON.stringify(extra)}`, "create-investor-portfolio",
      () => { off(); seedInvestorPortfolio(); },
      { jwt: "jwt-agent", body: investorBody(extra) },
      [r3Basis, ["pending op metadata gains requested_roi_percentage", metadataRequestedRate("pending_wallet_operations")]]);
  }
});

Deno.test("E11.4 create-investor-portfolio (back office, instant deduct, typed 20)", async () => {
  await golden("create-investor-portfolio/back-office", "create-investor-portfolio",
    () => { off(); seedInvestorPortfolio(); },
    { jwt: "jwt-manager", body: investorBody({ roi_percentage: 20, invite_id: "invite-1" }) },
    [
      ["staff creators: response gains rate keys", responseRateKeys((b) => b.portfolio)],
      ["pending op metadata gains requested_roi_percentage", metadataRequestedRate("pending_wallet_operations")],
    ]);
});

Deno.test("E11.5 agent-invest-for-partner", async () => {
  await golden("agent-invest-for-partner", "agent-invest-for-partner",
    () => { off(); seedInvestForPartner(); },
    { jwt: "jwt-agent", body: { partner_id: PARTNER, amount: 1_000_000 } },
    [r3Basis]);
});

Deno.test("E11.6 coo-invest-for-partner", async () => {
  await golden("coo-invest-for-partner", "coo-invest-for-partner",
    () => { off(); seedInvestForPartner(); },
    { jwt: "jwt-manager", body: { partner_id: PARTNER, amount: 1_000_000 } },
    [r3Basis]);
});

Deno.test("E11.7 coo-create-portfolio (typed 15 and 20; payout and compounding)", async () => {
  for (const [rate, mode] of [[15, "monthly_payout"], [20, "monthly_compounding"]] as const) {
    await golden(`coo-create-portfolio ${rate} ${mode}`, "coo-create-portfolio",
      () => { off(); seedInvestForPartner(); },
      {
        jwt: "jwt-manager",
        body: { partner_id: PARTNER, amount: 1_000_000, roi_percentage: rate, roi_mode: mode, duration_months: 12, payment_method: "wallet", source_wallet_user_id: PARTNER },
      },
      [
        ["staff creators: response gains rate keys", responseRateKeys()],
        ["audit metadata gains requested_roi_percentage", metadataRequestedRate("audit_logs")],
      ]);
  }
});

Deno.test("E11.8 notify-house-booking (row rate 15)", async () => {
  await golden("notify-house-booking", "notify-house-booking",
    () => { off(); table("promissory_house_booking_notices").push(bookingNotice({ return_rate: 15 }), bookingNotice({ kind: "booked", return_rate: 15, total_rent: 777_777 })); },
    { body: {} });
});

Deno.test("E11.9 notify-promissory-note-pledge (row rate 15)", async () => {
  await golden("notify-promissory-note-pledge", "notify-promissory-note-pledge",
    () => { off(); table("promissory_note_pledge_notices").push(pledgeNotice({ return_rate: 15 })); },
    { body: {} });
});

Deno.test("E11.10 notify-funder-house-progress (row rate 15; login email differs / none)", async () => {
  await golden("notify-funder-house-progress", "notify-funder-house-progress",
    () => { off(); table("funder_house_progress_notices").push(progressNotice({ return_rate: 15 }), progressNotice({ kind: "tenant_placed", return_rate: 15 })); },
    { body: {} });
});

Deno.test("E11.11 process-supporter-roi (wallet path, Phase 2 pays round(rent*15/100))", async () => {
  await golden("process-supporter-roi/wallet", "process-supporter-roi",
    () => { off(); seedRoi({ reinvest: false, posted: { status: "posted", amount: 150_000, rate: 15 } }); },
    { body: {} },
    [
      ["wording: rate-free wallet description (SQL writes the paid rate into the ledger text)", (o, n) => {
        forEntries(o, (e) => e.target === "post_rent_facilitation_reward", (e) => delete e.payload.p_wallet_description);
        forEntries(n, (e) => e.target === "post_rent_facilitation_reward", (e) => delete e.payload.p_wallet_description);
      }],
      ["wording: ROI -> Returns in the manager ping", (o, n) => {
        for (const s of [o, n]) forEntries(s, (e) => String(e.target).endsWith("/notify-managers"), (e) => { e.payload.title = "*"; e.payload.body = "*"; });
      }],
    ]);
});

Deno.test("E11.12 process-supporter-roi (auto-reinvest; compound email)", async () => {
  await golden("process-supporter-roi/reinvest", "process-supporter-roi",
    () => { off(); seedRoi({ reinvest: true, posted: { status: "posted", amount: 150_000, rate: 15, new_principal: 2_150_000, previous_principal: 2_000_000 } }); },
    { body: {} },
    [
      ["compound email shows the paid rate (15%) instead of reward / principal (7.5%)", (o, n) => {
        for (const s of [o, n]) forEntries(s, (e) => e.payload?.templateName === "partner-portfolio-compounded" || e.payload?.templateName === "partner-compound", (e) => { dropKeys(e.payload.templateData, ["roi_percentage", "roi_return"]); });
      }],
      ["wording: 'ROI Auto-Reinvested' -> 'Returns Auto-Reinvested'; manager ping", (o, n) => {
        for (const s of [o, n]) {
          forEntries(s, (e) => e.target === "notifications", (e) => { if (e.payload?.title) e.payload.title = String(e.payload.title).replace("ROI", "Returns"); });
          for (const r of s.tables.notifications ?? []) if (r.title) r.title = String(r.title).replace("ROI", "Returns");
          forEntries(s, (e) => String(e.target).endsWith("/notify-managers"), (e) => { e.payload.title = "*"; e.payload.body = "*"; });
        }
      }],
    ]);
});

Deno.test("E11.13 fund-tenants (three fundings stored at 15)", async () => {
  await golden("fund-tenants", "fund-tenants",
    () => { off(); seedFundTenants([15, 15, 15]); },
    { jwt: "jwt-partner", body: { rent_request_ids: RRS } });
});

Deno.test("E11.14 process-portfolio-redemption (login email differs / none)", async () => {
  const seed = () => {
    off();
    signIn("jwt-cfo", { id: "c0c0c0c0-0000-4000-8000-000000000001" }, ["cfo"]);
    table("portfolio_action_requests").push({
      id: "req-1", portfolio_id: "pf-1", request_type: "REDEMPTION_REQUEST", status: "pending", partner_id: PARTNER,
      partner_name: "Pat Partner", partner_email: PROFILE_EMAIL, portfolio_code: "WIP1", portfolio_name: "Main", portfolio_value: 1_000_000,
      currency: "UGX",
      portfolio: { id: "pf-1", portfolio_code: "WIP1", account_name: "Main", investor_id: PARTNER, investment_amount: 1_000_000, roi_percentage: 15, duration_months: 12, maturity_date: "2027-01-01", next_roi_date: "2026-12-01", status: "active" },
    });
    state.rpc.apply_portfolio_redemption = () => ({ data: { redemption_id: "red-1", roi_percentage: 15, scope: "partial", redeemed_amount: 400_000, old_principal: 1_000_000, remaining_principal: 600_000, portfolio_code: "WIP1", account_name: "Main" }, error: null });
  };
  await golden("process-portfolio-redemption", "process-portfolio-redemption", seed, { jwt: "jwt-cfo", body: { request_id: "req-1", scope: "partial", amount: 400_000 } });
});

Deno.test("E11.15 notify-self-topup-approved (login email differs / none)", async () => {
  const seed = () => {
    off();
    table("partner_self_topups").push({
      id: "dddddddd-0000-4000-8000-000000000001", partner_id: PARTNER, amount: 1_000_000, status: "approved",
      effective_at: "2026-11-07T00:00:00Z", prorata_amount: 0, rent_request_ids: [],
      commitment: { id: "commit-1", monthly_rate: 15, term_months: 6, term_end_at: "2027-05-07", next_payout_at: "2026-12-07" },
    });
  };
  await golden("notify-self-topup-approved", "notify-self-topup-approved", seed,
    { jwt: "jwt-ops", body: { topup_id: "dddddddd-0000-4000-8000-000000000001" } },
    [["section 8.4 (round 3 additions): the response no longer echoes the recipient (recipient -> with_figures)", (o, n) => {
      if (o.body?.recipient === PROFILE_EMAIL && n.body?.with_figures === true) { delete o.body.recipient; delete n.body.with_figures; }
    }]]);
});

Deno.test("E11.16 og-plan (stored description wins byte for byte while no cut-off is set)", async () => {
  const seed = () => {
    off();
    table("short_links").push({
      code: "abcd1234", target_path: "/", target_params: { plan: "eeeeeeee-0000-4000-8000-000000000001", ref: AGENT },
      og_title: "Support a tenant", og_description: "Support this tenant for UGX 600,000 and earn UGX 90,000 per month.",
      og_image_url: "https://img/x.jpg", destination_path: "/", og_updated_at: "2026-11-01T00:00:00Z",
    });
    table("v_partner_self_fundable_plans").push({ rent_request_id: "eeeeeeee-0000-4000-8000-000000000001", funding_amount: 600_000, house_category: "single_room", request_city: "Kampala", tenant_location: "Kira", house_image_urls: ["https://img/x.jpg"] });
  };
  const o = await callOg("origin", seed);
  const n = await callOg("new", seed);
  if (o.status !== 200 || o.body !== n.body) throw new Error(`og-plan differs:
${String(o.body).slice(0, 600)}
---
${String(n.body).slice(0, 600)}`);
  applied["og-plan"] = [];
});

Deno.test("E11.16b og-plan without a stored description: origin computes 15% of rent, new gives the rate-free sentence (section 8.4)", async () => {
  const seed = () => {
    off();
    table("short_links").push({ code: "abcd5678", target_path: "/", target_params: { plan: "eeeeeeee-0000-4000-8000-000000000002" }, og_title: null, og_description: null, og_image_url: null, destination_path: "/" });
    table("v_partner_self_fundable_plans").push({ rent_request_id: "eeeeeeee-0000-4000-8000-000000000002", funding_amount: 600_000, house_category: null, request_city: null, tenant_location: null, house_image_urls: [] });
  };
  const o = await callOg("origin", seed, "abcd5678");
  const n = await callOg("new", seed, "abcd5678");
  if (!o.body.includes("UGX 90,000 per month")) throw new Error("origin fixture no longer computes the figure");
  if (n.body.includes("90,000") || !n.body.includes("Support this tenant for UGX 600,000 by paying their landlord on the platform and earn monthly Returns. Start here today.")) {
    throw new Error(`new og-plan: ${n.body.slice(0, 600)}`);
  }
});

async function callOg(which: "origin" | "new", seed: () => void, code = "abcd1234") {
  _resetPolicyCacheForTests();
  seed();
  const handler = await loadHandler("og-plan", which);
  return await deterministic(async () => {
    const res = await handler(new Request(`http://edge.test/og-plan?code=${code}`, { method: "GET" }));
    return { status: res.status, body: await res.text() };
  });
}

Deno.test("E11.17 import-partners: same partners, portfolios and roles stored (batched calls differ by design)", async () => {
  const body = {
    partners: [
      { partner_name: "Paper One", phone: "+256701000001", email: "one@example.com", portfolios: [{ amount: 100_000, roiPercentage: 15, durationMonths: 12, roiMode: "monthly_payout" }, { amount: 200_000, roiPercentage: 20, durationMonths: 6, roiMode: "monthly_compounding", contributionDate: "2025-05-01" }] },
      { partner_name: "Pat Partner", phone: "+256772000111", email: null, portfolios: [{ amount: 300_000, roiPercentage: 15, durationMonths: 12, roiMode: "monthly_payout" }] },
      { partner_name: "Paper Two", phone: "", email: "two@example.com", portfolios: [{ amount: 100_000, roiPercentage: 15, durationMonths: 12, roiMode: "monthly_payout" }] },
    ],
  };
  const seed = () => {
    off();
    state.rpc.profile_ids_by_emails = (args: { p_emails: string[] }) => {
      const want = new Set((args.p_emails ?? []).map((e) => e.toLowerCase()));
      return { data: table("profiles").filter((p) => p.email && want.has(String(p.email).toLowerCase())).map((p) => ({ id: p.id, email: String(p.email).toLowerCase() })), error: null };
    };
  };
  const o = await run("import-partners", "origin", seed, { jwt: "jwt-manager", body });
  const n = await run("import-partners", "new", seed, { jwt: "jwt-manager", body });
  const nameOf = (s: Snapshot) => new Map((s.tables.profiles ?? []).map((p) => [p.id, p.full_name]));
  const view = (s: Snapshot) => {
    const names = nameOf(s);
    return {
      status: s.status,
      totals: [s.body.partnersCreated, s.body.partnersMatched, s.body.portfoliosCreated, s.body.skippedDuplicates, s.body.errors, s.body.credentials.length],
      portfolios: (s.tables.investor_portfolios ?? []).map((p) => ({
        who: names.get(p.investor_id), amount: p.investment_amount, rate: p.roi_percentage, basis: p.rate_basis, months: p.duration_months,
        mode: p.roi_mode, status: p.status, payout_day: p.payout_day, maturity: p.maturity_date, next: p.next_roi_date,
        created: String(p.created_at).slice(0, 10), agentIsSelf: p.agent_id === p.investor_id,
      })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1),
      profiles: (s.tables.profiles ?? []).map((p) => ({ name: p.full_name, email: p.email?.endsWith("@noapp.welile.user") ? "placeholder" : p.email, phone: p.phone ?? null, must_change_password: p.must_change_password ?? null })).sort((a, b) => a.name < b.name ? -1 : 1),
      supporters: (s.tables.user_roles ?? []).filter((r) => r.role === "supporter").map((r) => names.get(r.user_id)).sort(),
      audit: (s.tables.audit_logs ?? []).map((a) => ({ who: names.get(a.record_id), meta: { ...a.metadata, imported_by: "*" } })).sort((a, b) => a.who < b.who ? -1 : 1),
    };
  };
  const vo = view(o), vn = view(n);
  // The new response adds per-row CFO fields (section 8.4 import-partners); compare the shared totals.
  const d = firstDiff(vo, vn);
  if (d) throw new Error(`import-partners differs: ${d}`);
  applied["import-partners"] = ["batched calls and per-row CFO fields (section 8.4): compared stored state + totals"];
});

// ---- round 2: functions the fix round (E1-E6) touched -------------------------------------------------

const PUBLIC_ROW = { roi_percentage: 15, rate_basis: "switch_off" };
/** A portfolio written before Phase 1: rate_basis NULL (no backfill). Public until the cut-off exists (F1). */
const LEGACY_ROW = { roi_percentage: 20, rate_basis: null };
const transactionalEmail = (e: any) => String(e.target).endsWith("/functions/v1/send-transactional-email") ? e.payload?.templateData : null;

Deno.test("E11.18 approve-pending-portfolio: agreement email (public row; legacy row; login email differs / none)", async () => {
  for (const row of [PUBLIC_ROW, LEGACY_ROW]) {
    await golden(`approve-pending-portfolio ${row.rate_basis}`, "approve-pending-portfolio",
      () => { off(); seedPendingPortfolio(row); },
      { jwt: "jwt-ops", body: { portfolio_id: PF } });
  }
});

Deno.test("E11.19 approve-pending-portfolio: self-managed deployment email", async () => {
  await golden("approve-pending-portfolio self-managed", "approve-pending-portfolio",
    () => { off(); seedPendingPortfolio(PUBLIC_ROW); table("funder_pending_portfolios").push({ portfolio_id: PF, source: "self_managed_house", commitment_id: null, term_months: 12 }); },
    { jwt: "jwt-ops", body: { portfolio_id: PF } });
});

Deno.test("E11.20 approve-pending-portfolio, legacy row: self-managed deployment email, identical with no cut-off (F1)", async () => {
  await golden("approve-pending-portfolio legacy self-managed", "approve-pending-portfolio",
    () => { off(); seedPendingPortfolio(LEGACY_ROW); table("funder_pending_portfolios").push({ portfolio_id: PF, source: "self_managed_house", commitment_id: null, term_months: 12 }); },
    { jwt: "jwt-ops", body: { portfolio_id: PF } });
});

Deno.test("E11.21 resend-portfolio-invite with a staff copy (public row; legacy row)", async () => {
  for (const row of [PUBLIC_ROW, LEGACY_ROW]) {
    // With no cut-off a legacy row is public too (F1): the staff-typed copy keeps the rate, as in origin.
    const allows: [string, Allow][] = [["section 8.4 (round 3 additions): the response gains sent_to, origin's address before the cut-off", (o, n) => {
      if (n.body.sent_to !== o.body.partner_email) throw new Error(`sent_to ${n.body.sent_to} is not origin's recipient ${o.body.partner_email}`);
      delete n.body.sent_to;
    }]];
    await golden(`resend-portfolio-invite ${row.rate_basis}`, "resend-portfolio-invite",
      () => { off(); seedPendingPortfolio(row, { status: "awaiting_partner_details" }); },
      { jwt: "jwt-ops", body: { portfolio_id: PF, copy_to: "copy@example.com" } },
      allows);
  }
});

Deno.test("E11.22 top-up confirmations: manager-portfolio-topup, coo-wallet-to-portfolio, approve-portfolio-topup", async () => {
  for (const row of [PUBLIC_ROW, LEGACY_ROW]) {
    for (const fn of ["manager-portfolio-topup", "coo-wallet-to-portfolio"]) {
      await golden(`${fn} ${row.rate_basis}`, fn, () => { off(); seedTopupPortfolio(row); }, { jwt: "jwt-manager", body: topupBody });
    }
    await golden(`approve-portfolio-topup ${row.rate_basis}`, "approve-portfolio-topup",
      () => { off(); seedTopupPortfolio(row); seedTopupOperation(); },
      { jwt: "jwt-manager", body: { portfolio_id: PF, action: "approve" } });
  }
});

Deno.test("E11.23 process-supporter-roi inline top-up merge (disabled flag turned on in both copies)", async () => {
  const variant = (which: "origin" | "new") => loadHandlerVariant("process-supporter-roi", which, inlineTopupMergeOn);
  const rows = [
    { id: "cccccccc-0000-4000-8000-0000000000a1", investor: PARTNER, rate: 15, rate_basis: "switch_off" },
    { id: "cccccccc-0000-4000-8000-0000000000b2", investor: PARTNER, rate: 20, rate_basis: null },
    { id: "cccccccc-0000-4000-8000-0000000000c3", investor: PARTNER2, rate: 15, rate_basis: "typed_switch_off" },
  ];
  await golden("process-supporter-roi top-up merge", variant,
    () => { off(); seedRoiTopups(rows); },
    { body: {} },
    [["wording: ROI -> Returns in titles and the manager ping", (o, n) => {
      for (const s of [o, n]) {
        for (const e of s.log) if (typeof e.payload?.title === "string") e.payload.title = e.payload.title.replace(/ROI/g, "Returns");
        for (const r of s.tables.notifications ?? []) if (typeof r.title === "string") r.title = r.title.replace(/ROI/g, "Returns");
        forEntries(s, (e) => String(e.target).endsWith("/notify-managers"), (e) => { e.payload.title = "*"; e.payload.body = "*"; });
      }
    }], ["origin sends each top-up email inside the loop, the new code after it: compared as a set", (o, n) => {
      for (const s of [o, n]) {
        const mails = s.log.filter((e) => transactionalEmail(e));
        const rest = s.log.filter((e) => !transactionalEmail(e));
        s.log = [...rest, ...mails.sort((a, b) => JSON.stringify(canon(a)) < JSON.stringify(canon(b)) ? -1 : 1)];
      }
    }]]);
});

Deno.test("E11.24 submit-partner-form (new person; existing account)", async () => {
  for (const existing of [false, true]) {
    await golden(`submit-partner-form existing=${existing}`, "submit-partner-form",
      () => {
        off();
        table("agent_form_tokens").push({ id: "t1", token: "tok", agent_id: AGENT, is_active: true, expires_at: "2027-01-01T00:00:00Z", uses_count: 0, max_uses: 10 });
        const partner = table("profiles").find((p) => p.id === PARTNER)!;
        if (existing) partner.phone = "+256772000999";
      },
      {
        body: {
          token: "tok", agent_id: AGENT, full_name: "Pat Partner Test", phone: "0772000999", email: "pat.new@example.com",
          residence: "Kira", investment_amount: 1_000_000, payout_method: "mobile_money", mobile_money_number: "0772000999",
        },
      });
  }
});

Deno.test("E11.25 welile-ai-chat, signed in: estimate without a rate and own portfolios (AI replies fixed)", async () => {
  const seed = () => {
    off();
    aiReplies.length = 0;
    aiRequests.length = 0;
    state.rpc.partner_quote_rate = () => ({ data: 15, error: null }); // partner_rate_now with the switch off
    state.rpc.nexa_get_my_portfolios = () => ({ data: [], error: null });
    aiReplies.push(
      {
        choices: [{
          message: {
            content: "",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "estimate_supporter_returns", arguments: JSON.stringify({ amount: 1_000_000 }) } },
              { id: "c2", type: "function", function: { name: "get_my_portfolios", arguments: "{}" } },
            ],
          },
        }],
      },
      { choices: [{ message: { content: "About UGX 150,000 a month." } }] },
    );
  };
  await golden("welile-ai-chat signed in", "welile-ai-chat", seed,
    {
      jwt: "jwt-partner",
      body: { messages: [{ role: "user", content: "How much would I earn as a supporter partner returns on 1,000,000? my portfolio balance" }] },
      headers: { "x-forwarded-for": "10.2.0.1" },
    },
    [
      ["section 8.4 Nexa: system prompt and tool definitions (live public rate, own-rate tool); the tool RESULTS are still compared", (o, n) => {
        for (const s of [o, n]) {
          for (const e of s.log) {
            if (!String(e.target).includes("ai.gateway.lovable.dev")) continue;
            e.payload.tools = "*";
            e.payload.messages[0].content = "*";
          }
        }
      }],
      ["section 8.4 Nexa: origin's estimate default was a hard-coded 10%; the new default is the caller's own rate (15 with the switch off)", (o, n) => {
        const toolMsgs = (s: Snapshot) => s.log.filter((e) => String(e.target).includes("ai.gateway.lovable.dev")).flatMap((e) => e.payload.messages.filter((m: any) => m.role === "tool"));
        const om = toolMsgs(o), nm = toolMsgs(n);
        om.forEach((m: any, i: number) => {
          const a = JSON.parse(m.content), b = nm[i] ? JSON.parse(nm[i].content) : null;
          if (a?.monthlyRatePercent === 10 && b?.monthlyRatePercent === 15 && a.amount === b.amount && a.months === b.months && a.mode === b.mode) m.content = nm[i].content;
        });
      }],
      ["section 8.4 Nexa: partner_quote_rate('me') read for the default rate (read only)", (_o, n) => {
        n.log = n.log.filter((e) => !(e.kind === "rpc" && e.target === "partner_quote_rate"));
      }],
    ]);
});

function reportSeed() {
  off();
  fetchRoutes.length = 0;
  fetchRoutes.push({ match: (u) => u.includes("welile-logo.png"), answer: () => ({ status: 404, text: "" }) });
  state.rpc.get_partner_ops_range_report = () => ({ data: { kpis: { total_capital: 5_000_000, active_portfolios: 4 } }, error: null });
  state.rpc.get_partner_ops_compound_topup_outlook = () => ({ data: null, error: null });
  state.rpc.get_partner_return_report = () => ({ data: null, error: { code: "PGRST202", message: "missing" } });
  table("system_events");
  table("promissory_notes");
}
const reportSection: [string, Allow] = ["section 8.4 daily report: new Returns section (get_partner_return_report read; system_events metadata gains returns_check; the PDF grows by the section)", (o, n) => {
  for (const s of [o, n]) {
    if (s.body?.report?.pdf_bytes) s.body.report.pdf_bytes = "*";
    for (const e of s.log) if (e.target === "system_events" && e.payload?.metadata?.pdf_bytes) e.payload.metadata.pdf_bytes = "*";
    for (const r of s.tables.system_events ?? []) if (r.metadata?.pdf_bytes) r.metadata.pdf_bytes = "*";
  }
  n.log = n.log.filter((e) => !(e.kind === "rpc" && e.target === "get_partner_return_report"));
  for (const e of n.log) if (e.target === "system_events" && e.payload?.metadata) delete e.payload.metadata.returns_check;
  for (const r of n.tables.system_events ?? []) if (r.metadata) delete r.metadata.returns_check;
}];

Deno.test("E11.26 partner-ops-daily-report: service key send (full reply)", async () => {
  try {
    await golden("partner-ops-daily-report service key", "partner-ops-daily-report", reportSeed,
      { body: { to: "cfo@example.com", force: true }, headers: { Authorization: `Bearer ${SERVICE_KEY}` } },
      [reportSection]);
  } finally {
    fetchRoutes.length = 0;
  }
});

Deno.test("E11.27 partner-ops-daily-report: today's cron (no credentials)", async () => {
  try {
    await golden("partner-ops-daily-report cron", "partner-ops-daily-report", reportSeed,
      { body: { date: "2026-11-07" }, headers: { apikey: "anon-key" } },
      [reportSection, ["section 8.4 'gated endpoint' (E4): the no-credentials reply is { success, skipped } only, not the whole report", (o, n) => {
        if (n.body && Object.keys(n.body).sort().join() === "skipped,success" && o.body?.success === true && n.body.skipped === (o.body.report?.skipped === true)) {
          o.body = n.body;
        }
      }]]);
  } finally {
    fetchRoutes.length = 0;
  }
});

Deno.test("E11.28 import-partners: rates below 1% and bad rows give origin's errors; nothing stored", async () => {
  const body = {
    partners: [
      { partner_name: "Low Rate", phone: "+256701000011", email: "low@example.com", portfolios: [{ amount: 100_000, roiPercentage: 0.5, durationMonths: 12, roiMode: "monthly_payout" }] },
      { partner_name: "Zero Rate", phone: "+256701000012", email: "zero@example.com", portfolios: [{ amount: 100_000, roiPercentage: 0, durationMonths: 12, roiMode: "monthly_payout" }] },
      { partner_name: "Small Amount", phone: "+256701000013", email: "small@example.com", portfolios: [{ amount: 10_000, roiPercentage: 15, durationMonths: 12, roiMode: "monthly_payout" }] },
    ],
  };
  const seed = () => {
    off();
    state.rpc.profile_ids_by_emails = () => ({ data: [], error: null });
  };
  const o = await run("import-partners", "origin", seed, { jwt: "jwt-manager", body });
  const n = await run("import-partners", "new", seed, { jwt: "jwt-manager", body });
  const view = (s: Snapshot) => ({ status: s.status, created: s.body.portfoliosCreated, errors: s.body.errors, portfolios: (s.tables.investor_portfolios ?? []).length });
  const d = firstDiff(view(o), view(n));
  if (d) throw new Error(`import-partners lower bound differs: ${d}`);
  applied["import-partners lower bound"] = ["compared response errors + stored portfolios (calls are batched by design)"];
});

// ---- phone-signup, confirm-phone-account, self-update-phone (round 3 F2 proof writes withdrawn in round 4 U1) --

/** The three phone functions are byte-identical to origin/lovable again: every path below (the verified
 *  code included) must match origin with NO allowance -- no otp_login_audit row, no linker call. */
const PHONE = "256772000999";
const otpOk = (last9 = "772000999", minAgo = 5) =>
  table("otp_verifications").push({ phone: last9, verified: true, verified_at: new Date(Date.parse("2026-11-07T09:00:00Z") - minAgo * 60_000).toISOString() });
Deno.test("E11.29 phone-signup (verified code; refused: no code, other number)", async () => {
  const body = { email: "772000999@welile.user", password: "secret1", full_name: "Nora New", phone: PHONE };
  await golden("phone-signup verified", "phone-signup", () => { off(); otpOk(); }, { body });
  await golden("phone-signup no code", "phone-signup", () => { off(); }, { body });
  await golden("phone-signup other number", "phone-signup", () => { off(); otpOk("772000888"); }, { body });
});

Deno.test("E11.30 confirm-phone-account (first confirmation; later code; already confirmed)", async () => {
  const user = (extra: Row) => state.authUsers.push({
    id: "abababab-0000-4000-8000-000000000001", email: "772000999@welile.user", email_confirmed_at: null,
    created_at: "2026-11-07T08:56:00Z", user_metadata: { phone: PHONE }, ...extra,
  });
  const body = { user_id: "abababab-0000-4000-8000-000000000001", phone: PHONE };
  await golden("confirm-phone-account first", "confirm-phone-account", () => { off(); otpOk(); user({}); }, { body });
  await golden("confirm-phone-account later code", "confirm-phone-account", () => { off(); otpOk(); user({ created_at: "2026-11-07T08:50:00Z" }); }, { body });
  await golden("confirm-phone-account already confirmed", "confirm-phone-account", () => { off(); otpOk(); user({ email_confirmed_at: "2026-11-07T08:57:00Z" }); }, { body });
});

Deno.test("E11.31 self-update-phone (first phone; refused without a code)", async () => {
  const seed = (code: boolean) => () => {
    off();
    if (code) otpOk();
    signIn("jwt-caller", { id: "cdcdcdcd-0000-4000-8000-000000000001", email: "cara@example.com", email_confirmed_at: "2026-10-01T00:00:00Z", phone: null });
    table("profiles").push({ id: "cdcdcdcd-0000-4000-8000-000000000001", full_name: "Cara Caller", phone: null });
    table("audit_logs");
  };
  await golden("self-update-phone first phone", "self-update-phone", seed(true), { jwt: "jwt-caller", body: { phone: "0772000999" } });
  await golden("self-update-phone no code", "self-update-phone", seed(false), { jwt: "jwt-caller", body: { phone: "0772000999" } });
});

Deno.test("E11.z report the allowed differences", () => {
  console.log("\nE11 allowed differences applied:\n" + Object.entries(applied).map(([k, v]) => `  ${k}: ${v.length ? v.join("; ") : "none (identical)"}`).join("\n"));
  void MANAGER;
});
