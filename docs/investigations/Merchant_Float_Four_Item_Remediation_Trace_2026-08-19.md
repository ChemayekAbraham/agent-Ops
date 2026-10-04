# Merchant Float — Four-Item Remediation Trace (read-only)

**Date:** 19 Aug 2026. **Writes performed:** none. No ledger, wallet, reconciliation or deposit row
was created, updated or deleted. No reversal has been posted.

---

## Item 1 — Double reversal of 14 Aug: CONFIRMED, still uncorrected

The two migrations are both present and both ran:

- `20260814140355_5908b849-2fce-4c2a-b0c2-7c21926e6e85.sql` — selects approved deposits created
  `2026-08-14 13:55:00+00 … 13:56:30+00`, posts `agent_float_deposit` / `cash_out` / `float` /
  `admin_correction`, key `sweep-reversal-<id>`, then flips each deposit to `rejected`.
- `20260814140634_6e4f5ee3-eef8-4a7b-9cde-7c467c54a0e9.sql` — three minutes later selects the **same**
  deposits by the same window, now matching on `status = 'rejected'` (i.e. exactly the rows the first
  migration had just rejected), and posts a second debit `system_balance_correction` / `cash_out` /
  `float` / `admin_correction`, key `sweep-reversal-balance-<id>`. The distinct category and
  idempotency key meant nothing deduplicated it.

Live state of that deposit window: **15 rows, UGX 32,810,000, all 15 `rejected`.**
Per-source_id leg census (`general_ledger` where `source_table='deposit_requests'`):

| Desk agent | Amount | Original credit | Reversal 1 (`agent_float_deposit`) | Reversal 2 (`system_balance_correction`) | Any later corrective credit | Last leg |
|---|---|---|---|---|---|---|
| Babrah Tusingwire | 2,000,000 | 1 | 1 | 1 | 0 | 14 Aug |
| Bayo Mercy | 50,000 | 1 | 1 | 1 | 0 | 14 Aug |
| Bayo Mercy | 110,000 | 1 | 1 | 1 | 0 | 14 Aug |
| Bayo Mercy | 500,000 | 1 | 1 | 1 | 0 | 14 Aug |
| Bayo Mercy | 5,000,000 | 1 | 1 | 1 | 0 | 14 Aug |
| Catherine Nabaggala | 2,000,000 | 1 | 1 | 1 | 0 | 14 Aug |
| Hilary Evanz | 2,000,000 | 1 | 1 | 1 | 0 | 14 Aug |
| Hilary Evanz | 5,000,000 | 1 | 1 | 1 | 0 | 14 Aug |
| JOSHUA WANDA | 950,000 | 1 | 1 | 1 | 0 | 14 Aug |
| JOSHUA WANDA | 1,000,000 | 1 | 1 | 1 | 0 | 14 Aug |
| JOSHUA WANDA | 1,200,000 | 1 | 1 | 1 | 0 | 14 Aug |
| NABBALE CLAIRE | 2,000,000 | 1 | 1 | 1 | 0 | 14 Aug |
| NABBALE CLAIRE | 3,000,000 | 1 | 1 | 1 | 0 | 14 Aug |
| Nankambo Sharimah | 3,000,000 | 1 | 1 | 1 | 0 | 14 Aug |
| Tugabirwe Apophia | 5,000,000 | 1 | 1 | 1 | 0 | 14 Aug |

Exactly the predicted shape: one credit, two debits, **no third corrective leg since**. Net wrong
debit **UGX 32,810,000** across 9 desks; total debited UGX 65,620,000 against UGX 32,810,000 of
credit.

**The money was real.** All 15 deposits carry a provider TID (`mtn` / `airtel`) that matches a row in
`gmail_transactions` **exactly by `transaction_id`** — 15/15. The first migration also NULLed
`gmail_transactions.linked_deposit_request_id` for each, so the provider evidence is now orphaned
from its deposit while the deposit itself reads `rejected` with the reason "not an approved credit".
That statement is factually wrong for all 15 rows.

