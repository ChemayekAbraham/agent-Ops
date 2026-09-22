# A2 (Agent Float) accounting check — findings and proposed correction

Read-only verification of how "agent pays a tenant's rent from float" lands on the Book of Accounts line A2. Nothing was changed: no wallets, no tenant repayments, no collections, no operational records.

## What should happen

When an agent settles a tenant's rent out of float, the float asset (A2) must go **down** by exactly the float used. The money leaves the float and becomes a tenant repayment.

## What actually happens

Live float movements recorded as "agent float used for rent" (reportable entries only):

| | Count | Amount (UGX) |
|---|---|---|
| Float spent (should reduce A2) | 7,119 | 218,383,518 |
| Float returned/reversed (should increase A2) | 30 | 6,541,236 |
| **Expected net A2 reduction** | | **211,842,282** |
| **Actual net A2 reduction on the statement** | | **105,676,608** |
| **Shortfall — A2 overstated** | | **106,165,674** |

### Where the reduction is lost

1. **2,417 entries, UGX 53,166,837** — float spent, but the balance sheet *adds* it to A2 instead of subtracting it. Because a wrong-signed entry counts twice, this alone overstates A2 by **UGX 106,333,674**.
   - Cause: the reporting rule that says "a float entry in a group that also contains a tenant-repayment entry is cash *received*". That rule is right for collections, but these groups are float being *spent*, so the sign is inverted.
   - Concentration: 2,288 entries / UGX 49,047,477 in September 2026; the rest April–May 2026.
2. **6 entries, UGX 84,000** — float returns treated as reductions instead of increases (understates A2 by UGX 168,000). Net of item 1, the overstatement is UGX 106,165,674.

### A separate source-level problem (not a reporting rule)

**24 entries, UGX 6,457,236** were written as float *coming in* when the agent was in fact spending float. Mostly 10 and 21 September 2026 — JAMES KATONGOLE (UGX ~5.9m across 11 entries), IAN MUHWEZI, DAVID KANYESIGYE, Akandwanaho Wycliffe, Thomas Hawahka, plus one April entry (Akampurira Onesmus, UGX 300,000). No later entry reverses them.

### An offsetting posting that props A2 back up

The 21 September receivable correction created **10,794 offset entries totalling UGX 274,680,914** that land as an *increase* to A2. These are accounting-only counterparts, not real float, so they inflate A2 further on top of the figures above.

## Proposed correction (nothing applied yet)

1. **Fix the reporting rule only** (recommended first step): restrict the "float in a repayment group is cash received" rule so it never applies to `agent_float_used_for_rent`. This is a reporting-definition change; no ledger row is touched, no wallet moves. Effect: A2 falls by UGX 106,165,674 to its true position.
2. **Reverse the 24 wrong-direction source entries** with balanced correcting entries (accounting-only, classification `admin_correction`, with written basis). Effect: a further UGX 6,457,236 removed from A2.
3. **Re-map the 10,794 offset counterparts** off A2 to the correct counterpart account so the September receivable correction stops inflating float.

Each step is separable and each needs your explicit approval. Step 1 alone already removes the bulk of the misstatement.

## Technical notes

- Resolver: `public.sofp_ledger_legs(as_at)` → `get_statement_of_financial_position`. The inverting branch is the `wallet` / `A2` case gated on `n_repay > 0 OR n_land_recv > 0`.
- Correct shape (4,702 groups): wallet `A2` credit + bridge `A3 rent_receivable_created` debit + commission legs.
- Wrong shape (2,417 groups): wallet `A2` debit + platform `A3 tenant_repayment` / `tenant_repayment_collected` credit.
- Offset legs: `platform.agent_float_cash_offset`, `cash_in`, source `agent_collections`, 10,794 legs / UGX 274,680,914, mapped to `A2` debit.
- Any fix stays in the resolver/account map per the standing rule: never edit `general_ledger` rows to make the balance sheet agree.
