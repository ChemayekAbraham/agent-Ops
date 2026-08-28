-- The 44 claims manually reconciled on 2026-08-28
-- (20260828190000_reconcile_stranded_processing_claims_20260812.sql) never
-- became eligible for the 0.5% cashout commission: merchant_commission_
-- eligibility() requires one of five settlement-evidence signals (customer
-- wallet debit, a consumed float reservation, a payout proof, a disbursed
-- linked landlord payout, or any wallet-scope settlement leg), and none of
-- those were posted for these rows by design (see that migration's header).
-- The 15-minute reconcile_merchant_payout_commissions() cron correctly keeps
-- skipping them as "payout_settlement_unproven".
--
-- Operator already confirmed these 44 were genuinely paid out in the field
-- (2026-08-28, same confirmation behind the reconciliation itself) -- that
-- covers the commission too. This credits the 0.5% commission directly for
-- whichever of the 44 are still missing it (12 rows, UGX 29,174 total across
-- 3 agents), mirroring credit_merchant_payout_commission()'s own ledger
-- shape exactly, tagged awarded_via='manual_reconciliation_20260828' instead
-- of going through the eligibility gate a second confirmation would be
-- redundant with.

DO $do$
DECLARE
  r record;
  v_amount numeric;
  v_ref text;
BEGIN
  FOR r IN
    SELECT wr.id, wr.amount,
           COALESCE(wr.processing_started_by, wr.dispatch_claimed_by, wr.processed_by) AS agent_id
    FROM public.withdrawal_requests wr
    WHERE wr.fin_ops_reference LIKE 'MANUAL-RECON-%'
      AND NOT EXISTS (SELECT 1 FROM public.merchant_commission_awards a WHERE a.withdrawal_id = wr.id)
  LOOP
    v_amount := round(COALESCE(r.amount, 0) * 0.005);
    v_ref := r.id::text || '-cashout-commission';
    CONTINUE WHEN v_amount <= 0 OR r.agent_id IS NULL;

    BEGIN
      INSERT INTO public.merchant_commission_awards (
        withdrawal_id, agent_id, payout_amount, commission_rate, commission_amount,
        reference_id, awarded_via
      ) VALUES (
        r.id, r.agent_id, r.amount, 0.005, v_amount, v_ref, 'manual_reconciliation_20260828'
      );
    EXCEPTION WHEN unique_violation THEN
      CONTINUE;
    END;

    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', r.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
          'amount', v_amount, 'category', 'agent_commission_earned',
          'source_table', 'withdrawal_requests', 'source_id', r.id,
          'description', 'Cashout payout commission expense (0.5%) for withdrawal ' || r.id::text || ' (manual reconciliation)',
          'currency', 'UGX', 'reference_id', v_ref, 'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', r.agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_in',
          'amount', v_amount, 'category', 'agent_commission_earned',
          'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
          'source_table', 'withdrawal_requests', 'source_id', r.id,
          'description', 'Cashout payout commission (0.5%) for withdrawal ' || r.id::text || ' (manual reconciliation)',
          'currency', 'UGX', 'reference_id', v_ref, 'transaction_date', now()
        )
      ),
      'manual-recon-cashout-commission-' || r.id::text,
      false
    );

    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES (
      'agent_collection', r.agent_id, 'withdrawal_requests', r.id,
      jsonb_build_object(
        'kind', 'merchant_payout_commission', 'commission_amount', v_amount,
        'payout_amount', r.amount, 'awarded_via', 'manual_reconciliation_20260828'
      )
    );
  END LOOP;
END;
$do$;