Remediation shape when authorised: one compensating **credit** per source_id for the second debit
only (UGX 32,810,000 total), individually keyed, plus re-link of the `gmail_transactions` rows and
correction of the misleading rejection reason. Note the trap in
`mem://constraints/user-facing-ledger-filter`: an `admin_correction` credit is filtered out of
`v_user_wallet_strict`, so a naive `admin_correction` compensating credit will post but will not move
the displayed float. It must be `production` with an explicit evidence reference.

---

## Item 2 — Bayo Mercy duplicate opening balance: ALREADY CORRECTED. Do not apply the draft.

The draft migration `20260817130000_fix_balance_baseline_bayo_mercy_landlord_payout_matching.sql`
**does not exist in the repo** (never tracked, and not present on disk now).

Live pre-check against her `agent_id` `cfa56623…`:

- `merchant_ledger_float()` = **UGX 500,000** — not the 49,780,000 the draft expects, and not 13,000.
- Her whole `36,780,000` history is two legs and only two:
  - 17 Aug 08:49 `agent_float_deposit` / `cash_in` / `production` — "Merchant desk opening balance recognised"
  - 17 Aug 11:00 `system_balance_correction` / `cash_out` / `admin_correction` — **"Reversal of duplicate merchant desk opening-balance recognition"**
- Legs sourced from `merchant_float_reconciliations` for her: 17 Aug 08:49 (36,780,000 credit),
  17 Aug 10:32 (9,402,000 write-down, "float set to 13000"), 18 Aug 10:18 (1,000,000). There is **one**
  opening-balance credit posted, not three; the 07:29 and 07:40 passes left no ledger credit.
- The 13,000 target was reached by the 10:32 write-down. The float then moved on legitimately: a
  5,000,000 `mtn` float deposit at 16:02 on 17 Aug and subsequent settlement activity, leaving 500,000.

**Conclusion: the duplicate is gone. Applying the draft as-is would post a fresh, unbacked
UGX 36,780,000 debit against a desk that currently holds 500,000 — creating the very defect it was
written to fix.** The draft should be deleted, not applied. If a further baseline change is ever
wanted it must be recomputed against the live figure with fresh evidence.

---

## Item 3 — General-purpose correction queue

**The queue is larger than the master report states.** Scoped as merchant-desk wallet float debits
since the 1 Aug anchor with those four reference prefixes: **162 legs, UGX 639,264,680** (161 legs /
639,214,680 restricting to `is_active` desks). The report's "101 legs / UGX 374,895,199" is a subset.

| Prefix | Category | Legs | Amount |
|---|---|---|---|
| `FXW-*` | `agent_float_assignment` | 111 | 370,037,880 |
| `ECW-*` | `agent_float_assignment` | 25 | 132,989,824 |
| `FLT2WDR-*` | `agent_float_assignment` | 15 | 99,930,000 |
| `PAY-*` | `system_balance_correction` | 11 | 36,306,976 |

(Outside the anchor window the same prefixes carry a further ~UGX 460m of history on merchant desks,
back to Apr 2026 — out of scope here but it exists.)

### Authorship, roles at posting, evidence

`general_ledger` has **no operator column**, so authorship was recovered from
`audit_logs.metadata->>'reference_id'` (`finops_wallet_move`, `admin_float_to_withdrawable`, which
store `caller_roles` = the roles held **at posting time**) and from `error_correction_audit`
(`operator_roles`, `business_justification`). Every one of the 162 legs resolved to a named operator.

| Operator | Legs | Amount | Legs on a desk they themselves own | Legs with no `financial_ops`/`cfo` in roles at posting |
|---|---|---|---|---|
| Nankambo Sharimah | 147 | 554,500,089 | 91 | 118 |
| Joshua Wanda | 6 | 53,691,610 | 5 | 3 |
| Bayo Mercy | 9 | 31,072,981 | 1 | 9 |

Two structural control findings, independent of note quality:

