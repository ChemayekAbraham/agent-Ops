# Cash Deposit PDF Receipt

## Goal
Add a branded PDF receipt to the wallet-credit confirmation flow without changing deposit verification, wallet credits, ledger entries, or retry behavior.

## Implementation
- Generate a one-page Welile cash-deposit receipt server-side from the same authoritative values already used by the confirmation email: depositor name, deposited amount, Kampala date/time, reference number, masked deposit code, and resulting wallet balance.
- Keep the PDF in private storage and create a time-limited signed download link.
- Add a prominent “Download PDF receipt” button to the existing confirmation email.
- Preserve the current queue, idempotency key, automatic retries, SMS confirmation, and non-blocking behavior after wallet credit.
- If PDF generation or storage fails, still send the wallet-credit confirmation email without the receipt link and record the failure for operations.

## Technical details
- Reuse the existing server-side `pdf-lib` pattern and private file-storage pattern.
- Extend only the cash-deposit confirmation payload/template and the post-credit email call site.
- App emails do not support direct file attachments in this flow, so the secure signed link is the supported equivalent.

## Validation
- Add focused tests for receipt rendering and filename/reference handling.
- Run edge-function tests and all project guards.
- Render the generated PDF to an image, inspect it for clipping/overlap/font issues, fix any defects, then re-check.
- Deploy the changed email and cash-deposit functions and verify recent function logs.
