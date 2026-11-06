# 261. Withdrawal PIN: web frontend (2026-11-05)

**Status:** BUILT, committed on `dev/withdrawal-pin`, **not run in a browser, not type-checked, not pushed.** `npm run guard:all` passed. Closes open item 1 of doc 259 section 8.
**Companion to:** docs 258 (design), 259 (what was built and tested), 260 (email-change hold, not applied).

## 1. What was added

| File | Purpose |
|---|---|
| `src/hooks/useWithdrawalPin.ts` | RPC and edge-function calls (`my_withdrawal_pin_status`, `verify_withdrawal_pin`, `set_withdrawal_pin`, `cancel_withdrawal_pin_reset`, edge actions `begin`/`send_code`/`complete`/`change_send_code`/`change_complete`) and `pinErrorMessage`, one message per code. Passes `getDeviceFingerprint()` when it has the valid shape. Never stores or logs a PIN or code. |
| `src/components/wallet/WithdrawalPinPrompt.tsx` | 4-digit PIN dialog and `useWithdrawalPinPrompt()` -> `askPin(purpose)`. Asks the database fresh whether a PIN is required; for an account without one it resolves true and shows nothing. |
| `src/components/settings/WithdrawalPinSection.tsx` | Settings > Safety card: set PIN; change (current PIN, then emailed code + new PIN); forgot (emailed code + new PIN); cancel a pending reset (proved with the PIN). Shows lock and payout-number-hold times. |

Edited (small diffs): `WithdrawFlow.tsx` (PIN asked right before the submit, every payout method including cash; friendly message if the database answers `withdrawal_pin_proof_required`), `useWalletWithdrawalOtp.ts` (maps the same error from `verify-wallet-withdrawal-otp`, which returns it as a 400), `PayoutNumberChangeDialog.tsx` (PIN asked before `request_payout_number_change`), `Settings.tsx` (mounts the card under the app-lock PIN card).

## 2. Behaviour to know

* **Accounts without a PIN see no change** while `enforce_mode = 'pin_holders'`.
* **Mode `all` and no PIN:** `askPin` shows "set a PIN in Settings" and blocks. This is the case that made the web a blocker for `all`; it now has a screen.
* **Status unreadable:** `askPin` lets the flow continue; the database trigger is the real gate and its error is mapped.
* **No automatic retry** after an expired proof: the person taps confirm again and is asked again (the OTP step can take 10 minutes, the proof lives 5, but the PIN is asked after the OTP is typed, immediately before submit).
* The new code `email_recently_changed` (doc 260) is already mapped.
* Copy uses no "loan", "lender", "ROI" or "interest".

## 3. Not done / not verified

* **No browser test, no screenshots.** Needs the test-plan rows 7 and 8 of doc 259 on the web build.
* **No type-check** (full `tsc` runs out of memory locally; files were only syntax-checked). Run the project's normal build before merging.
* RPCs are called through `(supabase as any).rpc(...)` because the generated types do not know them (same pattern as `useAuth`). Regenerate types later.
* Other self-service writers of `withdrawal_requests` (agent and merchant screens) were not inventoried (doc 258 decision 7). Any that insert for their own user will get the trigger's error if that user holds a PIN. Staff proxy inserts are exempt.
* Merge target not named; nothing pushed.

## 4. Rollout order

1. Merge the branch (merge commit) after the target is named and the Lovable agent is idle (CLAUDE.md).
2. Test on web: set, withdraw (mobile money, cash), change, forgot, cancel, number change.
3. Only then consider `enforce_mode = 'all'`, and not before doc 260 is applied and the Android message for `email_recently_changed` exists.
