---
name: Debit Bucket Attempt Audit
description: Per-transfer audit table that records which wallet bucket Financial Ops tried, why it failed, and which bucket they switched to.
type: feature
---
Table `public.wallet_debit_bucket_attempts` is written by `RouteEmailDepositDialog` at four points: pre-flight block, operator switch, mutation success, mutation failure. Fields: target_user_id/name, attempted_bucket (withdrawable|float|proxy_withdrawable), amount, available_at_attempt, outcome (insufficient_funds_blocked|switched|succeeded|failed_other), switched_to_bucket, failure_reason, gmail_transaction_id, transaction_reference, created_by/name. RLS: insert requires created_by = auth.uid(); read open to operations/cfo/manager/super_admin. Blocked rows are deduped client-side per user+bucket+amount within a dialog session.
