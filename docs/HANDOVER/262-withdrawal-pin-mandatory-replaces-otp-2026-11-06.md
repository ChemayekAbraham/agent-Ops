# 262. Withdrawal PIN becomes mandatory and replaces the withdrawal OTP (2026-11-06)

**Status:** BUILT on `dev/withdrawal-pin`, **not pushed, not applied, not browser-tested.** Frontend only. `enforce_mode` on production is still `pin_holders`.
**Origin:** Josh (CTO), 2026-11-06: "the user should set the withdrawal PIN before they withdraw, then we remove the OTP." He repeated this after the first-PIN risk below was put to him.
**Companion to:** docs 258 to 261.

## 1. What changed (web only, `src/components/payments/WithdrawFlow.tsx`)

* The 6-digit SMS code step is switched off by one constant, `WITHDRAWAL_OTP_REQUIRED = false`. `issue-wallet-withdrawal-otp` and `verify-wallet-withdrawal-otp` are untouched and nothing calls them while the flag is false. Setting it back to `true` restores the old step.
* Every payout method (mobile money, bank, cash) now submits through the same direct path cash already used (`processWithdrawal` -> `submit_withdrawal_request`). The database trigger from doc 258 spends the PIN proof in that insert.
* Step 4 (Verify) reads the PIN status fresh:
  * **No PIN:** an inline "Set your withdrawal PIN first" form (PIN twice, Save). After saving, the PIN field appears.
  * **Has a PIN:** the 4-digit PIN field. Confirm stays disabled until it is filled; the PIN is checked when Confirm is tapped.
  * **Status unreadable:** a red notice with "Try again". Confirm stays disabled (fail closed, because there is no OTP any more).
* The separate pop-up from doc 261 is no longer used in the withdraw flow (still used by the payout-number-change dialog).

## 2. Read this before pushing: what removing the OTP gives up

1. **The first-PIN hole.** The OTP existed (migration `20260914090000`) so that someone with only a stolen session could not register their own number as the payout destination on a first withdrawal. With the OTP gone, `set_withdrawal_pin` for a first PIN asks nothing: a session holder on an account that has no PIN can set one and withdraw at once to a number of their choice. The 48 h hold only covers payout-number changes, not a first destination. **Josh was offered "one-time phone code to set the first PIN" and chose to proceed without it.** It is a small build (one SMS code before `set_withdrawal_pin` succeeds for a first PIN) and is the recommended follow-up.
2. **The old OTP was never enforced in the database.** `submit_withdrawal_request` does not check it; only the edge function path did, so a person calling the RPC directly with a session token already bypassed it. The PIN trigger is the first database-enforced withdrawal control, but only for users who have a PIN while `enforce_mode = 'pin_holders'`.
3. **To bind everyone, `enforce_mode` must become `all`** (production configuration change, not done). Until then a user with no PIN who calls the RPC directly is not stopped.
4. **No email, no recovery.** 59% of accounts have a placeholder email. They can set a first PIN, but cannot change or reset it (`no_email`) until they add a real email. Support must handle those.
5. Payout-number change is still asked with the PIN only for PIN holders; an account with no PIN can still ask for a change with the new-number code alone.
6. Other self-service writers of `withdrawal_requests` (agent and merchant screens) were not inventoried; when `enforce_mode = 'all'` they will be refused for users without a PIN.

## 3. Rollout

1. Browser-test: no-PIN account (set PIN inline, withdraw), PIN account (wrong PIN, right PIN), cash, mobile money, bank.
2. Decide the first-PIN code (section 2.1) and the doc 260 email-change hold before announcing.
3. Push to `lovable` only with Josh's go-ahead and Lovable's agent idle; then message Lovable.
4. Only then consider `enforce_mode = 'all'`. Kill switch: `update public.withdrawal_pin_config set enforce_mode = 'off'` (does not restore the OTP; flip the constant for that).
