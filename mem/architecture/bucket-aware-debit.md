---
name: Bucket-aware CFO debit architecture
description: CFO Direct Debit validates, records and recovers per wallet bucket; float corrections never create personal debt
type: constraint
---
Since 2026-08-02 every CFO wallet debit is **bucket-aware**:

- Solvency gate: `wallet_bucket='withdrawable'` → `get_user_available_balance`; `wallet_bucket='float'` (recipient_type `operational_wallet`) → `get_user_float_available_balance` (float leg of `v_user_wallet_strict`). Never validate a float correction against withdrawable.
- Float debits can NEVER overdraw: `allow_overdraw` is force-dropped for float, so Forced Reversal / Freeze + Split Debit / personal-debt acknowledgement are hidden in `DirectCreditTool` for float and refused server-side.
- `cfo_debit_obligations` carries `wallet_bucket` + `recovery_source`. Trigger `trg_enforce_bucket_aware_obligation` rejects float+`auto_recover=true` and any cross-bucket recovery_source.
- `recover_cfo_debit_obligation(id, amount, source_bucket)` is the only recovery entry point; it raises `INVALID_BUCKET_RECOVERY` when the credit bucket differs from `recovery_source`. Float obligations may never be settled from commissions, overrides, bonuses, payroll or Returns.
- Error codes are bucket-specific: `FLOAT_INSUFFICIENT_BALANCE`, `WITHDRAWABLE_INSUFFICIENT_BALANCE`, `NEGATIVE_FLOAT_BLOCKED`, `WITHDRAWABLE_HOLD_ACTIVE`, `INVALID_BUCKET_RECOVERY` — never a generic "Ledger error".
- Audit logs + obligation metadata record wallet_bucket, recovery_source, solvency_rule, validation_method, bucket_before, bucket_after and correction_class (`operational_float_correction` vs `personal_recoverable_debit`).
- `report_float_auto_recover_obligations()` lists legacy float obligations wrongly flagged auto_recover. Data is NEVER auto-corrected — Finance decides per record.
- CFO Direct Debit and FinOps "Recover to platform" are financially equivalent for float corrections; only workflow/permissions differ.
