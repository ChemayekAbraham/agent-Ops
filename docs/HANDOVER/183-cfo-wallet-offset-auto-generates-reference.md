# 183 — CFO wallet offset no longer needs a typed TID

**Status 2026-10-01: BUILT, edge function NOT yet deployed** (`cfo-record-advance-payment`).

## Problem
Recording an advance repayment with payment method **Wallet Offset** in the CFO
advance-repayments dialog returned "Edge Function returned a non-2xx status code".
The edge function rejected any request with an empty `reference` (HTTP 400), and a
wallet offset has no external TID: the money moves inside our own ledger.

## Fix
`supabase/functions/cfo-record-advance-payment/index.ts`: when
`payment_method = 'wallet_offset'` and no reference is sent, it generates
`WOFF-<YYYYMMDDHHMMSSmmm>-<6 hex>` and passes that to `cfo_record_advance_payment`.
A reference typed by the CFO is still used as-is. Mobile money, bank transfer, cash
and other still require a reference. The RPC, ledger shape and statement rows are unchanged.

## Not done (UI, Gemini)
`RecordAdvancePaymentDialog.tsx` still labels the field "Reference / Transaction ID"
for wallet offset, and `supabase.functions.invoke` hides the server's message behind
the generic non-2xx text for any other 4xx. Suggest: hide or mark the field optional for
wallet offset, and surface `error.context` JSON.

## Verify after deploy
Record a small wallet-offset payment with the reference blank; the advance statement row
should show a `WOFF-…` reference. `architecture-map.html` not updated: no subsystem,
table or flow changed.

## Follow-up 2026-10-01: the dialog blocked it before the edge function
The CFO "Advance Repayments" dialog (`StaffRepayAdvanceDialog.tsx`) disabled its
Record button until a reference was typed (`valid` required `reference.trim()`), so
the edge-function fix was never reached. `valid` now skips that check when the
method is `wallet_offset`. The label still says "(required)" (Gemini). `other` is
still rejected by the RPC (`0A000`, only wallet_offset/mobile_money/bank_transfer/cash).
`RecordAdvancePaymentDialog.tsx` has no such gate and was already fixed by the edge function.