- **Self-service on own desk: 97 legs, UGX 409,098,926** were posted by the operator against a desk
  whose `agent_id` is the operator. The largest are `FLT2WDR` 83,000,000 (Nankambo, 6 Aug,
  `[wrong_bucket] Supposed bd W…`), `ECW` 50,000,000 (Joshua Wanda, 10 Aug, "BACK TO PLATFORM"), and a
  run of `FXW` legs noted only "PARTNERSHIP" / "PARTBERSHIP" (42m, 30m, 30m, 20m, 20m, 15m, 13m, 12m,
  10m …).
- **No finance role at posting: 130 legs.** All 11 `PAY-*` legs carry **no recorded roles at all** —
  no `audit_logs` row with that `reference_id` exists, so there is no role or justification trail for
  them beyond the auto-generated ledger description. 9 of the 11 (UGX 29,306,976) also have no TID.

### Provider corroboration

TID corroboration tested as an amount match in `gmail_transactions` within −3/+1 days of the leg
(these are internal reclassifications, so most are not expected to have one): **58 of 162 legs have
no provider match** — `FXW` 26, `ECW` 19, `PAY` 9, `FLT2WDR` 4.

### Named candidates for reversal — no evidence AND no intelligible justification

Only these four meet both tests (no provider match, operator note absent or consonant-run gibberish).
**Total UGX 2,035,800. Nothing has been reversed.**

| Date | Desk | Amount | Prefix | Operator | Roles at posting | Operator note |
|---|---|---|---|---|---|---|
| 2026-08-01 | Nankambo Sharimah | 1,200,000 | `PAY` | Nankambo Sharimah | (none recorded) | `Requesred for 3vand given 2 nhggg` |
| 2026-08-11 | Nankambo Sharimah | 420,000 | `FXW` | Nankambo Sharimah | `operations, manager` | `HHDGDGVGF HHH` |
| 2026-08-12 | Bayo Mercy | 295,800 | `ECW` | Bayo Mercy | `operations, manager` | `gthngdfghjkmnhhj` |
| 2026-08-17 | Nankambo Sharimah | 120,000 | `FXW` | Nankambo Sharimah | `operations, manager` | `wantsbffggg` |

A second, larger tier is *not* proposed for reversal but should be evidenced or written off by CFO
decision: the 97 self-desk legs (UGX 409,098,926), and specifically the ten `FXW`/`FLT2WDR` legs over
UGX 10m whose entire justification is the single word "PARTNERSHIP" (or a typo of it) with no
counterparty, portfolio id or TID recorded.

---

## Item 4 — "Sweep" credits: no unevidenced credits exist; the sweep keys are Item 1

Every `general_ledger` wallet leg on a merchant desk with a `sweep`-prefixed idempotency key:

| Direction | Category | Classification | Legs | Amount | Dates |
|---|---|---|---|---|---|
| cash_out | `agent_float_deposit` | `admin_correction` | 15 | 32,810,000 | 14 Aug |
| cash_out | `system_balance_correction` | `admin_correction` | 15 | 32,810,000 | 14 Aug |

**30 legs, UGX 65,620,000 — and all 30 are debits, keyed `sweep-reversal-*` / `sweep-reversal-balance-*`.
There are zero `sweep`-keyed credits.** The "up to UGX 65,620,000 of sweep credits" in the master
report is the *reversal* population double counted, not a credit exposure.

The underlying credits the sweep created are the 15 `deposit_requests` in Item 1. Matched against
`gmail_transactions` by TID:

| Provider | Deposits | Amount | Exact TID match in `gmail_transactions` |
|---|---|---|---|
| mtn | 8 | 16,660,000 | 8 |
| airtel | 7 | 16,150,000 | 7 |
| **Total** | **15** | **32,810,000** | **15 / 15** |

**Nothing to flag.** The claim that ~UGX 22.65M was "auto-credited from internal gap arithmetic with
no independent provider match" does not hold: every one of the 15 carries a provider TID that exists
verbatim in the provider feed. The defect in this population is not a phantom credit — it is the
double debit of Item 1 against real, evidenced provider cash, compounded by the sweep having NULLed
the `linked_deposit_request_id` that proved it.

---

## Summary of what is actually owed remediation

