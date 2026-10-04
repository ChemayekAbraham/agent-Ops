---
name: Ledger Delivery Verification service
description: Server-side read-only verification of whether any earning reached a wallet; client must never match earnings to ledger credits
type: constraint
---
- `verify_ledger_delivery(p_items jsonb)` (STABLE, SECURITY DEFINER, read-only) is the ONLY approved way to determine whether an earning was delivered to a wallet. Generic — works for agent commissions, recruiter overrides, listing/referral bonuses, Returns payouts, advance recoveries, merchant settlements and future earning types.
- Match priority is authoritative only: (1) `transaction_group_id`, (2) `idempotency_key`, (3) `source_table` + `source_id`. Amounts/timestamps are NEVER a matching signal (timestamp is a tie-break only). Returns `credited | pending | failed | not_found` plus wallet txn id, bucket, credited amount/time, group id, or failure reason / processing state / retry status.
- `get_payout_delivery_audit(p_user_id, p_limit)` builds the agent Payout Audit feed server-side and delegates to the verifier. Self-access only, plus ops/exec roles.
- **Constraint:** the frontend must never compare `source_id`, amount, timestamps or metadata to infer wallet delivery. `SubAgentPayoutAudit.tsx` renders RPC output only. Client-side matching caused the false "Never reached wallet" negatives (all 97 recruiter overrides for Muwanguzi Fred were in fact credited; the client query was error-blind and capped at 500 ledger rows).
- Verification is strictly read-only: no ledger inserts, no wallet mutation, no projection updates.