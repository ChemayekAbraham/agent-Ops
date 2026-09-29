# 167 — Manual FinOps float credits now fund rent collection

**LIVE 2026-09-29.** Migration `20260929232000_manual_float_credit_counts_as_tid_backed.sql` was applied through `query_database` and verified.

## Symptom

Agent **Watsala Enock** tried to allocate UGX 9,178 to tenant Najjinda Jesca and got: "Only deposits verified by a real transaction ID may fund rent collection. TID-backed balance: 0, Requested: 9178." His float of UGX 16,000 came from a Manual Float Credit in Financial Ops with TID 157665927432.

## Root cause

`finops_manual_float_credit` posts `agent_float_deposit` with `source_table = 'ledger_transaction'` and puts no TID in `sub_category`. `tg_credit_tid_backed_float()` only recognises `deposit_requests` (gmail-matched) and `cfo_direct_credit` (TID in `sub_category`). As a result, every manual credit raised float but never raised `agent_tid_backed_float`. The rent-collection gate from doc `20260921100000` reads only `agent_tid_backed_float`.

## Decision (Josh)

A manual float credit counts as TID-backed, because the panel requires a TID. The RPC already refuses a TID that is in `ledger_reconciled_tids`, so a TID can back float only once, whether it came from email/IFTTT or was entered by hand. The rule changes from "gmail-matched TID only" to "gmail-matched, **or** a unique TID entered by Financial Ops".

## Fix

- `finops_manual_float_credit` calls `credit_agent_tid_backed_float(p_user_id, v_amt)` after posting. The rest of the body is identical to `20260929200000`. The trigger is unchanged: it never sees these rows, so nothing is counted twice.
- The raw-float check in `agent_allocate_tenant_payment_internal` still runs first. TID-backed float cannot create money.
- **Scoped backfill:** only today's three manual credits that are still unspent were backfilled. Each was capped at float minus the existing TID-backed balance, and each is marked in `audit_logs` with `tid_backed_float_manual_credit_backfill`.

| Agent | Credit | TID-backed after | Float |
|---|---|---|---|
| Watsala Enock | 16,000 | 16,000 | 16,000 |
| Tijan Edris | 7,200 | 10,000 | 10,000 |
| NATTU SHARIFAH | 50,000 | 51,120 | 51,120 |

- SHAFEEQ SSENABULYA's credits from 09-24 and 09-25 (403,500) were **not** backfilled, because that float is already spent (float 204). Manual credits made before the gate went live were not backfilled either. As in `20260923090000`, there was no platform-wide recompute.

## If an agent reports the same error after an older manual credit

Compare their current float with their TID-backed balance. Credit only the unspent part of a verified manual credit, capped at float minus TID-backed, and add the same audit row.
