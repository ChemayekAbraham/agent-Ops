# 166 — Manual Float Credit: paste the MoMo message; the TID lock can no longer be dodged by spelling

**Date:** 2026-09-29 · **Asked by:** Josh ("in the manual float credit on Financial Ops make it possible that I can paste in a message and it picks the TID, time and amount")
**Files:**
- `src/lib/floatCreditMessage.ts` and `.test.ts` (new)
- `src/components/financial-ops/ManualFloatCreditPanel.tsx` (handler and a paste box)
- `supabase/migrations/20260929200000_manual_float_credit_normalises_tid.sql`

**Status:**
- **RPC:** LIVE. Applied through `query_database` and verified.
- **Panel:** committed. It ships with the next Lovable publish.

## Paste-to-fill

The panel now has a **"Paste the MTN / Airtel message"** box and a **Fill from message** button. `parseFloatCreditMessage()` reuses the shared `parseSMS` (the same parser as the deposit screen's "Paste from SMS" and the Gmail poller) and adds:
- **TID** in the exact form the lock stores. That is digits for MTN and Airtel, with Airtel's `TID` prefix and any stray punctuation removed.
- **Amount:** the received amount, never the fee or the balance.
- **Date and time** when the message has them. MTN sometimes includes `at 2026-09-29 12:11:39`. **Airtel messages never include a date or time**, so the panel warns the operator to set it from the SMS.
- **Depositor name** from `from (NAME)` or `from NAME at…`. When the message shows only a phone (Airtel), the panel says so and asks for the name.
- **A warning when the paste is a money-*sent* message** rather than money received.

Nothing is posted until the operator reviews the fields and confirms, as before.

Tests: 6 vitest cases built on real message shapes (Airtel, MTN with `(NAME)`, MTN with `at <datetime>`, a sent message, empty input, TID normalisation). All pass.

## TID lock hole closed (server side)

`finops_manual_float_credit` locked and checked the TID after stripping **only whitespace**. The lock table (`ledger_reconciled_tids.tid_normalized`) holds bare digits. So typing `TID157623817657` or `157623817657.` for a TID the email/IFTTT path had already credited passed the `EXISTS` check. That would **credit the same money twice**.
- **Evidence:** one live manual row was locked as `157144620810.` on 2026-09-25. It was a single credit, because the `general_ledger` trigger locked the clean form in the same transaction, but it shows the typed form reaches the lock unchanged.
- **Fix:** the RPC now drops every non-alphanumeric character, then strips a leading `TID` from an Airtel ID. Case is preserved, because `EQ…` Equity refs are mixed case. The panel applies the same `normaliseFloatTid` to typed TIDs as well. Nothing else in the RPC changed. The function is not in `critical_function_baselines`.
- **Verified live:** the auto-credited Airtel TID `157623817657` is now reported as already locked whether it is entered as `TID157623817657`, `tid 1576 2381 7657` or digits.
