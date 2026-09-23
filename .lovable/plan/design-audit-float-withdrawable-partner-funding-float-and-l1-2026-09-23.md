# Design audit — float ⇄ withdrawable, partner_funding float, and L1 custody

Read-only. Nothing was posted, remapped, deployed or modified. This is a design proposal for approval.

## What the live architecture actually does today

The classifier is `public.sofp_ledger_legs(as_at)` (SQL, SECURITY DEFINER). Every leg gets a starting account from `ledger_account_map` (bucket-specific row first, then bucket-agnostic row, then the wallet fallback: float→A2, advance→A4, other wallet→L1). Two later branches then override that:

- account override, line 87: `wallet` leg whose starting account is `L1`, in a group of exactly 2 wallet legs (1 A2 + 1 L1) with no platform legs other than `system_balance_correction` → forced to **A8**.
- direction override, line 112: the same condition → direction forced to `cash_in`, i.e. a **debit**.

The rule keys purely on group *shape*, never on category. That is the whole defect:

| Population | Legs / groups | Raw withdrawable side | Currently lands in |
|---|---|---|---|
| `wallet_transfer` float ⇄ withdrawable | 356 / 356 | 681,478,775 Cr net | A8 debit |
| `bucket_reclass_in` / `bucket_reclass_out` | 625 | 521,044,061 Cr net | A8 debit |

Both populations are customer withdrawable money being parked in a **current asset**.

Separately, map row `8987f13e-3244-4021-91d6-dac1d0df0712` (wallet / `partner_funding` / `wallet_bucket IS NULL` / **L1** / `debit_when cash_out`) is bucket-agnostic, so it also captures float-bucket partner_funding legs — pulling **368,320,964 net debit** into customer custody that belongs in A2. There is no `wallet + partner_funding + float` row to catch them first.

Also confirmed: the two `bucket_reclass_*` **withdrawable** map rows carry `debit_when = cash_in`, which inverts a liability (a custody inflow must be a credit). It is currently inert only because line 87 overrides the account anyway.

## Intended accounting treatment

1. **float → withdrawable** — A2 float asset down (credit), L1 custody payable up (credit). Because both sides are credits, a balancing debit is required: the float asset is derecognised and an obligation is created, and both are real economic costs to the company. So the group needs an expense counterpart of **2× the amount** (float derecognised + custody recognised). Today's A8 debit is what hides this cost as an asset.
2. **withdrawable → float** — the exact mirror: A2 up (debit), L1 down (debit), with a matching income/recovery credit of 2× the amount.
3. **float-bucket `partner_funding`** — A2 (float asset), at the float-bucket native direction `debit_when = cash_in`. Never L1: partner float is company money, not customer custody.
4. **genuine withdrawable → withdrawable transfers** — none exist in the population (100% of the 356 groups are float ⇄ withdrawable). If any arise, both legs start at L1, the group shape is 2 wallet / 0 A2 / 2 L1, so it never meets the reclass condition: one L1 debit, one L1 credit, net zero custody. No change needed.

## Proposed smallest correction (reporting side only)

Three narrow, category-keyed changes. No `general_ledger` row, wallet balance, wallet behaviour, tenant repayment path or historical amount is touched.

**Change 1 — mapping: add one row**
`ledger_scope = 'wallet'`, `category = 'partner_funding'`, `wallet_bucket = 'float'`, `account_code = 'A2'`, `debit_when = 'cash_in'`.
Because the bucket-specific join wins, float partner_funding legs stop reaching L1. The existing bucket-agnostic L1 row keeps serving withdrawable/other-bucket partner_funding legs, unchanged.

**Change 2 — mapping: correct the two inverted rows**
`bucket_reclass_in` / `bucket_reclass_out` at `wallet_bucket = 'withdrawable'` → `debit_when` changes `cash_in` → `cash_out`, so a custody inflow reads as a credit. (No effect until Change 3 removes the override.)

**Change 3 — resolver: replace the shape-keyed override with a category-keyed, balanced rule**
- Delete the A8 account branch (line 87) and the forced-`cash_in` direction branch (line 112). The withdrawable leg then keeps L1 at its own mapped direction. Nothing else in the function references that branch.
- Add a narrow synthetic counterpart in the existing `synth` CTE (same mechanism already used for `float_backed_collection_counterpart`), gated on **all** of: `sc = 'wallet'`, resolved account `L1`, `cat IN ('bucket_reclass_in','bucket_reclass_out','wallet_transfer')`, `n_wallet = 2`, `n_a2 = 1`, `n_l1 = 1`, `(n_plat = 0 OR n_plat = n_plat_sbc)`. It emits two `X4` legs of the group amount — `float_derecognised_on_bucket_reclass` and `custody_recognised_on_bucket_reclass` — debits for float→withdrawable, credits for the reverse.

The category list is explicit, so no unrelated category can be captured, and the A2 leg keeps its existing treatment untouched.

## Expected accounting effect (verified amounts)

| Account | Movement | UGX |
|---|---|---|
| L1 — wallet_transfer withdrawable side returns to custody | credit | 681,478,775 |
| L1 — bucket_reclass withdrawable side returns to custody | credit | 521,044,061 |
| L1 — misrouted partner_funding float debit removed | credit | 368,320,964 |
| **L1 total increase** | **credit** | **1,571,844,840** |
| A8 — reclass debits removed | reduction | (1,202,522,836) |
| A2 — partner_funding float recognised | debit | 368,320,964 |
| X4 — float conversion expense counterpart (2 × 1,202,522,836) | debit | 2,405,045,672 |

Resulting L1: 205,241,812.20 Cr → **1,777,086,652.20 Cr**.
Balance proof: the partner_funding pair is self-balancing (A2 debit vs L1 credit, 368,320,964 each). For the reclass population, credits rise by 1,202,522,836 (L1) while A8 debits fall by the same, so the X4 debit of 2,405,045,672 restores debits = credits exactly.

Measured against wallet custody support (withdrawable 77,513,637.98 + locked 342,423,706.00 = 419,937,343.98), the corrected L1 is far larger — because the credits being restored are historical custody movements that were later withdrawn in cash, not balances still outstanding. The pre-existing SOFP self-check failure of (13,000,000) is unrelated and stays.

## Two decisions needed before any SQL

1. **The 2× expense.** It is the only arrangement that satisfies all your constraints simultaneously (L1 recognises custody, A2 float accounting preserved, books balance). It asserts the company bore a real cost on both sides — the float asset gone *and* a withdrawable claim created. If you consider one side a non-cash bookkeeping correction, then either A2 must be relieved instead or L1 must not rise, and I need your ruling on which.
2. **Locked balances as custody** — still outstanding from the L1 verification, and it decides the sign of the remaining variance.

Nothing will be written or deployed until you approve.
