# Incident Report — Merchant Float Overstatement

**Period:** 14–17 August 2026
**Status:** Contained on the reporting surface. Underlying defects mostly unfixed.
**Audience:** CFO and leadership (Sections 1, 2, 4); engineering (Section 3).
**Author:** Platform engineering. Read-only forensic pass, no money moved in producing this report.

---

## Section 1 — What happened, in plain language

Between 14 and 17 August 2026 the Financial Operations board displayed **UGX 38,973,832** as float
held with merchant agents — money the company believed was sitting on agents' phones, available to
pay customers. An independent, read-only audit anchored at 16 Aug 23:59:59 EAT found that only
**UGX 15,000** of that figure was backed by an independent provider record (an actual MTN or Airtel
transaction we could point at). Of the remainder, roughly **UGX 34.6m was a display artifact**: real
historical debt that the platform had silently discarded because a balance was not permitted to go
negative, resurfacing on screen as apparent cash. The rest, roughly **UGX 4.2m, was asserted only** —
entries typed into a corrections table by someone without financial authority, with no evidence
attached. This touched **at least 12 merchant desks**. When the audit widened beyond the headline, it
surfaced a further **UGX 374,895,199** of unrelated debits against the same desks, written through
general-purpose wallet-correction tools and justified with placeholder or unintelligible notes. The
board was not slightly wrong. For practical purposes the board figure carried almost no information
about how much company cash the merchant desks were actually holding.

---

## Section 2 — Apology

This was a defect in what we built and shipped. It was not an emergent accident, not a data-entry
problem, and not something the business did wrong.

Three specific decisions in code caused it, and each was ours:

- We chose to floor wallet balances at zero, which meant a debit that would have produced a negative
  position was discarded rather than recorded. That decision converted real debt into apparent cash.
- We chose to let `manager` write to the merchant float corrections table, and we did not block a
  person from writing corrections for their own desk. A merchant agent then authored 77 correction
  rows totalling UGX 619,078,503 across 16 desks, four of them for her own desk.
- We chose to have a trigger stamp every corrections row as `display_only` unconditionally, which
  mislabelled rows that had also been posted as real ledger entries and caused them to be counted
  twice.

Compounding all of it: **none of the platform's own monitoring caught any of this.** We have drift
detectors, reconciliation panels, anomaly scanners and a daily acceptance-test cron, and every one
of them reported healthy while the board was overstated by more than three orders of magnitude
against evidence. It took a manual, external, read-only forensic pass to find it. That monitoring gap
is not context around the failure — it is part of the failure, and arguably the most serious part,
because it is what allowed the other three defects to persist unnoticed.

We are sorry. The CFO made decisions against a number we produced and told them was cash.

---

## Section 3 — Complete technical inventory

Each item states what it does, what it got wrong, and where it lives. Items 12–14 were found during
the completeness pass required by item 11 and were not in the original brief. Two items (1 and 3)
differ from the initial framing; the verified position is stated.

### 1. The zero-floor clamp — `apply_wallet_movement` (historical) → projection layer (current)

**What it does:** applies a ledger movement to a user's wallet buckets.

**What it got wrong:** any bucket that would go negative is floored at zero, so the suppressed
amount is discarded silently — no error, no log, no `clamped_shortfall`. A desk that had spent more
company float than it was credited kept showing a confident positive number with nothing behind it.
This is the mechanism responsible for the ~UGX 34.6m clamp artifact.

**Correction to the brief:** `public.apply_wallet_movement` no longer contains the clamp — both
overloads are now neutered (they write no bucket values at all; the 4-arg form only logs unrouted
categories, the 5-arg form only enforces `recipient_type`). The clamp survives, unchanged in effect,
one layer down:

- `public.v_user_wallet_strict` — `GREATEST(0::numeric, COALESCE(b.float_raw, 0))` for
  `float_balance`, and the same floor on `withdrawable` and `advance_balance`. The view does expose
  `float_balance_signed` (unfloored), but nothing in the merchant float path reads it.
- `public.refresh_wallet_projection_for(uuid)` — `v_float_balance := GREATEST(0, v_float_raw);`
  before the write into `wallet_balances_projection`.
- `public.get_merchant_float_positions()` — floors a third time:
  `COALESCE(GREATEST(w.float_balance, 0), 0) AS ledger_float`.

So the value is clamped three times on the way to the screen, and the true negative is never
persisted anywhere a human or an alert would see it. `wallet_overdraw_events` exists as a table but
is not written by any of these paths.

