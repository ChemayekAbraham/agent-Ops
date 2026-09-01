DO $$
DECLARE
  v_line uuid := '1619584e-db5d-4c24-9dd3-242852415b7a';
  v_commit uuid := '9f11336c-a089-4914-98df-fa5c578688be';
  v_portfolio uuid := 'e3216eda-c862-41cf-b8de-e968d7d8ac03';
  v_pending uuid := 'bb4fceb4-af0a-41bd-8587-359174ee57db';
  v_partner uuid := '0b109aad-212a-4fd0-ab03-3d7aee9cf397';
  v_amount numeric := 100000;
  v_release jsonb;
  v_group uuid;
BEGIN
  -- 1. Release the rent plan + reverse the landlord float that was disbursed.
  v_release := public.psm_release_self_funding_line(
    v_line,
    'Auto-approved self-support portfolio reverted so the Partner Ops vetting path can be tested end to end'
  );
  RAISE NOTICE 'release: %', v_release;

  -- 2. Refund the partner operational float that was debited at creation.
  IF NOT EXISTS (
    SELECT 1 FROM public.general_ledger
     WHERE idempotency_key = 'psm-commit-revert-' || v_commit::text
  ) THEN
    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_partner, 'amount', v_amount, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'classification', 'production', 'currency', 'UGX',
          'source_table', 'partner_self_commitments', 'source_id', v_commit,
          'linked_party', 'platform',
          'description', 'Self-support capital returned to operational float — portfolio reverted to Partner Ops vetting (float_usage=self_portfolio_funding reversal)'
        ),
        jsonb_build_object(
          'amount', v_amount, 'direction', 'cash_out',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'classification', 'production', 'currency', 'UGX',
          'source_table', 'partner_self_commitments', 'source_id', v_commit,
          'linked_party', v_partner::text,
          'description', 'Reversal of self-support capital received — portfolio reverted to Partner Ops vetting'
        )
      ),
      idempotency_key := 'psm-commit-revert-' || v_commit::text
    );
  END IF;

  -- 3. Close out the commitment, line, portfolio and pending vetting row.
  UPDATE public.partner_self_funding_lines
     SET status = 'cancelled', updated_at = now()
   WHERE id = v_line;

  UPDATE public.partner_self_commitments
     SET status = 'cancelled', updated_at = now()
   WHERE id = v_commit;

  UPDATE public.investor_portfolios
     SET status = 'cancelled'
   WHERE id = v_portfolio;

  UPDATE public.funder_pending_portfolios
     SET status = 'rejected',
         review_reason = 'Reverted: created by the pre-fix direct path that self-approved without Partner Ops vetting',
         reviewed_at = now(),
         updated_at = now()
   WHERE id = v_pending;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_partner, 'psm_revert_portfolio_to_vetting', 'investor_portfolios', v_portfolio::text,
          'psm_revert_portfolio_to_vetting',
          'Self-approved self-support portfolio reversed back to the ready-to-fund pool for vetting test',
          jsonb_build_object('commitment_id', v_commit, 'line_id', v_line,
                             'pending_id', v_pending, 'amount', v_amount,
                             'float_release', v_release, 'refund_group_id', v_group));
END $$;