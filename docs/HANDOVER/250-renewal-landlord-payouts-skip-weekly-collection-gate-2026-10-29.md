# 250 — Landlord payouts for renewal Rent Plans are no longer held by the weekly collection gate (2026-10-29)

**Migration written, not applied (Josh applies by hand):**
`supabase/migrations/20261029170000_renewal_landlord_payouts_skip_weekly_gate.sql`
(rollback: the same name ending `.rollback.sql`). Read this before touching `enforce_landlord_float_performance_gate`,
`set_landlord_payout_block_exemption_unchecked` or `landlord_payout_is_renewal`.

## What was asked

Josh, 2026-10-29: let Ian Muhwezi's landlord payouts through at the CFO "because they are for renewals". Ian was at 37.9% for
22-28 Oct (38.6% on current plans against the 50% needed), so the weekly gate refused his payouts and the CFO could not release them.

## What the database showed

- **Nothing of Ian's was waiting at the CFO.** His last 10 landlord payouts, up to 2026-10-22, were all completed, and the CFO had
  exempted each one individually (`landlord_block_exempt_at`). Nine of the ten were renewals.
- **Only 1 of the 7 float items he holds is a renewal** (Adong Margret, UGX 4,000,000). The other six (UGX 1,550,000) are
  `normal` registrations funded in May.
- **The gate has two places that refuse a below-target agent**, and both had to change:
  `enforce_landlord_float_performance_gate` (BEFORE INSERT on `withdrawal_requests`) and the rejection loop in
  `set_landlord_payout_block_exemption_unchecked` (the CFO "allow through the queue block" action).
- **The only existing override is agent-wide and needs an approver code.** `allow_agent_landlord_float_withdrawal` writes
  `landlord_float_withdrawal_exceptions` (one row per agent per week, covers every payout that agent makes, not only renewals) and
  consumes an emailed one-time code via `use_verified_exception_approval`. A migration that inserted that row directly would have
  skipped the approver's code, so it was not written that way. Josh chose a rule change instead.

## The fix

A withdrawal whose landlord payout is for a **renewal** passes the weekly gate in both places. Nothing else about the gate changes.

"Renewal" is defined by `landlord_payout_is_renewal(landlord_payout_id)`, which is true only when:

1. the payout's rent request has `registration_type = 'renewal'`, **and**
2. the same tenant has an earlier rent request (created before it) whose status is `repaying`, `completed` or `funded`.

The second test exists because `registration_type` is set by whoever submits the plan and no trigger guards it. Trusting the label alone
would let any agent skip the gate by labelling a plan a renewal. Measured 2026-10-29: all 400 renewal plans, and all 292 payouts on them,
meet both tests, so the stricter definition costs no real renewal.

Every skip for an agent who was under target writes an `audit_logs` row, `action_type = 'landlord_gate_renewal_skip'`, with the
withdrawal, payout, amount, rate and basis. The helper is closed by default (`service_role` only); the two functions that call it are
`SECURITY DEFINER`.

## Checked before writing this (read-only, and one rolled-back test)

- Neither changed function is in `critical_function_baselines`: no re-baseline.
- The migration's `set_landlord_payout_block_exemption_unchecked` differs from production's body by exactly one added line.
- Tested on production inside a transaction that always rolls back: the helper returned true for a renewal payout (Namere Babra,
  4,000,000), false for a normal payout, false for NULL; 292 of 292 renewal payouts returned true. Afterwards production still had no helper
  and neither function carried the change.
- **Not tested end to end:** inserting a `withdrawal_requests` row through the trigger and running the CFO action with a renewal were not
  run, because they write real rows. Do this after applying (below).

## After applying, verify

```sql
-- 1. The helper and both changes are live.
select (select count(*) from pg_proc where proname = 'landlord_payout_is_renewal') helper,
       (select pg_get_functiondef(oid) like '%landlord_payout_is_renewal%' from pg_proc
         where proname = 'enforce_landlord_float_performance_gate') gate,
       (select pg_get_functiondef(oid) like '%landlord_payout_is_renewal%' from pg_proc
         where proname = 'set_landlord_payout_block_exemption_unchecked') cfo_action;

-- 2. Next days: who got through under target, and how much.
select created_at, user_id, record_id, metadata->>'amount' amount, metadata->>'rate_pct' rate_pct
  from audit_logs where action_type = 'landlord_gate_renewal_skip' order by created_at desc;
```

## Applied state, 2026-10-29 (read this before re-applying)

- **Live:** `landlord_payout_is_renewal` and `enforce_landlord_float_performance_gate` (the withdrawal-insert gate), applied by hand.
- **NOT live: `set_landlord_payout_block_exemption_unchecked`.** It, and `set_landlord_payout_block_exemption`, are in `protected_functions`
  (baselined 2026-10-29 12:44 UTC). `zz_protected_functions_guard` is a DDL event trigger that **restores the baselined body of a protected
  function** whenever it is redefined, unless `welile.fn_unlock` is set to the secret whose sha256 matches `protected_function_settings.unlock_hash`.
  A plain `apply_migration` reported success (recorded as `20261029140611 renewal_payouts_cfo_exemption_skip`) and the guard silently
  reverted the function. The hand-applied first attempt hit the same guard. So `schema_migrations` says applied; the function is unchanged.
- **Effect today:** a renewal withdrawal can now be inserted (the gate lets it through), but the CFO's "allow through the queue block" action still
  rejects an agent under target, notifies them "Landlord payout not released", and writes `landlord_payout_block_rejected`.
- **To finish:** the holder of the unlock token runs the third function with `set_config('welile.fn_unlock', '<token>', true)` in the same
  transaction. The guard then logs `allowed_with_unlock` and re-baselines the new body. A ready script (token left as a placeholder) is at
  `scratchpad/apply_cfo_exemption_renewal_skip_WITH_UNLOCK.sql`. The token was not requested or looked for.
- Verify afterwards: `select pg_get_functiondef('public.set_landlord_payout_block_exemption_unchecked(uuid[],boolean)'::regprocedure) like '%landlord_payout_is_renewal%';` must be true.

## What this does not do

- **The agent app can still show a lock banner.** `get_landlord_float_gate`, `landlord_float_lock_message` and
  `get_landlord_payout_agent_rates` judge the agent, not one payout, so a locked agent can still see "locked" while a renewal payout goes
  through. That is a display matter for Gemini; the database refusal is what changed.
- **Normal and outstanding-balance plans are refused exactly as before.** Ian's six May plans (UGX 1.55M) are not renewals and stay held.
- **It applies to every agent, not just Ian.** 134 renewal plans were registered in the last 30 days.
- **The six-eyes and COO checks are untouched.** Doc 250 does not change how float is approved (see the approval trail on Ian's float:
  the COO step checks the budget, not collection rate).

## What not to do

- Don't loosen the definition to the label alone (`registration_type = 'renewal'`). The earlier-plan test is what stops an agent labelling a
  plan a renewal to skip the target.
- Don't insert into `landlord_float_withdrawal_exceptions` from a migration to let one agent through. It skips the approver's code.
