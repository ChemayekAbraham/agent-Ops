# Principal accounting destination — STAGED, NOT APPLIED

Private-copy tested 2026-09-29. File: `principal_accounting_destination.sql` (replaces `_post_four_part_fee_split`).

Change (additive, inside the existing split transaction, same source/source_id/journal date/idempotency key):
- Dr A22 `landlord_pool_return_company_managed` (cash_in) = Principal, cents kept
- Cr A5 `landlord_pool_return_source` (cash_out) = Principal
- Self-support plan (`rent_requests.self_funding_partner_id` or `self_funding_line_id` set) -> A21 `landlord_pool_return_self_support`
- No A2, wallet, L4 or landlord-allocation leg
- Skipped when the plan has a `landlord_pool_movements` deploy row, because `trg_zz_landlord_pool_return` posts Principal on that path (prevents double A22)
- Split group now posts when fees = 0 but Principal > 0

## Blocker found (live, pre-existing)
Live check `instalment_allocations.access_split_reconciles` requires
Returns + Commission + Platform Fee = access_fee_component. The installed split puts part of the
fees in registration_fee_component, so every four-part insert with a registration fee fails.
Live collections catch it as `fee_posting_failed`; the repayment still goes through but no split posts.
Must be decided and fixed before this change (or the release) can work. Not changed here.
