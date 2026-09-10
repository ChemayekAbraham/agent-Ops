# Catch-up: move already-recognised fees into Platform Treasury

## What was confirmed (read-only)

- Every new-plan collection since the split went live records its registration and access fee portions. 37 fee-bearing splits exist, totalling UGX 1,581,197 of fees recognised.
- The separate step that actually moves that fee cash out of agent custody into the Platform Treasury pool only began running on 10 Sep at 06:21 (Kampala 09:21). Since then it has fired on every fee-bearing collection: 17 movements, UGX 173,637.
- 20 fee-bearing collections recorded before that time never got the Treasury movement. 10 of those were later reversed, so they owe Treasury nothing. The remaining 10 are valid and still missing the movement, worth UGX 41,262 of fees.

So: recognition is correct throughout; the physical Treasury routing is correct from 10 Sep 06:21 onward, with a 10-collection gap before it.

## What to do

Run a one-off catch-up that posts the missing Treasury cash movement for exactly those 10 collections, using the same existing routine that runs live today — no new maths, no fee recalculation.

Rules the catch-up must obey:

- Use the fee amounts already stored on each collection's split. Never recompute a fee.
- Skip any reversed collection.
- Skip any collection that already has a Treasury movement (the routine is already idempotent — a second run posts nothing).
- Cash custody only: the fee cash moves out of agent custody into the Treasury pool. Total cash across the business is unchanged, principal stays with the agent, and no wallet balance, commission, revenue entry, or tenant record is touched.

Expected result: 10 new Treasury movements totalling UGX 41,262, after which every valid fee-bearing collection on the new plan has its fee cash in Treasury.

## Verification after the run

- Re-count fee-bearing splits vs Treasury movements — the only remaining gaps should be reversed collections.
- Confirm the Treasury cash position rises by exactly UGX 41,262 and that agent float custody falls by the same amount.
- Confirm no collection received a duplicate movement.

## Technical notes

- Catch-up calls `public.post_treasury_fee_cash_transfer(collection_id)` per eligible collection; it posts a balanced pair of platform legs (`agent_float_cash_offset` cash_out / `cash_receipt_in_transit` cash_in) via `create_ledger_transaction` with an exactly-once idempotency key.
- Eligible set: `instalment_allocations` rows with `source_table = 'agent_collections'` and a positive registration + access component, whose collection is not reversed and which has no existing platform `cash_receipt_in_transit` cash_in leg for that `source_id`.
- Delivered as a migration-run DO block (no new persistent function, no schema change, no policy change). Treasury Cash = A1 + A5, so this raises Treasury by the transferred amount while A1+A2+A5 stays constant.
- No frontend changes; CFO Treasury figures read from the same ledger and pick this up automatically.
