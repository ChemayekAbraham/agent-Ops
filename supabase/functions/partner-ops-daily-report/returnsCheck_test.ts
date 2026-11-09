import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { returnsCheckView } from "./returnsCheck.ts";

const NOW = "2026-11-07T18:00:00Z"; // 21:00 EAT

// A healthy answer while the switch is off (shape of get_partner_return_report).
function healthy(): any {
  return {
    window: { start: "2026-11-07", end: "2026-11-07" },
    policy: { enabled: false, release_ready: false, cutoff_at: null, enabled_at: null, public_rate: 15, new_contract_rate: 10 },
    new_portfolios: [
      { basis: "switch_off", rate: 15, count: 3, amount: 3_000_000 },
      { basis: "typed_switch_off", rate: 20, count: 1, amount: 500_000 },
    ],
    notes: [],
    cfo_queue: { pending: 0, oldest_pending_at: null, approved_in_window: 0, rejected_in_window: 0, pending_lowering: 0 },
    conformance: {},
    checks_failing: [],
    release_checks_failing: [],
    assert_has_phase4_hook: true,
    drift_open: [],
    monitor: { scheduled: true, active: true, last_end: "2026-11-07T17:55:00Z", last_status: "succeeded" },
    rule_check: {
      cohort_new_below_own: 0, non_cohort_new_above_public: 0, precutoff_offer_live_non_cohort: 0,
      open_pending_portfolios: 0, note_windows_beyond_90d: 0,
    },
  };
}

Deno.test("healthy, switch off: tiles, monitor line, no watch items", () => {
  const v = returnsCheckView(healthy(), NOW);
  assertEquals(v.state, "ok");
  assertEquals(v.watch, []);
  assertEquals(v.tiles.map((t) => t.label), ["Switch", "New-partner rate", "New portfolios", "CFO rate queue", "Monitor"]);
  assertEquals(v.tiles[0].value, "Off");
  assertEquals(v.tiles[0].sub, "Never switched on");
  assertEquals(v.tiles[1].value, "15%");
  assertEquals(v.tiles[1].sub, "Existing partners keep their own rate");
  assertEquals(v.tiles[2].value, "4");
  assert(v.tiles[2].sub.includes("switch off 3") && v.tiles[2].sub.includes("typed 1") && v.tiles[2].sub.includes("new 0"));
  assertEquals(v.tiles[4].value, "20:55 EAT");
  assertEquals(v.monitorLine, "Returns monitor last ran at 20:55 EAT, 7 Nov (succeeded); it runs every 10 minutes.");
  assert(v.summaryText.startsWith("Returns rate check: switch off, new partners 15%, 4 new portfolios (0 awaiting CFO)."));
  assertEquals(v.meta, { enabled: false, checks_failing: [], monitor_last_end: "2026-11-07T17:55:00.000Z", note_links_held: 0 });
});

Deno.test("switch on: On since / Cut-off dates in EAT", () => {
  const rc = healthy();
  rc.policy = { ...rc.policy, enabled: true, cutoff_at: "2026-11-30T21:30:00Z", enabled_at: "2026-11-30T21:30:00Z", public_rate: 10 };
  const v = returnsCheckView(rc, NOW);
  assertEquals(v.tiles[0].value, "On since 1 Dec 2026");
  assertEquals(v.tiles[0].sub, "Cut-off 1 Dec 2026");
  assertEquals(v.tiles[1].value, "10%");
});

Deno.test("every watch item", () => {
  const rc = healthy();
  rc.checks_failing = ["renewal_keeps_rate", "assert_failed: boom"];
  rc.assert_has_phase4_hook = false;
  rc.release_checks_failing = [{ check_name: "rate_masked_for_others" }, "note_browser_writes_closed"];
  rc.drift_open = [{ check: "partner_rate.conformance", since: "2026-11-07T10:00:00Z" }];
  rc.monitor = { scheduled: true, active: true, last_end: "2026-11-07T16:00:00Z", last_status: "failed" };
  rc.cfo_queue = { pending: 4, oldest_pending_at: "2026-11-01T18:00:00Z", approved_in_window: 1, rejected_in_window: 1, pending_lowering: 2 };
  rc.conformance = { above_entitled: 2, below_entitled: 1 };
  rc.rule_check = {
    cohort_new_below_own: 1, non_cohort_new_above_public: 2, precutoff_offer_live_non_cohort: 3,
    open_pending_portfolios: 5, note_windows_beyond_90d: 6,
  };
  const w = returnsCheckView(rc, NOW).watch;
  const has = (s: string) => assert(w.some((x) => x.includes(s)), `${s}\n${w.join("\n")}`);
  has("Partner Returns checks failing: renewal_keeps_rate, assert_failed: boom");
  has("Returns checks hook missing from the assert: re-apply 4a's assert line");
  has("Before release: rate_masked_for_others, note_browser_writes_closed");
  has("Partner Returns problem open since 13:00 EAT, 7 Nov: partner_rate.conformance");
  has("Returns monitor last ran at 19:00 EAT, 7 Nov (over 30 minutes ago)");
  has("Returns monitor's last run failed");
  has("CFO Returns-rate queue: 4 pending, oldest 6 days");
  has("2 CFO requests would lower a partner below their own rate");
  has("3 portfolios have a Returns rate that does not match the rule");
  has("1 existing partner portfolio below the partner's own rate");
  has("2 new-partner portfolios above the new-partner rate (CFO-approved or drift)");
  has("3 portfolios written before the cut-off and live after it keep a rate above the new-partner rate");
  has("5 portfolios not yet live: approve or cancel before switch-on");
  has("6 promissory note windows run more than 90 days past the cut-off");
  // Copy rules: Rent Plan / Supporter / Returns, never ROI, interest, loan, lender.
  for (const line of w) assert(!/\b(ROI|interest|loan|lender)\b/i.test(line), line);
});

