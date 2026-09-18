# 84 — Merchant agent couldn't finalize an exempted user's payout: a fourth gate missing the exception

**Fixed live, verified 2026-09-18** — `mcp__lovable__query_database` applied this one directly
(unlike every other DB fix today, the classifier did not block it). Read this before touching
`withdrawal_destination_gate` or `approve-withdrawal`'s destination check again — and check the
full list in doc 80/this doc before assuming a gate is covered.

## What was reported

Josh, screenshot of a merchant agent's confirmation screen for bwayo mark's withdrawal: "for mark
the merchant agent has failed to finalize the payout." The agent had already sent UGX 120,000 MoMo
to `0749080906` (MARK BWAYO), the SMS-extracted TID/amount matched, and confirmation was still
rejected: "This payout destination is not verified. Open Financial Ops → Verify Payout Numbers..."

## What was found

A **fourth** independent copy of the withdrawal identity/destination gate — the other three fixed
today are `submit_withdrawal_request`, `enforce_withdrawal_destination_verified` (doc 75), and
`issue-wallet-withdrawal-otp` (doc 80). This one is `withdrawal_destination_gate(p_withdrawal_id)`,
called from `approve-withdrawal` (the merchant agent's payout-finalization edge function, line ~649
of `supabase/functions/approve-withdrawal/index.ts` — the function's own comment already calls it
"Third copy of the destination gate," undercounting by one since it didn't know about doc 80's
edge-function copy either).

Its exemption ladder — landlord payout, legacy pre-cutoff snapshot, proxy-initiated, pure-partner,
then verified-destination / identity-binding — never checked `id_verification_exceptions`. bwayo
mark has an active exception but no verified destination and no identity binding (the entire point
of the exception), so the ladder fell through to `{ ok: false, reason: 'unverified' }`, and
`approve-withdrawal` returned the generic "not verified" message even though every other gate today
(72/74/75/76/77/80) is already fixed for her specifically.

## What was fixed

`supabase/migrations/20260918190000_withdrawal_destination_gate_id_exception.sql` — `CREATE OR
REPLACE FUNCTION`, identical body, adds one more short-circuit immediately after the existing
`user_is_pure_partner` check, before the destination-verified computation — same precedence as
every other gate patched today:

```sql
IF EXISTS (
  SELECT 1 FROM public.id_verification_exceptions e
  WHERE e.user_id = w.user_id AND e.revoked_at IS NULL
) THEN
  RETURN jsonb_build_object('ok', true, 'reason', 'id_verification_exception');
END IF;
```

## Verified live

```sql
select w.id, w.status, w.mobile_money_number, public.withdrawal_destination_gate(w.id) as gate
from public.withdrawal_requests w
where w.user_id = 'fe1e9f51-a2c3-49fc-bd40-b2c143afe628'
order by w.created_at desc limit 1;
-- f1a47e71-0f7e-4812-8fb3-223b586218c2 (the exact pending request from the screenshot, UGX 120,000
-- to 0749080906, created 2026-09-18 13:59:04): {"ok": true, "reason": "id_verification_exception"}
```

Have the merchant agent re-open the same withdrawal and re-submit the confirmation (paste the same
SMS again) — it should finalize instead of rejecting.

## Full list of gates now covered by `id_verification_exceptions` (as of this doc)

1. `payout_withdrawal_block_reasons` — advisory, feeds the Withdraw screen's message (docs 72, 74).
2. `submit_withdrawal_request` — the RPC that inserts `withdrawal_requests` (doc 75).
3. `enforce_withdrawal_destination_verified` — the `BEFORE INSERT` trigger (doc 75).
4. `WithdrawFlow.tsx`'s own client-side field checks (doc 76).
5. `CTOKycLevelPanel.tsx`'s Grant-button visibility (doc 77).
6. `issue-wallet-withdrawal-otp` — the SMS-code edge function (doc 80, deploy status unconfirmed).
7. `withdrawal_destination_gate` — the merchant agent's `approve-withdrawal` finalization gate
   (this doc).

`withdrawal_user_id_verified` (the merchant-*claim* gate, distinct from finalization) already had
it from the start (`20260914240000`).

## What not to do

- Don't assume this is the last one. Every gate on this list was found by testing an actual
  exempted account through a real end-to-end flow (Withdraw screen → OTP → merchant claim →
  merchant finalize), not by code review alone. If a fifth surface turns up rejecting an exempted
  user, grep for `payout_destination_verifications`/`user_identity_bindings`/`user_is_pure_partner`
  reads across `supabase/functions/` before assuming it's a new bug class — it's almost certainly
  another copy of this same gate.
