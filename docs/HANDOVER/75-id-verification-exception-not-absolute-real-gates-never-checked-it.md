# 75 — CTO ID-verification exception was never wired into the gates that actually move money

**Migration written 2026-09-18, needs manual apply via Lovable Cloud → SQL editor (`CREATE OR
REPLACE FUNCTION` is blocked from `mcp__lovable__query_database` by the auto-mode classifier, same
as docs 63/66/71/72/74). Read this before touching `submit_withdrawal_request`,
`enforce_withdrawal_destination_verified`, or `id_verification_exceptions` again — and before
telling anyone a CTO exception makes them able to withdraw.**

## What was reported

Josh, after granting exceptions to NABBAALE CLAIRE, bwayo mark, and ATUHAIRE CAROLYNE via the CTO
KYC & ID-Verification Overrides panel and expecting the grant to actually work: "give this place
the absolute power to exempt anyone."

## What was found

Doc 72 wired `id_verification_exceptions` into `payout_withdrawal_block_reasons` — but that
function is **advisory only**. It feeds the Withdraw screen's "why can't I withdraw" message; it
does not decide whether a withdrawal actually goes through. Two separate, real gates never learned
about the exceptions table at all:

1. **`submit_withdrawal_request()`** — the RPC that actually inserts a `withdrawal_requests` row.
   It requires `ensure_payout_destination()`'s returned status to be `'verified'`, or a matching
   `user_identity_bindings.locked_payout_number`. Neither path knows about
   `id_verification_exceptions`.
2. **`enforce_withdrawal_destination_verified()`** — the `BEFORE INSERT` trigger on
   `withdrawal_requests`, the true DB-level backstop for *any* insert path, not just this RPC. It
   already exempts `user_is_pure_partner` (checked before it even looks at destination status) but
   was never given the exception check either.

Checked live: bwayo mark (`fe1e9f51-a2c3-49fc-bd40-b2c143afe628`, doc 72's account) has an active
exception, and `payout_withdrawal_block_reasons` correctly says `blocked: false`. But her one
`payout_destination_verifications` row is still `status = 'waiting'` (never touched by Financial
Ops) and she has no `user_identity_bindings` row. Reading `submit_withdrawal_request`'s live logic
directly: an actual withdrawal attempt from her would still be rejected with `destination_unverified`
— "This number is not yet verified." Doc 72 fixed what the screen *says*; it never fixed what
actually happens when she taps Withdraw.

## What was fixed

`supabase/migrations/20260918170000_id_verification_exception_bypasses_actual_withdrawal_gates.sql`
— `CREATE OR REPLACE FUNCTION` on both real gates, identical bodies otherwise:

- `submit_withdrawal_request`: adds `v_id_exempt boolean` (an active-exception check, computed
  once near the top) and short-circuits both the `destination_rejected` and `destination_unverified`
  returns with `AND NOT v_id_exempt`. `ensure_payout_destination()` is still called as before — the
  destination row still gets recorded for the audit trail — it just no longer gates an exempted
  user.
- `enforce_withdrawal_destination_verified`: adds an `id_verification_exceptions` early `RETURN NEW`
  immediately after the existing `user_is_pure_partner` early return, same precedence, before the
  hard National-ID gate.

Not yet applied — same classifier block as every prior migration to these functions today.

## Verify after applying

```sql
-- Simulated: after applying, bwayo mark should be able to actually submit, not just see "verified".
-- (Can't call submit_withdrawal_request directly here -- it reads auth.uid() -- but confirm the
-- exception is still active and her destination is still unverified, so this is a real test of
-- the new bypass, not a no-op:)
select * from public.id_verification_exceptions where user_id = 'fe1e9f51-a2c3-49fc-bd40-b2c143afe628' and revoked_at is null;
select status from public.payout_destination_verifications where user_id = 'fe1e9f51-a2c3-49fc-bd40-b2c143afe628';
-- Have her (or Josh, impersonating/testing on her behalf) actually attempt a withdrawal and confirm
-- it no longer returns destination_unverified/destination_rejected.
```

## What not to do

- Don't treat `payout_withdrawal_block_reasons` returning `blocked: false` as proof a withdrawal
  will succeed — it's a UI hint, not enforcement. Doc 74 already found one way it can be wrong in
  the *lenient* direction (checking the wrong partner function); this is a second, different way
  (an exemption source it didn't share with the real gates at all).
- Don't assume granting a CTO exception via `cto_grant_id_verification_exception` is enough by
  itself going forward — if a *third* gate turns up (a new withdrawal path, a new edge function)
  that checks destination/identity status without also checking `id_verification_exceptions`, it
  will silently reject an exempted user again. Grep every caller of
  `payout_destination_verifications.status` and `user_identity_bindings` before trusting a new
  surface honors this.
- Don't remove the `ensure_payout_destination()` call from `submit_withdrawal_request` even for
  exempt users — it still needs to run so the destination row exists and is upserted correctly for
  reporting/audit; only the *gating* on its result changed.
