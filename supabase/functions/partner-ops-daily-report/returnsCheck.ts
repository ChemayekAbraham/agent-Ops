// "Returns rate check" section of the daily partner report: a pure view over the JSON returned by
// get_partner_return_report(p_start, p_end) (Partner Returns Phase 4a). Counts only, no names.
//
// The owner's rule: new partners earn the new-partner rate from the cut-off; existing partners keep
// their own rate. The watch items below are what needs a person's attention.

export interface ReturnsTile {
  label: string;
  value: string;
  sub: string;
  kind?: "hero" | "good" | "bad";
}

export interface ReturnsCheckView {
  /** ok: the RPC answered; not_installed: the SQL is not applied yet; unavailable: any other failure. */
  state: "ok" | "not_installed" | "unavailable";
  /** Section text to print instead of the tiles when state is not ok. */
  note: string | null;
  tiles: ReturnsTile[];
  monitorLine: string;
  /** Items for the report's Watchlist. */
  watch: string[];
  /** One line for the plain-text email part. */
  summaryText: string;
  /** Small, figure-free summary for the system_events metadata. */
  meta: {
    enabled: boolean | null;
    checks_failing: string[];
    monitor_last_end: string | null;
    /** Promissory notes the database would not link (D3): null when the check did not answer. */
    note_links_held: number | null;
  };
}

const FUNCTION_MISSING = new Set(["PGRST202", "42883"]);
const MONITOR_STALE_MS = 30 * 60 * 1000;
const CFO_QUEUE_OLD_MS = 3 * 24 * 60 * 60 * 1000;
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const plural = (count: number, one: string, many = `${one}s`) => (count === 1 ? one : many);
const ts = (v: unknown): number | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
function eatParts(ms: number) {
  const d = new Date(ms + EAT_OFFSET_MS);
  return {
    hh: String(d.getUTCHours()).padStart(2, "0"),
    mm: String(d.getUTCMinutes()).padStart(2, "0"),
    day: d.getUTCDate(),
    mon: MONTHS[d.getUTCMonth()],
    year: d.getUTCFullYear(),
  };
}
/** "21:05 EAT, 7 Nov" */
export function eatTimeLabel(ms: number): string {
  const p = eatParts(ms);
  return `${p.hh}:${p.mm} EAT, ${p.day} ${p.mon}`;
}
/** "7 Nov 2026" (EAT calendar day) */
export function eatDateLabel(ms: number): string {
  const p = eatParts(ms);
  return `${p.day} ${p.mon} ${p.year}`;
}
const fmtPct = (v: unknown): string | null => {
  const x = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(x) && x > 0 ? `${Math.round(x * 100) / 100}%` : null;
};
/** Check names from a list of strings or of { check_name } rows. */
function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? String((x as Record<string, unknown>).check_name ?? (x as Record<string, unknown>).check ?? "") : ""))
    .filter(Boolean);
}

/** new_portfolios rows grouped for the tile's sub line. */
const BASIS_GROUPS: Array<[string, string[]]> = [
  ["new", ["new", "new_no_investor"]],
  ["existing", ["existing_partner", "signed_agreement", "carried"]],
  ["employee", ["employee", "salary_reinvestment"]],
  ["note", ["promissory_note"]],
  ["switch off", ["switch_off"]],
  ["typed", ["typed_switch_off"]],
];

