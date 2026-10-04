DO $$
DECLARE
  v_uid uuid := '0b109aad-212a-4fd0-ab03-3d7aee9cf397';
  v_sale uuid := 'b2bd1e4a-4541-496b-bdba-bb4a10b4d19d';
BEGIN
  PERFORM public.create_ledger_transaction(
    entries => jsonb_build_array(
      jsonb_build_object(
        'user_id', v_uid,
        'ledger_scope', 'wallet',
        'direction', 'cash_in',
        'amount', 30000,
        'category', 'agent_repayment',
        'recipient_type', 'user',
        'wallet_bucket', 'withdrawable',
        'source_table', 'merchandise_sales',
        'source_id', v_sale,
        'description', 'Reversal of test merchandise order - Welile Evidence',
        'currency', 'UGX',
        'metadata', jsonb_build_object('source', 'merchandise_test_order_reversal', 'sale_id', v_sale)
      ),
      jsonb_build_object(
        'user_id', v_uid,
        'ledger_scope', 'platform',
        'direction', 'cash_out',
        'amount', 30000,
        'category', 'agent_repayment',
        'recipient_type', 'operational_wallet',
        'source_table', 'merchandise_sales',
        'source_id', v_sale,
        'description', 'Reversal of test merchandise sale - Welile Evidence',
        'currency', 'UGX',
        'metadata', jsonb_build_object('source', 'merchandise_test_order_reversal', 'sale_id', v_sale)
      )
    ),
    idempotency_key => 'merch-test-reversal-' || v_sale::text
  );

  UPDATE public.merchandise_sales
     SET order_status = 'rejected',
         payment_status = 'paid',
         amount_paid = 0,
         amount_outstanding = 0,
         rejection_reason = 'Test order reversed - UGX 30,000 refunded to wallet',
         rejected_at = now()
   WHERE id = v_sale;

  UPDATE public.merchandise_recovery_plans
     SET status = 'cancelled', outstanding_balance = 0
   WHERE sale_id = v_sale;
END $$;