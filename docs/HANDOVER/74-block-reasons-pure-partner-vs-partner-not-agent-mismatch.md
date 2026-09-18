# 74 — `payout_withdrawal_block_reasons` told Lukodda Joseph he was verified; `submit_withdrawal_request` still rejected him

**Migration written 2026-09-18, needs manual apply via Lovable Cloud → SQL editor (`CREATE OR
REPLACE FUNCTION` is blocked from `mcp__lovable__query_database` by the auto-mode classifier, same
as docs 63/66/71/72). Read this before touching `payout_withdrawal_block_reasons`,
`ensure_payout_destination`, `is_partner_not_agent`, or `user_is_pure_partner` again.**

## What was reported

Josh: "LUKODDA JOSEPH is also denied to withdrawal yet he has an ID on file."

## What was found

Same family of bug as doc 40, but the inverse direction. There are (at least) five accounts named
some variant of "Lukodda" — narrowed to `b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c`, the one with actual
withdrawal history (14 completed withdrawals, most recently 2026-09-11, amounts from 60k to 2.8M,
paid to a different mobile money number almost every time).

Checked against live data:

- `public.payout_withdrawal_block_reasons('b4d7c324-...')` → `{"blocked": false, "code": "ok",
  "status": "verified"}`. The Withdraw screen told him he was completely clear.
- `public.submit_withdrawal_request(...)` (traced by reading the live function) would actually
  reject him with `destination_unverified`: "This number is not yet verified. Financial Ops will
  call you to confirm it belongs to you." — because none of his 32 `payout_destination_verifications`
  rows has ever reached `status = 'verified'`, and he has no `user_identity_bindings` row.

Root cause: `payout_withdrawal_block_reasons`'s exemption short-circuit (added in doc 40 /
`20260916170000`) checks `user_is_pure_partner(v_uid)` → **true** for him. But the function that
actually decides whether his destination gets auto-verified, `ensure_payout_destination()` (called
from `submit_withdrawal_request()`), checks a **different** function, `is_partner_not_agent(v_uid)`
→ **false** for him. Doc 40 already documented that these two functions are deliberately not
identical — `is_partner_not_agent` additionally excludes anyone appearing in
`rent_requests.agent_id`/`assigned_agent_id`/`proxy_agent_id`, `user_is_pure_partner` only excludes
`agent_collections` — and explicitly chose not to unify them. Lukodda Joseph is exactly the
population that shape allows to fall through: partner-like by the loose definition, but with some
proxy/assigned-agent footprint by the strict one, so `is_partner_not_agent` correctly refuses to
auto-verify his destination while `user_is_pure_partner` wrongly told the advisory function he
needed nothing further.

Confirmed the divergence is real and specific to him, not a general mismatch — the four accounts
doc 40 originally fixed (Simon Kavuma, Elvis Opio, okee samuel, MARVIN SSEMBATYA) return `true` for
**both** functions, and a second "Lukodda Joseph" account (`0c0b9843-...`, a different person, same
name, different national ID) also returns `true` for both and is unaffected by this bug.

His profile does have `national_id` on file (`CM76031102LC8J`, matching Josh's "he has an ID on
file") but no `national_id_photo_path`/`selfie_photo_path` and no `mobile_money_number` — so even
under the corrected check he still can't withdraw yet, but the reason is now accurate and
actionable instead of a false "you're verified."

## What was fixed

`supabase/migrations/20260918160000_block_reasons_use_partner_not_agent_not_pure_partner.sql` —
`CREATE OR REPLACE FUNCTION`, identical body, one-line change: the pure-partner short-circuit now
checks `public.is_partner_not_agent(v_uid)` instead of `public.user_is_pure_partner(v_uid)`, so this
advisory function agrees with `ensure_payout_destination`/`submit_withdrawal_request` — the
functions that actually move money — instead of a looser, unrelated definition. The
`id_verification_exceptions` check added in doc 72 is untouched and still fires independently (Mark
is neither `pure_partner` nor `partner_not_agent`, so this change doesn't affect her at all — she
still passes purely on her CTO exception).

Not yet applied to production — same classifier block as doc 72.

## Verify after applying

```sql
select public.payout_withdrawal_block_reasons('b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c'::uuid);
-- expect: {"blocked": true, "code": "identity_not_submitted", "reasons": [
--   "Take a photo of the front of your National ID.",
--   "Take a selfie with your whole face visible.",
--   "Add the mobile money number that will receive your money and confirm it with the code we send."]}

-- must NOT regress these (both flags true, should stay blocked:false):
select public.payout_withdrawal_block_reasons(id) from public.profiles
where id in ('2cab68aa-108a-4d50-8168-a4eef15f097c', -- Simon Kavuma
             '7be2365f-2a83-4e5b-8abd-81e966074c58', -- Elvis Opio
             'ccf2d91b-de93-4970-bf4b-c09cd97edb34', -- okee samuel
             '733f7a98-f077-4cdd-9211-4ea458a3ef43', -- MARVIN SSEMBATYA
             '0c0b9843-b5e8-4960-9785-d8cd0cbcde23'); -- the OTHER Lukodda Joseph

-- must still stay blocked:false (id_verification_exceptions path, unaffected by this change):
select public.payout_withdrawal_block_reasons('fe1e9f51-a2c3-49fc-bd40-b2c143afe628'::uuid); -- bwayo mark
```

## What to tell Lukodda Joseph

He needs to finish Settings → Withdrawal & Identity: take a front ID photo and a selfie, and add/
confirm the mobile money number that should receive his money — none of that was ever actually on
file for him despite having a National ID number recorded. Once Financial Ops verifies whichever
number he confirms (or he clears the OTP-confirm + identity-binding path), the block clears for
real, unlike before.

## What not to do

- Don't assume `payout_withdrawal_block_reasons` returning `blocked: false` means
  `submit_withdrawal_request` will succeed for the same user — verify against the money-moving
  function's own logic (`ensure_payout_destination`) when in doubt, the same caution as doc 40's
  closing note but now cutting the other way.
- Don't unify `is_partner_not_agent` and `user_is_pure_partner` into one function "for
  consistency" without auditing every caller of each (doc 40 already declined to do this once) —
  this fix only changes which one `payout_withdrawal_block_reasons` uses, it does not touch either
  underlying function or the trigger (`enforce_withdrawal_destination_verified`) that still uses
  `user_is_pure_partner` on its own, separate call path.
- If a third gate turns up disagreeing with `ensure_payout_destination` for a "partner" user, check
  which of these two functions it's calling before assuming it's a new bug class.
