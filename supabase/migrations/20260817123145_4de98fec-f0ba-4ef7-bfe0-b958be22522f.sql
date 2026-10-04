-- 1) New balance-sheet account for physical cash received but not yet banked
INSERT INTO public.ledger_account_catalog (code, label, section, nature, sort_order)
VALUES ('A5', 'Cash in Transit — Received, Not Yet Banked', 'current_asset', 'asset', 25)
ON CONFLICT (code) DO UPDATE
  SET label = EXCLUDED.label,
      section = EXCLUDED.section,
      nature = EXCLUDED.nature,
      sort_order = EXCLUDED.sort_order;

-- 2) Map the new treasury movement categories onto the chart of accounts.
--    debit_when = 'cash_in' for all four: a cash_in leg debits the account,
--    a cash_out leg credits it.
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
VALUES
  ('platform', 'cash_receipt_in_transit', NULL, 'A5', 'cash_in',
   'Physical cash received by Financial Ops, recognised as cash in transit'),
  ('platform', 'cash_at_bank_reclass',    NULL, 'A1', 'cash_in',
   'Reclass out of Cash and Bank until the cash is physically banked'),
  ('platform', 'cash_in_transit_banked',  NULL, 'A5', 'cash_in',
   'Cash in transit released when the deposit is banked'),
  ('platform', 'treasury_bank_deposit',   NULL, 'A1', 'cash_in',
   'Treasury / Cash at Bank increase when Financial Ops banks the cash')
ON CONFLICT DO NOTHING;

-- 3) Extend the locked ledger category allowlist with the four treasury categories
CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    '🔧 Manual Adjustment','access_fee_collected','account_merge','advance_repayment',
    'agent_advance_credit','agent_advance_repayment','agent_bonus','agent_commission',
    'agent_commission_earned','agent_commission_payable','agent_commission_used_for_rent',
    'agent_commission_withdrawal','agent_float_assignment','agent_float_deposit',
    'agent_float_funding','agent_float_settlement','agent_float_topup','agent_float_used',
    'agent_float_used_for_rent','agent_investment_commission','agent_landlord_payout',
    'agent_proxy_investment','agent_repayment','angel_pool_investment','balance_correction',
    'cfo_direct_credit','coo_proxy_investment','coo_proxy_investment_reversal',
    'correction_reversal','credit_access_repayment','debt_clearance','debt_recovery','deposit',
    'equipment_expense','general_admin_expense','historical_balance_reseed','interest_expense',
    'landlord_rent_payment','listing_bonus','listing_bonus_expense','listing_rejection_offset',
    'listing_rejection_penalty','listing_rejection_recovery','manager_credit','manager_debit',
    'marketing_expense','merchant_float_correction_writedown','orphan_reassignment',
    'orphan_reversal','partner_commission','partner_funding','payroll_expense',
    'pending_portfolio_topup','platform_expense','platform_loss_writeoff',
    'pool_capital_received','pool_rent_deployment_reversal','proxy_investment_commission',
    'proxy_partner_withdrawal','reconciliation','referral_bonus','registration_fee_collected',
    'rent_disbursement','rent_float_funding','rent_obligation','rent_obligation_reversal',
    'rent_obligation_reversal_adjustment','rent_payment_for_tenant','rent_payment_received',
    'rent_principal_collected','rent_receivable_created','rent_repayment',
    'research_development_expense','roi_expense','roi_payout','roi_reinvestment',
    'roi_wallet_credit','salary_advance','salary_advance_repayment','salary_payout',
    'share_capital','supporter_capital','supporter_rent_fund','system_balance_correction',
    'tax_expense','tenant_default_charge','tenant_repayment','test_funds_cleanup',
    'wallet_deduction','wallet_deduction_cash_payout_retraction',
    'wallet_deduction_general_adjustment','wallet_deposit','wallet_to_investment',
    'wallet_transfer','wallet_withdrawal',
    -- Treasury / cash custody movements (Financial Ops cash deposits)
    'cash_receipt_in_transit','cash_at_bank_reclass','cash_in_transit_banked',
    'treasury_bank_deposit'
  ]::text[];
$function$;

