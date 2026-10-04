DO $$
DECLARE
  v_portfolio_id uuid := 'b05beadc-87b1-4c13-86ea-8fbcd7b91126';
  v_partner_id uuid := '0b109aad-212a-4fd0-ab03-3d7aee9cf397';
  v_roi bigint := 10000;
  v_new_principal bigint := 60000;
  v_ref text := 'CMP-WIP2604226578-C1-' || to_char(now(),'YYYYMMDDHH24MISS');
  v_new_roi_date date;
BEGIN
  SELECT (COALESCE(next_roi_date, CURRENT_DATE) + INTERVAL '1 month')::date
    INTO v_new_roi_date
    FROM public.investor_portfolios WHERE id = v_portfolio_id;

  UPDATE public.investor_portfolios
     SET investment_amount = v_new_principal,
         next_roi_date = v_new_roi_date
   WHERE id = v_portfolio_id;

  PERFORM public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_partner_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
        'amount', v_roi, 'category', 'roi_expense',
        'description', 'ROI compounded: UGX ' || v_roi || ' reinvested into WIP2604226578. New principal: UGX ' || v_new_principal || '. Ref: ' || v_ref,
        'reference_id', v_ref, 'source_table', 'investor_portfolios',
        'source_id', v_portfolio_id::text, 'linked_party', v_partner_id, 'currency', 'UGX'
      ),
      jsonb_build_object(
        'user_id', v_partner_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
        'amount', v_roi, 'category', 'roi_reinvestment',
        'description', 'ROI reinvestment: UGX ' || v_roi || ' added to principal of WIP2604226578. New principal: UGX ' || v_new_principal || '. Ref: ' || v_ref,
        'reference_id', v_ref, 'source_table', 'investor_portfolios',
        'source_id', v_portfolio_id::text, 'linked_party', v_partner_id, 'currency', 'UGX'
      )
    )
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_partner_id, 'roi_compounded', 'investor_portfolios', v_portfolio_id,
    jsonb_build_object(
      'roi_amount', v_roi, 'new_principal', v_new_principal, 'reference', v_ref,
      'partner_id', v_partner_id, 'new_roi_date', v_new_roi_date,
      'portfolio_code', 'WIP2604226578',
      'triggered_via', 'manual_migration_coo_request',
      'reason', 'Manual COO-requested compound of WIP2604226578 (SSENKAALI PIUS) cycle 1 with email dispatch'
    )
  );
END $$;