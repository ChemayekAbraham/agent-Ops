# 263. Withdrawal PIN: a first PIN needs a one-time phone code (2026-11-06)

**Status (2026-11-06):** LIVE. Migration applied to `byrzshwlentqvktcksem` and pushed to `lovable` (`bba5f6cde4`); Lovable synced and deployed `withdrawal-pin-reset`. SQL tested in a rolled-back transaction (25 checks). **The real first-PIN SMS flow was tested end to end by Josh (CTO) on 2026-11-06 and passed** (reported by Josh; I did not see the run). The live function has `verify_jwt: false` (no `config.toml` entry); it authenticates callers itself (401 with no or a fake token, probed).
**Closes:** the "first-PIN hole" recorded in doc 262 section 2.1. Asked for by Josh (CTO), 2026-11-06 ("add 1, then push").
**Companion to:** docs 258 to 262.

## 1. Why

Doc 262 retired the per-withdrawal SMS code. That code (migration `20260914090000`) existed so that someone with only a stolen session could not register their own number as the payout destination on a first withdrawal. With it gone, a first PIN that asked for nothing would have reopened the same hole: set a PIN, withdraw at once. The proof now happens once, when the first PIN is set; after that every withdrawal needs only the PIN.

## 2. What was built

| Piece | Behaviour |
|---|---|
| Table `withdrawal_pin_setup_codes` | Service role only; only a sha256 of the code is stored; RLS on, no browser grants. |
| `pin_setup_issue(user, hash, masked)` | Refuses if a PIN exists; 3 codes per hour; 10 minutes; issuing a new code kills any older unused one. Service role only. |
| `pin_setup_complete(user, hash, new_pin)` | Format check first (no try is spent on a weak PIN), then the guess is **counted before it is compared** in one UPDATE (5 tries per code), then the code is spent and the PIN created in the same call, with the audit row `WITHDRAWAL_PIN_SET` (`proof: phone_code`) and the 48 h payout-number hold. Service role only. |
| `set_withdrawal_pin` | No longer creates a first PIN: answers `phone_code_required` (no PIN) or `email_code_required` (has a PIN). |
| Edge function `withdrawal-pin-reset` | New actions `setup_send_code` (SMS to the REGISTERED phone `profiles.phone`, text "Welile PIN code: ...", code redacted in `sms_delivery_log` by the existing redactor) and `setup_complete`. `no_phone` if the profile phone is not a usable Ugandan number. |
| Web | `FirstPinSetup.tsx` (PIN twice -> "Text me a code" -> code -> Save) used in the withdraw dialog (Verify step) and in Settings. `useWithdrawalPin.ts`: `setupPin`, new messages. |

Files: `supabase/migrations/20261106090000_withdrawal_pin_first_set_phone_code.sql` (+ `.rollback.sql`), `supabase/functions/withdrawal-pin-reset/index.ts`, `src/components/wallet/FirstPinSetup.tsx`, edits to `WithdrawFlow.tsx`, `WithdrawalPinSection.tsx`, `useWithdrawalPin.ts`.

## 3. Tested (live project, one rolled-back transaction, two fake users)

Right code sets the PIN (bcrypt, hold set, one audit row); weak PIN refused without spending the code; wrong code counts down 4, 3, 2, 1, 0; **the correct code is refused after 5 wrong tries**; an older code is dead once a newer one is issued; a spent code cannot be reused; no code when a PIN exists; 4th code in an hour is `rate_limited`; the app role gets `phone_code_required` / `email_code_required` from `set_withdrawal_pin`; `authenticated` and `anon` cannot execute the two new functions or read the table. Afterwards the live project had no table, no test users, `enforce_mode = pin_holders`, one PIN holder.

## 4. Not tested / known gaps

* **Not run:** the edge function actions (never deployed or called), the SMS delivery, the screens in a browser. No parallel (30 connection) lock test; the count-first UPDATE is the same pattern as docs 251 and 256.
* **Android:** its "set PIN" calls `set_withdrawal_pin` directly and will now fail with `phone_code_required` until it is updated to the two new edge actions. Existing Android PIN holders are unaffected.
* **Accounts with no usable phone** (`no_phone`) cannot set a first PIN and therefore cannot withdraw on the web; support must fix the profile phone first.
* The registered phone itself can be changed by a session holder (known gap in `20260914090000`); this proof is only as strong as that.
* `enforce_mode` is still `pin_holders`; a no-PIN user calling `submit_withdrawal_request` directly is not stopped until it is `all`.

## 5. Rollback

`20261106090000_withdrawal_pin_first_set_phone_code.rollback.sql` (then re-create `set_withdrawal_pin` from `20261104150100`). Doing so reopens the first-PIN hole: put the OTP back at the same time (`WITHDRAWAL_OTP_REQUIRED = true` in `WithdrawFlow.tsx`).