| Item | Status | Net wrong amount | Action |
|---|---|---|---|
| 1. Double reversal 14 Aug | Confirmed, uncorrected | **UGX 32,810,000** under-credited across 9 desks | Post one compensating `production` credit per source_id; re-link provider rows; fix rejection reasons |
| 2. Bayo Mercy 36.78m | **Already reversed 17 Aug 11:00** | 0 | Delete the stale draft; applying it would create a new 36.78m error |
| 3. Correction queue | Larger than reported (162 legs / 639.3m) | 4 legs / **UGX 2,035,800** fully unjustified; 97 legs / 409.1m self-authored on own desk | CFO decision list; no reversal executed |
| 4. Sweep credits | Population misidentified; 15/15 TID-evidenced | 0 phantom credits | Nothing to flag; folds into Item 1 |

All figures reproducible with read-only SQL against `general_ledger`, `deposit_requests`,
`gmail_transactions`, `audit_logs`, `error_correction_audit`, `merchant_float_reconciliations`,
`cashout_agents`, `profiles` and `wallet_strict_for_user()`.
---

# ADDENDUM B — Per-item owed_to_agent delta quantification (read-only, 19 Aug 2026)

Formula under test (`get_merchant_float_positions`, anchor `2026-08-01`):

```
owed_to_agent = GREATEST( paid_out_total - (float_credits_recorded + adjustments_total), 0 )

paid_out_total          = SUM(withdrawal_requests.amount) WHERE status='completed'
                          AND COALESCE(processed_at,updated_at) >= anchor
                          AND (assigned_cashout_agent_id = desk OR processed_by = desk.agent_id)
                          -- NOTE: no payout_method filter
float_credits_recorded  = SUM(general_ledger.amount) WHERE wallet_bucket='float'
                          AND direction='cash_in'
                          AND category IN ('agent_float_deposit','agent_float_assignment')
                          AND classification <> 'admin_correction'
adjustments_total       = unposted merchant_float_reconciliations only
```

**Structural consequence:** every `cash_out` leg and every `admin_correction` leg is invisible to this
formula. Items 1, 3 and 4 consist entirely of `cash_out` / `admin_correction` legs, so they cannot
inflate `owed_to_agent` at all. Only Item 2 touches it — and it *suppresses* it.

## Live platform position (recomputed 19 Aug)

| Metric | Value |
|---|---|
| SUM(owed_to_agent) over active desks | **UGX 88,203,296** |
| Card figure quoted in the brief | UGX 86,315,896 (drifted; +1,887,400 since) |
| Desks with owed_to_agent > 0 | 5 of the active desk population |

| Desk / agent | paid_out | float_credits | adjustments | **owed_to_agent** | merchant_ledger_float() | merchant_float_visible_net() |
|---|---|---|---|---|---|---|
| Sky Bubbles (desk BAITA) | 220,403,745 | 147,230,000 | 30,317,606 | **42,856,139** | 0 | 0 |
| Bayo Mercy | 120,165,267 | 87,751,300 | −8,894,064 | **41,308,031** | 500,000 | 500,000 |
| Mudumba Samuel | 45,523,797 | 32,950,625 | 9,362,776 | **3,210,396** | 60,715 | 60,715 |
| Babrah Tusingwire | 5,980,977 | 5,534,354 | 0 | **446,623** | 0 | 0 |
| Nakajjubi Shamirah | 4,450,855 | 4,068,748 | 0 | **382,107** | 0 | 0 |

## Item 1 — double reversal of 15 float deposits (UGX 32,810,000)

The **original production `cash_in` credit survives for all 15** deposits, so `float_credits_recorded`
already contains the full 32,810,000. Both reversing legs are `cash_out` + `admin_correction`.

