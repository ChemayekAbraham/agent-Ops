-- Rollback of 20261104190000_spiro_bike_release_a13_corrections: puts the two plans' accounting split back
-- (principal_total 710,000 -> 500,000, fee_total 700,000 -> 910,000). The 4 correction groups STAY (the General Ledger is
-- append-only); to reverse them post opposite entries with new keys. Collections made in between keep the split they were
-- posted with. No wallet, balance or status change.
SET lock_timeout = '5s';
UPDATE public.merchandise_recovery_plans
  SET principal_total = 500000, fee_total = 910000, updated_at = now()
  WHERE id IN ('93d95269-34da-45f0-9845-fff6b7312220', 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9')
    AND principal_total = 710000 AND fee_total = 700000;
INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
SELECT NULL, 'spiro_release_a13_correction_rollback', 'merchandise_recovery_plans', id::text,
       'rollback of 20261104190000: plan split restored (correction entries stay)', '{}'::jsonb
FROM public.merchandise_recovery_plans WHERE id IN ('93d95269-34da-45f0-9845-fff6b7312220', 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9');