### 2. `v_user_wallet_strict` — asymmetric admission of `admin_correction`

**What it does:** the canonical pivot between the `wallets` cache and `general_ledger`. Every drift
detector and balance gate compares through it.

**What it got wrong — and what is actually correct:** its ledger filter admits a row when
`classification IS NULL OR classification = 'production' OR (classification = 'admin_correction' AND
category = 'system_balance_correction' AND direction IN ('debit','cash_out'))`. Confirmed verbatim in
the view definition. Admin-correction **debits** count; admin-correction **credits** of the same
shape are filtered out.

This rule is deliberate and documented (`mem://constraints/user-facing-ledger-filter`). It exists
because a blanket exclusion of `system_balance_correction` had previously hidden legitimate
production reversals from users, while admitting admin credits had let an operator inflate a user's
withdrawable balance (the PC020 / Onesmus incident, 19 May 2026). Keeping debits and dropping credits
means a correction can always reduce a balance but never manufacture one.

**The consequence for this incident:** it is not a defect, but it is load-bearing and it surprised
us. It means a well-formed correcting credit cannot restore a wrongly-debited desk through this path
— the books stay wrong on screen even after the ledger is repaired. Any remediation that assumes
"post a compensating credit and the number fixes itself" is wrong on this platform.

### 3. The projection cache — `wallet_balances_projection`, `refresh_wallet_projection_for`

**What it does:** a materialised per-user balance row, refreshed by triggers on `general_ledger`,
withdrawal requests, and maturity events (`tg_refresh_wallet_projection_on_ledger`,
`tg_refresh_wallet_projection_on_wr`, `tg_refresh_wallet_projection_on_maturity`), so hot paths read
one row instead of aggregating the ledger.

**What it got wrong:** `get_user_wallet_view` and `get_user_available_balance` both read the
projection with **no dirty-check-and-repair step** (verified: neither function body references a
repair or dirty-flag path). If a trigger is deferred, fails, or a write path bypasses it, both RPCs
serve a stale number with no self-correction and no staleness signal.

**Correction to the brief:** there is no function named `wallet_projection_read_repair` in this
database — the only projection functions that exist are `refresh_wallet_projection_for`,
`rebuild_wallet_projection`, `detect_wallet_projection_drift`, and the three triggers. So the
14-Aug change did not *remove* a read-repair step from these RPCs; **no read-repair mechanism was
ever built for them.** `detect_wallet_projection_drift` exists but is a detector, not a repair, and
it did not surface this incident.

### 4. `get_merchant_float_positions()` — the RPC behind the board

**What it does:** produces one row per merchant desk for the "Money With Agents" card.

