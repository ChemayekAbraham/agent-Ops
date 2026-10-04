---
name: Cash-code deposit credit fortress
description: cash_deposit (receipt-code) deposits can ONLY credit after user enters the code; email matcher + auto-approve paths can never credit them
type: constraint
---
Cash deposits made through the receipt-code flow (`provider='cash_deposit'`, gated by
`cash_deposit_verifications`) MUST NEVER be auto-credited by the email auto-matcher or any
auto-approve path. Credit happens ONLY after the depositor enters the 4-digit code
(cash-deposit-verify-code stamps `cash_deposit_verifications.status='verified'` then calls
approve-deposit with system_auto_credit).

**Why:** Incident 2026-06-03 — our own outgoing code-notification email
("Cash deposit code NNNN — UGX X from <name>", from weliletenants@gmail.com) was ingested by
gmail-poll as an INCOMING deposit, self-matched by `auto_match_email_deposits` to the very
pending cash deposit it was meant to verify (amount + name = amount_strong), and auto-approved —
crediting the wallet before the user ever entered the code.

**Guards (defense in depth):**
1. `auto_match_email_deposits` RPC excludes `provider='cash_deposit'` deposits AND excludes
   gmail rows whose subject ILIKE 'cash deposit code%'.
2. `gmail-poll-transactions` ingestion skips self-sent code emails
   (from weliletenants@gmail.com + subject 'cash deposit code%'); late-link TID path adds
   `.neq('provider','cash_deposit')`.
3. `approve-deposit` FORTRESS: on `action='approve'`, every `cash_deposit` row in the batch must
   have a `cash_deposit_verifications` row with status='verified', else 403 `cash_code_required` —
   blocks managers, matcher, auto_approved, and system paths alike.
