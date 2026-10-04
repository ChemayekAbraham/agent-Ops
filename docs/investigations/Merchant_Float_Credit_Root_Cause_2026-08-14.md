# Root Cause Report — Merchant Agent Float Not Credited

**Date:** 14 Aug 2026
**Status:** Root cause fixed and verified in code. Two unrelated regressions found during
verification remain open (see §7).
**Reported symptom:** Company sent float money to a merchant agent's registered MoMo line. The
agent's wallet float balance never moved, and no record of the transfer existed anywhere in the
system (no deposit, no ledger entry, no alert).

---

## 1. Summary

Merchant agents hold a `float_balance` bucket in their wallet, topped up when the company sends
money to their registered mobile-money line. This top-up is detected automatically: an SMS
receipt of the company's outbound send is forwarded to a monitored Gmail inbox, polled every 2
minutes by the `gmail-poll-transactions` edge function, parsed, matched to the merchant, and
credited to their float.

That auto-credit had never actually run for this class of transaction. The code path that
credits a merchant's float lived inside the same function that also auto-*debits* wallets for
outgoing company payouts (customer withdrawals, landlord payouts). That function has a hard
safety switch — an "emergency stop" — intended to keep the auto-*debit* side off until a CFO
explicitly whitelists which company mailboxes/lines are allowed to trigger it. The merchant
float **credit** logic sat downstream of that same switch, so it was gated by a control that was
never meant to apply to it — and because the whitelist table has never had a row inserted into
it (in its entire migration history), the switch has always been in the "off" position, silently
disabling merchant float crediting from day one of that code path's existence, with no error, no
alert, and no record anywhere.

Ordinary customer deposits were never affected — they are handled by a completely separate
function that was never behind this switch. This is why the platform's normal float/deposit flow
"worked fine" while merchant agents specifically saw sent money disappear.

---

## 2. Timeline

| When | Event |
|---|---|
| (unknown, pre-dates this incident) | `welile_payout_source_accounts` table created empty, no seed row ever added in any migration. |
| (unknown) | Merchant float delivery detection (`cashout_agents.float_phone` match) added inside `tryAutoDebitPayout`, positioned *after* the whitelist check (Rule 3). |
| 14 Aug 2026 | Reported: a UGX 100,000 company send to merchant agent Joshua Wanda's registered float phone produced zero trace — no `deposit_requests` row, no `email_routing_history`, no `email_payout_match_attempts`, no `general_ledger` leg. Float balance unchanged. |
| 14 Aug 2026 | Investigated and confirmed: `tryAutoDebitPayout` returns at the Rule 3 whitelist check (zero active rows) before ever reaching the `cashout_agents.float_phone` match, ~70 lines later in the function. |
| 14 Aug 2026 (fix) | Merchant float credit check moved to run before Rule 3; a dedicated alert type added so any future non-credit outcome is visible; a second, independent bug in `approve-deposit`'s own verification step (it only accepted inbound-direction proof) was found and fixed for the trusted service-role caller only. |
| 14 Aug 2026 (hardening) | Credit mechanism rewritten from a multi-step insert→HTTP-call→approve sequence to a single atomic, idempotent database transaction (`record_merchant_float_delivery`). |

---

## 3. Root cause

