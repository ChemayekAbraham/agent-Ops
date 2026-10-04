# 7. Tribal Knowledge

Things that are true, expensive, and written down nowhere else. Most of these were learned by
losing money or losing a day. Read the whole file once before you touch production.

Each entry states the trap, the evidence, and what to do instead.

---

## Money traps

### 1. "Set float to X" re-credits float that has already been spent

**Cost so far: UGX 10,202,000, uncorrected.**

Absolute float assertions ignore the fact that the agent has already spent part of the float. The
operation restores the full figure, silently gifting the spent portion back.

- **Incident:** Sky Bubbles, 2026-08-25, over-credited UGX 10,202,000. Still outstanding.
- **Do instead:** use delta / "add" operations. If you genuinely need an absolute set, confirm the
  current spent amount first and compute the delta yourself.
- Same class of bug: `admin_reseed_wallet_cache(user, withdrawable, balance)` and
  `reseed_wallets_to_cached_balance`. Prefer `reconcile_wallet_from_ledger`, which *derives* the
  answer instead of asserting it.

### 2. The telecom charge is part of the float debit, not a separate receivable

A UGX 5,000 payout with a UGX 500 sending fee debits **UGX 5,500 as one atomic transaction**.

An earlier design split them into two postings, which manufactured phantom telecom receivables
that looked like money owed to Welile and were not. Keep it atomic so merchant float matches
their MoMo statement exactly.

### 3. Not every gap is debt — three cases that look like missing money and are not

Ops and finance have repeatedly re-opened these. They are closed.

| Apparent gap | Reality |
|---|---|
| ~UGX 403M of `rejected` merchant OOP claims | **Settled off-system. Closed business.** Do not re-open |
| Completed-withdrawal-requests vs ledger-legs differences | Finance settles these **outside the ledger**. Never label as reconciliation debt |
| `get_treasury_snapshot` showing about −2.8B | **Malformed output of a superseded RPC**, not a deficit |

For treasury cash the canonical RPC is **`get_treasury_cash_position` (A1+A5)**.
`get_treasury_snapshot` is superseded — do not quote it.

### 4. Attestation and evidence gates have twice hidden real debt

Two separate incidents where a gate meant to ensure quality instead suppressed the number:

- **Merchant OOP attestation gate:** "0 owed" actually meant "nothing confirmed". It concealed
  UGX 38.7M across 13 desks until the RPC was fixed on 2026-08-29.
- **`settle_merchant_out_of_pocket`:** paid the full `shortfall_amount` on any
  `pending_reimbursement` row with **no server-side evidence check**. Fixed 2026-09-01.

**Standing risk:** the settlement RPC and the evidence view are **independent copies of the same
logic**. They can drift apart again. If you change one, change both, and add a test that compares
them.

The merchant float evidence-gate asymmetry (gate excluding admin corrections) was resolved
2026-08-26 — the old "UGX 11.4M hidden debt" figure is stale. Re-measure before quoting it.

### 5. An orphaned standing order failed silently for a month

A UGX 150,000/month payroll standing order targeted a `user_id` that **never existed in
`auth.users`**. It failed every single day from 2026-08-01 and never surfaced to the CFO.

**Lesson:** failing scheduled money jobs do not necessarily alert anyone. When you add a
recurring payment, add a failure alert with it, and periodically reconcile standing-order targets
against `auth.users`.

### 6. A bad `agent_subagents` row can silently skim an agent's commission — and hundreds of agents can share the same bad row

**Incident:** agent Okwakol Micheal (`75891dff-d684-49e9-83ea-fab6e4cb4ded`) reported his advance
was fully repaid but his commission had "stopped." It had not stopped — it had been quietly cut
from 10% to 8% since 2026-09-07.

**Root cause:** `agent_allocate_tenant_payment_internal` (the RPC behind every agent-float rent
collection) looks up `agent_subagents` for a row where `sub_agent_id = <collecting agent>` and
`status IN ('verified','approved','accepted')`. If found — and the agent isn't in
`agent_subagent_commission_whitelist` — it silently splits the 10% commission into 8%
(collector) + 2% ("recruiter override" to `parent_agent_id`).

