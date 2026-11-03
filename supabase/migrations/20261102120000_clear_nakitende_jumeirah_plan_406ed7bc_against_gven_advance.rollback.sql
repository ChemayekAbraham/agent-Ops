-- Rollback for 20261102120000: reopen Nakitende Jumeirah's plan 406ed7bc as 'repaying'
-- (336,000 owed again). Only valid while amount_repaid is still 216,000.
UPDATE public.rent_requests
   SET status = 'repaying', updated_at = now()
 WHERE id = '406ed7bc-e837-4617-9110-cabb4b84313b'
   AND status = 'completed'
   AND amount_repaid = 216000;

INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
VALUES ('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b', 'rent_plan_balance_waiver_rolled_back',
        'rent_requests', '406ed7bc-e837-4617-9110-cabb4b84313b',
        'Rolled back the 2026-11-02 waiver of the 336,000 balance', '{}'::jsonb);