**Defect (a) — two labels, one number.** The final SELECT emits
`hd.ledger_float, hd.ledger_float` into `company_cash_with_agent` and `ledger_float_held`. They are
the identical expression. The board presented them as an independent cross-check ("what we think
they hold" vs "what the ledger says they hold") when agreement between them was arithmetically
guaranteed and meaningless. This is why the board looked internally consistent throughout.

**Defect (b) — double-counted reconciliations.** `owed_to_agent` is
`GREATEST(pd.total - (fc.total + aj.total), 0)`, where `fc` sums real `agent_float_deposit` /
`agent_float_assignment` ledger credits and `aj` sums `merchant_float_reconciliations` rows filtered
on `ledger_effect = 'display_only'`. Because the trigger in item 5 stamps *every* row
`display_only` — including rows that also posted a real ledger leg — the same money is counted once
in `fc` and again in `aj`. Measured impact on `owed_to_agent`: **UGX 14,180,000** double-counted (an
earlier pass measured 13.7m; the widened anchor gives 14.18m).

`GREATEST(..., 0)` on the same line clamps a negative (over-reimbursed) desk to zero, so desks
holding company money in excess of what they paid out are invisible on this metric.

### 5. `merchant_float_reconciliations` + `trg_stamp_merchant_reconciliation_truth`

**What it does:** the table behind the "Fix balance" button; each row is an operator assertion about
a desk's true float. The trigger stamps provenance columns at insert.

**Defect (a) — authorization.** The insert policy is
`created_by = auth.uid() AND (has_role(...,'cfo') OR has_role(...,'financial_ops') OR
has_role(...,'manager') OR has_role(...,'super_admin'))`. Two problems: `manager` is not a finance
role and should never have been on that list, and `created_by = auth.uid()` establishes authorship
but **does not prevent a person from writing corrections for their own desk**.

Confirmed authorship of all 92 rows:

| Author | Rows | Amount (UGX) | Desks | Self-authored | Finance role? |
|---|---|---|---|---|---|
| Bayo Mercy | 77 | 619,078,503 | 16 | 4 | **No** (manager only) |
| Nankambo sharimah | 6 | 4,220,000 | 2 | 0 | Yes (financial_ops) |
| bwayo mark | 3 | 1,850,000 | 1 | 0 | **No** (manager only) |
| TESTING DON'T WITHDRAW | 4 | 1,404,476 | 2 | 0 | **No** |
| Benjamin Muhanguzi | 2 | 110,884 | 1 | 2 | Yes (cfo) |

A merchant agent holding `manager` but neither `cfo` nor `financial_ops` authored 84% of the rows by
count and 99% by value, across 16 desks, including four for her own.

**Defect (b) — the trigger.** `public.stamp_merchant_reconciliation_truth()` opens with
`NEW.ledger_effect := 'display_only';` — unconditional, before any inspection of whether a real
production ledger leg was posted alongside the row. There is no branch. A row that moved real money
and a row that is pure display assertion are stamped identically, which is what makes defect 4(b)
possible and what makes the table useless as an audit record.

### 6. `gmail-poll-transactions` → `tryAutoDebitPayout` — the original root cause

**What it does:** polls the company mailbox for MTN/Airtel transaction emails and reconciles them.

**What it got wrong:** merchant float **crediting** was dead code. It sat downstream of "Rule 3", an
emergency stop that reads `welile_payout_source_accounts` and aborts the whole handler when the
whitelist is empty — and that table has been empty since creation. Rule 3 was designed to gate
auto-**debit** (never charge a user based on an email unless the CFO has whitelisted the sending
line). Placing a credit path behind a debit whitelist meant every float delivery SMS was dropped on
the floor, which is why merchant float never appeared on the books in the first place — the original
symptom that started this investigation. The current code carries the corrected comment
("Merchant float credits are handled above and are unaffected"), confirming the credit path was
moved out from behind Rule 3.

### 7. `record_merchant_float_delivery` — this one was done right

Introduced 14 Aug as the fix for item 6, and it is sound. Stated plainly because not everything in
this report is a defect:

- Normalises the TID and checks `ledger_reconciled_tids` before doing anything.
- Inserts into `merchant_float_deliveries` with `ON CONFLICT (tid_normalized) DO NOTHING` and returns
  early if the row already existed — a genuine unique constraint, not an advisory check.
- Posts a balanced wallet/platform pair through `create_ledger_transaction` with
  `idempotency_key := 'merchant_float:' || v_tid`.
- Verifies the agent is a registered, active desk with a float phone before crediting.
- Runs as one transaction, so a partial credit is not possible.

Re-running it for the same TID is a no-op at three independent layers. This is the standard the other
paths should have met.

### 8. The two duplicate-reversal migrations

`20260814140355_5908b849…` and `20260814140634_6e4f5ee3…`, three minutes apart. Verified mechanism:

- **M1 (14:03:55)** looped `deposit_requests` created between 13:55:00 and 13:56:30 **with
  `status = 'approved'`** and posted a reversing `agent_float_deposit` cash_out per row.
- **M2 (14:06:34)** looped the *same time window* but **`status = 'rejected'`** and posted a second
  reversing leg per row, this time as `system_balance_correction`.

The two status filters look mutually exclusive, which is presumably why the second was considered
safe. They were not: those deposit requests were rejected in the three minutes between the two runs.
All 15 rows now sit at `status = 'rejected'`, and the overlap is exact — the same 15 `source_id`s,
same users, same amounts, **UGX 32,810,000 reversed twice**.

Nothing prevented it. Neither migration set an `idempotency_key`; neither checked for an existing
reversal leg against the same `source_id`; both set `solvency_bypass_reason = 'duplicate_reversal'`,
which disabled the solvency guard that might otherwise have objected. Two one-off `DO $$` blocks
against live financial data, three minutes apart, with no interlock between them.

The 16:55 batch (`20260814145634_dc64755d…`, `20260814151937_7bd60039…`) is a different and better
story: both define `post_merchant_opening_float_ledger`, and the second revision adds the
`has_role(v_actor,'cfo') OR has_role(v_actor,'financial_ops')` check that the first lacked. That is
the authorization pattern item 5 still needs.

### 9. The historical-gap backstop sweep

An earlier version auto-credited roughly **10 historical gaps totalling ~UGX 22.65m** before being
corrected to alert-only. Those specific credits **were never independently reconciled against
provider statements** — they were inferred from internal gap arithmetic, not matched to an MTN or
Airtel record. They remain on the books as ordinary float credits and are indistinguishable, in the
ledger, from evidenced deliveries. Ledger legs carrying `sweep`-prefixed idempotency keys against
merchant desks total **UGX 65,620,000 across 30 legs**, so the unreconciled population may be larger
than the 22.65m identified; it needs a named reconciliation pass, not an estimate.

### 10. The UGX 374,895,199 UNKNOWN_NEEDS_REVIEW queue

101 debit legs. Every distinct mechanism found, measured over merchant desks from the 1 Aug anchor:

| Mechanism | Reference prefix | Category | Legs | Amount (UGX) |
|---|---|---|---|---|
| Float-to-withdrawable reclassification | `FXW-*` | `agent_float_assignment` | 82 | 267,037,880 |
| "Error correction" entries | `ECW-*` | `agent_float_assignment` | 25 | 132,989,824 |
| Float reclassification | `FLT2WDR-*` / `FLT-*` | `agent_float_assignment` | 13 | 98,810,000 |
| CFO direct credit / retraction | `PAY-*` | `system_balance_correction` | 11 | 36,306,976 |
| Unreferenced balance corrections | none | `system_balance_correction` | 17 | 33,124,500 |

The justification notes on these range from vague to unintelligible. Critically: **none of these are
merchant-float tools.** `cfo_direct_credit`, float-to-withdrawable reclassification, and the ECW
error-correction machinery are general-purpose, platform-wide wallet-correction instruments that
operate on any user's wallet. The merchant float board is simply where we happened to look. The same
class of defect — an authorised-looking correction with no evidence requirement, no self-authorship
block, and a display/ledger ambiguity — is available today on every wallet in the system.

### 11. Completeness pass

Everything else this investigation touched, confirmed present and stated rather than assumed absent:

- `merchant_ledger_float(uuid)` — called by the trigger to stamp `ledger_float_at_post`; reads the
  same clamped source, so the "variance at post" column understates variance by the clamped amount.
- `create_ledger_transaction` — correct; enforced group balance throughout. Not a defect.
- `wallet_route_for_category` — routes uncategorised legs; behaved correctly.
- `wallet_overdraw_events`, `wallet_unrouted_movements`, `wallet_routing_violations` — diagnostic
  tables that exist and are the right destination for suppressed-debit logging, currently unwritten
  by the clamp paths.
- `detect_phantom_wallet_drift`, `detect_withdrawable_drift_alerts`, `wallet_anchored_drift_view`,
  `run_payout_acceptance_checks` (daily cron) — all live, all reported healthy, none detected this.
  They compare the cache against the *clamped* pivot, so a clamped desk is in agreement with itself
  by construction. **This is why monitoring was silent**, and it is the single most important
  technical finding in this report.
- `merchant_payout_funding` / `classify_merchant_payout_funding` — the own-cash evidence gate; worked
  as designed and is the model for the evidence requirement proposed in Section 4.

### 12. `get_merchant_float_positions()` excludes `admin_correction` from credits only

`float_credits` filters `classification <> 'admin_correction'`, but `raw_float_net` (used to derive
the clamp artifact) applies no classification filter at all. The two sides of the same RPC therefore
count different ledger populations, which is a second, independent reason the board's internal
figures could not be cross-checked against each other.

### 13. `owed_to_agent` and `company_cash_with_agent` were never reconciled to each other

There is no invariant anywhere — in SQL, in tests, or in the UI — asserting any relationship between
paid out, reimbursed, and held. Each was computed independently and displayed adjacently.

### 14. Duplicate `apply_wallet_movement` overloads

Two functions share the name with different arities. The 4-arg form silently returns after logging;
the 5-arg form raises on a missing `recipient_type`. A caller that omits `recipient_type` therefore
gets silence instead of an error, purely as a function-resolution side effect.

---

## Section 4 — Permanent fix plan

### Shipped

**Step 0 — evidenced-only reporting surface.** `get_merchant_float_positions()` now returns
`clamp_artifact_amount`, `evidenced_amount`, `asserted_only_amount` and `evidence_status`
(`evidenced` | `asserted_only` | `clamp_artifact` | `mixed`), constructed so that
clamp + evidenced + asserted_only equals the displayed figure exactly. `MoneyWithAgentsCard.tsx`
headlines **"Total float with merchant agents (evidenced only)"** — currently UGX 15,000 — and badges
each desk with why its number is not trusted. `useMerchantFloat.ts` carries the same split.

Shipped **16 August 2026**; commits `4c6503f33c`, `e14628171b`, `43e7d6e997`
(`MoneyWithAgentsCard.tsx`, `useMerchantFloat.ts`) and `a3043226ab`
(`MerchantBalanceDisputesPanel.tsx`).

This stops the board from asserting money it cannot evidence. It fixes **nothing underneath**.

### Pending

Each item needs a named owner before work starts. Owners are unassigned in this document
deliberately — assigning them is a leadership decision, not an engineering one. No item below should
be scheduled as "when convenient".

**P1 — Make suppressed debits visible (do not remove the clamp).**
Keep the zero floor; a negative displayed balance would break every consumer. Add, at each of the
three clamp sites (`v_user_wallet_strict`, `refresh_wallet_projection_for`,
`get_merchant_float_positions`), a `clamped_shortfall` output carrying the discarded amount, and
write a row to `wallet_overdraw_events` whenever it is non-zero. A desk whose true position is
negative must say so on screen. **Owner: unassigned.**

**P2 — Authorization and evidence on `merchant_float_reconciliations`.**
Drop `manager` from the insert policy, leaving `cfo`, `financial_ops`, `super_admin`. Add a
self-authorship block (`agent_id <> auth.uid()`). Require a non-null evidence reference — a provider
TID or a `gmail_transactions` id — on any row that increases a desk's float, modelled on the existing
`merchant_payout_funding` evidence gate. Mark all 92 existing rows with an `authorization_status`,
flag the 84 written without a finance role, and queue them for **named human ratify-or-reverse
decisions**. No bulk ratification, no bulk reversal. **Owner: unassigned.**

**P3 — Fix `trg_stamp_merchant_reconciliation_truth`.**
Replace the unconditional `NEW.ledger_effect := 'display_only'` with a derivation from reality:
`ledger_posted` when a matching production leg exists for the row, `display_only` otherwise.
Backfill the correct value for existing rows, which removes the UGX 14,180,000 double-count in
`owed_to_agent` without touching any ledger entry. **Owner: unassigned.**

**P4 — Standing detection, in CI and in production.**

- *Clamp-drift alert*: fire when `clamped_shortfall` is non-zero on any wallet, at any amount.
- *Assertion-coverage alert*: fire when the evidenced share of any board falls below a
  CFO-set materiality threshold. Merchant float today would fire at 0.04%.
- *Structural regression tests* added to the build so these fail CI rather than waiting for another
  manual audit — the four invariants: (i) no two output columns of a reporting RPC may be the same
  expression; (ii) reconciliation rows and ledger legs may not both feed one total; (iii) every
  correcting insert path enforces a role check and a self-authorship block; (iv) every
  `create_ledger_transaction` group nets to zero.

The detectors matter more than the fixes. Every defect in Section 3 would have been caught in hours
by any one of them. **Owner: unassigned.**

**P5 — Item 10 gets the same treatment. Explicitly, yes.**

The `FXW-*`, `ECW-*`, `FLT2WDR-*` and `PAY-*` mechanisms **must receive the same authorization and
evidence requirements as `merchant_float_reconciliations`** — role gate, self-authorship block,
mandatory evidence reference, and a derived rather than asserted ledger effect.

The reasoning is not about the 374.9m. It is that these are general-purpose, platform-wide wallet
correction tools. Hardening only the merchant float table fixes the board we happened to audit and
leaves the identical failure mode live on every other wallet in the system, reachable through a
different table name. Any remediation that stops at `merchant_float_reconciliations` should be
treated as incomplete.

**P6 — Reconcile the item 9 sweep credits.**
Match the ~UGX 22.65m of auto-credited historical gaps (and the wider UGX 65,620,000 of
`sweep`-keyed legs) against provider statements, one by one. Where no provider record exists, the
credit is an assertion and must be reclassified as such. **Owner: unassigned.**

### Not in scope of this document

The 15 confirmed duplicate-reversal legs from item 8 (UGX 32,810,000) have a dry-run correction
prepared and **await CFO approval**; nothing has been written. Bayo Mercy's UGX 13,776,000 Equity
account remains **UNTRACED**. Mudumba samuel's UGX 2,208,633 remains **NO INDEPENDENT EVIDENCE** and
needs provider confirmation before it is either recognised or written off.

---

*This report documents existing state and planned work. Producing it involved no ledger writes, no
schema changes, and no RPC changes.*