Deno.test("open pending portfolios are a pre-switch item only", () => {
  const rc = healthy();
  rc.policy.enabled = true;
  rc.rule_check.open_pending_portfolios = 5;
  assert(!returnsCheckView(rc, NOW).watch.some((x) => x.includes("not yet live")));
});

Deno.test("monitor not scheduled / never run", () => {
  const rc = healthy();
  rc.monitor = { scheduled: false };
  let v = returnsCheckView(rc, NOW);
  assertEquals(v.watch, ["Returns monitor is not scheduled"]);
  assertEquals(v.monitorLine, "Returns monitor has not run yet.");
  rc.monitor = { scheduled: true, active: true, last_end: null, last_status: null };
  v = returnsCheckView(rc, NOW);
  assertEquals(v.watch, ["Returns monitor has not run yet"]);
});

Deno.test("function missing -> not installed yet, no watch item; other error -> unavailable + watch", () => {
  for (const code of ["PGRST202", "42883"]) {
    const v = returnsCheckView({ error: "Could not find the function", code }, NOW);
    assertEquals(v.state, "not_installed");
    assertEquals(v.note, "Returns rate check not installed yet.");
    assertEquals(v.watch, []);
    assertEquals(v.tiles, []);
  }
  const v = returnsCheckView({ error: "INVALID_WINDOW", code: "22023" }, NOW);
  assertEquals(v.state, "unavailable");
  assertEquals(v.note, "Returns rate check unavailable.");
  assertEquals(v.watch, ["Returns rate check failed: INVALID_WINDOW"]);
  assertEquals(returnsCheckView(null, NOW).state, "unavailable");
});

Deno.test("no personal data: the view is counts and rates only", () => {
  const rc = healthy();
  rc.new_portfolios.push({ basis: "existing_partner", rate: 20, count: 2, amount: 9_000_000, partner_name: "Should Not Show" });
  const v = returnsCheckView(rc, NOW);
  assert(!JSON.stringify(v).includes("Should Not Show"));
  assert(v.tiles[2].sub.includes("existing 2"));
});

Deno.test("held note links: a watch item, a sentence in the text part and a count in system_events", () => {
  // A missing key (SQL older than the fix) counts as 0: nothing shown.
  const none = returnsCheckView(healthy(), NOW);
  assert(!none.watch.some((x) => x.includes("waiting for Partner Ops")));
  assert(!none.summaryText.includes("waiting for Partner Ops"));
  assertEquals(none.meta.note_links_held, 0);

  const rc = healthy();
  rc.note_links_held = 3;
  const v = returnsCheckView(rc, NOW);
  const item = "3 promissory notes waiting for Partner Ops: the account never proved the note's phone or email";
  assertEquals(v.watch, [item]);
  assert(v.summaryText.includes(`(0 awaiting CFO). ${item}. Returns monitor last ran`), v.summaryText);
  assertEquals(v.meta.note_links_held, 3);

  rc.note_links_held = 1;
  assertEquals(returnsCheckView(rc, NOW).watch, ["1 promissory note waiting for Partner Ops: the account never proved the note's phone or email"]);
  for (const bad of [0, null, "x", -2]) {
    rc.note_links_held = bad;
    assertEquals(returnsCheckView(rc, NOW).watch, [], String(bad));
  }
  // The check did not answer: no count.
  assertEquals(returnsCheckView({ error: "boom", code: "XX000" }, NOW).meta.note_links_held, null);
  for (const line of v.watch) assert(!/(ROI|interest|loan|lender)/i.test(line), line);
});
