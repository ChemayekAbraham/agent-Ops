-- Rollback of 20261104110000_merchandise_phase3_stock_phone_pledge: restores cfo_disburse_smartphone_order, apply_smartphone_roi_pledge and the allowlist to the
-- production definitions of 2026-11-04 (verbatim), drops the stock-issue trigger and functions and the settings column.
-- STAY (append-only / evidence): the 8 correction groups, any posted stock recognitions and the review rows; the two
-- mapping rows stay while any leg uses them (removing a mapping would restate those legs to A9).
SET lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.cfo_disburse_smartphone_order(p_sale_id uuid, p_amount numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_price numeric;
  v_total numeric;
  v_daily numeric;
  v_days integer;
  v_months integer;
  v_full boolean;
  v_sched jsonb;
  v_start date;
  v_ref text;
  v_adv_ref text;
  v_group uuid;
  v_adv_group uuid;
  v_supplier uuid;
  v_agent uuid;
  v_agent_name text;
  v_agent_phone text;
  v_supplier_name text;
  v_plan_id uuid;
BEGIN

  IF auth.uid() IS NOT NULL AND NOT public.is_cfo_approver(auth.uid()) THEN
    RAISE EXCEPTION 'This request could not be completed';
  END IF;
  IF NOT public.can_cfo_disburse_smartphone_orders(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to disburse smartphone advances';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'coo_approved' THEN
    RAISE EXCEPTION 'Application must be COO approved first (currently %)', COALESCE(v_sale.order_status, 'submitted');
  END IF;
  IF v_sale.customer_id IS NULL THEN
    RAISE EXCEPTION 'Application has no linked agent account';
  END IF;

  v_agent := v_sale.customer_id;

  v_supplier := v_sale.supplier_id;
  IF v_supplier IS NULL THEN
    SELECT supplier_id INTO v_supplier FROM public.smartphone_catalog WHERE id = v_sale.smartphone_catalog_id;
  END IF;
  IF v_supplier IS NULL THEN
    RAISE EXCEPTION 'No registered supplier is attached to this phone';
  END IF;
  IF v_supplier = v_agent THEN
    RAISE EXCEPTION 'The supplier and the applying agent cannot be the same person';
  END IF;

  v_price := COALESCE(NULLIF(p_amount, 0), NULLIF(v_sale.total_amount, 0), NULLIF(v_sale.unit_price, 0), 0);
  IF v_price <= 0 THEN
    RAISE EXCEPTION 'Phone price is missing on this application';
  END IF;

  -- payment_plan defaults to 'full' on every application, so it is not a
  -- reliable signal. A chosen period of 1-12 months is always instalments.
  v_full := COALESCE(v_sale.advance_period_months, 0) NOT BETWEEN 1 AND 12;
  v_months := CASE WHEN v_full THEN NULL ELSE v_sale.advance_period_months END;
  v_start := current_date + COALESCE(NULLIF(v_sale.grace_days, 0), 7);

  IF v_full THEN
    v_sched := jsonb_build_object('payment_plan', 'full', 'total_repayable', v_price);
    PERFORM public.smartphone_rebuild_repayment_schedule(p_sale_id, v_price, NULL, v_start);
    v_total := v_price;
    v_daily := v_price;
    v_days := 1;
    v_start := current_date;
  ELSE
    v_sched := public.smartphone_rebuild_repayment_schedule(p_sale_id, v_price, v_months, v_start);
    v_total := COALESCE(NULLIF((v_sched->>'total_repayable')::numeric, 0), NULLIF(v_sale.total_repayable, 0), v_price);
    v_daily := COALESCE(NULLIF((v_sched->>'first_daily')::numeric, 0), NULLIF(v_sale.access_daily_amount, 0), 0);
    v_days  := COALESCE(NULLIF((v_sched->>'days')::integer, 0), NULLIF(v_sale.access_repayment_days, 0), 365);
  END IF;

  SELECT full_name, phone INTO v_agent_name, v_agent_phone FROM public.profiles WHERE id = v_agent;
  SELECT full_name INTO v_supplier_name FROM public.profiles WHERE id = v_supplier;

  v_ref := 'smartphone-supplier-payment-' || p_sale_id::text;
  v_adv_ref := 'smartphone-advance-' || p_sale_id::text;

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_supplier, 'amount', v_price, 'direction', 'cash_in',
        'category', 'wallet_deposit', 'ledger_scope', 'wallet',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'merchandise_sales', 'source_id', p_sale_id,
        'reference_id', v_ref, 'currency', 'UGX',
        'description', 'Smartphone supplier payment for ' || COALESCE(v_agent_name, 'agent'),
        'transaction_date', now()
      ),
      jsonb_build_object(
        'user_id', v_uid, 'amount', v_price, 'direction', 'cash_out',
        'category', 'equipment_expense', 'ledger_scope', 'platform',
        'source_table', 'merchandise_sales', 'source_id', p_sale_id,
        'reference_id', v_ref, 'currency', 'UGX',
        'description', 'Smartphone purchased from ' || COALESCE(v_supplier_name, 'supplier')
                       || ' for ' || COALESCE(v_agent_name, 'agent'),
        'transaction_date', now()
      )
    ),
    v_ref
  );

  IF NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = v_adv_ref) THEN
    v_adv_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_agent, 'amount', v_price, 'direction', 'cash_in',
          'category', 'agent_advance_credit', 'ledger_scope', 'wallet',
          'recipient_type', 'user', 'wallet_bucket', 'advance_credit',
          'source_table', 'merchandise_sales', 'source_id', p_sale_id,
          'reference_id', v_adv_ref, 'currency', 'UGX',
          'description', 'Smartphone advance recorded on wallet - '
                         || COALESCE(v_sale.item_name, 'Welile Smartphone'),
          'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', v_agent, 'amount', v_price, 'direction', 'cash_out',
          'category', 'smartphone_advance_receivable', 'ledger_scope', 'platform',
          'source_table', 'merchandise_sales', 'source_id', p_sale_id,
          'reference_id', v_adv_ref, 'currency', 'UGX',
          'description', 'Smartphone advance receivable from ' || COALESCE(v_agent_name, 'agent'),
          'transaction_date', now()
        )
      ),
      v_adv_ref
    );
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'approved',
      payment_status = 'credit',
      payment_plan = CASE WHEN v_full THEN 'full' ELSE 'installment' END,
      advance_period_months = v_months,
      advance_markup_pct = CASE WHEN v_price > 0
                                THEN round((v_total - v_price) * 100 / v_price, 2)
                                ELSE advance_markup_pct END,
      total_repayable = v_total,
      access_daily_amount = v_daily,
      access_repayment_days = v_days,
      repayment_starts_on = v_start,
      payment_projection = v_total - v_price,
      amount_outstanding = v_total,
      supplier_id = v_supplier,
      cfo_disbursed_by = v_uid,
      cfo_disbursed_at = now(),
      disbursed_amount = v_price,
      disbursement_group_id = v_group,
      notes = COALESCE(notes, '') || ' | CFO paid supplier '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' amount ' || to_char(v_price, 'FM999,999,999')
              || CASE WHEN v_full THEN ' - full payment due'
                      ELSE ' - first daily ' || to_char(v_daily, 'FM999,999,999') END
              || ' from ' || to_char(v_start, 'YYYY-MM-DD')
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  SELECT id INTO v_plan_id
  FROM public.merchandise_recovery_plans
  WHERE sale_id = p_sale_id AND status = 'active'
  LIMIT 1;

  IF v_plan_id IS NULL THEN
    INSERT INTO public.merchandise_recovery_plans (
      sale_id, customer_id, customer_name, customer_phone, item_name,
      original_amount, outstanding_balance, amount_recovered,
      daily_rate, daily_deduction_amount, starts_on, status, created_by
    ) VALUES (
      p_sale_id, v_agent, COALESCE(v_agent_name, v_sale.client_name),
      COALESCE(v_agent_phone, v_sale.client_phone),
      COALESCE(v_sale.item_name, 'Welile Smartphone'),
      v_total, v_total, 0,
      0.33, v_daily, v_start, 'active', v_uid
    ) RETURNING id INTO v_plan_id;
  ELSE
    UPDATE public.merchandise_recovery_plans
    SET customer_id = v_agent,
        customer_name = COALESCE(v_agent_name, customer_name),
        customer_phone = COALESCE(v_agent_phone, customer_phone),
        original_amount = v_total,
        outstanding_balance = GREATEST(v_total - COALESCE(amount_recovered, 0), 0),
        daily_deduction_amount = v_daily,
        starts_on = COALESCE(starts_on, v_start),
        updated_at = now()
    WHERE id = v_plan_id;
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'smartphone_advance_disbursed', 'merchandise_sales', p_sale_id,
            'CFO paid the registered supplier; ID and workplace photo verified on collection day',
            jsonb_build_object('price', v_price, 'total_repayable', v_total,
                               'first_daily', v_daily, 'starts_on', v_start,
                               'schedule', v_sched,
                               'supplier_id', v_supplier, 'repaid_by_agent_id', v_agent,
                               'advance_group_id', v_adv_group,
                               'recovery_plan_id', v_plan_id));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id, 'order_status', 'approved',
    'total_amount', v_price, 'disbursed_amount', v_price,
    'payment_projection', v_total - v_price, 'daily_amount', v_daily,
    'repayment_starts_on', v_start, 'disbursement_group_id', v_group,
    'advance_group_id', v_adv_group, 'advance_recorded', v_price,
    'recovery_plan_id', v_plan_id, 'repaid_by_agent_id', v_agent,
    'paid_supplier_id', v_supplier, 'schedule', v_sched
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_smartphone_roi_pledge(p_user_id uuid, p_roi_amount numeric, p_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_p record; v_plan record; v_pledged numeric; v_avail numeric; v_amount numeric; v_closing numeric;
  v_split jsonb; v_prin_part numeric; v_charge_part numeric; v_entries jsonb;
BEGIN
  IF COALESCE(p_roi_amount,0) <= 0 THEN RETURN jsonb_build_object('applied',0,'reason','no_roi'); END IF;
  IF EXISTS (SELECT 1 FROM public.smartphone_roi_pledge_applications WHERE reference = p_reference) THEN
    RETURN jsonb_build_object('applied',0,'reason','already_applied');
  END IF;
  SELECT * INTO v_p FROM public.smartphone_roi_pledges WHERE user_id = p_user_id AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied',0,'reason','no_pledge'); END IF;
  SELECT p.* INTO v_plan FROM public.merchandise_recovery_plans p
    JOIN public.merchandise_sales s ON s.id = p.sale_id
    WHERE p.customer_id = p_user_id AND p.status = 'active' AND p.outstanding_balance > 0
      AND NOT COALESCE(p.is_bike_lease,false) AND s.item_name ILIKE '%smartphone%'
    ORDER BY p.created_at LIMIT 1 FOR UPDATE OF p;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied',0,'reason','no_plan'); END IF;
  v_pledged := CASE WHEN v_p.mode = 'percent' THEN floor(p_roi_amount * v_p.value / 100) ELSE v_p.value END;
  v_avail := COALESCE(public.get_user_available_balance(p_user_id),0);
  v_amount := floor(LEAST(v_pledged, p_roi_amount, v_plan.outstanding_balance, v_avail));
  IF v_amount <= 0 THEN RETURN jsonb_build_object('applied',0,'reason','nothing_available'); END IF;

  -- 2026-11-03 (CFO): principal -> A12 (merchandise_recovery_repayment), charge -> R1 (access_fee_collected);
  -- was one A10 leg (agent_advance_repayment). The wallet leg is unchanged.
  v_split := public._smartphone_recovery_split_safe(v_plan.id, v_amount, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_prin_part := (v_split->>'principal')::numeric;
  v_charge_part := (v_split->>'charge')::numeric;
  v_entries := jsonb_build_array(
    jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
      'amount', v_amount, 'category', 'agent_repayment', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
      'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
      'description', 'Smartphone repayment - ' || COALESCE(v_plan.item_name,'Welile Smartphone') || ' (from monthly Returns)'));
  IF v_prin_part > 0 THEN
    v_entries := v_entries || jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
      'amount', v_prin_part, 'category', 'merchandise_recovery_repayment', 'recipient_type', 'operational_wallet',
      'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
      'description', 'Smartphone cost recovered from monthly Returns: ' || COALESCE(v_plan.item_name,'Welile Smartphone'));
  END IF;
  IF v_charge_part > 0 THEN
    v_entries := v_entries || jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
      'amount', v_charge_part, 'category', 'access_fee_collected', 'recipient_type', 'operational_wallet',
      'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
      'description', 'Smartphone monthly charge collected from monthly Returns: ' || COALESCE(v_plan.item_name,'Welile Smartphone'));
  END IF;
  PERFORM public.create_ledger_transaction(entries => v_entries, idempotency_key => 'phone_roi_pledge_' || p_reference);

  v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);
  INSERT INTO public.merchandise_recovery_deductions (plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after, transaction_ref)
    VALUES (v_plan.id, p_user_id, COALESCE(v_plan.item_name,'Welile Smartphone') || ' (from monthly Returns)', v_amount, v_avail, v_closing, gen_random_uuid());
  UPDATE public.merchandise_recovery_plans
    SET outstanding_balance = v_closing, amount_recovered = amount_recovered + v_amount,
        due_balance = GREATEST(0, COALESCE(due_balance,0) - v_amount), last_recovery_at = now(),
        status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
        completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END, updated_at = now()
    WHERE id = v_plan.id;
  UPDATE public.merchandise_sales
    SET amount_paid = COALESCE(amount_paid,0) + v_amount,
        amount_outstanding = GREATEST(0, COALESCE(amount_outstanding,0) - v_amount), updated_at = now()
    WHERE id = v_plan.sale_id;
  INSERT INTO public.smartphone_roi_pledge_applications(user_id, plan_id, reference, roi_amount, pledged_amount, applied_amount, outstanding_after)
    VALUES (p_user_id, v_plan.id, p_reference, p_roi_amount, v_pledged, v_amount, v_closing);
  BEGIN
    INSERT INTO public.system_events(event_type, user_id, metadata)
    VALUES ('payment_made', p_user_id, jsonb_build_object('kind','smartphone_roi_pledge_applied','amount',v_amount,'plan_id',v_plan.id,'reference',p_reference));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('applied', v_amount, 'outstanding_after', v_closing);
