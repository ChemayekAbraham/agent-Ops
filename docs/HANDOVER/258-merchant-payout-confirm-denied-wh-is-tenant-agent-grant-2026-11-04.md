# 258 - Merchant payout "Confirm Paid" failed: permission denied for function _wh_is_tenant_agent (2026-11-04)

**Status: APPLIED TO PRODUCTION 2026-11-04, grant verified. Payout flow itself not re-tested end to end (ask the agent to retry).**
Migration `20261104140000_grant_execute_wh_is_tenant_agent_to_authenticated.sql`; rollback `20261104140000_grant_execute_wh_is_tenant_agent_to_authenticated.rollback.sql` (same folder).

## Symptom
A merchant agent confirming a payout (Cheptoo Esther, bank transfer, UGX 1,425,000, 11-04) got "Confirmation rejected: permission denied for function _wh_is_tenant_agent" on Confirm Paid with the proof of payment. The claim stayed held, nothing was lost.

## Cause
`public._wh_is_tenant_agent(p_uid, p_tenant)` is a SECURITY DEFINER helper whose ACL was only `postgres` and `service_role` (default-closed function grants, see CLAUDE.md). Two RLS policies call it directly, and RLS policies run as the signed-in user:
- `public.wh_tenant_identity` -> `wh_tenant_identity_read`
- `storage.objects` -> `wh tenant id photo upload by agent`

Postgres evaluates every policy on `storage.objects` for any upload, so the payout proof upload hit the Welile Homes policy and failed. `wh_set_tenant_identity` also calls it, but it is SECURITY DEFINER and was never affected. The upload path is an inference from the symptom, not reproduced.

## Fix
`grant execute on function public._wh_is_tenant_agent(uuid, uuid) to authenticated;` Function body unchanged. It only checks that a `welile_homes_subscriptions` row links the caller to the tenant.

## Blast radius
Every signed-in user whose storage upload or `wh_tenant_identity` read evaluated those policies was affected, not only this agent. Other payouts waiting in the queue were likely blocked the same way.

## Rule for next time
A plain helper called from an RLS policy, view or column default must stay executable by `authenticated`. Before closing a function, check `pg_policies` (including `storage.objects`) as well as `pg_depend`. Quick check:
`select policyname from pg_policies where coalesce(qual,'')||coalesce(with_check,'') ilike '%<fn>%';`