| Agent | source_id (deposit_requests) | amount | original credit leg id | reversal 1 (14:03:55, agent_float_deposit) | reversal 2 (14:06:34, system_balance_correction) | provider TID | current owed | owed delta if item corrected |
|---|---|---|---|---|---|---|---|---|
| Babrah Tusingwire | 58c7c23f-10f8-40b1-8d1a-cc56eead3c0d | 2,000,000 | 5a6db142 | efd4ff95 | 3c820f77 | 153940906265 | 446,623 | 0 |
| Bayo Mercy | 089ae94e-fe80-438d-a80c-88e5da697ff2 | 5,000,000 | d196e4f7 | 82806fd7 | 4def02f0 | 42739397201 | 41,308,031 | 0 |
| Bayo Mercy | 19a096e0-38ae-4089-835f-167cba96f4e7 | 500,000 | e8a87d07 | 74f60335 | aad29706 | 42738769917 | ″ | 0 |
| Bayo Mercy | 3070f505-3d56-40e6-a354-98a5e588ac9d | 110,000 | 35f24863 | 5dd838fa | 87309178 | 42667649239 | ″ | 0 |
| Bayo Mercy | 55228e7d-f42d-4a11-ac77-c6b4a59dbb5c | 50,000 | 15880e3a | 5b4a98b2 | 34b6e86a | 42667830164 | ″ | 0 |
| Catherine Nabaggala | 0933087e-4ced-4ea4-b7de-6a98a709b824 | 2,000,000 | a1603a73 | dbcc4ebd | 7c2a6883 | 153939982935 | 0 | 0 |
| Hilary Evanz | 85195814-8fcf-4155-b5c0-a76361d70bdf | 2,000,000 | 83b8834e | 0b92ad4d | 6ca49532 | 153939903251 | 0 | 0 |
| Hilary Evanz | 96cabda2-1e03-43c5-855d-ea6de8c4c716 | 5,000,000 | 5fd72cad | d604ab6d | 842259c8 | 153719403119 | 0 | 0 |
| Joshua Wanda | 78884626-e39d-4031-a7a2-bac338175f6d | 950,000 | c9e669a7 | 933c2454 | cb65d81b | 153927379986 | 0 | 0 |
| Joshua Wanda | 82cdda43-7787-45b1-922f-c6db962691b4 | 1,000,000 | 7ac9ed8c | 61944017 | de4ce602 | 153780808118 | 0 | 0 |
| Joshua Wanda | fc6e04ce-97e4-4d5f-a806-87a520c62f1f | 1,200,000 | 240ab8aa | 1dde2523 | def7109f | 153802953581 | 0 | 0 |
| Nabbale Claire | 9c1b385d-2bf2-4f0b-b4d2-5e8ccdecc16b | 3,000,000 | 66a9d095 | 7096e053 | 9281bf43 | 42740427573 | 0 | 0 |
| Nabbale Claire | fc8ba1ab-5f66-4c6d-a86b-d8da7c20b1f2 | 2,000,000 | e592af32 | 1ea8982d | cd46c822 | 42693571793 | 0 | 0 |
| Nankambo Sharimah | 9bdee02a-2968-4cd5-bd99-06f73503e7db | 3,000,000 | 75b8c8be | 46e4fac2 | 5ac98738 | 153426985875 | 0 | 0 |
| Tugabirwe Apophia | e9ab8e23-1b4a-48e7-9ab5-55291c55899e | 5,000,000 | e741df0c | 5974edf9 | 9d6c61be | 42757995152 | 0 | 0 |

All legs: `source_table='deposit_requests'`, `wallet_bucket='float'`, `transaction_date` 2026-08-14.

Live positions of the 8 affected agents (all desks active): Babrah 0/0 · Bayo Mercy 500,000/500,000 ·
Catherine Nabaggala 938,092/938,092 · Hilary Evanz 26,949/26,949 · Joshua Wanda 0/0 ·
Nabbale Claire 0/0 · Nankambo Sharimah 0/0 · Tugabirwe Apophia 0/0.

**owed_to_agent delta if corrected = UGX 0.** The damage is confined to
`merchant_ledger_float()` / `merchant_float_visible_net()`, understated by 32,810,000 in aggregate.

**Remediation warning (changed from the earlier plan):** the compensating credit must NOT be posted as
`agent_float_deposit` / `cash_in` / `production` — that would re-enter `float_credits_recorded`
alongside the surviving original and wrongly extinguish owed:
Babrah −446,623 and Bayo Mercy −5,660,000, i.e. a **spurious UGX 6,106,623 reduction** of platform
owed. Post it as `system_balance_correction` `cash_in` instead (restores the wallet bucket, invisible
to the owed formula).

