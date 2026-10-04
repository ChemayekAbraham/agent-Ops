# 16. Feature — Wallet withdrawal OTP verification (2026-09-14)

**Status: live in production, verified end-to-end.**

---

## The gap this closes

`submit_withdrawal_request` let anyone with an open session on an account type in **any**
mobile-money number/name or bank account and submit it as the payout destination. The only
existing guard, `trg_enforce_withdrawal_payout_account_lock` (see
[`12-withdrawal-payout-account-lock.md`](./12-withdrawal-payout-account-lock.md)), only blocks
**changing** an already-registered number — it does nothing on a first-ever destination for an
account. Financial Ops' own manual call-based verification (`finops_decide_payout_destination`)
only proves the typed-in number is live and answered, not that whoever answered is the account's
real owner.

Realistic attack: someone gains mere session/credential access to a victim's account (leaked
password, shared device, left-open session — nothing sophisticated) on an account that has never
withdrawn before. They type in their own real MTN/Airtel number, Financial Ops calls it, they
answer their own phone and confirm it's "theirs," and it gets marked verified — locking in the
attacker's number as the account's permanent payout destination.

---

## The fix — two gates, in a specific order

1. **Gate 2 (destination verification) runs first.** `issue-wallet-withdrawal-otp` calls
   `ensure_payout_destination` *before* generating or sending anything. This is a **one-time**
   state per destination — once Financial Ops verifies a number/account it stays verified for
   every future withdrawal to it. If the destination isn't verified yet, the request is rejected
   immediately with no SMS sent (and no verification code wasted) — the call also doubles as
   first-time registration, so a brand-new destination still enters the Ops queue right here even
   though this OTP path never reaches `submit_withdrawal_request` until a code is verified.
2. **Gate 1 (account-phone OTP) runs only after Gate 2 passes**, and is required on **every
   single withdrawal**, regardless of destination history. A 6-digit code goes to the account's
   own registered `profiles.phone` (the signup/login channel) — **never** the payout number just
   entered. Whoever completes the withdrawal must currently control that original phone,
   independent of whether they merely have an open session.

Ordering these correctly matters: the original build had OTP first, destination check second
(inside `submit_withdrawal_request`) — meaning a user could complete a whole OTP round-trip only
to be rejected afterwards on a destination that could never have passed anyway. Reordered so the
one-time check happens before the always-required one.

Cash pickup is exempt from both — no destination-redirection surface (physical code collected in
person).

---

## What was built

| Piece | What it does |
|---|---|
| `wallet_withdrawal_otp_challenges` / `wallet_withdrawal_otp_events` | Challenge + audit tables. RLS enabled, **zero** client-facing policies — the client never queries these directly, only through the two edge functions below (service_role, bypasses RLS). |
| `issue-wallet-withdrawal-otp` | Checks `ensure_payout_destination` first (Gate 2); if verified, generates/hashes a 6-digit code, sends it to `profiles.phone` via the shared multi-provider SMS sender, returns only a **masked** phone (`+••• ••• 456`) — never the OTP hash or full number. |
| `verify-wallet-withdrawal-otp` | Checks the code, then calls `submit_withdrawal_request` **as the same user** (forwarded JWT) so every one of that RPC's own checks — balance, format, destination status again — still runs in full. OTP success alone never bypasses them. |
| `useWalletWithdrawalOtp` hook + `WithdrawFlow.tsx` | The existing "Verify" step now auto-issues a code for `mobile_money`/`bank_transfer`, shows the destination phone read-only and masked, and blocks Confirm until a valid 6-digit code is entered. An unverified/rejected destination shows a blocking notice with **no OTP UI at all** — nothing to verify yet. |

---

## Known remaining gap — do not assume this is airtight

`profiles.phone` itself can be changed via Settings **without re-verifying the old number
first** — `trg_normalize_validate_profile_phone` / `trg_prevent_duplicate_phone_update` only
normalise format and dedupe, they do not require proving control of the phone being replaced.

This closes the realistic case (stolen session/credentials on an account whose real registered
phone the attacker does **not** also control). It does **not** close a compound attack: attacker
also changes the account's registered phone first, *then* proceeds. Closing that needs the same
OTP-the-old-number treatment applied to profile phone changes — not built, this is a follow-up
decision for whoever owns Settings/profile edit flows.

---

## Verify this is still working

```sql
-- Gate 2 still runs inside submit_withdrawal_request (defense in depth, unchanged):
select pg_get_functiondef('public.submit_withdrawal_request(numeric,text,text,text,text,text,text,text,uuid,text)'::regprocedure)
       ilike '%ensure_payout_destination%'; -- expect true

-- OTP tables exist and have zero client-facing policies:
select count(*) from pg_policy where polrelid = 'public.wallet_withdrawal_otp_challenges'::regclass; -- expect 0
```

Live-behaviour check: start a mobile-money withdrawal on an account with **no** prior verified
destination. Expect: reaching the Verify step shows a blocking "destination not verified" notice,
no code sent, no OTP fields rendered. On an account with an **already-verified** destination:
reaching Verify auto-sends a code to the account's own phone (check `sms_delivery_log` for
`source = 'wallet_withdrawal_otp'`), the field showing where it went is masked and read-only, and
Confirm stays disabled until 6 digits are entered.