// deno-lint-ignore no-explicit-any
export function returnsCheckView(rc: any, nowIso: string): ReturnsCheckView {
  const now = ts(nowIso) ?? Date.now();
  const empty = (state: ReturnsCheckView["state"], note: string, watch: string[]): ReturnsCheckView => ({
    state,
    note,
    tiles: [],
    monitorLine: "",
    watch,
    summaryText: note,
    meta: { enabled: null, checks_failing: [], monitor_last_end: null, note_links_held: null },
  });

  if (rc && typeof rc === "object" && "error" in rc && rc.error) {
    const code = typeof rc.code === "string" ? rc.code : null;
    if (code && FUNCTION_MISSING.has(code)) return empty("not_installed", "Returns rate check not installed yet.", []);
    const msg = String(rc.error).slice(0, 160);
    return empty("unavailable", "Returns rate check unavailable.", [`Returns rate check failed: ${msg}`]);
  }
  if (!rc || typeof rc !== "object") {
    return empty("unavailable", "Returns rate check unavailable.", ["Returns rate check failed: no answer from the database"]);
  }

  const pol = (rc.policy ?? {}) as Record<string, unknown>;
  const enabled = pol.enabled === true;
  const cutoff = ts(pol.cutoff_at);
  const enabledAt = ts(pol.enabled_at);
  const publicPct = fmtPct(pol.public_rate);

  // --- New portfolios by basis ---
  const rows = Array.isArray(rc.new_portfolios) ? rc.new_portfolios : [];
  const byBasis = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const c = n(r?.count);
    total += c;
    const b = String(r?.basis ?? "unstamped");
    byBasis.set(b, (byBasis.get(b) ?? 0) + c);
  }
  const grouped = new Set<string>();
  const parts = BASIS_GROUPS.map(([label, bases]) => {
    bases.forEach((b) => grouped.add(b));
    return `${label} ${bases.reduce((a, b) => a + (byBasis.get(b) ?? 0), 0)}`;
  });
  const other = [...byBasis.entries()].filter(([b]) => !grouped.has(b)).reduce((a, [, c]) => a + c, 0);
  if (other > 0) parts.push(`other ${other}`);

  // --- CFO queue ---
  const q = (rc.cfo_queue ?? {}) as Record<string, unknown>;
  const pending = n(q.pending);
  const oldest = ts(q.oldest_pending_at);
  const oldestDays = oldest === null ? null : Math.max(0, Math.floor((now - oldest) / 86_400_000));
  const decided = n(q.approved_in_window) + n(q.rejected_in_window);

  // --- Monitor ---
  const mon = (rc.monitor ?? {}) as Record<string, unknown>;
  const scheduled = mon.scheduled !== false && mon.active !== false;
  const lastEnd = ts(mon.last_end);
  const lastStatus = typeof mon.last_status === "string" ? mon.last_status : null;
  const monitorLine = lastEnd !== null
    ? `Returns monitor last ran at ${eatTimeLabel(lastEnd)} (${lastStatus ?? "unknown"}); it runs every 10 minutes.`
    : "Returns monitor has not run yet.";

  const tiles: ReturnsTile[] = [
    {
      label: "Switch",
      value: enabled ? (enabledAt !== null ? `On since ${eatDateLabel(enabledAt)}` : "On") : "Off",
      sub: cutoff !== null ? `Cut-off ${eatDateLabel(cutoff)}` : "Never switched on",
      kind: enabled ? "good" : "hero",
    },
    { label: "New-partner rate", value: publicPct ?? "-", sub: "Existing partners keep their own rate" },
    { label: "New portfolios", value: String(total), sub: parts.join(" · ") },
    {
      label: "CFO rate queue",
      value: String(pending),
      sub: `${oldestDays === null ? "none pending" : `oldest ${oldestDays} ${plural(oldestDays, "day")}`} · decided in window ${decided}`,
      kind: pending > 0 ? "bad" : "hero",
    },
    {
      label: "Monitor",
      value: lastEnd !== null ? `${eatTimeLabel(lastEnd).split(",")[0]}` : "Not run",
      sub: !scheduled ? "not scheduled" : lastStatus ? `last run ${lastStatus}` : "no run yet",
      kind: !scheduled || (lastStatus !== null && lastStatus !== "succeeded") ? "bad" : "hero",
    },
  ];

  // --- Watch items ---
  const watch: string[] = [];
  const failing = names(rc.checks_failing);
  if (failing.length) watch.push(`Partner Returns checks failing: ${failing.join(", ")}`);
  if (rc.assert_has_phase4_hook === false) {
    watch.push("Returns checks hook missing from the assert: re-apply 4a's assert line");
  }
  const releaseFailing = names(rc.release_checks_failing);
  if (releaseFailing.length) watch.push(`Before release: ${releaseFailing.join(", ")}`);

  const drift = Array.isArray(rc.drift_open) ? rc.drift_open : [];
  if (drift.length) {
    const since = drift.map((d: Record<string, unknown>) => ts(d?.since)).filter((x: number | null): x is number => x !== null);
    const first = since.length ? Math.min(...since) : null;
    const driftNames = drift.map((d: Record<string, unknown>) => String(d?.check ?? "")).filter(Boolean);
    watch.push(`Partner Returns problem open since ${first !== null ? eatTimeLabel(first) : "unknown time"}: ${driftNames.join(", ")}`);
  }

  if (!scheduled) {
    watch.push("Returns monitor is not scheduled");
  } else {
    if (lastEnd === null) watch.push("Returns monitor has not run yet");
    else if (now - lastEnd > MONITOR_STALE_MS) watch.push(`Returns monitor last ran at ${eatTimeLabel(lastEnd)} (over 30 minutes ago)`);
    if (lastStatus !== null && lastStatus !== "succeeded") watch.push("Returns monitor's last run failed");
  }

  if (oldest !== null && now - oldest > CFO_QUEUE_OLD_MS) {
    watch.push(`CFO Returns-rate queue: ${pending} pending, oldest ${oldestDays} ${plural(oldestDays ?? 0, "day")}`);
  }
  const lowering = n(q.pending_lowering);
  if (lowering > 0) watch.push(`${lowering} CFO ${plural(lowering, "request")} would lower a partner below their own rate`);

  const conformance = rc.conformance && typeof rc.conformance === "object" ? rc.conformance as Record<string, unknown> : {};
  const notConforming = Object.values(conformance).reduce((a: number, v) => a + n(v), 0);
  if (notConforming > 0) {
    watch.push(`${notConforming} ${plural(notConforming, "portfolio")} ${notConforming === 1 ? "has" : "have"} a Returns rate that does not match the rule`);
  }

  const rule = (rc.rule_check ?? {}) as Record<string, unknown>;
  const belowOwn = n(rule.cohort_new_below_own);
  if (belowOwn > 0) watch.push(`${belowOwn} existing partner ${plural(belowOwn, "portfolio")} below the partner's own rate`);
  const abovePublic = n(rule.non_cohort_new_above_public);
  if (abovePublic > 0) {
    watch.push(`${abovePublic} new-partner ${plural(abovePublic, "portfolio")} above the new-partner rate (CFO-approved or drift)`);
  }
  const precutoff = n(rule.precutoff_offer_live_non_cohort);
  if (precutoff > 0) {
    watch.push(`${precutoff} ${plural(precutoff, "portfolio")} written before the cut-off and live after it ${precutoff === 1 ? "keeps" : "keep"} a rate above the new-partner rate (not an existing partner)`);
  }
  const openPending = n(rule.open_pending_portfolios);
  if (openPending > 0 && !enabled) {
    watch.push(`${openPending} ${plural(openPending, "portfolio")} not yet live: approve or cancel before switch-on`);
  }
  const longWindows = n(rule.note_windows_beyond_90d);
  if (longWindows > 0) {
    watch.push(`${longWindows} promissory note ${plural(longWindows, "window")} ${longWindows === 1 ? "runs" : "run"} more than 90 days past the cut-off`);
  }
  // Notes the database did not link to an account (D3): the account never proved the note's phone or
  // email, so Partner Ops links them by hand. A missing key (older SQL) counts as 0.
  const linksHeld = n(rc.note_links_held);
  const linksHeldItem = linksHeld > 0
    ? `${linksHeld} promissory ${plural(linksHeld, "note")} waiting for Partner Ops: the account never proved the note's phone or email`
    : null;
  if (linksHeldItem) watch.push(linksHeldItem);

  const summaryText = `Returns rate check: switch ${enabled ? "on" : "off"}, new partners ${publicPct ?? "-"}, ${total} new ${plural(total, "portfolio")} (${pending} awaiting CFO).${linksHeldItem ? ` ${linksHeldItem}.` : ""} ${monitorLine}`;

  return {
    state: "ok",
    note: null,
    tiles,
    monitorLine,
    watch,
    summaryText,
    meta: {
      enabled,
      checks_failing: failing,
      monitor_last_end: lastEnd !== null ? new Date(lastEnd).toISOString() : null,
      note_links_held: linksHeld,
    },
  };
}