## Item 2 — Bayo Mercy duplicate opening-balance credit (UGX 36,780,000)

Exactly two legs, both `wallet_bucket='float'`:

| id | transaction_date | amount | category | classification | direction | source_table / source_id |
|---|---|---|---|---|---|---|
| b1c251b4-3614-40d8-ad8d-a1474cbf75eb | 2026-08-17 08:49:40Z | 36,780,000 | agent_float_deposit | **production** | **cash_in** | merchant_float_reconciliations / 2132e8da-6215-430e-9581-201c485267ad |
| 38363eb8-4e20-4c0b-8d84-4a19052312bd | 2026-08-17 11:00:06Z | 36,780,000 | system_balance_correction | admin_correction | cash_out | ledger_transaction / — |

Live: `merchant_ledger_float()` = **500,000**, `merchant_float_visible_net()` = **500,000**
(the draft reversal expects a 49,780,000 pre-check — it is stale; do not run it).

The wallet balance is already correct, **but the reversal was `admin_correction` so the formula never
saw it**: the duplicate credit is still inflating her `float_credits_recorded`. Her three
`opening_balance` reconciliation rows total 36,980,000 against a real opening of 200,000.

**owed_to_agent delta if corrected = +UGX 36,780,000** (Bayo Mercy 41,308,031 → **78,088,031**).
Platform total 88,203,296 → **124,983,296**. This item *hides* debt; it does not inflate it.

## Item 3 — general-purpose correction queue

Scope re-cut on active merchant desks since the anchor, by reference prefix:

| direction | category | classification | legs | amount |
|---|---|---|---|---|
| cash_out | agent_float_assignment | production | 150 | 602,907,704 |
| cash_out | system_balance_correction | admin_correction | 11 | 36,306,976 |
| cash_in | agent_float_deposit | production | 74 | 547,899,665 |
| cash_in | agent_float_assignment | production | 15 | 24,563,199 |

The 161 debit legs (639,214,680) are `cash_out` → **owed_to_agent delta = UGX 0**, including the
4 unevidenced/unintelligible legs (2,035,800) and the 97 self-authored legs (409,098,926).

The real exposure in this population is on the **credit** side: 89 `cash_in` legs (572,462,864) whose
`reference_id` is a self-minted `PAY-*` / `FXW-*` string with **no matching `gmail_transactions.transaction_id`**.
On the five owed desks, unevidenced credits are:

| Desk | unevidenced credit legs | amount | as % of that desk's float_credits |
|---|---|---|---|
| Sky Bubbles | 6 | 147,230,000 | **100%** |
| Bayo Mercy | 2 | 56,780,000 | 65% |
| Mudumba Samuel | 18 | 32,950,625 | **100%** |
| Nakajjubi Shamirah | 5 | 4,068,748 | **100%** |
| Babrah Tusingwire | 2 | 2,034,354 | 37% |

Each of these *suppresses* owed. If the unevidenced credits were disallowed, platform owed would rise
by roughly the full 243,063,727 on these desks (bounded by paid_out). Directionally this item, like
Item 2, understates rather than inflates.

## Item 4 — "sweep" credits

Population does not exist as described: all 30 `sweep-*` keyed legs are the Item 1 `cash_out`
reversals (2 per source_id × 15), so 65,620,000 is 32,810,000 counted twice. 15/15 are TID-corroborated.
**owed_to_agent delta = UGX 0.**

## Aggregate

| Item | owed_to_agent delta if corrected |
|---|---|
| 1 — double reversal | 0 (wallet float +32,810,000) |
| 2 — Bayo duplicate credit | **+36,780,000** |
| 3 — correction queue (debit legs) | 0 |
| 4 — sweep credits | 0 (population void) |
| **Net across all four items** | **+36,780,000** |

**Conclusion: none of the UGX 88,203,296 headline is attributable to Items 1–4.** Those four defects
are wallet-balance and control defects; corrected faithfully they would *raise* the figure by
36,780,000. The inflation lives in two mechanisms outside the named scope:

1. **Cross-method attribution — UGX 62,342,175 (70.7% of the headline).** `paid_out_total` has no
   `payout_method` filter, so bank transfers the desk never funded from float are charged to it.
   Sky Bubbles: 210,298,745 of 220,403,745 paid_out is `bank_transfer`; momo-only owed = **0**
   (−42,856,139). Bayo Mercy: 19,486,036 bank of 120,165,267; momo-only owed = 21,821,995
   (−19,486,036). Mudumba, Babrah, Nakajjubi are 100% mobile money — unaffected.
2. **Multi-desk double attribution — up to UGX 10,107,036** across 10 completed withdrawals matched to
   two desks each by the `assigned_cashout_agent_id OR processed_by` disjunction.

Genuine float-backed debt to agents after both corrections: **UGX 25,861,121**
(Bayo Mercy 21,821,995 + Mudumba 3,210,396 + Babrah 446,623 + Nakajjubi 382,107 + Sky Bubbles 0),
before any haircut for the 243,063,727 of unevidenced credits described in Item 3.

**Data-quality flag:** two distinct profiles carry near-identical names — `Bayo Mercy`
(cfa56623-e6cb-4023-b601-3dbd4fdbc027, the owed desk) and `Mercy Bayo` (separate id, holder of
35,000,000 of `PAY-*` credits). Confirm these are separate humans before any settlement.

---

# ADDENDUM C — Candidate lists awaiting sign-off (nothing posted)

Governance accepted for every reversing entry: named non-conflicted CFO/FinOps officer, guarded
fail-closed pre-check, unique `idempotency_key`, explicit prior-reversal interlock on the same
`source_id`, one item at a time with a fresh trace between items.

## Authorizing officer eligibility

| Officer | Role | Eligible | Reason |
|---|---|---|---|
| Benjamin Muhanguzi (cf561688-b3a2-4f62-b9c1-67ee7b36ff2b) | cfo | **Yes** | Not a desk holder in any item; did not author the 14/17 Aug defects |
| Angwen Sarah (29a0cfa8-1eaf-453c-874c-0fc72fa4f74b) | cfo | **Yes** | Not a desk holder in any item |
| Joshua Wanda (cb798acb-68bc-4b4e-a414-a3d374e030b6) | cfo | **No** | Desk holder on 3 of the 15 Item 1 deposits (3,150,000) — self-authorization |
| Nankambo Sharimah (59d45ad2-0d44-433c-b4ec-20927a25c281) | financial_ops | **No** | Desk holder on Item 1 deposit 9bdee02a (3,000,000) |

The 14 Aug double reversal and the 17 Aug duplicate credit were posted by **migration**, not by an
authenticated user — no `audit_logs` actor exists for them, so no officer is excluded on causation
grounds beyond the two desk-holder conflicts above.

## Interlock state verified 19 Aug (pre-flight, read-only)

- Zero legs exist against any of the 15 Item 1 `source_id`s dated after 2026-08-14 → no third
  correcting leg, confirming the population is still uncorrected and un-double-corrected.
- Zero collisions for the proposed key namespaces `mfc1-restore-*` and `mfc2-credit-declass-*`.

## Candidate list 1 — restore the 15 double-debited float deposits

- Scope: 15 legs, one per `source_id`, total **UGX 32,810,000**, 8 desks.
- Posting shape: `wallet_bucket='float'`, `direction='cash_in'`,
  `category='system_balance_correction'`, `classification='admin_correction'`,
  `source_table='deposit_requests'`, `source_id` = the original deposit,
  `idempotency_key='mfc1-restore-<source_id>'`, `reference_id` = the original provider TID.
- Category choice is deliberate: `agent_float_deposit` would re-enter `float_credits_recorded`
  next to the surviving original and spuriously erase UGX 6,106,623 of platform owed.
- Pre-check (fail closed, per source_id): exactly 1 production `cash_in` leg **and** exactly 2
  `admin_correction` `cash_out` legs of the same amount **and** 0 legs with key prefix
  `mfc1-restore-`; otherwise `RAISE EXCEPTION` and post nothing.
