# 258. Withdrawal PIN: design and implementation for lead-engineer review (2026-11-04)

**Status:** WRITTEN FOR REVIEW. On branch `dev/withdrawal-pin` (cut from `origin/lovable` at `48fe9af9eb`). Not pushed, not applied to production, **not run anywhere** (no local database was available; see "What has and has not been tested").
**Files:** `supabase/migrations/20261104090000_withdrawal_pin.sql` (+ `.rollback.sql`), `supabase/tests/withdrawal_pin_manual_tests.sql`. No edge function and no frontend change yet.
**Origin:** Josh : every user has a secret PIN used to withdraw; it must not be tied to the phone number but to the Welile ID, so a person who gets into an account cannot withdraw.

## 1. The problem, as verified in the code

Whoever holds a logged-in session can today move money out. The existing controls prove things about the **destination**, not about the **person**:

1. `request_payout_number_change` (live RPC) proves the caller controls the **new** number (`otp_verifications` row for that number, last 24 h), then queues a request for Financial Ops. It never asks who the caller is. `payout_destination_auto_verdict` (doc 136) can then verify the destination automatically for accounts with partner activity.
2. `issue-wallet-withdrawal-otp` sends the withdrawal code to the **payout number the caller typed** (`otpPhone = isUgandanPhone(payoutPhone) ? payoutPhone : accountPhone`), so an attacker who has entered their own number receives the code on their own handset. The comment on that function says the code "proves whoever is submitting still controls the account's original channel"; the code does the opposite for mobile-money payouts.
3. Everything stops at an SMS, which is the factor an account-takeover attacker (SIM swap, shared or stolen phone) already holds.

A PIN is a factor that is not on the phone and is not delivered by SMS.

## 2. "Welile ID", not phone

The Welile ID is derived, not stored: `'WEL-' || upper(first 6 hex of profiles.id)` (doc 190). Six hex characters are neither unique nor secret, so the PIN is keyed on the **full `profiles.id` / `auth.users.id`**, which is exactly what the Welile ID is a display form of. The PIN therefore survives phone changes and is independent of any number. One row per user.

## 3. Design

```
verify_withdrawal_pin(pin, purpose) --ok--> withdrawal_pin_proofs (one use, 300 s)
                                                      |
BEFORE INSERT trigger on withdrawal_requests  --------+--> consume proof or refuse
BEFORE INSERT trigger on payout_number_change_requests --+
```

* **Storage:** `user_withdrawal_pins.pin_hash` = bcrypt (`pgcrypto crypt(..., gen_salt('bf', 10))`). The PIN is never stored, logged, or returned. RLS on, **no policies, no browser grants**: every access goes through SECURITY DEFINER functions. `service_role` has table access for support.
* **Format:** exactly 6 digits; refuses all-same (`000000`) and straight runs (`123456`, `654321`, ...). A 6-digit space is 1,000,000; the defence is the lockout plus bcrypt cost, not secrecy of the format.
* **Attempt limiting (the lesson from docs 251/256):** `withdrawal_pin_check` counts the guess **first** in a single atomic `UPDATE ... RETURNING`, then compares. 5 wrong tries lock for 30 minutes; while locked the `UPDATE` matches no row, so even the **correct** PIN is refused. Parallel guesses queue on the row lock, so 30 at once still get 5 tries. Counter resets only on a correct PIN.
* **Proofs:** a successful `verify_withdrawal_pin` inserts a proof for one `purpose` (`withdrawal`, `payout_number_change`, `pin_change`) that expires in 300 s. The trigger spends it with `FOR UPDATE SKIP LOCKED`, so two parallel inserts cannot share one proof. If the insert later fails, the proof is un-spent (same transaction).
* **Gate (triggers), not edits to the big RPCs:** `submit_withdrawal_request` is a 12 KB live function that is not faithfully in the repo (CLAUDE.md gotcha). Wrapping it would mean copying production's text into a migration. A `BEFORE INSERT` trigger needs no such copy and also covers any other self-service path that inserts into these tables.
  * Gated only when `auth.uid() = NEW.user_id`. Service role, staff proxy withdrawals, auto-routes and system inserts are untouched.
  * `withdrawal_requests`: only `payout_method in ('mobile_money','bank_transfer')`, the same scope as the withdrawal OTP (cash pickups exempt there; same here).
