-- Run AFTER the pending deposit from 20261018010000 has been approved.
--
-- Counts the approved manual-intake Airtel deposit (TID 159128404754, UGX 5,000,
-- ARINAITWE MARTIN BRIAN) as TID-backed float. tg_credit_tid_backed_float() only
-- does this when a gmail_transactions row with the same TID exists, and this
-- message never reached gmail_transactions. Same approach as
-- 20261018000000_tid_backed_float_manual_intake_backfill.sql.
--
-- Capped at wallets.float_balance minus agent_tid_backed_float.balance.
-- Idempotent via an audit_logs marker per deposit request id.
-- Does nothing while the deposit is still pending.
-- One statement, no DO block, no apostrophes or semicolons in comments.

WITH src AS (
  SELECT dr.id AS deposit_id, dr.user_id, dr.amount, dr.transaction_id
    FROM public.deposit_requests dr
   WHERE dr.transaction_id IN ('TID159128404754', '159128404754')
     AND dr.status = 'approved'
     AND dr.deposit_purpose = 'operational_float'
     AND dr.notes LIKE 'Manual intake 2026-10-17%'
     AND NOT EXISTS (
           SELECT 1 FROM public.audit_logs a
            WHERE a.action_type = 'tid_backed_float_manual_intake_backfill'
              AND a.record_id = dr.id::text)
), capped AS (
  SELECT s.*,
         LEAST(s.amount,
               GREATEST(0, coalesce(w.float_balance, 0) - coalesce(tb.balance, 0))) AS add_amt
    FROM src s
    LEFT JOIN public.wallets w ON w.user_id = s.user_id
    LEFT JOIN public.agent_tid_backed_float tb ON tb.agent_id = s.user_id
), marked AS (
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  SELECT c.user_id, 'tid_backed_float_manual_intake_backfill', 'agent_tid_backed_float',
         c.deposit_id::text,
         'Manual-intake deposit (dropped Airtel message 2026-10-17) recognised as TID-backed float.',
         jsonb_build_object('tid', c.transaction_id, 'deposit_amount', c.amount, 'credited', c.add_amt)
    FROM capped c
  RETURNING record_id
)
SELECT public.credit_agent_tid_backed_float(c.user_id, c.add_amt)
  FROM capped c
 WHERE c.add_amt > 0;
