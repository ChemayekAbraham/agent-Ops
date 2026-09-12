# Cash-deposit email resend and expiry

## Build
- Add the exact code-expiry date and time in East Africa Time to the cash-deposit code email.
- Include the verification expiry context in the wallet-credit confirmation while clearly stating the used code no longer works.
- Add a “Resend code” email link that opens an account-authenticated page and issues a fresh 10-minute code only for the signed-in deposit owner.
- Reuse the existing resend function, delivery channels, audit trail, attempt reset, and deposit-state safeguards.

## Security
- Require a valid signed-in session and exact ownership match before account self-resend.
- Do not place reusable secrets, plaintext codes, or editable recipient addresses in the link.
- Keep Financial Operations resend permissions and all wallet/ledger logic unchanged.

## Verification
- Test owner, wrong-account, expired, and already-verified behavior.
- Run focused tests, project guards, build checks, then deploy the changed email and resend functions.
