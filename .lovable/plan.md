# A2 (Cash at Hand — Float with Agents): accounting discrepancy found

Read-only investigation. Nothing was posted, reversed or changed.

## What A2 should do when an agent pays a tenant's rent

When an agent settles a tenant's rent from float, the agent is holding less cash, so
A2 must go **down** by exactly the float used. In the ledger that is the wallet-scope
`agent_float_used_for_rent` leg, posted as `cash_out`, which the Book of Accounts must
read as a **credit** to A2.

## Finding 1 — since 8 September, float spent on rent *increases* A2 instead of reducing it

The raw ledger is correct: 7,112 production legs, **UGX 218,279,518**, all `cash_out`.
The Book of Accounts mis-signs a large block of them.

| Treatment in the Book of Accounts | Groups | Amount |
| --- | --- | --- |
| Float spent, A2 reduced (correct) | 4,702 | UGX 165,216,681 |
| Float spent, **A2 increased (wrong sign)** | 2,410 | **UGX 53,062,837** |

Effect on A2: the 2,410 transactions should have reduced A2 by UGX 53,062,837 and
instead added it, so A2 is overstated by **UGX 106,125,674** from this alone.

The split is not random. Correctly credited groups are the old collection shape whose
counterpart leg is `rent_receivable_created` (bridge). The mis-signed groups are the
**current** shape, whose counterpart is platform `tenant_repayment_collected` /
`tenant_repayment`. Daily evidence of the cutover:

```text
 07 Sep   credit 3,489,067   debit         0     correct
 08 Sep   credit   347,960   debit 3,452,667     cutover day
 09 Sep   credit         0   debit 3,479,638     wrong from here on
 ...
 22 Sep   credit         0   debit 1,769,487
```

Cause: in `sofp_ledger_legs`, when a group contains a platform repayment leg the
platform leg is sign-flipped to keep the group balanced, and the wallet A2 leg is then
left on its raw direction — which turns a `cash_out` float leg into a debit. Every
collection recorded from 8 September onwards follows that path.

## Finding 2 — 18 collections were posted with the wrong direction at source

18 wallet legs, **UGX 6,373,236**, carry `cash_in` on `agent_float_used_for_rent`
(they should be `cash_out`). 16 of them are on 10 Sep 2026 — JAMES KATONGOLE
UGX 5,897,368 (10 legs), Saka Homi Melvin UGX 93,668 (5), Akandwanaho Wycliffe
UGX 73,000 (1) — with the whole group sign-flipped (`platform cash_out
tenant_repayment_collected`). The remaining 2 legs (UGX 84,000, April) came in via
`wallet_deposits`. These add a further **UGX 6,373,236** of overstatement, and no
later posting reverses them.

## Finding 3 — the 21 September A3 correction also debits A2

The 10,794 A3 reversal legs posted on 21 Sep use platform `agent_float_cash_offset`
with `cash_in`, and that category maps to **A2 as a debit**. So a correction intended
to clear the Rent Access Receivable also **increased A2 by UGX 274,680,914**. The A3
side is right; the counterpart landed on the wrong account.

## Legitimate items — not part of the discrepancy

- 46 admin_correction legs (UGX 1,260,000, 21 Sep) voiding collections with no deposit
  evidence: correctly excluded from the statement.
- 2 genuine float-return reversals (UGX 300,000 and UGX 9,200).

## Total A2 discrepancy

| Item | A2 overstatement |
| --- | --- |
| 2,410 mis-signed collection groups (8 Sep onward) | 106,125,674 |
| 18 wrong-direction source legs | 6,373,236 |
| A3 correction counterpart landing on A2 | 274,680,914 |
| **Total** | **387,179,824** |

## Proposed correction — accounting only, nothing yet

1. Fix the statement rule so a wallet `agent_float_used_for_rent` leg is always read as
   a credit to A2, whatever its counterpart category. Reporting logic only — no ledger
   rows touched, so all 2,410 groups correct themselves the moment it is fixed.
2. Post a same-amount, opposite-direction accounting reversal for each of the 18
   wrong-direction legs, each naming the leg it reverses, idempotent by leg id.
3. Re-map the A3 correction counterpart off A2 (or reclassify those 10,794 legs to the
   intended account) so clearing a receivable no longer inflates agent float.
4. Re-verify: A2 equals float genuinely held by agents, zero remaining wrong-direction
   legs, and no reversal larger than its original.

Wallets, tenant repayment behaviour, collections and operational transactions stay
untouched throughout.

## Confirm before I act

Whether to do step 1 only (reporting fix), or steps 1–3 together.
