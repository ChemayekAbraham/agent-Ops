# 247 — CFO may post her own Daily lunch allowance (self-route allowlist)

**Date:** 2026-10-20 · **Status:** migration written, NOT applied (Josh applies by hand)

## Symptom
Sarah Angwen (CFO) tried CFO Direct Credit for her own Daily lunch allowance (UGX 3,000, standing order every day). The tool failed with `WALLET_CORRECTION_SELF_BLOCKED: you cannot record a wallet correction for your own account`.

## Cause
Not the edge function, and not the screen. `cfo-direct-credit` has no self-check for the designated approver. The trigger `guard_platform_wallet_correction` on `platform_wallet_corrections` refuses any correction where `created_by = target_user_id` unless `wallet_self_route_allowed(created_by)` is true. That reads `wallet_self_route_allowed__impl`, a hard-coded list of four people: Joshua Wanda, Nankambo sharimah, Bayo Mercy, Mercy Bayo. Josh's own 3,000 allowance (20 Oct 07:32 UTC, `PAY-MVGD8UXE-PYJ5`) went through because he is on that list.

## Change
`supabase/migrations/20261020100000_allow_sarah_angwen_self_routed_lunch_allowance.sql` adds SARAH ANGWEN (`29a0cfa8-1eaf-453c-874c-0fc72fa4f74b`) to the list. The migration aborts if the live function no longer holds exactly the four expected ids, or if she is already on it.

Unchanged: the trigger, the CFO / Financial Ops / super_admin role gate, the 20-character evidence floor, and the `self_authored_operator` metadata marker on self-authored rows.

## Decision and risk
Option 1 was chosen over a narrower rule. The allowlist has no amount or category limit, so this lets her post any self-credit through this guard, not only the lunch allowance. The narrower alternative (credit only, 3,000 or less) was offered and not chosen. The marker `metadata->>'self_authored_operator'` on `platform_wallet_corrections` is the way to list her self-credits for review.

Separately, she switched on "Automate this payout (daily)", which creates a standing order paying her every day with no further sign-off.

## Verify after applying
```sql
SELECT public.wallet_self_route_allowed__impl('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b'); -- true
SELECT public.wallet_self_route_allowed__impl('98ee118b-06d1-47a4-aa2b-76bd12170b70'); -- false
SELECT created_at, amount, metadata
FROM platform_wallet_corrections
WHERE created_by = target_user_id AND metadata->>'self_authored_operator' = 'true'
ORDER BY created_at DESC;
```
Then ask her to retry the 3,000 credit.

## Notes
- Neither `wallet_self_route_allowed__impl` nor `guard_platform_wallet_correction` is in `critical_function_baselines` (checked 2026-10-20), so no re-baseline is needed.
- Rollback: re-run the `CREATE OR REPLACE` without the SARAH ANGWEN line.