**A control designed for one risk (auto-debiting an arbitrary matched wallet) was also gating an
unrelated, much lower-risk action (crediting a pre-vetted, CFO-registered merchant's float),
and the control had never been switched on.**

Concretely, in `supabase/functions/gmail-poll-transactions/index.ts`, function
`tryAutoDebitPayout`:

```
Eligibility gates → Rule 1 (reconciled-TID dedupe)
  → Rule 3: SELECT ... FROM welile_payout_source_accounts WHERE is_active = true LIMIT 1
      if empty → return                      ← execution stopped HERE, every time
  → (never reached) merchant float-phone match against cashout_agents
  → (never reached) generic recipient match / Rule 2 / Rule 4 / actual debit
```

`welile_payout_source_accounts` is a CFO-managed whitelist meant to keep the **auto-debit**
engine off until a specific company payout line is explicitly approved to trigger it — a
sensible control, because auto-debiting an arbitrary matched user's wallet based on fuzzy
name/phone parsing is genuinely risky. But the merchant float **credit** doesn't carry that risk
profile: the recipient is already an `is_active` agent with a `float_phone` on file in
`cashout_agents`, a table the CFO already curates for exactly this purpose. That table *is* the
correct whitelist for this action. Routing the credit through the debit engine's switch as well
added no safety and cost total silence: because the switch was checked first and the whitelist
table was never seeded, the credit logic was dead code from the moment it was written — it could
never execute, and its absence produced no symptom other than "the merchant didn't get their
money," with nothing in any table to explain why.

### Why it was invisible

Every return statement inside the gated code path, including the Rule 3 return, was a plain
`console.log` with no database write. There was no `deposit_requests` row (nothing was ever
created), no `email_payout_match_attempts` row (that audit table is only written by code *after*
the Rule 3 return), and no alert of any kind. The email itself was correctly ingested and parsed
into `gmail_transactions` — the failure was entirely downstream of parsing, inside the decision
logic, which is why the raw email data looked completely normal on inspection.

---

## 4. Fix

1. **Decoupled the gates.** The `cashout_agents.float_phone` match now runs immediately after
   Rule 1 and *before* Rule 3. Rule 3 remains exactly as strict as before, but only for the
   generic auto-debit path it was built for; it no longer sits in front of the merchant credit.
2. **Made the credit path atomic and idempotent.** Crediting is now a single database
   transaction, `record_merchant_float_delivery(p_tid, p_agent_user_id, p_amount, p_provider,
   p_gmail_transaction_id, p_occurred_at)`:
   - Normalizes the transaction ID and checks it isn't already reconciled.
   - Re-verifies server-side that the agent is `is_active` with a registered `float_phone`
     (defense in depth, not just trusted from the caller).
   - Inserts into a new `merchant_float_deliveries` table with a **unique constraint on the
     normalized TID** (`ON CONFLICT DO NOTHING`) — replaying the same email can never
     double-credit.
   - Posts the balanced double-entry ledger legs and stamps `ledger_reconciled_tids`, all inside
     the same transaction.
   This replaced an earlier version of the fix that created a `deposit_requests` row and called a
   separate edge function over HTTP to approve it — a sequence with a real gap between "recorded"
   and "credited" that produced at least one inconsistent row needing manual cleanup during
   testing.
3. **Nothing can fail silently anymore.** `raiseMerchantFloatAlert` now fires on every outcome
   that isn't a clean credit (insert failure, RPC error, still-linked-but-pending, etc.), and
   auto-resolves once the credit lands.
4. **The backstop sweep detects, it does not decide.** A periodic sweep still looks for outbound
   sends to a registered float phone with no linked receipt (catching any future gap in the live
   path), but it now only raises an alert for FinOps to review — it does not auto-credit.
   Retroactive crediting of a historical gap is a finance decision, not something the automation
   should make unsupervised; an earlier version of the sweep did auto-credit ~10 historical rows
   before this was corrected, and those specific credits still need independent reconciliation
   against real provider statements (not yet done as of this report).

---

## 5. Impact

- At least one confirmed instance: UGX 100,000 sent to merchant agent Joshua Wanda's registered
  float phone, not credited, no trace, until manually investigated.
- An unknown number of historical company→merchant float deliveries prior to the fix are
  similarly unrecorded. Ten such gaps were surfaced by the (now-retired) auto-crediting version
  of the backstop sweep, totaling approximately UGX 22.65M — these were credited automatically at
  the time and still require independent confirmation against provider statements before being
  considered closed.
- Ordinary customer deposits and ordinary merchant payout debits were not affected by this root
  cause.

---

## 6. Why this is fixed durably, not just patched around the symptom

The fix does not add a special case for "the whitelist happens to be empty" — it removes the
dependency entirely, so the merchant credit path's correctness no longer depends on an unrelated
table's contents. The credit itself is now a single all-or-nothing database transaction with a
uniqueness constraint enforced by Postgres, not by application-level checks scattered across an
edge function — so it cannot half-complete, and it cannot be double-applied by a retry, a replay,
or a future backstop sweep run.

---

## 7. Open follow-ups (found during verification, not part of the original root cause)

These were discovered while verifying the fix and are documented in full, with file/line
references, in `docs/investigations/Merchant_Float_Credit_Flow_And_Durability_2026-08-14.md`:

1. A same-day follow-up rewrite of `get_merchant_float_positions()` (the query behind the FinOps
   "Money with agents" card) unintentionally dropped a wallet-cache read-repair step that had
   been added earlier the same day — the FinOps card can show a briefly stale float figure again.
2. The same rewrite tightened the function's authorization check in a way that appears to block
   merchant agents from the parts of that RPC's data their own dashboard widget requests
   (confirmed in code; the widget itself does not crash because it silently falls back to zero
   for those two figures — the merchant's main "float available to pay out" number is sourced
   from a different, unaffected RPC).
3. A migration that added a new alert type to `deposit_match_alerts` dropped an existing alert
   type (`gmail_poll_stale`) that a separate pipeline-health monitor depends on.

None of these affect whether a company→merchant float send is correctly credited — they affect
the accuracy of a couple of secondary reporting figures and one monitor. They are listed here for
completeness and should be tracked as separate fixes.