On 2026-09-03 a row was inserted with `source = 'admin_assignment'` pointing
`parent_agent_id` at `3d78f1f8-f690-4fe8-bb2e-202f3ef2ecb0` — which is not an agent. It is one of
Okwakol's own **tenants** ("sir ian martin"). Every collection after that date leaked 2% to a
tenant who did nothing to earn it.

**This is not a one-off.** The same tenant ID is `parent_agent_id` on **392** other
`agent_subagents` rows via `admin_assignment`, plus 41 via `link_signup`. Something upstream of
that bulk assignment used this ID as a bad default/placeholder. **That exposure was found but not
yet fixed** — only Okwakol's single row was voided (`status='rejected'`) on 2026-09-11. Re-check
before assuming it's still limited to one agent:

```sql
SELECT status, source, count(*) FROM public.agent_subagents
WHERE parent_agent_id = '3d78f1f8-f690-4fe8-bb2e-202f3ef2ecb0'
GROUP BY 1, 2 ORDER BY 3 DESC;
```

**Second, independent trap found while fixing the first one:** `wallet_strict_for_user` (and the
`create_ledger_transaction` balance check) only count a ledger leg toward the real balance when
`classification IN (NULL, 'production')`, **or** `classification = 'admin_correction'` **and**
`category IN ('system_balance_correction', 'merchant_float_correction_writedown')` **and**
`direction IN ('debit','cash_out')`. A `classification = 'admin_correction'` **credit** (`cash_in`)
is *never* counted, for any category. Posting a correction with `admin_correction` on the
crediting leg inserts cleanly, returns a `transaction_group_id`, looks correct in
`general_ledger` — and has **zero effect** on the recipient's balance. There is no error to catch.

- **To debit back an erroneous credit as a correction:** `classification='admin_correction'`,
  `category='system_balance_correction'`, `direction='cash_out'` — this is honoured.
- **To credit a user to make them whole:** use `classification='production'` with a real earning
  category (e.g. `agent_commission_earned`) and an explicit `wallet_bucket='withdrawable'`. This
  is indistinguishable from an organic earning in the ledger, which is the point — the strict
  function has no "trust this credit" path for `admin_correction`.

**Third finding, same incident:** a negative `withdrawable` bucket **clamps to 0** in every
consumer (`wallet_strict_for_user`, `wallet_balances_projection`, the dashboard). Okwakol's real
withdrawable was **UGX −229,580** — driven mostly by `agent_repayment` debits recovering his two
`agent_advances` (both showed `status='completed'`, `outstanding_balance=0` in that table, which
tracks the loan; the wallet-side recovery ledger is a separate, independently-tracked total and
had not fully caught up). He saw "0", not "owed 229,580" — an agent whose advance status says
"done" can still be earning into a hole with no visible sign of it. If an agent insists their
commission has vanished and their advance is marked complete, **check the raw sum, not the
clamped balance:**

```sql
-- Raw withdrawable before the GREATEST(0, ...) clamp — adapt the classification
-- filter from wallet_strict_for_user() if it has changed since this was written.
SELECT sum(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END) AS raw_withdrawable
FROM public.general_ledger
WHERE user_id = '<agent_uuid>' AND ledger_scope = 'wallet' AND wallet_bucket = 'withdrawable'
  AND (classification IS NULL OR classification = 'production');
```

