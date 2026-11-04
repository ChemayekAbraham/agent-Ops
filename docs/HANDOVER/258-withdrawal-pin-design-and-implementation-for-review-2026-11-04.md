# 258. Withdrawal PIN: design and implementation for lead-engineer review (2026-11-04, v2)

**Status:** WRITTEN FOR REVIEW. On branch `dev/withdrawal-pin` (cut from `origin/lovable` at `48fe9af9eb`). Not pushed, not applied to production, **not run anywhere** (no local database was available; see section 9).
**Files:** `supabase/migrations/20261104090000_withdrawal_pin.sql` (+ `.rollback.sql`), `supabase/functions/withdrawal-pin-reset/index.ts`, `supabase/tests/withdrawal_pin_manual_tests.sql`. No frontend change yet.
**Origin:** Josh (CTO), 2026-11-04: every user has a secret PIN used to withdraw; it must be tied to the Welile ID, not the phone number, so a person who gets into an account cannot withdraw.
**v2 changes** (lead engineer's review, same day): (1) cash pickups are gated too; (2) forgotten PIN is reset by a 2FA code instead of a bare wait; (3) the PIN proof records whether the device is one the owner trusts.

## 1. The problem, as verified in the code

Whoever holds a logged-in session can today move money out. The existing controls prove things about the **destination**, not about the **person**:

1. `request_payout_number_change` (live RPC) proves the caller controls the **new** number (`otp_verifications` row for that number, last 24 h), then queues a request for Financial Ops. It never asks who the caller is. `payout_destination_auto_verdict` (doc 136) can verify a destination automatically for accounts with partner activity.
2. `issue-wallet-withdrawal-otp` sends the withdrawal code to the **payout number the caller typed** (`otpPhone = isUgandanPhone(payoutPhone) ? payoutPhone : accountPhone`), so an attacker who enters their own number receives the code on their own handset. The comment on that function says the code proves control of "the account's original channel"; for mobile-money payouts the code does the opposite.
3. Everything stops at an SMS, which is the factor an account-takeover attacker (SIM swap, shared or stolen phone) already holds.

The lead engineer's question, "do they enter the PIN rather than depend on the OTP?": yes. The PIN replaces the withdrawal OTP as the proof of *who is asking*. The OTP keeps one job, proving a **new** number is live (already in `request_payout_number_change`). Do not remove the withdrawal OTP until `enforce_mode = 'all'` is live, or users without a PIN lose their only gate.

## 2. "Welile ID", not phone

The Welile ID is derived, not stored: `'WEL-' || upper(first 6 hex of profiles.id)` (doc 190). Six hex characters are neither unique nor secret, so the PIN is keyed on the **full `profiles.id` / `auth.users.id`**, which the Welile ID is a display form of. The PIN survives phone changes and depends on no number. One row per user.

## 3. Design

```
verify_withdrawal_pin(pin, purpose, device_fp) --ok--> withdrawal_pin_proofs (one use, 300 s, records device)
                                                              |
BEFORE INSERT trigger on withdrawal_requests  ----------------+--> consume proof or refuse (all payout methods)
BEFORE INSERT trigger on payout_number_change_requests -------+--> consume proof, copy device evidence onto the row
```

* **Storage:** `user_withdrawal_pins.pin_hash` = bcrypt (`pgcrypto`). The PIN is never stored, logged or returned. RLS on, **no policies, no browser grants**; all access through SECURITY DEFINER functions.
* **Format:** exactly 6 digits; refuses all-same and straight runs. 1,000,000 combinations: the defence is the lockout plus bcrypt, not the format.
* **Attempt limiting (lesson of docs 251/256):** `withdrawal_pin_check` counts the guess **first** in one atomic `UPDATE ... RETURNING`, then compares. 5 wrong tries lock for 30 minutes; while locked even the **correct** PIN is refused. Parallel guesses queue on the row lock. Same rule for the reset codes (`pin_challenge_check`, 5 tries per code).
* **Proofs:** a successful verify inserts a proof for one `purpose` (`withdrawal`, `payout_number_change`, `pin_change`), 300 s, spent with `FOR UPDATE SKIP LOCKED`. If the insert later fails the proof is un-spent (same transaction).
* **Gate = triggers, not edits to the big RPCs:** `submit_withdrawal_request` is a 12 KB live function not faithfully in the repo (CLAUDE.md gotcha). A `BEFORE INSERT` trigger needs no copy of production text and covers every self-service path. Gated only when `auth.uid() = NEW.user_id`; service role, staff proxy, auto-routes and system inserts are untouched.
* **Cash pickups are gated** (v2, lead engineer): the trigger no longer filters on `payout_method`.
* **Modes** (`withdrawal_pin_config.enforce_mode`): `off` (kill switch), `pin_holders` (default: only users with a PIN are gated; deploying changes nothing until someone sets one), `all`.
* **First PIN on an existing account:** an attacker with a session could set the PIN first. Built-in mitigation: after a first set (or a phone-only reset) **payout-number-change proofs are refused for 48 h**. Withdrawals to the already-verified destination are not held.

### 3.1 Forgotten PIN: 2FA (v2)

Driven by the edge function `withdrawal-pin-reset` (service role) because sending email/SMS and judging "is this a real inbox" live outside the database. **59% of accounts (about 58,000 of 98,000) carry a placeholder address** (`@welile.agent`, `@welile.user`, `@noapp.welile.user`), so the email factor cannot be assumed. The edge function uses the existing `isUnusableEmail` guard (`recipientMailbox.ts`: placeholder, mistyped and disposable domains) and passes `p_email_usable` into the database; the database never guesses.

| Account has | Needed to reset | Wait |
|---|---|---|
| a usable email | code emailed **and** code to the login number (or the payout number if the login number is lost) | none |
| no usable email | code to the login number (or payout number) only | 48 h cooling-off, then a 48 h payout-number hold |

* `begin`: records the reset, SMS notice to the login number ("a reset was requested; cancel it in Settings or contact support"). Max 3 resets per 24 h.
* `send_code`: a 6-digit code, 10 minutes, **3 per hour per channel**, only its sha256 (`"<user id>:<channel>:<code>"`) stored. Email reuses the existing `two-factor-code` template; SMS uses `sendSMS` with delivery confirmation.
* `complete`: checks the code(s) (each counted before comparing, 5 tries per code; a channel already verified stays verified) and sets the new PIN, atomically with marking the reset done.
* While a reset is pending, `withdrawal` and `payout_number_change` proofs are refused. The owner can cancel with the PIN (a `pin_change` proof) or staff can (`financial_ops`, `cfo`, `super_admin`, `manager`, AAL2).
* Changing the PIN **while knowing it** still needs only the current PIN (a factor the attacker lacks). The lead engineer wrote that a change should also be 2FA: decision 3 below.

### 3.2 Device (v2)

`verify_withdrawal_pin(..., p_device_fp)` checks the caller's fingerprint against `login_devices` (`status = 'trusted'`, the table behind the 2026-10-20 new-device alerts) and stores `device_fp` and `device_trusted` on the proof. For `payout_number_change` the trigger copies them (plus `pin_verified = true`) onto `payout_number_change_requests`. Financial Ops therefore sees, per request: PIN proven, and whether it came from a trusted device.

**What is NOT built:** the lead engineer's "same device that registered the number may change it directly, else it goes to admin". Today every number change already goes to the Financial Ops queue (`finops_decide_payout_number_change`); a direct self-service change needs surgery inside the locked-number write paths (`profiles`, `user_identity_bindings`, `payout_destination_verifications`) that I will not do blind. The data above is what a fast-track rule needs. Two caveats to tell the reviewer:
* "Trusted" means a device the owner trusted (first device trusted silently, later ones after "I know this device"), not "the device that registered the withdrawal number". Recording the registering device needs a new column written where the number is locked.
* The fingerprint is supplied by the app and can be copied by someone who has it. It stops casual takeover, not a targeted one. The PIN plus the codes are the real protection; the device is a third layer.

## 4. Error codes the UI must map

Trigger exceptions (SQLSTATE `28000`): `withdrawal_pin_required` (mode `all`, no PIN), `withdrawal_pin_proof_required` (PIN set, no valid proof). RPC / edge `code`: `wrong_pin` (+`attempts_left`), `pin_locked` (+`locked_until`), `no_pin`, `weak_pin`, `current_pin_required`, `pin_exists`, `pin_recently_set`, `pin_reset_pending`, `already_pending`, `rate_limited`, `no_pending_reset`, `not_ready` (+`release_at`), `wrong_code` (+`channel`, `attempts_left`), `code_expired_or_used_up`, `channel_not_required`, `no_email`, `no_phone`, `send_failed`, `not_pending`, `forbidden`, `invalid_purpose`, `unauthorized`.

## 5. Decisions for the lead engineer

1. **Reset factors:** email + phone when a real email exists, phone + 48 h otherwise (section 3.1). Right trade for the 59% without a real email?
2. **Email trust:** an attacker with a session could change the account email to their own, then use the email code. The code uses the email on file at reset time. Safe version: ignore an email changed in the last N days. Needs the date the email last changed; not available from `auth.users` reliably. Worth a column?
3. **Changing the PIN with the current PIN:** keep (PIN only) or also require a code (his note)? Costs a code per change.
4. **Fast-track for number changes** (section 3.2): who implements the direct change, and does "registered device" need its own column?
5. **PIN transport:** the PIN is an RPC argument over TLS (and passes through the edge function on reset). Confirm `log_statement` is off on this project.
6. **Proof binding:** a proof is not bound to amount or destination (5 minutes, single use). Bind to a hash of the request?
7. **Callers inventory:** gating cash and every payout method means any self-service insert into `withdrawal_requests` fails for PIN holders without a proof. Enumerate them before `pin_holders` goes wide.
8. **Other writers of the payout destination** (`profiles.mobile_money_number` while unlocked, `user_identity_bindings.locked_payout_number`, `ensure_payout_destination`) are not gated. The withdrawal trigger is the backstop (no PIN, no money out); the number-change trigger is a second layer.
9. **Config:** 5 tries / 30 min, 300 s proof, 48 h holds, 10 min codes, 3 codes/hour are config values. Defaults OK?

## 6. Not built yet (blocks enabling in production)

* **Frontend:** PIN set screen, PIN entry in `WithdrawFlow.tsx` (call `verify_withdrawal_pin('withdrawal', device_fp)` immediately before `verify-wallet-withdrawal-otp`, the proof lives 5 min and the OTP step up to 10) and in `PayoutNumberChangeDialog.tsx`, forgot-PIN screens (begin, send codes, complete), cancel-reset. Must map every code in section 4. Pass the device fingerprint the app already computes for `register_login_device`.
* **Notifications:** the reset notice by SMS is built. Missing: a notice when a PIN is first set, and when it locks.
* **Staff UI:** see locked users and pending resets; cancel a reset.
* **Edge function deploy:** `withdrawal-pin-reset` is new; needs deploying and a `config.toml` decision (it does its own `getUser`).

## 7. Rollout

1. Apply migration (`pin_holders`: no behaviour change). Verify triggers and grants on production (`has_function_privilege`, `has_table_privilege`), not just the file (CLAUDE.md: migrations diverge). Deploy `withdrawal-pin-reset` (Lovable, per the sync workflow).
2. Ship frontend. Staff accounts set PINs first and exercise every path, including a reset on both email paths and the no-email path.
3. Announce; offer PIN setup in the wallet. Watch `audit_logs` for `WITHDRAWAL_PIN_LOCKED` and `WITHDRAWAL_PIN_RESET_*`.
4. Move to `all` on an agreed date.
5. Kill switch: `update public.withdrawal_pin_config set enforce_mode = 'off'`.

## 8. Related findings, NOT fixed here

* `issue-wallet-withdrawal-otp` sends the code to the typed payout number and uses `Math.random()` for the code.
* `verify-wallet-withdrawal-otp` updates `attempts` by read-then-write (`ch.attempts + 1`), the race fixed for `otp-login` in doc 251.
* Both should get the atomic-counter treatment once the PIN lands.

## 9. What has and has not been tested

* **Not run:** nothing in the migration or the edge function has executed. No local Docker/Supabase was available, and DDL was deliberately not run against production (`CREATE TRIGGER` on `withdrawal_requests` takes a lock on a live money table).
* **Checked:** the edge function transpiles with 0 syntax diagnostics (TypeScript `transpileModule`; not type-checked, not run under Deno). `npm run guard:all` passed on the v1 commit; re-run before commit.
* **Checked against production (read-only):** `pgcrypto 1.3` in schema `extensions`; none of the new table names exist; `withdrawal_requests` already has 20+ BEFORE INSERT triggers (ours is additive); `payout_number_change_requests` has none; `login_devices` has `device_fp` and `status`; `has_role` / `require_staff_aal2` are used by the live `finops_decide_payout_number_change`; the `audit_logs` insert shape is the one `request_payout_number_change` uses; 58,000+ of 98,248 users have a placeholder email domain.
* **Next:** run `supabase/tests/withdrawal_pin_manual_tests.sql` on a Supabase preview branch (steps 1 to 12, each with its expected result); add a 30-parallel-guess test for the PIN lock and the code lock; run the trigger inserts (commented in step 7 because `withdrawal_requests` NOT NULL columns differ).
* **Unverified assumptions:** `profiles.id = auth.users.id`; `auth.uid()` survives inside the SECURITY DEFINER `submit_withdrawal_request` (the existing OTP flow relies on the same); `sendSMS`'s log context accepts the fields used (copied from `issue-wallet-withdrawal-otp`); the `two-factor-code` email template renders acceptably for "Withdrawal PIN reset" (it was written for sign-in codes).

## 10. Rollback

`20261104090000_withdrawal_pin.rollback.sql` drops triggers, functions, tables and the three added `payout_number_change_requests` columns; delete the edge function too. Faster and non-destructive: `update public.withdrawal_pin_config set enforce_mode = 'off'` stops all enforcement and keeps the data.