* **Modes** (`withdrawal_pin_config.enforce_mode`): `off` (kill switch), `pin_holders` (default: only users who set a PIN are gated, so deploying changes nothing until someone sets one), `all` (everyone must have one).
* **First PIN on an existing account:** an attacker with a session could set the PIN first. Mitigation built in: after a first set or a reset, **payout-number-change proofs are refused for 48 h** (`number_change_hold_until`). Withdrawals to the already-verified destination are not held. Notification of the owner is NOT built (see section 6).
* **Forgotten PIN (default chosen: cooling-off, option C):** `request_withdrawal_pin_reset` starts a 48 h wait. While a reset is pending, `withdrawal` and `payout_number_change` proofs are refused. The real owner can cancel with the PIN (a `pin_change` proof); staff (`financial_ops`, `cfo`, `super_admin`, `manager`, AAL2) can cancel any. `complete_withdrawal_pin_reset` works only after the wait, sets the new PIN and restarts the 48 h number-change hold. Josh has not chosen the reset method yet (staff approval / ID plus face / wait); the wait is the one that needs no new infrastructure. Changing it later swaps one function.
* **Audit:** `audit_logs` rows for set, change, lock, reset requested/cancelled/completed. Never the PIN.
* **Grants (closed by default, doc 247):** browser-callable: `verify_withdrawal_pin`, `set_withdrawal_pin`, `request_withdrawal_pin_reset`, `cancel_withdrawal_pin_reset`, `complete_withdrawal_pin_reset`, `my_withdrawal_pin_status` to `authenticated` + `service_role`. Internal helpers (`withdrawal_pin_check`, `consume_withdrawal_pin_proof`, `require_withdrawal_pin_proof`, `withdrawal_pin_format_ok`) to `service_role` only. `anon` nothing.

## 4. Error codes the UI must map

Trigger exceptions (SQLSTATE `28000`): `withdrawal_pin_required` (mode `all`, no PIN set), `withdrawal_pin_proof_required` (PIN set, no valid proof). RPC `code` values: `wrong_pin` (+`attempts_left`), `pin_locked` (+`locked_until`), `no_pin`, `weak_pin`, `current_pin_required`, `pin_exists`, `pin_recently_set` (+`release_at`), `pin_reset_pending` (+`release_at`), `already_pending`, `not_ready`, `not_pending`, `forbidden`, `invalid_purpose`, `unauthorized`.

## 5. Decisions for the lead engineer

1. **Reset method** (section 3): keep the 48 h wait, or replace with staff approval / national-ID + face. Business call (Josh).
2. **PIN transport:** the PIN is an RPC argument over TLS. Supabase does not log RPC arguments by default; confirm `log_statement` is not enabled on this project. Alternative is an edge function that hashes before the database; more moving parts.
3. **Proof binding:** a proof is not bound to amount or destination. Binding it to a hash of the request payload would stop a proof being spent on a different request within its 5 minutes. Worth it? Cost: both endpoints must hash identically.
4. **Cash pickups** are exempt (as in the withdrawal OTP). Agree?
5. **Default `enforce_mode`:** `pin_holders` is safe to ship but protects nobody until they opt in. The plan to reach `all` (section 7) needs a date.
6. **Number-change hold of 48 h** and the **5 tries / 30 min** lock are config values, not constants. Defaults reasonable?
7. **Other writers of the payout destination** (`profiles.mobile_money_number` when not yet locked, `user_identity_bindings.locked_payout_number`, `ensure_payout_destination`) are NOT gated. The withdrawal trigger is the backstop: money cannot leave without the PIN whatever the destination says. The number-change trigger is a second layer, not the primary control.