- Expected effect: `merchant_ledger_float()` +32,810,000 in aggregate;
  `owed_to_agent` unchanged (**delta 0**); platform owed stays 88,203,296.
- Secondary, separate sign-off: re-link the 15 `gmail_transactions` rows nulled on 14 Aug and
  reverse the false "not an approved credit" rejection reasons on the 15 `deposit_requests`.

## Candidate list 2 — declassify the Bayo Mercy duplicate opening-balance credit

- Scope: 1 leg, `b1c251b4-3614-40d8-ad8d-a1474cbf75eb`, **UGX 36,780,000**, desk
  `1c9bb2f6-3f95-47d7-8e56-f291c79d1261`, agent `cfa56623-…198c`.
- Wallet balance is already correct — the only defect is that the 17 Aug reversal
  (`38363eb8`) was `admin_correction`, so the duplicate credit still counts toward
  `float_credits_recorded`.
- Posting shape (option A, preferred): a `production` `cash_out` `agent_float_deposit` contra leg keyed
  `mfc2-credit-declass-2132e8da-…` so the pair nets to zero inside the owed formula, plus a
  compensating `admin_correction` `cash_in` so the wallet float does not move. Option B (reclassify
  `b1c251b4` in place) is rejected — it mutates a historical production row.
- Pre-check: `merchant_ledger_float(cfa56623…)` = **500,000** exactly; `b1c251b4` still
  `production`/`cash_in`; `38363eb8` present; 0 legs keyed `mfc2-credit-declass-%`.
  Any mismatch → `RAISE EXCEPTION`.
- Expected effect: Bayo Mercy `owed_to_agent` 41,308,031 → **78,088,031**; platform
  88,203,296 → **124,983,296**; wallet float unchanged at 500,000.
- Also flagged for the same sign-off: her `opening_balance` recon rows total 36,980,000
  (22b21079 100,000 · fed1ba1a 100,000 · 2132e8da 36,780,000) against a real opening of 200,000, and
  `1b68a9ee` (1,000,000 write-down) carries the note `0 NGBGFFFHHGGG VHHHJ`.
- **The pre-existing draft reversal is stale and must be deleted, not run** (it expects 49,780,000).

## Candidate list 3 — correction queue: no ledger reversal proposed, CFO adjudication only

- 161 debit legs (639,214,680) cannot move `owed_to_agent`; reversing them would move wallet floats
  that have since been settled. No blanket reversal is proposed.
- Adjudication list A — **4 legs / UGX 2,035,800** with neither provider evidence nor an
  intelligible justification (notes such as `HHDGDGVGF HHH`, `gthngdfghjkmnhhj`).
- Adjudication list B — **97 legs / UGX 409,098,926** posted by an operator against their own desk.
- Adjudication list C — **11 `PAY-*` legs** with no `audit_logs` row at all: no actor, no role,
  no justification.
- Adjudication list D — **89 `cash_in` legs / UGX 572,462,864** whose `reference_id` is a self-minted
  `PAY-*`/`FXW-*` string with no `gmail_transactions` match. These *suppress* owed
  (243,063,727 of them sit on the five owed desks). Any disallowance raises platform owed and needs
  its own sign-off per desk.

## Candidate list 4 — sweep credits: nothing to post

Population void — the 30 `sweep-*` legs are Item 1's debits (2 per source_id × 15), 15/15
TID-corroborated. Item closed with no entry.

## Out-of-scope defects that actually drive the headline (no reversal fixes them)

1. `get_merchant_float_positions.paid_out_total` has no `payout_method` filter →
   **UGX 62,342,175 (70.7%)** of the headline is bank transfers charged to desks that never funded
   them. This is a **code fix**, not a ledger correction.
2. The `assigned_cashout_agent_id OR processed_by` disjunction double-counts 10 withdrawals across two
   desks each — up to **UGX 10,107,036**.
3. Reconcile the two similarly named profiles `Bayo Mercy` and `Mercy Bayo` before any settlement.

Posting order requested: 1 → fresh trace → 2 → fresh trace → (3 adjudication) → code fix.