END $function$;

CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT ((public.ledger_category_allowlist_base() || ARRAY[
    'agent_advance_receivable_opening',
    'agent_access_fee_receivable_opening',
    'merchandise_recovery_receivable_opening',
    'bike_recovery_receivable_opening',
    'credit_draw_receivable_opening',
    'merchandise_credit_sale_receivable_opening',
    'service_centre_advance_receivable_opening',
    'service_centre_receivable_opening',
    'tenant_service_charge_receivable_opening',
    'business_advance_receivable_opening',
    'rent_plan_receivable_restatement',
    'receivable_restatement_equity',
    'merchandise_recovery_repayment',
    'bike_recovery_repayment',
    'credit_draw_repayment',
    'smartphone_advance_receivable',
    'agent_advance_disbursement',
    'agent_advance_access_fee_charged',
    'agent_advance_registration_fee_charged',
    'agent_advance_fee_revenue',
    'agent_advance_penalty_accrued',
    'agent_advance_penalty_unearned',
    'agent_advance_access_fee_collected',
    'agent_advance_registration_fee_collected',
    'agent_advance_written_off',
    'agent_advance_access_fee_written_off',
    'agent_advance_registration_fee_written_off',
    'agent_advance_reversed',
    'agent_advance_clawback',
    'agent_advance_late_fee_income',
    'agent_advance_access_fee_collected_external',
    'agent_advance_registration_fee_collected_external',
    'agent_advance_penalty_accrued_external',
    -- Landlord Float Pool (20260929160000, 20260929180000, 20260929240000)
    'landlord_pool_reserve_self_support',
    'landlord_pool_reserve_company_managed',
    'landlord_pool_reserve_source',
    'landlord_pool_topup_self_support',
    'landlord_pool_topup_company_managed',
    'landlord_pool_compound_self_support',
    'landlord_pool_compound_company_managed',
    'landlord_pool_deploy_self_support',
    'landlord_pool_deploy_company_managed',
    'landlord_pool_deploy_target',
    'landlord_pool_return_self_support',
    'landlord_pool_return_company_managed',
    'landlord_pool_return_source',
    'landlord_pool_release_self_support',
    'landlord_pool_release_company_managed',
    'landlord_pool_release_target'
  ]::text[]) || ARRAY['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',
                       'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment']::text[]) || ARRAY['special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',
                       'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income']::text[];
