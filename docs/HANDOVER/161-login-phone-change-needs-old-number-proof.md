# 161. Login-phone change needs proof of the OLD number (2026-09-29)

**Status: written, NOT yet deployed.** Needs: migration `20260929190000`, deploy edge functions
`self-update-phone` and `issue-wallet-withdrawal-otp`, then the frontend. Deploy the edge functions
**before** publishing the frontend, and the migration last (it is what turns the direct write off).

## CEO concern

> "If this can change by just phone number SMS OTP, then withdraw verification has no help."

Screenshot: Settings → Profile → change phone → "Verify Phone Number via SMS".

## What was actually wrong (three things, verified against production 2026-09-29)

1. **`profiles.phone` was directly writable by the account owner.** RLS policy "Users can update own
   profile" + a column UPDATE grant to `authenticated` + triggers that only *normalise/dedupe* the number
   (`trg_normalize_validate_profile_phone`, `trg_prevent_duplicate_phone_update`). Any signed-in session
   could `supabase.from('profiles').update({ phone })` with **no OTP at all**. The `self-update-phone`
   edge function was advisory, not enforced. This is worse than what the screenshot shows.
2. **The edge function only proved the NEW number.** Anyone with a live session (leaked password,
   unlocked handset) could move the login to a SIM they control. This is the gap doc 16 recorded as
   "known remaining gap — not built".
3. **Doc 16 overstates what the withdrawal OTP does.** `issue-wallet-withdrawal-otp` sends the code to
   the **payout number the user typed** (`otpPhone = isUgandanPhone(payoutPhone) ? payoutPhone :
   accountPhone`); the account phone is only the fallback (bank transfers, non-Ugandan payout number).
   So the OTP proves the payout handset, and the real protection of the money is the destination gate
   (Ops verification + identity lock). Taking over the login phone still matters: it gives the attacker
   permanent OTP login to the account and controls the bank-transfer fallback and first-ever
   destination registration. Don't describe the withdrawal OTP as "goes to the account's own phone".

## What changed

| Piece | Change |
|---|---|
| `trg_block_self_service_phone_change` (migration `20260929190000`) | BEFORE UPDATE OF phone on `profiles`. Rejects (`42501`, `phone_change_requires_verification`) a change where `auth.uid() = NEW.id`, the old phone was set, and the last-9 digits differ. Allowed: service role (`auth.uid()` null — the edge function), staff/managing agents editing **other** users, first-ever phone, pure reformatting (`0783…` → `+256783…`). |
| `phone_change_otp_challenges` | Hashed code, bound to user + target number's last 9, 10 min TTL, 3 attempts, single use. RLS on, zero policies. |
| `self-update-phone` | New action `request_old_phone_code` (rate-limited 5/hour; texts the **current** number; invalidates earlier pending codes). Apply path now requires `old_phone_code` when the profile has a phone, in addition to the existing new-number OTP. Code is burned before any state change. After success, the old number is texted a notice. |
| `issue-wallet-withdrawal-otp` | 24h withdrawal hold after a `user_phone_self_update` audit row. Runs before Gate 2 so a held account registers no destination and sends no SMS. Error `phone_changed_recently` with `release_at`. |
| `Settings.tsx` | State + handlers for the old-number code; plain placeholder input (Gemini to restyle). Flow: verify new number → request code to current number → enter it → Save. |

## Known gaps — do not assume this is airtight

- **The 24h hold is only in `issue-wallet-withdrawal-otp`.** `submit_withdrawal_request` and cash
  pickup do not check it (cash pickup was already exempt from OTP). Putting it in the RPC needs the live
  function body verified first (migrations diverge from production).
- **Staff and managing agents can still change other users' `profiles.phone`** (COO partner edit pages,
  agent → managed tenant). That is deliberate for managed users with no login of their own, but it is
  the same takeover primitive if a staff account is abused. Not changed here.
- **`auth.users.phone` (the OTP-login phone) is not protected by the trigger** — it lives in the auth
  schema and only the edge function / admin API changes it. Users cannot change it directly through
  the client; if a direct path is found, it needs its own check.
- A user whose current number is not Ugandan, or who has lost the SIM, cannot self-serve. They must go
  through support. That is the intended trade-off.
- `MerchantRegister.tsx` and `InviteMerchantAgent.tsx` write `phone` on the user's own profile. They are
  fine when the number is unchanged or first-set; a *different* number over an existing one now fails.
  Watch for this after deploy.

## Verify

```sql
-- direct write is now refused for a signed-in owner (run as that user via PostgREST, not service role)
-- expect: 42501 phone_change_requires_verification
select tgname from pg_trigger where tgrelid='public.profiles'::regclass and tgname='trg_block_self_service_phone_change';

-- audit trail
select created_at, action_type, details from audit_logs
where action_type in ('user_phone_change_code_requested','user_phone_self_update')
order by created_at desc limit 20;
```

Related: [`16-wallet-withdrawal-otp-verification.md`](./16-wallet-withdrawal-otp-verification.md).
