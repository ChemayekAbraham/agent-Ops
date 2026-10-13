# Read-only check: migrations and edge functions (no changes made)

No code or database changes were made. Only SELECT queries and file listings.

## Migrations

| Migration | Result | How checked |
|---|---|---|
| 20261008140000 route_tid158315386626_to_micheal_float | Applied | Ledger has agent_float_deposit PAY-TID158315386626, UGX 10,000, Micheal, 12:42 UTC 8 Oct. One platform_wallet_corrections evidence row and one email_credit_idempotency row mention the TID. Float then used for rent at 13:43 (10,000), so tid-backed balance and float are now 0, as expected. |
| 20261008160000 merchant_claim_requires_verified_payout_number | Applied | Both public.withdrawal_payout_number_check and public.claim_withdrawal_verified exist. The claim function body contains payout_number_not_verified. |
| 20261009100000 repoint_tid44081020985_robert_mugisha_misattach | Applied, one loose end | Deposit 4fa90cec is approved and belongs to tenant 86eb32d3. Rent Plan ef5e2e18 shows amount_repaid 41,000, status repaying. No float-deposit legs remain on the wrong profile in that window. Loose end: the settlement attempt row ceabfda0 still shows tenant_id dc676bca (the wrong profile) and paid_from_phone +256779166640. Money and the plan are right; this is only a stale label on the audit row. |

Note: supabase_migrations.schema_migrations holds no rows after 2026-09-11 (and none for these three). This database does not record applies there, so I checked the objects and records each migration creates.

## Edge functions

- approve-wallet-operation, cfo-direct-credit, requisition-decide all exist in the repo.
- Last repo change: cfo-direct-credit, commit dbb5cec058, 8 Oct 20:54 EAT. I deployed cfo-direct-credit earlier this session.
- Not confirmed: I have no tool that reads the live deployed version, so I cannot confirm approve-wallet-operation or requisition-decide are deployed with the latest pushes. Redeploying is a change, so I did not do it.

## Nothing shows as not applied. Stopped; waiting for your decision.
