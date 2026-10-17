-- Manual-intake float is TID-backed (backfill for the 2026-10-17 MTN outage payments).
--
-- Symptom: after the three agent float top-ups from the MTN feed outage were
-- approved (NAGASHA Mellon 86,000, Mata Pius 22,800, DERRICK LUTAMAGUZI 21,000),
-- the app refused to collect rent with the new float: "You can collect up to
-- UGX 12,309. Rent collection needs real Mobile Money float" (12,309 was
-- NAGASHA's old TID-backed balance; her float is 98,309).
--
-- Cause: tg_credit_tid_backed_float() credits agent_tid_backed_float for a
-- deposit_requests credit only when a gmail_transactions row with the same TID
-- exists. These payments never reached gmail_transactions (the feed was down),
-- so the float was credited but never marked TID-backed.
--
-- The TIDs were checked against the MTN till statement by Financial Ops before
-- approval, and approve-deposit locked each one in ledger_reconciled_tids, so
-- each TID can back float only once. This credits the same amount to
-- agent_tid_backed_float, as 20260929232000 did for manual float credits.
--
-- Safety, same rules as the earlier backfill:
--   * scoped to the three approved 'Manual intake 2026-10-17' operational_float
--     deposits; the tenants' rent-repayment deposits are excluded (their float
--     was consumed by settlement and tenants do not collect rent);
--   * capped at wallets.float_balance - agent_tid_backed_float.balance, so
--     TID-backed can never exceed real float;
--   * idempotent via an audit_logs marker per deposit request id.
-- The trigger and the gate are NOT changed. The raw-float check in
-- agent_allocate_tenant_payment_internal still applies.
--
-- Single statement, no DO block.

WITH src AS (
  SELECT dr.id AS deposit_id, dr.user_id, dr.amount, dr.transaction_id
    FROM public.deposit_requests dr
   WHERE dr.transaction_id IN ('44308696961', '44312707356', '44313474818')
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
         'Manual-intake deposit (MTN feed outage 2026-10-17) recognised as TID-backed float.',
         jsonb_build_object('tid', c.transaction_id, 'deposit_amount', c.amount, 'credited', c.add_amt)
    FROM capped c
  RETURNING record_id
)
SELECT public.credit_agent_tid_backed_float(c.user_id, c.add_amt)
  FROM capped c
 WHERE c.add_amt > 0;
