# 72 — CTO-granted ID-verification exception missing from `payout_withdrawal_block_reasons`

**Written 2026-09-18, migration NOT yet applied to production (blocked by the auto-mode
classifier — needs Josh to run it by hand, same as docs 63/66/71). Read this before touching
`payout_withdrawal_block_reasons` again, or if a CTO-exempted user still can't withdraw.**

## What was reported

Josh: "Mark is exempted but she cannot make the withdrawal" — referring to bwayo mark, who has an
active CTO-granted ID-verification exception (`CTOKycLevelPanel.tsx`, "Verified for withdrawal:
Yes", granted 2026-09-18 11:08 UTC, reason "VCERIFIED HR 101").

## What was found

Same shape as doc 40 (pure-partner exemption missing from this same function) — there are multiple
independent places that gate a withdrawal on identity verification, and they don't all agree on
who's exempt.

Checked against live data (`fe1e9f51-a2c3-49fc-bd40-b2c143afe628`):

- `id_verification_exceptions` has one active row for her (`revoked_at IS NULL`).
- `public.withdrawal_user_id_verified(...)` → `true`. Correct — this is the merchant-claim gate
  (RLS policies, `claim_withdrawal_verified`, `auto_dispatch_withdrawals`), and it already `OR`s in
  an active exception per the 20260914240000 migration.
- `public.payout_withdrawal_block_reasons(...)` → `{"blocked": true, "code":
  "identity_not_submitted", "reasons": ["Enter your National ID number...", "Take a photo of the
  front of your National ID.", "Take a selfie with your whole face visible."]}`. **Wrong** — this
  is the RPC that feeds `WithdrawFlow.tsx`'s `identityBlock` state and disables the Withdraw
  button. She has no `national_id`/photos on file (never needed them — that's the entire point of
  the exception), so this function's identity-binding branch always fires for her.

The function only ever checked `user_is_pure_partner(v_uid)` as a short-circuit (added in doc 40 /
`20260916170000`). It never checked `id_verification_exceptions` at all — the table didn't exist
yet when this function was first written, and doc 40's fix only added the one exemption source it
was investigating at the time. Doc 40 explicitly flagged this risk: "there could be a fourth place
... with the same kind of unconditional check." This is that place, for a second, independent
exemption source.

## What was fixed

`supabase/migrations/20260918150000_exempt_id_verification_exception_from_withdrawal_block_reasons.sql`
— `CREATE OR REPLACE FUNCTION`, identical body, adds one more short-circuit immediately after the
existing `user_is_pure_partner` check:

```sql
IF EXISTS (
  SELECT 1 FROM public.id_verification_exceptions e
  WHERE e.user_id = v_uid AND e.revoked_at IS NULL
) THEN
  RETURN jsonb_build_object('blocked', false, 'code', 'ok',
    'status', 'verified', 'reasons', to_jsonb(ARRAY[]::text[]));
END IF;
```

Placed before the rejected-destination and identity-binding checks — same precedence as the
pure-partner short-circuit and the choke-point comment on `withdrawal_user_id_verified` itself: an
exception means skip ID verification entirely, not skip one leg of it.

**Not yet applied** — `mcp__lovable__query_database` refused the `CREATE OR REPLACE FUNCTION` with
`Permission denied by auto mode classifier: [Production Deploy]`. Needs manual apply via Lovable
Cloud → SQL editor (paste the `CREATE OR REPLACE FUNCTION ... COMMENT ON FUNCTION` body from the
migration file and run it), same path used for docs 63/66/71.

## Verify after applying

```sql
select public.payout_withdrawal_block_reasons('fe1e9f51-a2c3-49fc-bd40-b2c143afe628'::uuid);
-- expect: {"blocked": false, "code": "ok", "status": "verified", "reasons": []}
```

## What not to do

- Don't assume `withdrawal_user_id_verified` returning `true` means the whole withdrawal path is
  unblocked — it only gates the merchant-claim surface. `payout_withdrawal_block_reasons` is a
  separate, independently-maintained copy of "is this person ID-exempt" logic and can drift from
  it, as it just did.
- Don't fold `id_verification_exceptions` and `user_is_pure_partner` into one combined check "for
  cleanliness" without auditing every other caller of each — they're independent exemption
  sources for independent reasons (CTO manual override vs. structural partner-not-agent status)
  and doc 40 already chose not to unify similarly-named partner functions for the same reason.
- If a third "is this person exempt" gate turns up blocked for a known-exempt user, check this
  function's sibling gates (`ensure_payout_destination`, `enforce_withdrawal_destination_verified`)
  for the same missing check before assuming it's a new bug class.
