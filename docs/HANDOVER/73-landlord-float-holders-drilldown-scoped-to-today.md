# 73 — Landlord Float "Holders" drilldown now scoped to today too

**Migration written, blocked by the auto-mode classifier — needs manual apply, same as docs
66/69/71. Follows directly from doc 71. Before touching `WalletBucketHoldersPanel.tsx`'s
`landlord_float` branch or `get_landlord_float_due_today()` again.**

## What was reported

After doc 71 shipped (Wallet Buckets tile now shows ~4M, today's funded-not-yet-paid rent, instead
of the ~80M total float held), Josh clicked into the tile and sent a screenshot of the "Landlord
Float — Holders" drilldown still showing UGX 80,257,727 at the top: "NOW IT IS SHOWING 80M."

## What was found

Not a regression — the drilldown (`WalletBucketHoldersPanel.tsx`, opened by tapping the Wallet
Buckets tile) is a genuinely separate screen from the list tile doc 71 fixed. It read
`agent_landlord_float.balance` directly (every agent's running float balance, all backlog
included), never touched by that migration. Landing on it right after seeing the corrected ~4M on
the previous screen made it look like the fix hadn't taken.

Asked Josh whether this drilldown should stay as "who's holding how much float" (a legitimately
different question) or also switch to "today." He chose to also switch it.

## What was fixed

New RPC **`get_landlord_float_due_today()`** (migration
`20260918150000_landlord_float_due_today_holders.sql`, **written, not yet applied**) — same
"today" definition as doc 71 (rent_requests funded today, Africa/Kampala, with no completed
landlord_payouts yet), but read through `agent_landlord_float_allocations` (the existing per-agent,
per-rent_request earmark table — already used by `create_landlord_float_allocation` and the
existing company/funder source-split card) instead of raw `rent_requests`, so it can be grouped by
agent. Returns both the per-agent holder list AND the company-vs-funder split in one call, so the
two can never disagree with each other.

`WalletBucketHoldersPanel.tsx`, `landlord_float` branch:
- `loadHolders` now calls this RPC instead of reading `agent_landlord_float` directly (both the
  old search path via `resolveSearchIds` + `batchedQuery`, and the old top-500-by-balance browse
  path, are gone — the due-today list is small, so search is now a simple client-side substring
  filter over the already-fetched rows).
- Per-row `meta` changed from all-time `Funded X • Paid out Y` (misleading next to a due-today
  headline) to `N rent request(s) funded today • Landlord(s): ...`.
- The `sourceSplit` query (the "Funded by company float" / "Funded by funders directly" summary
  cards) now reads from the same new RPC instead of an unfiltered read of
  `agent_landlord_float_allocations`, so it's scoped to today too.
- `TITLES.landlord_float.desc`/`amountLabel` updated to describe "today," not "reserved."

**Deliberately left alone:**
- The "Float receivable" card (funder pledges not yet deposited) — a genuinely forward-looking
  figure, not tied to any `rent_request.funded_at`, so it has no "today" analog and stays
  unfiltered.
- The "Unearmarked float" card's formula (`total − company − funder`) — untouched, and now
  correctly nets to ~0 in practice under the today scope (verified live: the one due-today
  allocation is fully sourced as `cfo_disbursement`, so nothing is left unaccounted for).

**Until the migration is applied, this drilldown will still show the old ~80.3M total-held
figures.**

## What not to do

- Don't be surprised that this drilldown and the parent tile (doc 71) needed two separate fixes —
  they're two different data-fetching paths (`get_wallet_bucket_totals()` vs. this new RPC) reading
  two different sources (`rent_requests` directly vs. `agent_landlord_float_allocations`) that
  happen to compute the same headline number. If a third "Landlord Float" surface turns up showing
  the old total-held number, it needs its own equivalent fix — there is no single shared query
  underneath all of them.
- Don't reuse `agent_landlord_float.balance`, `total_funded`, or `total_paid_out` for anything
  framed as "today" — those are lifetime running totals per agent, unrelated to same-day funding.
- Don't fold the "Float receivable" or "Unearmarked float" cards into the today scope without
  asking first — the first is forward-looking by definition and the second's meaning changes
  entirely (it goes from "float genuinely sitting idle" to "today's funding missing a recorded
  source," a much narrower and rarer thing to flag).
