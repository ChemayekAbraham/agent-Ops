# 113 — TID-backed rent-collection gate never recognized Financial-Ops-routed deposits

**Fixed and applied live 2026-09-23. Root-caused from a real agent complaint within hours of the
gate (doc from 2026-09-21) going into full enforcement.**

## What was reported

Josh forwarded a WhatsApp complaint from agent Okwakol Micheal ("Mike"): "Am having issues
allocating tenant payments... Yesterday, the same issue happened when I tried to allocate another
tenant's payment." Screenshot showed `Confirm Payment` failing with: "Only deposits verified by a
real transaction ID may fund rent collection. TID-backed balance: 0, Requested: 80000."

First pass concluded this was the TID-backed hard rule (2026-09-21, `agent_allocate_tenant_payment_internal`)
working as designed — Mike's lifetime TID-matched deposits (UGX 2,586,000) were almost exactly
drawn down by his lifetime collections (UGX 2,605,000), landing his backfilled balance at 0. That
conclusion was **wrong**. Josh corrected it: "HE HAS DEPOSITED THE 80K ON HIS WALLET AND IT WAS
ROUTED TO HIS WALLET BY FINANCIAL OPS FROM THE EMAIL TRANSACTIONS."

## What was found

Financial Ops has a second, legitimate path for crediting an agent's float: when an inbound
deposit email/SMS fails to auto-match a `deposit_requests` row, a FinOps staffer manually routes it
from the **Email Transactions** panel (`RouteEmailDepositDialog.tsx` → `cfo-direct-credit` edge
function). That function posts a `category='agent_float_deposit'` credit leg to the agent's
wallet — same category the TID-backed trigger watches — but with `source_table='cfo_direct_credit'`
(never `'deposit_requests'`), and stamps the real gmail TID into `sub_category` instead of linking
through a `deposit_requests` row. `tg_credit_tid_backed_float()` (the trigger from doc/migration
20260921100000) only recognized the `deposit_requests` shape, so **every credit routed this way was
structurally invisible to the TID-backed tracker from the day the gate was built** — even though it
originates from the exact same `gmail_transactions` row a deposit_requests match would have used.

Verified live: Mike's two routed credits (`sub_category = 'TID157147029064'` / `'TID157053803819'`,
UGX 80,000 + 25,000, this morning and yesterday) both match a real `gmail_transactions.transaction_id`
with an equal amount — genuinely real, verifiable deposits. Platform-wide: **628** `general_ledger`
rows carry `category='agent_float_deposit', source_table='cfo_direct_credit'` (UGX ~1.59B total),
but only **~62** of those actually carry a matchable TID in `sub_category` — the other ~90% have no
TID at all (administrative/override credits routed through the same edge function, not real
deposits) and correctly stay excluded under the same verification standard the `deposit_requests`
branch already applies.

## What was fixed

- **`tg_credit_tid_backed_float()`**: added a branch for `source_table = 'cfo_direct_credit'` that
  verifies `sub_category` against a real `gmail_transactions.transaction_id` before crediting
  (cash_in), and mirrors the existing unconditional cash_out clawback for reversals/debits on this
  path. This part is forward-looking and safe — it only affects `general_ledger` rows posted from
  now on, for every agent, and never touches anything historical.
- **Mike's `agent_tid_backed_float.balance` only**: set directly to **105,000** (his two verified
  credits; his pre-existing historical component was separately confirmed to already be 0). This is
  a scoped, single-row correction — not a recompute of his history.
- Migration `20260923090000_tid_backed_float_recognize_cfo_direct_credit.sql`, applied live.

### What was tried and reverted — read this before touching this table again

The first pass **recomputed every agent's balance** from the full reflected-random-walk history
(the same formula the original 20260921100000 seed uses), now including the `cfo_direct_credit`
branch. This was **reverted** after Josh flagged it: a full-history recompute is not purely
additive — because it also newly recognizes `cfo_direct_credit` **cash_out** events (debits/
reversals on this same path) for the first time, it moved **41 agents' balances in both
directions** (19 up, 22 down), by amounts up to several million UGX each (e.g. TURIBAMWE BRAISON
−5,000,000, NAMPIIMA RUTH +8,000,000) — none of it visible on any agent's actual wallet balance
(`get_user_wallet_view()` reads `wallet_balances_projection`, never this table, confirmed live) but
still far more disruption to an internal gating number than the one verified complaint warranted.
All 40 non-Mike agents were reverted to their exact pre-recompute values; only Mike's row was kept
corrected. See the conversation transcript (2026-09-23) for the full before/after table if it's
ever needed again.

## What not to do

- Don't treat every `cfo_direct_credit` row as TID-backed just because it shares the category with
  a real deposit — most have no TID at all (of 628 `cfo_direct_credit` rows platform-wide, only
  ~62 carry a matchable TID in `sub_category`; the rest are administrative/override credits) and
  are legitimately excluded. Always verify through the `gmail_transactions` join, never the
  `source_table` label alone.
- **Don't re-run a platform-wide recompute of `agent_tid_backed_float` to fix another agent's
  complaint.** It touches everyone, not just the reported case, and moves balances in both
  directions in ways that are non-obvious from the formula alone. If another agent reports the same
  symptom, verify their specific `cfo_direct_credit` rows against `gmail_transactions` individually
  (same method as Mike above) and correct only their row, by exact amount.
- The internal `agent_tid_backed_float` table is a gating counter, not a wallet balance — it is
  never shown to an agent and has no display surface. Changing it is lower-stakes than a ledger
  entry, but per Josh's direction it still gets patch-and-verify treatment, not blanket rebuilds.
- Separately, many agents genuinely have zero TID-backed float and are not affected by this bug at
  all (most of the platform's active agents run on non-TID-backed float sources) — that is a
  distinct, already-documented finding, not evidence this fix is incomplete.
