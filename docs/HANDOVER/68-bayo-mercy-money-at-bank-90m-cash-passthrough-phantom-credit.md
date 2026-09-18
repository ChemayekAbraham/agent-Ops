# 68 — "Money at Bank" showed 90,002,000 as Reconciled when 90M of it had already been spent a week earlier

**Read this before touching `get_money_at_bank_reconciliation()`, or if the Bayo Mercy account
reconciliation panel (`BankEmailReconciliationPanel.tsx`, CFO Overview) shows a total that doesn't
match what Financial Ops knows is actually in the account. Migration written, blocked by the
auto-mode classifier — needs manual apply.**

## What was reported

Josh flagged, from the CFO Overview panel: "THIS MONEY WAS NOT RECONCILED YET IT WAS MOVED" —
the panel showed Bayo Mercy's account as **Reconciled**, Money at Bank UGX 90,002,000, with a
stale hardcoded freshness badge ("Emails from 11:40 AM Kampala, 3 Sep 2026") that hadn't been true
since the day it was written. He then explained: Mercy received 90,000,000 UGX cash from the
company, paid Pr. Nasasira 15,690,000 UGX cash, and carried the remaining 74,310,000 UGX to Sky
Bubbles as cash — attaching a WhatsApp screenshot ("Immy S&S", "Received 74,310,000" 19:09).

## What was found

Two separate problems, both real:

**1. The badge was lying.** It was a hardcoded string, not derived from any query result. Verified
against production: `gmail_transactions` (channel `bank`) is actually current through
2026-09-17 08:57 EAT — the 1-minute and 5-minute `gmail-poll-transactions` cron jobs are healthy.
The badge just never updated after whoever wrote it first tested it on 3 Sep.

**2. The 90,000,000 UGX cash pass-through was already fully investigated — and still invisible.**
The 90M credit landed via a real Equity Bank email (10 Sep, Ref A925C076F3D2F) and is correctly
counted in `extracted_received`. The two cash-out legs (Nasasira 15,690,000; Sky Bubbles
74,310,000 — both confirmed in a `merchant_float_reconciliations` row from 2026-09-11, matching
the same figures and the same WhatsApp evidence Josh just resent) were cash handovers with no bank
alert, so nothing had ever recorded them leaving her account. Net effect: the tracker showed the
90M as still sitting there, a week after it was gone.

This is the same shape as the 2026-09-07 188M cash handoff (see the 2026-09-08 migration), which
*was* captured — by inserting `general_ledger` rows tagged `source_table IN
('cfo_direct_credit','financial_ops_manual_entry')` with `description ILIKE '%bayo mercy
equity%'`, read by the RPC's `ledger_actions` CTE. So the fix should have been: post the same kind
of entry for the two 2026-09-10 outflows.

**It wasn't that simple.** The RPC's `intake_summary` CTE sums *every* `ledger_actions` row by day
and manufactures a matching same-day synthetic credit, on the assumption every ledger-recorded
outflow is brand-new cash that was never counted anywhere else — true for the 09-07 case (cash
handoff, no bank email on either side, so `intake_summary` supplies the missing credit and
`ledger_actions` supplies the debit; net zero, correctly modeling "cash arrived and immediately
left"). It is **not** true here: the 90M's credit side already exists as a real bank email. Posting
the two outflows as ordinary `ledger_actions` rows made `intake_summary` manufacture a **phantom
extra +90,000,000 credit**, which silently cancelled the fix — `money_at_bank_total` stayed exactly
90,002,000 (verified by hand before touching the RPC). Both `extracted_received` and
`extracted_sent` were now wrong by +90M each (584.7M / 494.698M instead of 494.7M / 404.698M),
even though the net happened to come out the same.

Also: the ledger is append-only (`trg_prevent_ledger_update`/`trg_prevent_ledger_delete`, plus
`trg_enforce_ledger_rpc_only` which blocks any write outside `create_ledger_transaction`). A first
attempt at posting the two outflows via `create_ledger_transaction` omitted `source_table` in the
entries, which defaults to `'ledger_transaction'` — a value the reconciliation RPC's filter doesn't
match at all. Those four rows (group `9328a476-ad44-4301-9265-061f36728e83`) are now permanent,
inert artifacts: `ledger_scope='platform'`, `user_id=NULL`, so they don't touch any wallet balance
and aren't read by anything — left in place rather than fought, per the append-only design.

## What was fixed

- **The badge**: `BankEmailReconciliationPanel.tsx` now derives the freshness label from
  `max(qualifying_emails[].extracted_at)` instead of a hardcoded string.
- **The 90M pass-through, recorded correctly**: a second `create_ledger_transaction` call (group
  `9d2efff6-c695-4246-8674-bd148c9193b2`) posted the same two outflows with `source_table:
  'financial_ops_manual_entry'` and `category: 'reconciliation'` (a new category, chosen
  specifically so it wouldn't collide with the existing `agent_float_deposit` /
  `cash_receipt_in_transit` counterparty mapping and wouldn't imply Sky Bubbles' float got credited
  again — it already was, via the 09-11 `merchant_float_reconciliations` "float set to 20,189,508"
  correction, and must not be touched a second time).
- **The RPC itself** (migration
  `20260918120000_fix_money_at_bank_reconciliation_intake_summary_double_count.sql`, **written but
  NOT yet applied to production** — blocked by the auto-mode classifier on direct DDL, same as doc
  66's `refresh_wallet_totals_cache` fix): added a `ledger_actions_for_intake` CTE that excludes
  `category = 'reconciliation'` rows from `intake_summary`'s basis. Every other category
  (`agent_float_deposit`, `cash_receipt_in_transit`, `treasury_bank_deposit`, ...) is unaffected —
  the 2026-09-07 188M case still nets to zero exactly as before. Once applied, `money_at_bank_total`
  will correctly drop from 90,002,000 to ~2,000 (the residual is bank-fee dust from unrelated fully
  matched pairs elsewhere in the account, not a new discrepancy).

**Until the migration is applied, the dashboard will still show 90,002,000, not the corrected ~2,000.**
The ledger entries are already in place and correct; only the RPC's aggregation logic is still
stale in production.

## What not to do

- Don't post a Bayo-Mercy-equity outflow via the `ledger_actions` pattern without checking whether
  its matching inflow already exists somewhere else (a bank email, in this case). The
  `intake_summary` CTE assumes it doesn't, and will silently absorb your correction if that
  assumption is wrong — verify the *money_at_bank_total* actually changed by hand-running the CTEs
  before trusting a ledger write.
- Don't use `category = 'agent_float_deposit'` for a documentation-only Bayo-Mercy-equity entry
  just to get a nicer counterparty label in this RPC — that category is what actually credits a
  merchant desk's float wallet elsewhere in the schema (`wallet_route_for_category`); reusing it
  here on a `ledger_scope='platform'`, `user_id=NULL` row happens to be inert, but it's one accident
  away from double-crediting a desk that was already corrected by hand (see
  `project_float_set_to_vs_add_overcredit` in memory — same desk, same failure mode, different
  incident).
- Don't try to `UPDATE`/`DELETE` the four dead `source_table='ledger_transaction'` rows
  (group `9328a476-ad44-4301-9265-061f36728e83`) — the ledger is append-only by design and the
  triggers will refuse it outright. They're harmless; leave them.
- Don't apply the migration via `query_database` DDL directly — it will be denied by the auto-mode
  classifier (`[Production Deploy]`). It needs the same manual-apply path as doc 66's
  `refresh_wallet_totals_cache` migration.