-- 4) Atomic cash-location change WITH double-entry treasury posting
CREATE OR REPLACE FUNCTION public.fin_ops_set_cash_location(
  p_deposit_request_id uuid,
  p_location text,
  p_note text DEFAULT NULL::text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_loc text;
  v_prev text;
  v_dep record;
  v_seq int;
  v_group uuid;
  v_ref text;
  v_audit jsonb := '{}'::jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_loc := CASE WHEN p_location = 'bank' THEN 'bank' ELSE 'cash_at_hand' END;

  -- Lock the deposit so the status flip and the accounting posting are atomic
  SELECT id, amount, status, deposit_purpose, purpose_audit
    INTO v_dep
  FROM public.deposit_requests
  WHERE id = p_deposit_request_id
  FOR UPDATE;

  IF v_dep.id IS NULL THEN
    RAISE EXCEPTION 'deposit_request_not_found';
  END IF;

  v_prev := COALESCE(v_dep.purpose_audit->>'cash_location', 'cash_at_hand');
  v_seq  := COALESCE(NULLIF(v_dep.purpose_audit->>'treasury_seq','')::int, 0);
  v_ref  := 'DEP-' || left(p_deposit_request_id::text, 8);

  IF v_loc = 'bank' THEN
    IF v_dep.status <> 'approved' THEN
      RAISE EXCEPTION 'deposit_not_verified';
    END IF;
    IF COALESCE(v_dep.amount, 0) <= 0 THEN
      RAISE EXCEPTION 'invalid_deposit_amount';
    END IF;
  END IF;

  -- 4a) Recognise the physical cash as Cash in Transit exactly once per deposit.
  --     The verification posting already debited Cash and Bank, so this reclass
  --     moves it out of the bank account until it is really banked.
  IF v_dep.status = 'approved' AND COALESCE(v_dep.amount, 0) > 0 THEN
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_in',
          'category','cash_receipt_in_transit','amount', v_dep.amount,
          'account','platform:cash_in_transit',
          'description','Cash received by Financial Ops — held as cash in transit',
          'source_table','deposit_requests','source_id', p_deposit_request_id,
          'reference_id', v_ref, 'classification','production'
        ),
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_out',
          'category','cash_at_bank_reclass','amount', v_dep.amount,
          'account','platform:cash_at_bank',
          'description','Reclass out of Cash and Bank pending physical banking',
          'source_table','deposit_requests','source_id', p_deposit_request_id,
          'reference_id', v_ref, 'classification','production'
        )
      ),
      'cash_receipt_transit:' || p_deposit_request_id::text
    );
    v_audit := v_audit || jsonb_build_object('cash_transit_group_id', v_group);
  END IF;

  -- 4b) Bank the cash: Cash in Transit -> Treasury / Cash at Bank
  IF v_loc = 'bank' AND v_prev <> 'bank' THEN
    v_seq := v_seq + 1;
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_in',
          'category','treasury_bank_deposit','amount', v_dep.amount,
          'account','platform:cash_at_bank',
          'description','Treasury: cash deposit banked by Financial Ops',
          'source_table','deposit_requests','source_id', p_deposit_request_id,
          'reference_id', v_ref, 'classification','production'
        ),
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_out',
          'category','cash_in_transit_banked','amount', v_dep.amount,
          'account','platform:cash_in_transit',
          'description','Cash in transit released — banked to Treasury',
          'source_table','deposit_requests','source_id', p_deposit_request_id,
          'reference_id', v_ref, 'classification','production'
        )
      ),
      'treasury_bank_deposit:' || p_deposit_request_id::text || ':' || v_seq::text
    );
    v_audit := v_audit || jsonb_build_object('treasury_group_id', v_group, 'treasury_posted_at', now());

  -- 4c) Un-bank: exact reversal so Treasury is never overstated
  ELSIF v_loc = 'cash_at_hand' AND v_prev = 'bank' AND v_seq > 0
        AND COALESCE(v_dep.amount, 0) > 0 THEN
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_out',
          'category','treasury_bank_deposit','amount', v_dep.amount,
          'account','platform:cash_at_bank',
          'description','Treasury: banking reversed — cash returned to hand',
          'source_table','deposit_requests','source_id', p_deposit_request_id,
          'reference_id', v_ref, 'classification','production'
        ),
        jsonb_build_object(
          'ledger_scope','platform','direction','cash_in',
          'category','cash_in_transit_banked','amount', v_dep.amount,
          'account','platform:cash_in_transit',
          'description','Cash back in transit — banking reversed',
          'source_table','deposit_requests','source_id', p_deposit_request_id,
          'reference_id', v_ref, 'classification','production'
        )
      ),
      'treasury_bank_reversal:' || p_deposit_request_id::text || ':' || v_seq::text
    );
    v_audit := v_audit || jsonb_build_object('treasury_reversal_group_id', v_group, 'treasury_reversed_at', now());
  END IF;

  UPDATE public.deposit_requests
  SET purpose_audit = COALESCE(purpose_audit, '{}'::jsonb)
    || jsonb_build_object(
         'cash_location', v_loc,
         'cash_location_changed_at', now(),
         'cash_location_changed_by', auth.uid(),
         'cash_location_previous', v_prev,
         'cash_location_note', p_note,
         'treasury_seq', v_seq
       )
    || v_audit,
    updated_at = now()
  WHERE id = p_deposit_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (
    auth.uid(),
    'cash_location_changed',
    'deposit_requests',
    p_deposit_request_id::text,
    'cash_location_changed',
    jsonb_build_object(
      'cash_location', v_loc,
      'previous', v_prev,
      'amount', v_dep.amount,
      'treasury_seq', v_seq,
      'ledger', v_audit,
      'reason', COALESCE(NULLIF(p_note, ''), 'Cash location updated to ' || v_loc || ' by finance staff')
    )
  );

  RETURN v_loc;
END;
$function$;