Fixed for Okwakol on 2026-09-11: voided the bad `agent_subagents` row, credited back the UGX 3,000
actually skimmed (reversed from the tenant's wallet, since it had genuinely landed there), and
posted a UGX 229,580 platform-absorbed correction (`agent_commission_earned` / `agent_commission_payable`
pair, same convention as every other commission payout) to bring his withdrawable to exactly 0.
Ledger groups: `admin-correction-okwakol-recruiter-override-2026-09-11-v2`,
`admin-correction-okwakol-zero-withdrawable-2026-09-11`.

### 7. A stale-withdrawal reconciliation job can double-debit a wallet a manual correction already fixed

**Incident:** Fredrick Baliddawa (`e5e1e0fb-ff68-4d77-a35a-685a84216401`), reported 2026-09-11 —
his wallet showed UGX 5,200,000 right after a fresh UGX 7,000,000 credit landed. UGX 1,800,000
short.

**Root cause:** `cfo_reconcile_stale_withdrawal`'s only duplicate-debit guard checked
`general_ledger` for a row with `source_table = 'withdrawal_requests' AND source_id = <this
withdrawal>`. A debit posted through any *other* path — e.g. the generic "CFO Direct Credit/Debit"
tool — never sets `source_id` back to the withdrawal, so it is invisible to that check.

Timeline:
- Apr 1 — a ROI payout credits his wallet UGX 1,800,000.
- Apr 1, same day — he withdraws that exact UGX 1,800,000 via mobile money. The payout completes,
  but the wallet-side debit never gets posted to the ledger, so the withdrawal sits in a "held"
  status indefinitely.
- Apr 13 — a CFO manually debits his wallet UGX 1,800,000 via the generic Direct Credit tool
  ("Wallet Retraction"), correctly catching up the missing debit — but with
  `source_table = 'cfo_direct_credit'`, `source_id = NULL`.
- Aug 12 — the stale-withdrawal-hold sweep finds no *linked* debit for the withdrawal, calls
  `cfo_reconcile_stale_withdrawal(..., 'settle')`, and posts a **second** UGX 1,800,000 debit for
  the same payout.

**Fixed 2026-09-11:** added a second guard — before settling, `cfo_reconcile_stale_withdrawal` now
looks for any unlinked wallet-scope `cash_out` of the same amount for the same user in a window
around the withdrawal, and raises `POSSIBLE_DUPLICATE_DEBIT` instead of silently posting a second
one. See migration `20260911140000_stale_withdrawal_settle_checks_unlinked_debit.sql`.

**Do instead:** treat any general-purpose manual wallet correction (`cfo_direct_credit` and
similar) as a potential duplicate-debit trap for every *other* reconciliation job that keys off
`source_table`/`source_id` — it leaves no trace those jobs can see. When investigating "wallet
received X but shows Y", sum `general_ledger` wallet-scope legs for the user chronologically
rather than trusting the cached `wallets.balance`; don't assume a shortfall means money left the
platform twice — check whether the ledger *debited* the user twice for one real-world payout.

**Status:** the fix is deployed; the correction owed to Fredrick (credit UGX 1,800,000 back) had
**not** been applied as of this writing — it requires a CFO/Financial Ops/super_admin session to
post through `cfo-direct-credit`. Still pending.

---

## Deposit and identity traps

### 8. MTN till receipts carry a name and no TID

Exact-match-or-nothing silently orphaned these deposits — the user paid, nothing appeared, and no
alert fired. A fuzzy-flag fix was built on 2026-08-28.

**Verify the migration is actually deployed before assuming the fix is live.** It was still
pending at the time of writing.

### 9. Diagnose from ingested data, never from a screenshot

A payer-side SMS screenshot is **not** the merchant-side row that was actually ingested. They
routinely differ in amount formatting, name and reference.

Always check `gmail_transactions` for the row Welile actually received before concluding anything
about a deposit.

### 10. The deposit relink job used to abandon deposits after 14 days

The only retry job gave up on pending deposits past 14 days **with no alert**, and cross-user TID
collisions were invisible to it. Fixed 2026-09-01. Worth re-checking if old deposits reappear.

### 11. Operator name-search attaches portfolios to stale shell profiles

Searching a partner by name can return a never-logged-in duplicate profile. The operator attaches
the portfolio to the shell; the real partner then sees an empty portfolio while their funds sit on
an account nobody can log into.

**Check `/admin/account-conflicts` and `v_suspicious_duplicate_accounts` before attaching capital
to a profile found by name search.** Prefer matching on phone.

### 12. Duplicate rent requests make an agent look "cleared" when they are not

Live example: tenant "inyero / Anyero beatrice" (agent Maasa) has a **closed duplicate request
with zero evidence** sitting next to the real one, which genuinely owes UGX 192,500. The
duplicate makes the agent's queue look settled.

When an agent appears cleared but the money never arrived, look for a duplicate `rent_requests`
row before believing the status.

### 13. Merchant float top-up is per-agent-phone, not centralised

Confirmed behaviour of the IFTTT deposit intake: top-ups are matched per agent phone number, not
to a central account. There is also a known direction-classifier bug in that path — inbound and
outbound can be misread.

---

## Development traps

### 14. `tsc` cannot complete on this repo locally

It OOMs at 4 GB and is **OS-killed at 8 GB**. The failure mode is the dangerous part:

- A crashed `tsc` reports **zero errors**.
- Piping through `head` hides exit code 134 behind the pager's exit 0.

So you will conclude the typecheck passed when it never ran. Use `npm run build`, which routes
through `scripts/run-with-heap.mjs`.

### 15. `supabase/migrations/` is not a record of production

3,203 files that drift from the live schema. Local has been as much as **119 commits behind**
`origin/lovable`.

- Verify columns, functions and RPCs against the live catalog — see
  [`06-live-state-verification.md`](./06-live-state-verification.md).
- Branch from `origin/lovable`, not from a stale local branch.
- `SYSTEM_CONTEXT.md` itself is measurably behind — see the drift table in
  [`README.md`](./README.md#known-documentation-drift--read-before-trusting-system_contextmd).

### 16. Lovable writes to your working tree without a commit

The Lovable agent live-syncs edits to disk **before** anything is committed. After a
`send_message`, watching `git log` tells you nothing.

- Watch the **working tree**, not the log.
- `agentFinished` and `latest_commit_sha` from `get_project` are the real status signals.

### 17. Two remotes, one of them personal

```
origin    github.com/weliletenants-sys/welilereceipts-com-98bba33b   <- production
rentflow  github.com/Joshwanda17/rentflow.git                        <- personal, different project
```

Welile code has leaked into `rentflow` before, through a disabled local-revert step in the
rebrand/sync pipeline. **Confirm the remote before every push.** Default branch is `lovable`.

Domain rule: `welileapp.com` is canonical for Welile; `welile.tech` is rentflow-only.

### 18. Division of labour — Claude does logic, Gemini does UI

Two agents work this repo in parallel. Claude owns `supabase/functions/`, `supabase/migrations/`,
RPCs/triggers, `src/lib/`, `src/hooks/`, `src/integrations/`, `scripts/`, and anything touching
money. Gemini owns JSX markup, layout, `src/components/` composition, Tailwind, shadcn/ui.

In a shared file, touch only the data/state/handler code. **Do not reformat or restyle a file
just because you are in it** — it will fight the other agent's next pass.

---

## Withdrawal & payout traps

### 19. An RLS policy, not the permission matrix, can make the Merchant Payout Queue empty for everyone

**Incident, 2026-09-11:** merchant agents platform-wide reported "no pending withdrawals" on
every tab (All/MoMo/Bank), including agents whose `cashout_agents.config` was fully open
(all channels, all categories). The queue was genuinely non-empty — 14 pending bank payouts and
~20 pending MoMo payouts existed, unclaimed — and the config-driven client filters
(`buildQueueCategoryOrClause` / `buildChannelProviderOrClause` in `src/lib/cashoutAgentConfig.ts`)
were verified correct by direct SQL. The queue was still empty for every agent.

**Root cause:** the RLS `SELECT` policy on `withdrawal_requests`
("Owners staff and assigned merchant agents can view withdrawals") only granted an active
cash-out agent visibility into a row once it was **already** `assigned_cashout_agent_id` /
`dispatch_claimed_by` / `processed_by` = themselves. A fresh, untouched, unclaimed row
(`assigned_cashout_agent_id IS NULL`) matched none of those clauses for any regular agent, so
Postgres silently returned zero rows before the client's category/channel filters even ran. No
error surfaced — the UI's genuine-empty state ("No pending withdrawals") and an RLS-blocked
empty result look identical to the client.

**This is easy to misdiagnose as a permissions-matrix problem** because the symptom (agent can't
see a withdrawal) is exactly what a missing category/channel grant also looks like, and because
`query_database`-style tooling runs as a privileged role that bypasses RLS entirely — every
"the data and config are correct" check done that way is blind to an RLS gap. If config/data
checks all pass but the complaint persists across *multiple, differently-configured* agents
(including ones with full permissions), suspect RLS next, not another config field:

```sql
SELECT policyname, cmd, qual FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'withdrawal_requests' ORDER BY cmd, policyname;
```

**Fixed 2026-09-11** — widened the policy to also allow `assigned_cashout_agent_id IS NULL`:
see migration `20260911150000_allow_cashout_agents_view_unclaimed_withdrawals.sql`. That clause
had no status filter and exposed ~4,190 historical unassigned withdrawals (575 with bank account
numbers) to every merchant; `20260911190000_merchant_rls_unclaimed_rows_open_queue_only.sql`
narrows it to exactly the queue fence (`applyMerchantQueueFence` / `v_merchant_payout_queue`).
When widening RLS for a queue, copy the queue's own predicate — never just "unassigned". Applying an
`ALTER POLICY` against a busy table can hit `40P01 deadlock detected` under live traffic — this
is transient lock contention, not a bad statement; retry it.

**Two more bugs surfaced during the same incident, fixed or flagged separately:**

- `src/components/payouts/ProoflessPayoutBlocker.tsx` compared `assigned_cashout_agent_id`
  (a `cashout_agents.id`) against `user.id` — two different ID spaces that never match — so its
  real "did I settle this" check silently fell back to `dispatch_claimed_by`, a field set the
  instant a merchant accepts a push dispatch and **never cleared** when that claim later expires
  and a different agent actually settles it. This wrongly blamed agents for other agents'
  settlements. Fixed by matching on `processed_by` / the agent's own `cashout_agents.id` instead.
- That same fix exposed a second, unresolved issue: the blocker's `fin_ops_verified_by`/
  `fin_ops_approved_by` self-stamp exemption matches on ~99.8% of all self-settled payouts
  platform-wide (5,196 of 5,206), because auto-approved payouts get stamped with the settling
  merchant's own id as "verifier" by default. Practically, this means the proof-of-payment gate
  has almost never fired on genuine unproven self-settlements — only on the misattribution bug
  above. The blocker was **temporarily disabled** (early `return null` in the component) during
  a rush-hour payout backlog rather than left to block everyone once the misattribution bug was
  fixed and the self-stamp exemption started dominating. Re-enabling it needs a compliance policy
  decision on whether self/auto-approved payouts should still require proof, not just a code fix.
- `claim_withdrawal_verified` (the RPC that actually lets an agent claim a withdrawal) does
  **not** check the CFO's category/channel permission matrix at all — only the MoMo
  number/name match. The permission matrix is enforced only in the frontend today. Any active
  cash-out agent can currently claim any withdrawal via a direct API call regardless of what the
  CFO restricted them to. Not exploited in this incident; **the matrix gap is still open** in both
  `claim_withdrawal_verified` and `approve-withdrawal`.
- Related and **closed 2026-09-11 (later the same day):** `approve-withdrawal`'s atomic claim was
  a status compare-and-set with no ownership check, so any merchant could settle a payout another
  merchant had claimed (and might be paying at that moment) — a double-payout path. A merchant who
  is not `is_withdrawal_staff` is now refused with `CLAIMED_BY_ANOTHER_MERCHANT`, and the same
  condition sits inside the compare-and-set. Measured before shipping: 924 desk-claimed
  settlements in 14 days, 8 cross-desk, all by FinOps staff (who keep the override).

**Do not** assume a `cashout_agents.config` change will restore visibility once you've confirmed
it's correct — verify the actual RLS policy set for the querying role before spending more time
on the permission matrix.

### 20. The one-claim-per-merchant rule only existed in React, and the stale-claim releaser had no cron

**Found and fixed 2026-09-11**, same day as trap #19, in the same merchant payout queue.

**Root cause 1 — client-only enforcement.** The Pending Queue UI blocked a merchant from claiming
a second withdrawal while one was already open (`AgentCashPayoutsTab.tsx`'s `myActiveClaims`
check), but `claim_withdrawal_verified` itself only ever checked
`WHERE assigned_cashout_agent_id IS NULL` — nothing in the RPC stopped a merchant from holding
multiple simultaneous claims via a direct call, a race between two tabs, or any client that skips
the React gate. The one-claim rule was UX, not a server invariant.

**Root cause 2 — an orphaned releaser.** `release_stale_cashout_claims()` already existed to free
a claim that's gone quiet, but **no cron job called it** — only `release-stale-merchant-float`
was scheduled, which is a different function. A stale claim stayed `assigned_cashout_agent_id`-
locked to one merchant forever; the 30-second client ticker only refetches, it doesn't release
anything server-side. Combined with root cause 1, one merchant could accumulate several open
claims and sit on the entire visible queue.

**Fix** (`drizzle/migrations/0006_merchant_one_active_claim_and_stale_release_cron.sql`, live and
verified against production 2026-09-11):
- `claim_withdrawal_verified` now takes `pg_advisory_xact_lock(hashtext('cashout_claim:<agent
  id>'))` before checking, then looks up any other open, unsettled claim already assigned to that
  agent (canonical queue statuses, `processed_at`/`fin_ops_reference` both empty) and refuses with
  `active_claim_exists` + `blocking_withdrawal_id` if one exists. The gate runs **before**
  `reserve_merchant_float`, so a refused claim never leaves a dangling float reservation. The
  original `UPDATE ... WHERE assigned_cashout_agent_id IS NULL` race guard, priority holds, fraud
  checks and MoMo name/number verification are unchanged.
- New cron `release-stale-cashout-claims` (`*/5 * * * *`) actually calls
  `public.release_stale_cashout_claims()`. Registration is idempotent (unschedules any prior copy
  by name before scheduling).
- Live recovery ran `release_stale_cashout_claims()` once by hand to clear the backlog that had
  built up before the cron existed; only rows with zero settlement progress (no proof/code/TID/
  processing) were released — nothing with evidence was touched, and no wallet/ledger/settlement
  row was written.

**Follow-up the same evening — whose reservation is it?** There is one
`merchant_float_reservations` row per *withdrawal*, and three functions treated it as the caller's
without checking: `claim_withdrawal_verified` released it on a lost race (freeing the **winner's**
float — that is what `released_reason = 'claim_race_lost'` on a live claim means),
`reserve_merchant_float` handed a live reservation to whoever asked next, and
`release_stale_cashout_claims` returned the row to the pool but left the old reservation `reserved`
and `dispatch_claimed_by` stamped. `classify_merchant_payout_funding` then owed the payout to the
reservation holder instead of the merchant who settled it (and got the commission). Measured
2026-09-11: 29 receivables / UGX ~21.3M `pending_reimbursement` booked to a merchant other than the
settler, plus UGX 2,000,000 already reimbursed that way. Code fixed in
`20260911200000_merchant_claim_reservation_ownership.sql` (the classifier now attributes to the
settler and refuses to guess on a mismatch). **The 29 existing rows were deliberately left as they
are (Josh, 2026-09-11)** — the classifier skips any withdrawal that already has a receivable on a
mismatch, so the reconciler cron will not rewrite them. Do not "correct" them without Finance
confirming who actually paid.

**Do not** assume a client-side "one claim at a time" UI restriction is also true server-side —
check whether the RPC actually enforces it before relying on it as a security or fairness
boundary. **Do not** assume a "stale claim releaser" function being present means it runs — check
`cron.job` for an active schedule calling it, not just that the function exists.

---

## Architecture decisions that look wrong but are deliberate

| Decision | Why |
|---|---|
| No service worker, no `version.json`, no forced-update machinery | Deliberately removed. Chunk failures recover with `window.location.reload()`. Re-adding it has broken deploys |
| Client-side Maps route optimisation | The Maps key is referrer-restricted, so server-side Routes/Geocoding calls 403 by design |
| `sync_wallet_from_ledger` is a permanent no-op | Retained only for compatibility. Do not "fix" it |
| Several `trg_block_*` triggers guard removed features | They fence off retired paths. Do not drop them |
| `wallet-deduction` returns HTTP 410 | Retired on purpose |
| `notifications` writes are suppressed | Lean-DB policy at 40M-user target |
| Cash-code deposits are never auto-credited | Fraud control. The user must enter the `RCT` code |
| Landlord Ops uses one route per destination | 23-destination IA adopted 2026-09-04. Every sidebar link is its own URL — **never** a one-page `?view=` dashboard |
| `zz_enforce_wallet_scope_requires_user` has a `zz_` prefix | Name-ordered to fire last, after routing resolves. Keep the prefix |
| Payroll authority is position-based, not role-based | `hr_pay_authorities` + `hr_pay_is_preparer/approver/releaser`. Separation of duties |

---

## Silent-failure modes to know about

These fail without raising. They are the hardest class of bug in this system.

| What | Symptom |
|---|---|
| A new ledger category with no bucket route | Lands in `wallet_unrouted_movements`. No error |
| `system_events` insert using `payload` | There is **no `payload` column** — only `metadata`. The insert silently no-ops |
| SMS with sender ID `WELILE` | Unregistered; carriers drop it. Delivery log may still look fine |
| `entries` passed as `JSON.stringify(...)` to `create_ledger_transaction` | Raises, but the message is confusing. Pass a raw array |
| A cron job whose target function was renamed | Fails into `cron.job_run_details`, which is pruned after ~1 day |
| A crashed `tsc` | Reports zero errors |
| A scheduled payment to a non-existent `user_id` | Fails daily, alerts nobody (see trap 5) |
| A manual wallet correction with no `source_id` back to what it's fixing | Invisible to any other job's duplicate-debit guard — can get re-charged later (see trap 7) |
| Two writers sharing one `create_ledger_transaction` idempotency key | The second caller gets the first caller's group id back with **no error** and none of its own entries written (see "Telecom fee dropped" below) |

### Telecom fee dropped when the float guard wins the idempotency key (fixed 2026-09-11)

`approve-withdrawal` sets the withdrawal `completed` *before* it posts the merchant float debit.
That status change fires `trg_merchant_payout_float_guard` → `ensure_merchant_payout_float_debit`,
which posts the float debit under the same key approve-withdrawal uses
(`approve-withdrawal-merchant-float-consume-<id>`). When the 2026-08-30 change moved the telecom
leg under that key, every payout the guard reached first (~75%) lost its telecom fee: the
edge function's combined call returned the guard's principal-only group as a "success". Measured
2026-09-11: ~770 payouts since 2026-08-31, zero telecom legs, and every one of them flagged
`unsettled`.

Fixed in `20260911180000_merchant_guard_posts_telecom_and_settlement_classifier_fix.sql` (the guard
now posts principal + telecom) and in `approve-withdrawal` (reads back the legs actually posted and
catches up a missing fee under `approve-withdrawal-merchant-telecom-charge-<id>`). The historical
~770 are **not** backfilled — a Finance decision, because later float "set to" adjustments may
already have absorbed the fees. **Rule:** if a trigger and an edge function can both write the
same money movement, either one must write *all* of it, or they must use different keys and each
check for the other's legs.

---

## When you are unsure

The safe ordering, always:

1. **Read** the live catalog before believing any document, including this one.
2. **Pause** with `maintenance_mode` before diagnosing a live money problem.
3. **Add** a compensating entry rather than editing history.
4. **Dry-run** anything that offers one.
5. **One at a time** — one function deploy, one secret rotation, one cron enable.
6. **Ask the CFO** before changing anything in `treasury_controls`.
