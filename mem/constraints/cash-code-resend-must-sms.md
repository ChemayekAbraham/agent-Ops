---
name: Cash deposit code resend must send SMS
description: Resending a cash deposit code must go through finops-cash-deposit-resend edge fn; the fin_ops_reissue_cash_code RPC only rotates the code and delivers nothing
type: constraint
---
The FinOps "Resend code" button in `CashDepositCodesPanel` MUST call the
`finops-cash-deposit-resend` edge function. It rotates `cash_deposit_verifications`
(code_hash/code_plain/attempts/expires_at) AND sends the SMS via
`sendSmsMultiProvider`, logs a `code_reissued` audit event, and returns 502
`sms_not_delivered` when the provider rejects delivery.

**Why:** the old path called the `fin_ops_reissue_cash_code` DB RPC, which has no
SMS capability — a new code was generated silently while the UI still toasted
"New code sent by SMS", so depositors never received a code.

Never revert the button to that RPC. Never toast success without a real
`sms_sent: true` from the function.