## 6. Not built yet (blocks enabling in production)

* **Frontend:** PIN set screen, PIN entry in `WithdrawFlow.tsx` (call `verify_withdrawal_pin('withdrawal')` immediately before `verify-wallet-withdrawal-otp`, because the proof lives 5 min and the OTP step can take up to 10) and in `PayoutNumberChangeDialog.tsx`, forgot-PIN screen. Must handle every code in section 4.
* **Owner notification** (SMS to the account phone) on first PIN set, PIN reset requested, and PIN lockout. Required before the reset flow is safe: without it the cooling-off period warns nobody. Needs an edge function (service role) reading the `audit_logs` rows or called from the RPC path; not done.
* **Callers inventory:** any other self-service path that inserts into `withdrawal_requests` with a user session (agent commission, merchant, landlord flows) would fail for PIN holders until it sends a proof. Search all `.from('withdrawal_requests').insert` and `submit_withdrawal_request` callers before leaving `pin_holders`.
* **Staff UI** to see locked users / pending resets / cancel a reset.

## 7. Rollout

1. Apply migration (`pin_holders`: no behaviour change). Verify triggers, grants (`has_table_privilege`, `has_function_privilege`) on production, not just the file (CLAUDE.md: migrations diverge).
2. Ship frontend + notifications. Internal staff accounts set PINs first and exercise every path.
3. Announce; offer PIN setup in the wallet. Watch `audit_logs` for `WITHDRAWAL_PIN_LOCKED` rates.
4. Move to `all` on an agreed date. Users without a PIN are routed to set one (and are subject to the 48 h number-change hold).
5. Kill switch at any time: `update public.withdrawal_pin_config set enforce_mode = 'off'`.

## 8. Related findings, NOT fixed here (should be separate changes)

* `issue-wallet-withdrawal-otp` sends the code to the typed payout number (section 1, point 2) and uses `Math.random()` for the code.
* `verify-wallet-withdrawal-otp` updates `attempts` by read-then-write (`ch.attempts + 1`), the same race fixed for `otp-login` in doc 251; 30 parallel guesses can each see the same count.
* Both are good candidates for the same atomic-counter treatment once this PIN lands; the PIN removes most of the damage either way.

## 9. What has and has not been tested

* **Not run:** nothing in the migration has executed. No local Docker/Supabase was available, and DDL was deliberately not run against production (`CREATE TRIGGER` on `withdrawal_requests` takes a lock on a live money table).
* **Checked against production (read-only):** `pgcrypto 1.3` in schema `extensions`; none of the four new table names exist; `withdrawal_requests` has many existing BEFORE INSERT triggers (ours is additive); `payout_number_change_requests` has none; `has_role` and `require_staff_aal2` are used by the live `finops_decide_payout_number_change`; the live `audit_logs` insert shape `(user_id, action_type, table_name, record_id, reason, new_values)` is the one `request_payout_number_change` uses.
* **Next:** run `supabase/tests/withdrawal_pin_manual_tests.sql` on a Supabase preview branch (steps 1 to 11, each has its expected result); add a 30-parallel-guess test for the lock; add the trigger inserts (step 8 is commented because the NOT NULL columns of `withdrawal_requests` differ by instance).
* **Unverified assumptions:** `profiles.id = auth.users.id` for every user; `auth.uid()` survives inside the SECURITY DEFINER `submit_withdrawal_request` (the existing OTP flow relies on the same); trigger firing order with the other 20+ `withdrawal_requests` triggers does not matter because ours only reads config and writes proofs.

## 10. Rollback

`20261104090000_withdrawal_pin.rollback.sql` drops triggers, functions, then tables. Faster and non-destructive: `update public.withdrawal_pin_config set enforce_mode = 'off'` stops all enforcement and keeps the data.
