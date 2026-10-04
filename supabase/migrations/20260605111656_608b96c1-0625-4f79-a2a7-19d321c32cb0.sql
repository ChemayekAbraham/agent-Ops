DO $$
DECLARE
  r RECORD;
  v_op_id uuid;
  v_restored boolean;
BEGIN
  FOR r IN
    SELECT al.id AS audit_id,
           al.record_id::uuid AS portfolio_id,
           (al.metadata->>'previous_capital')::numeric AS prev_cap,
           (al.metadata->>'new_capital')::numeric AS new_cap,
           (al.metadata->>'total_merged')::numeric AS total_merged,
           (al.metadata->>'partner_id')::uuid AS partner_id,
           al.metadata->'pending_op_ids' AS op_ids,
           p.portfolio_code,
           p.account_name,
           p.next_roi_date
    FROM public.audit_logs al
    JOIN public.investor_portfolios p ON p.id = al.record_id::uuid
    WHERE al.action_type = 'auto_merge_pending_topups'
      AND al.created_at::date = DATE '2026-06-05'
      AND p.next_roi_date::date > DATE '2026-06-05'
  LOOP
    -- 1. Restore portfolio principal (guarded: only if still inflated to the merged figure)
    UPDATE public.investor_portfolios
       SET investment_amount = r.prev_cap
     WHERE id = r.portfolio_id
       AND investment_amount = r.new_cap;
    GET DIAGNOSTICS v_restored = ROW_COUNT;

    -- 2. Re-park the parked top-up operations back to the approved/waiting queue
    FOR v_op_id IN
      SELECT (jsonb_array_elements_text(r.op_ids))::uuid
    LOOP
      UPDATE public.pending_wallet_operations
         SET status = 'approved',
             reviewed_at = NULL,
             reviewed_by = NULL,
             metadata = (COALESCE(metadata, '{}'::jsonb)
                          - 'auto_applied_at_roi_cycle'
                          - 'merged_at')
                        || jsonb_build_object(
                             'reverted_premature_merge', true,
                             'reverted_at', now()
                           ),
             updated_at = now()
       WHERE id = v_op_id;
    END LOOP;

    -- 3. Post balanced admin_correction ledger reversal (platform scope)
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', r.partner_id,
          'amount', r.total_merged,
          'direction', 'cash_in',
          'category', 'pending_portfolio_topup',
          'source_table', 'investor_portfolios',
          'source_id', r.portfolio_id,
          'description', 'REVERSAL: premature ROI-cycle auto-merge for '
                         || COALESCE(r.account_name, r.portfolio_code)
                         || ' — pending capital re-parked',
          'currency', 'UGX',
          'ledger_scope', 'platform',
          'classification', 'admin_correction',
          'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', r.partner_id,
          'amount', r.total_merged,
          'direction', 'cash_out',
          'category', 'partner_funding',
          'source_table', 'investor_portfolios',
          'source_id', r.portfolio_id,
          'description', 'REVERSAL: premature ROI-cycle auto-merge for '
                         || COALESCE(r.account_name, r.portfolio_code)
                         || ' — capital de-activated',
          'currency', 'UGX',
          'ledger_scope', 'platform',
          'classification', 'admin_correction',
          'transaction_date', now()
        )
      )
    );

    -- 4. Write a revert audit record
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (
      NULL,
      'revert_premature_topup_merge',
      'investor_portfolios',
      r.portfolio_id::text,
      jsonb_build_object(
        'reason', 'Cron process-supporter-roi merged future-dated top-ups without an ROI due-date check; reverting to honor the park-until-due promise.',
        'portfolio_code', r.portfolio_code,
        'account_name', r.account_name,
        'partner_id', r.partner_id,
        'restored_capital', r.prev_cap,
        'reverted_from_capital', r.new_cap,
        'amount_reverted', r.total_merged,
        'next_roi_date', r.next_roi_date,
        'principal_restored', v_restored,
        'pending_op_ids', r.op_ids,
        'original_merge_audit_id', r.audit_id,
        'trigger', 'manual_finance_ops_revert'
      )
    );
  END LOOP;
END $$;