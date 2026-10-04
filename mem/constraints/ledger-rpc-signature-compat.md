---
name: Ledger RPC signature compatibility
description: create_ledger_transaction has both the canonical (entries, idempotency_key, skip_balance_check) signature and a permanent legacy overload (p_transaction_group_id, p_entries, ...). New code MUST use the canonical names.
type: constraint
---
- Canonical signature (use this in all new code, edge functions, and migrations):
  `create_ledger_transaction(entries jsonb, idempotency_key text DEFAULT NULL, skip_balance_check boolean DEFAULT false)`
- A compatibility overload exists for legacy callers that still pass `p_transaction_group_id => ..., p_entries => ...`. It IGNORES the supplied transaction group id and delegates to the canonical function. Do not rely on the legacy id being honored.
- **Why:** Multiple historical migrations were written against an older signature. Removing the overload would break those functions; rewriting every legacy migration is impractical. The shim makes both shapes work forever.
- **How to apply:** When writing a new migration or edge function, always pass `entries: [...]` (raw array, never stringified). Never invent new parameter names.
