# Share creation: choose whose operational float pays

## What changes for you
In "Add new shareholder" you will see two balances:
- **Shareholder's operational float** (existing users only)
- **Your operational float** (the signed-in staff member creating the shares)

A new "Pay from" choice has two options: **Shareholder's float** or **My float**.
- For a **New person**, or anyone with no float (for example someone who sent cash to the company), only "My float" can be picked.
- The amount is capped by whichever float you pick, and the maximum shown follows your choice.

The shareholder still receives the shares, the signing link and the agreement. Only the payer changes.

## Keeping the books balanced
- Same single, balanced ledger posting as today (category `share_capital`, wallet leg on the float bucket, platform leg on the other side). Only the wallet leg's owner changes, to the payer.
- The money comes out when the shares are countersigned, as it does today. At that moment the payer's float is checked again with the live spendable-float figure, so nobody can overspend.
- The payer's wallet statement shows "Angel Pool shares for <shareholder> (<reference>)".

## Searchable as Angel Pool creation
- The Angel Pool investment record keeps the shareholder as investor and adds who paid: `funded_by = 'staff_float'` plus `agent_id = payer` (both columns already exist). `payment_method` stays `wallet`.
- The ledger `reference_id` = the share reference (ANGEL-…), and `source_table = angel_pool_investments`. You can find the spend by reference, by payer or by shareholder.
- A system event and an audit log record the payer, the shareholder, the amount and the reference.

## Technical details
- Migration (additive): `share_onboarding_requests` gains `funding_source text not null default 'shareholder'` (check: `shareholder` | `creator`) and `funder_user_id uuid` (null means the shareholder pays).
- `CreateShareholderDialog.tsx`: a second balance query calls `get_user_float_available_balance` for the current user. It adds the Pay-from radio and sends `fundingSource`. For a New person, the payer is forced to be the creator.
- `create-share-onboarding`: accepts `fundingSource` and stores `funding_source`/`funder_user_id = user.id`. It checks the amount against that payer's spendable float via the RPC instead of `wallets.float_balance`.
- `finalize-share-onboarding`: debits `funder_user_id ?? shareholder_id` and gates on `get_user_float_available_balance` for that payer. It sets `funded_by`/`agent_id` on the investment and adds the payer to the event and audit metadata.
- Deploy only those two functions. Run `npm run guard:all`. Then do a live test in the dialog with no real countersign.