$function$;

DROP TRIGGER trg_merch_stock_issue_insert ON public.merchandise_sales;
DROP TRIGGER trg_merch_stock_issue_status ON public.merchandise_sales;
DROP FUNCTION public.trg_merch_stock_issue_event();
DROP FUNCTION public.cfo_post_merchandise_stock_recognition(uuid, text, text);
DROP FUNCTION public._merch_stock_queue(uuid, text);
DROP FUNCTION public._merch_post_stock_recognition(uuid, text, text, uuid);
DROP FUNCTION public._merch_stock_receivable_due(uuid);
ALTER TABLE public.merchandise_accounting_controls DROP COLUMN stock_issue_counterpart;
DELETE FROM public.ledger_account_map m WHERE m.category IN ('merchandise_revenue', 'merchandise_advance_memo_offset')
  AND NOT EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.category = m.category);
DO $post$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_disburse_smartphone_order(uuid, numeric, text)'))
       IS DISTINCT FROM 'a3642e31906685a7cee1dbea3462ea1e'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.apply_smartphone_roi_pledge(uuid, numeric, text)'))
       IS DISTINCT FROM '74ae9dca248b4b92e6e81a3bd472d997'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.ledger_category_allowlist()'))
       IS DISTINCT FROM 'd1b408552ac7f96bb3b84a286261c7fd' THEN
    RAISE EXCEPTION 'rollback post-check failed';
  END IF;
END $post$;
