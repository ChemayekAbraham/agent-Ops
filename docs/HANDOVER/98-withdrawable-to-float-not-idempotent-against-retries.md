# 98 — `agent-convert-withdrawable-to-float` had no retry protection; fixed in code, not yet deployed

**Fixed in code 2026-09-21, deploy status unconfirmed — same doc 79 GitHub Actions blocker.**
Before touching `agent-convert-withdrawable-to-float` again, or assuming a duplicate
`AGT-WDR2FLT-*` pair for the same agent/amount within a few seconds is two real user actions.

## What was asked

Follows doc 96. Josh asked whether the withdrawable→float self-service conversion (the one
mechanism that credits `agent_tid_backed_float`, per his own "agents dashboard only" answer) was
idempotent.

## What was found

It wasn't. `agent-convert-withdrawable-to-float` mints a fresh `AGT-WDR2FLT-${crypto.randomUUID()}`
on every invocation and posts through `postBalancedLedgerGroup` with no `idempotencyKey` — a field
that helper explicitly supports and other callers in this codebase use, just not this one.
`general_ledger.idempotency_key` also has no unique constraint, only a lookup index, so even a
passed key wouldn't be enforced at the database level without an explicit check. The existing
`lockUserId`/`minAvailable` advisory-lock guard only prevents two concurrent requests from
together overdrawing the withdrawable balance — if the agent has enough balance to cover the same
request twice, both succeed as two separate, fully real transfers.

This didn't matter much before doc 96: a duplicate transfer was just a cosmetic double ledger
entry. It matters now — `tg_credit_tid_backed_float` credits `agent_tid_backed_float` once per
transfer, so a retried/double-tapped conversion would hand the agent twice the real spendable
rent-collection capacity for money they only moved once.

## The fix

Before the existing `get_user_available_balance` gate, check for an identical `(user_id, amount)`
transfer through this exact path (`source_table='agent_withdrawable_to_float'`,
`category='bucket_reclass_out'`) posted in the last 10 seconds. If found, return that prior
transfer's `reference_id` and the wallet's *current* balances instead of posting a new pair of
ledger legs — the retry looks successful to the client, but no money moves twice. No new
migration needed; this is a read-then-conditionally-skip check inside the edge function, same
shape as the file's existing race guard.

## Verified

Code review only — traced the exact call shape against `postBalancedLedgerGroup`'s
`idempotencyKey` support (present but unused by this caller) and confirmed
`idx_general_ledger_idempotency_key`/`idx_general_ledger_idempotency_trgm` are plain indexes, not
unique constraints. Did not (and could not, from this tool) fire two real concurrent requests
against the live function to observe a duplicate landing, since doing so would require an
authenticated agent session and would move real money to prove the bug — the code-level evidence
(no key passed, no dedupe check present, confirmed missing) was treated as sufficient.

## Deploy status — NOT confirmed live

Same blocker as docs 79, 96, 97: GitHub Actions edge-function deploy has no working
`SUPABASE_ACCESS_TOKEN` for this repo. Code-only until someone with deploy access ships it.

## What was deliberately NOT done

- Did not add a client-supplied idempotency key end-to-end (frontend generating a key, passing it
  through, server enforcing uniqueness) — the frontend button/form for this screen wasn't
  investigated, and the simpler server-side time-window dedupe fully closes the actual risk
  (double-crediting `agent_tid_backed_float`) without touching UI code, which isn't this session's
  lane per the Claude/Gemini split.
- Did not add the same protection to `admin-withdrawable-to-float` (the Financial Ops path) —
  explicitly out of scope per Josh's "the one on the agents dashboard" answer in doc 96/this
  session; that path doesn't feed the TID-backed pool at all right now.
- Did not add a unique constraint on `general_ledger.idempotency_key` — a much larger change
  touching every ledger writer in the codebase, not scoped to what was asked here.
