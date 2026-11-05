-- Verbatim production copies (read-only export 2026-11-04 via pg_get_functiondef, project byrzshwlentqvktcksem) for
-- src/test/merchandiseReceivableControls.test.ts (in addition to scripts/fixtures/merch-a12a13-prod-2026-11-04.sql). md5(prosrc):
--   cfo_disburse_bike_lease(uuid,numeric,text)              5cf5ce0d544f197672ea0c9f6a87b322
--   cfo_issue_boutique_order(uuid)                          5f70e9460916a188ae592b62b5e59a59
--   agent_pay_merchandise_plan(uuid,numeric)                ecb3442334c8489213d4b5f7aa8cad89
--   reject_merchandise_purchase(uuid,text)                  9c600e7ca173a01d46c28bd5ba1456ca
--   merchandise_sale_cascade_recovery()                     6fb061bdb07e1bc3335584ace6c1d8df
--   _merch_bike_day(uuid,boolean,date)                      4376546b4fc22b52a7d5ff0183099d99
--   _merch_create_plan_for_sale(uuid)                       7168097936ea23221848305dd14e6593
--   _spiro_month_days(date,integer)                         594448e8f3246a188d86298da8860b75
--   _spiro_lease_month(numeric,integer,integer)             8fa6abe89d47d1e5e8dd7504da6ea34b
--   _spiro_lease_fee_total(numeric,integer)                 64abe6f4eb02ba514a14ddd81632dd41
--   _smartphone_recovery_split(uuid,numeric,date)           679dbcb343a41b6d6fe4cd005b9d6f63
--   _smartphone_recovery_split_safe(uuid,numeric,date)      decb6400590313e77fd2ddf3ed7ffd54
--   merchandise_plan_ineligible_reason(uuid)                44555b63befb3652e1bb7be108505bb6
--   merchandise_plan_recovery_eligible(uuid)                fd52204a0662a4353f1e1fb32c278ad2
--   smartphone_reducing_schedule(numeric,integer,date)      ac1512654e75942c484476f638c6dca2
--   smartphone_monthly_charge_pct()                         6060215fb2566ff5d868d0b98c5c259b

CREATE OR REPLACE FUNCTION public.cfo_disburse_bike_lease(p_sale_id uuid, p_valuation numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_sale public.merchandise_sales;
  v_valuation numeric;
  v_recover numeric;
  v_term integer;
  v_projection numeric;
  v_fee numeric;
  v_total numeric;
  v_customer uuid;
  v_name text;
  v_ref text;
  v_group uuid;
  v_supplier uuid;
  v_supplier_name text;
BEGIN

  IF auth.uid() IS NOT NULL AND NOT public.is_cfo_approver(auth.uid()) THEN
    RAISE EXCEPTION 'This request could not be completed';
  END IF;
  IF NOT public.can_cfo_disburse_bike_leases(v_uid) THEN
    RAISE EXCEPTION 'Not authorized to release Spiro bikes';
  END IF;

  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF COALESCE(v_sale.order_status, 'submitted') <> 'coo_approved' THEN
    RAISE EXCEPTION 'Application must be COO approved before disbursement (currently %)', COALESCE(v_sale.order_status, 'submitted');
  END IF;

  v_customer := v_sale.customer_id;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'Application has no linked agent account';
  END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_customer;

  -- Bike funds go to the assigned company supplier, never to the agent (leaseholder).
  v_supplier := v_sale.supplier_id;
  IF v_supplier IS NULL THEN
    RAISE EXCEPTION 'Assign the company supplier who procures this bike before releasing funds';
  END IF;
  IF v_supplier = v_customer THEN
    RAISE EXCEPTION 'The supplier and the leasing agent cannot be the same person';
  END IF;
  SELECT full_name INTO v_supplier_name FROM public.profiles WHERE id = v_supplier;

  -- Always the COO-approved price; any price the CFO sends (p_valuation) is ignored.
  v_valuation := COALESCE(NULLIF(v_sale.valuation_amount, 0), NULLIF(v_sale.total_amount, 0), v_sale.total_revenue, 0);
  IF v_valuation <= 0 THEN
    RAISE EXCEPTION 'Bike valuation must be greater than zero';
  END IF;
  -- No payments may exist before release; refuse and say what was found.
  IF COALESCE(v_sale.amount_paid, 0) > 0
     OR EXISTS (SELECT 1 FROM public.merchandise_recovery_plans p
                WHERE p.sale_id = p_sale_id AND (COALESCE(p.amount_recovered,0) > 0
                  OR EXISTS (SELECT 1 FROM public.merchandise_recovery_deductions d WHERE d.plan_id = p.id))) THEN
    RAISE EXCEPTION 'Release blocked: this bike lease already has payments recorded before release (UGX %). Resolve them first.',
      to_char(GREATEST(COALESCE(v_sale.amount_paid,0), COALESCE((SELECT sum(amount_recovered) FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id),0)), 'FM999,999,999,990.##');
  END IF;
  v_recover := v_valuation;
  IF v_recover <= 0 THEN
    RAISE EXCEPTION 'Lease has no amount to recover';
  END IF;
  v_term := GREATEST(COALESCE(v_sale.lease_term_months, 12), 1);
  v_projection := (SELECT m.daily FROM public._spiro_lease_month(v_valuation, v_term, 1) m);
  -- Bike price + 28% monthly fee on the principal still owed (matches src/lib/spiroBikeLease.ts).
  v_fee := public._spiro_lease_fee_total(v_valuation, v_term);
  v_total := v_recover + v_fee;

  v_ref := 'bike-lease-supplier-payment-' || p_sale_id::text;

  IF EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = 'bike-lease-disbursement-' || p_sale_id::text) THEN
    RAISE EXCEPTION 'This bike lease was already paid out under the old agent-wallet method';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = v_ref) THEN
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_supplier, 'amount', v_valuation, 'direction', 'cash_in',
          'category', 'wallet_deposit', 'ledger_scope', 'wallet', 'recipient_type', 'user',
          'wallet_bucket', 'withdrawable', 'source_table', 'merchandise_sales', 'source_id', p_sale_id,
          'reference_id', v_ref, 'currency', 'UGX',
          'description', 'Bike lease supplier payment for ' || COALESCE(v_name, 'agent'),
          'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', v_uid, 'amount', v_valuation, 'direction', 'cash_out',
          'category', 'equipment_expense', 'ledger_scope', 'platform',
          'source_table', 'merchandise_sales', 'source_id', p_sale_id,
          'reference_id', v_ref, 'currency', 'UGX',
          'description', 'Bike purchased from ' || COALESCE(v_supplier_name, 'supplier') || ' for ' || COALESCE(v_name, 'agent'),
          'transaction_date', now()
        )
      ),
      v_ref
    );
  END IF;

  UPDATE public.merchandise_sales
  SET order_status = 'approved',
      valuation_amount = v_valuation,
      total_amount = v_valuation,
      total_revenue = v_valuation,
      unit_price = v_valuation / GREATEST(COALESCE(quantity, 1), 1),
      amount_outstanding = v_total,
      payment_projection = v_projection,
      lease_daily_rate = NULL,
      payment_status = 'credit',
      cfo_disbursed_by = v_uid,
      cfo_disbursed_at = now(),
      disbursed_amount = v_valuation,
      disbursement_group_id = COALESCE(v_group, disbursement_group_id),
      lease_activated_at = now(),
      notes = COALESCE(notes, '') || ' | CFO paid supplier ' || COALESCE(v_supplier_name, v_supplier::text) || ' and activated the agent lease '
              || to_char(now(), 'YYYY-MM-DD HH24:MI')
              || ' at valuation ' || to_char(v_valuation, 'FM999,999,999')
              || COALESCE(' - ' || NULLIF(btrim(p_note), ''), '')
  WHERE id = p_sale_id;

  -- Bikes never use daily_rate (always 0); recovery uses the bike schedule only.
  IF NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id) THEN
    INSERT INTO public.merchandise_recovery_plans (
      sale_id, customer_id, customer_name, customer_phone, item_name,
      original_amount, outstanding_balance, daily_rate, created_by,
      pricing_basis, fee_total, principal_total, is_bike_lease
    ) VALUES (
      p_sale_id, v_customer, COALESCE(v_name, v_sale.client_name), v_sale.client_phone,
      COALESCE(v_sale.item_name, 'Welile Spiro Bike'), v_total, v_total, 0, v_uid,
      'spiro_28pct_v2', v_fee, v_recover, true
    );
  ELSE
    UPDATE public.merchandise_recovery_plans
    SET original_amount = v_total,
        outstanding_balance = v_total,
        is_bike_lease = true,
        daily_rate = 0,
        pricing_basis = 'spiro_28pct_v2',
        fee_total = v_fee,
        principal_total = v_recover,
        fee_recovered = 0,
        principal_recovered = 0,
        status = 'active',
        completed_at = NULL,
        recovery_started_on = NULL, due_accrued_through = NULL, due_balance = 0, term_end_on = NULL,
        last_success_on = NULL, last_attempt_on = NULL, last_attempt_result = NULL,
        daily_amount_fixed = NULL, miss_alert_sent = false
    WHERE sale_id = p_sale_id AND status <> 'cancelled';
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_uid, 'bike_lease_cfo_disbursed', 'merchandise_sales', p_sale_id,
            'CFO paid the bike funds to the assigned company supplier and activated the agent recovery lease',
            jsonb_build_object('valuation', v_valuation, 'cfo_sent_valuation_ignored', p_valuation,
                               'recovery_amount', v_total, 'principal', v_recover, 'access_fee', v_fee,
                               'monthly_rate_pct', 28, 'lease_term_months', v_term,
                               'leaseholder_agent_id', v_customer, 'supplier_id', v_supplier, 'reference_id', v_ref));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'order_status', 'approved',
    'valuation', v_valuation,
    'recovery_amount', v_total,
    'principal', v_recover,
    'access_fee', v_fee,
    'daily_recovery', v_projection,
    'monthly_rate_pct', 28,
    'lease_term_months', v_term,
    'leaseholder_agent_id', v_customer,
    'supplier_id', v_supplier,
    'supplier_name', v_supplier_name,
    'disbursement_group_id', v_group
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.cfo_issue_boutique_order(p_sale_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_sale record; v_ref text; v_group uuid; v_amt numeric; v_name text;
BEGIN
  IF NOT public.can_act_pinned_finance_action(auth.uid()) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can give final approval and issue boutique orders';
  END IF;
  SELECT * INTO v_sale FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF public.agent_product_category(v_sale.item_name) <> 'boutique' THEN RAISE EXCEPTION 'Not a boutique order'; END IF;
  IF v_sale.order_status IN ('issued','completed','awaiting_handover') THEN RETURN p_sale_id; END IF;
  IF v_sale.order_status <> 'coo_approved' THEN
    RAISE EXCEPTION 'Order must be approved by the COO first (status: %)', v_sale.order_status;
  END IF;

  IF v_sale.fulfilment_type = 'outsourced' THEN
    IF v_sale.customer_id IS NULL THEN RAISE EXCEPTION 'Order has no linked agent account'; END IF;
    v_amt := COALESCE(NULLIF(v_sale.amount_outstanding,0), v_sale.total_revenue, 0);
    IF v_amt <= 0 THEN RAISE EXCEPTION 'Order amount is missing'; END IF;
    SELECT full_name INTO v_name FROM public.profiles WHERE id = v_sale.customer_id;
    v_ref := 'merch-outsourced-disburse-' || p_sale_id::text;
    IF NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE reference_id = v_ref) THEN
      v_group := public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', v_sale.customer_id, 'amount', v_amt, 'direction', 'cash_in',
            'category', 'wallet_deposit', 'ledger_scope', 'wallet', 'recipient_type', 'user',
            'wallet_bucket', 'withdrawable', 'source_table', 'merchandise_sales', 'source_id', p_sale_id,
            'reference_id', v_ref, 'currency', 'UGX',
            'description', 'Merchandise funds to buy ' || COALESCE(v_sale.item_name,'item'), 'transaction_date', now()),
          jsonb_build_object('user_id', auth.uid(), 'amount', v_amt, 'direction', 'cash_out',
            'category', 'equipment_expense', 'ledger_scope', 'platform',
            'source_table', 'merchandise_sales', 'source_id', p_sale_id,
            'reference_id', v_ref, 'currency', 'UGX',
            'description', 'Out-sourced merchandise funds for ' || COALESCE(v_name,'agent') || ' - ' || COALESCE(v_sale.item_name,'item'),
            'transaction_date', now())
        ), v_ref);
    END IF;
    UPDATE public.merchandise_sales
    SET order_status = 'issued', cfo_disbursed_by = auth.uid(), cfo_disbursed_at = now(),
        disbursed_amount = v_amt, disbursement_group_id = COALESCE(v_group, disbursement_group_id), updated_at = now()
    WHERE id = p_sale_id;
    PERFORM public._merch_create_plan_for_sale(p_sale_id);
  ELSE
    UPDATE public.merchandise_sales
    SET order_status = 'issued', cfo_disbursed_by = auth.uid(), cfo_disbursed_at = now(), updated_at = now()
    WHERE id = p_sale_id;
  END IF;

  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, subject_id, entity_type, entity_id, metadata)
    VALUES ('merchandise.boutique_cfo_issued', auth.uid(), v_sale.customer_id, 'merchandise_sales', p_sale_id,
            jsonb_build_object('item_name', v_sale.item_name, 'total', v_sale.total_revenue, 'fulfilment_type', v_sale.fulfilment_type));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN p_sale_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.agent_pay_merchandise_plan(p_plan_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_plan    record;
  v_uid     uuid := auth.uid();
  v_avail   numeric;
  v_amount  numeric;
  v_closing numeric;
  v_ref     uuid := gen_random_uuid();
  v_idem    text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  SELECT * INTO v_plan
  FROM public.merchandise_recovery_plans
  WHERE id = p_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
  END IF;

  IF v_plan.customer_id <> v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_your_plan');
  END IF;

  IF v_plan.status <> 'active' OR COALESCE(v_plan.outstanding_balance, 0) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'plan_not_active');
  END IF;
  IF NOT public.merchandise_plan_recovery_eligible(v_plan.id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'order_not_eligible',
      'reason', public.merchandise_plan_ineligible_reason(v_plan.id));
  END IF;

  v_amount := floor(COALESCE(p_amount, 0));
  IF v_amount < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;

  v_avail := GREATEST(0, COALESCE(public.get_user_available_balance(v_uid), 0));
  IF v_avail < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_funds', 'available', v_avail);
  END IF;

  -- Never take more than is owed, and never more than is actually available.
  v_amount := LEAST(v_amount, v_plan.outstanding_balance, v_avail);
  IF v_amount < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_funds', 'available', v_avail);
  END IF;

  v_idem := 'merch_manual_' || v_plan.id::text || '_' || v_amount::bigint::text
            || '_' || to_char(now(), 'YYYYMMDDHH24MI');

  PERFORM public.create_ledger_transaction(
    entries => jsonb_build_array(
      jsonb_build_object(
        'user_id', v_uid,
        'ledger_scope', 'wallet',
        'direction', 'cash_out',
        'amount', v_amount,
        'category', 'agent_repayment',
        'recipient_type', 'user',
        'wallet_bucket', 'withdrawable',
        'source_table', 'merchandise_recovery_plans',
        'source_id', v_plan.id,
        'description', 'Merchandise Payment - ' || COALESCE(v_plan.item_name, 'Item') || ' (paid by agent)',
        'currency', 'UGX',
        'metadata', jsonb_build_object(
          'source', 'merchandise_manual_payment',
          'plan_id', v_plan.id,
          'sale_id', v_plan.sale_id
        )
      ),
      jsonb_build_object(
        'user_id', v_uid,
        'ledger_scope', 'platform',
        'direction', 'cash_in',
        'amount', v_amount,
        'category', CASE WHEN COALESCE(v_plan.item_name, '') ILIKE '%bike%' THEN 'bike_recovery_repayment' ELSE 'merchandise_recovery_repayment' END,
        'recipient_type', 'operational_wallet',
        'source_table', 'merchandise_recovery_plans',
        'source_id', v_plan.id,
        'description', 'Merchandise cost recovered from agent wallet: ' || COALESCE(v_plan.item_name, 'Item'),
        'currency', 'UGX',
        'metadata', jsonb_build_object(
          'source', 'merchandise_manual_payment',
          'plan_id', v_plan.id,
          'sale_id', v_plan.sale_id,
          'from_customer', v_uid,
          'item_name', v_plan.item_name
        )
      )
    ),
    idempotency_key => v_idem
  );

  v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);

  INSERT INTO public.merchandise_recovery_deductions (
    plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after, transaction_ref
  ) VALUES (
    v_plan.id, v_uid, v_plan.item_name, v_amount, v_avail, v_closing, v_ref
  );

  UPDATE public.merchandise_recovery_plans
  SET outstanding_balance = v_closing,
      amount_recovered = COALESCE(amount_recovered, 0) + v_amount,
      last_recovery_at = now(),
      status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
      completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END,
      updated_at = now()
  WHERE id = v_plan.id;

  IF v_plan.sale_id IS NOT NULL THEN
    UPDATE public.merchandise_sales
    SET amount_paid = COALESCE(amount_paid, 0) + v_amount,
        amount_outstanding = v_closing,
        payment_status = CASE WHEN v_closing <= 0 THEN 'paid' ELSE 'partial' END,
        updated_at = now()
    WHERE id = v_plan.sale_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'amount_paid', v_amount,
    'outstanding_after', v_closing,
    'completed', v_closing <= 0,
    'item_name', v_plan.item_name
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reject_merchandise_purchase(p_sale_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid          uuid := auth.uid();
  v_sale         record;
  v_plan         record;
  v_refund       numeric := 0;
  v_path         text;
  v_tid          uuid := gen_random_uuid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_uid, 'cmo'::app_role)
    OR public.has_role(v_uid, 'manager'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role)
    OR public.has_role(v_uid, 'coo'::app_role)
    OR public.has_role(v_uid, 'cfo'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only CMO, COO, CFO, Manager, or Super Admin can reject purchase requests';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A rejection reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_sale
  FROM public.merchandise_sales
  WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  -- Idempotent
  IF v_sale.order_status = 'rejected' THEN
    RETURN jsonb_build_object(
      'sale_id', v_sale.id,
      'already_rejected', true,
      'refunded', 0
    );
  END IF;

  IF v_sale.order_status NOT IN ('submitted','processing','pending_approval','ops_approved','coo_approved') THEN
    RAISE EXCEPTION 'Only submitted, processing, pending_approval or ops_approved orders can be rejected (current: %)', v_sale.order_status;
  END IF;

  IF v_sale.customer_id IS NULL THEN
    RAISE EXCEPTION 'This sale has no linked customer wallet to refund';
  END IF;

  -- Detect refund path via recovery plan
  SELECT * INTO v_plan
  FROM public.merchandise_recovery_plans
  WHERE sale_id = v_sale.id
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    v_path   := 'recovery_plan';
    v_refund := COALESCE(v_plan.amount_recovered, 0);

    -- Cancel the plan
    UPDATE public.merchandise_recovery_plans
    SET status = 'cancelled',
        outstanding_balance = 0,
        updated_at = now()
    WHERE id = v_plan.id;
  ELSE
    v_path   := 'instant';
    v_refund := COALESCE(v_sale.total_revenue, 0);
  END IF;

  -- Refund the wallet via balanced ledger legs (only when there is money to move back)
  IF v_refund > 0 THEN
    PERFORM public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'user_id', v_sale.customer_id,
          'ledger_scope', 'wallet',
          'direction', 'cash_in',
          'amount', v_refund,
          'category', 'system_balance_correction',
          'recipient_type', 'user',
          'wallet_bucket', 'withdrawable',
          'source_table', 'merchandise_sales',
          'source_id', v_sale.id,
          'description', 'Merchandise Purchase Refund – ' || v_sale.item_name,
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'source', 'merchandise_purchase_reject',
            'sale_id', v_sale.id,
            'refund_path', v_path,
            'rejected_by', v_uid,
            'reason', p_reason
          )
        ),
        jsonb_build_object(
          'user_id', v_sale.customer_id,
          'ledger_scope', 'platform',
          'direction', 'cash_out',
          'amount', v_refund,
          'category', 'system_balance_correction',
          'recipient_type', 'operational_wallet',
          'source_table', 'merchandise_sales',
          'source_id', v_sale.id,
          'description', 'Merchandise Purchase Refund – ' || v_sale.item_name,
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'source', 'merchandise_purchase_reject',
            'sale_id', v_sale.id,
            'refund_path', v_path,
            'rejected_by', v_uid,
            'reason', p_reason
          )
        )
      ),
      idempotency_key => 'merch_reject_' || v_sale.id::text,
      skip_balance_check => true
    );
  END IF;

  -- Mark the sale rejected
  UPDATE public.merchandise_sales
  SET order_status       = 'rejected',
      rejection_reason   = p_reason,
      rejected_by        = v_uid,
      rejected_at        = now(),
      amount_outstanding = 0,
      updated_at         = now()
  WHERE id = v_sale.id;

  -- Audit trail
  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, reason, metadata
  ) VALUES (
    v_uid,
    'merchandise_purchase_rejected',
    'merchandise_sales',
    v_sale.id,
    p_reason,
    jsonb_build_object(
      'refund_path', v_path,
      'refunded', v_refund,
      'item_name', v_sale.item_name,
      'customer_id', v_sale.customer_id
    )
  );

  -- System event (best-effort — do not fail the reject if the events table
  -- validator rejects the payload)
  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, metadata)
    VALUES (
      'merchandise.purchase_rejected',
      v_uid,
      jsonb_build_object(
        'sale_id', v_sale.id,
        'customer_id', v_sale.customer_id,
        'item_name', v_sale.item_name,
        'refunded', v_refund,
        'refund_path', v_path,
        'reason', p_reason
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'sale_id', v_sale.id,
    'refunded', v_refund,
    'refund_path', v_path,
    'already_rejected', false
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.merchandise_sale_cascade_recovery()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.merchandise_recovery_deductions d
   WHERE d.plan_id IN (
     SELECT p.id FROM public.merchandise_recovery_plans p WHERE p.sale_id = OLD.id
   );

  DELETE FROM public.merchandise_recovery_plans p
   WHERE p.sale_id = OLD.id;

  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public._merch_bike_day(p_sale_id uuid, p_v2 boolean, p_day date)
 RETURNS TABLE(daily numeric, fee_ratio numeric, term_end date, active boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE l record; a date; m int; inst numeric; fee numeric; ver int; mx int; v_starts date; v_base numeric; v_dim int;
BEGIN
  SELECT id, lease_activated_at, valuation_amount, GREATEST(COALESCE(lease_term_months,12),1) AS term
    INTO l FROM public.agent_bike_leases WHERE sale_id = p_sale_id;
  IF l.id IS NULL OR l.lease_activated_at IS NULL THEN active := false; RETURN NEXT; RETURN; END IF;
  SELECT starts_on INTO v_starts FROM public.merchandise_recovery_plans
   WHERE sale_id = p_sale_id AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1;
  a := COALESCE(v_starts, (l.lease_activated_at AT TIME ZONE 'Africa/Kampala')::date + 2);
  -- Strict flat 30-day lease months; calendar month length (28/29/31) is never used.
  term_end := a + 30 * l.term;
  IF p_day < a THEN active := false; RETURN NEXT; RETURN; END IF;
  active := true;
  m := LEAST(((p_day - a) / 30) + 1, l.term);
  v_dim := ((p_day - a) % 30) + 1;  -- day 1..30 within the lease month
  IF p_v2 THEN
    SELECT x.total_due, x.fee_due INTO inst, fee FROM public._spiro_lease_month(l.valuation_amount, l.term, m) x;
    fee_ratio := CASE WHEN COALESCE(inst,0) > 0 THEN fee / inst ELSE 0 END;
  ELSE
    SELECT max(version) INTO ver FROM public.agent_bike_lease_schedules WHERE lease_id = l.id;
    SELECT max(installment_no) INTO mx FROM public.agent_bike_lease_schedules WHERE lease_id = l.id AND version = ver;
    SELECT installment_amount INTO inst FROM public.agent_bike_lease_schedules
      WHERE lease_id = l.id AND version = ver AND installment_no = LEAST(m, COALESCE(mx, 1));
    fee_ratio := 0;
  END IF;
  -- Daily cap = instalment / 30. Day 30 takes the rounding remainder so the
  -- month accrues exactly the instalment, then the next month starts afresh.
  v_base := GREATEST(round(COALESCE(inst,0) / 30), 0);
  IF v_dim = 30 THEN
    daily := GREATEST(round(COALESCE(inst,0)) - 29 * v_base, 0);
  ELSE
    daily := v_base;
  END IF;
  RETURN NEXT;
END $function$;

CREATE OR REPLACE FUNCTION public._merch_create_plan_for_sale(p_sale_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE s public.merchandise_sales; v_plan uuid; v_name text; v_rate numeric;
BEGIN
  SELECT * INTO s FROM public.merchandise_sales WHERE id = p_sale_id;
  IF s.id IS NULL OR s.customer_id IS NULL OR COALESCE(s.amount_outstanding,0) <= 0 THEN RETURN NULL; END IF;
  SELECT id INTO v_plan FROM public.merchandise_recovery_plans WHERE sale_id = p_sale_id LIMIT 1;
  IF v_plan IS NOT NULL THEN RETURN v_plan; END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = s.customer_id;
  v_rate := CASE WHEN COALESCE(s.payment_plan,'full') = 'installment' THEN 0.25 ELSE 0.15 END;
  INSERT INTO public.merchandise_recovery_plans (sale_id, customer_id, customer_name, customer_phone, item_name,
    original_amount, outstanding_balance, daily_rate, created_by)
  VALUES (s.id, s.customer_id, COALESCE(v_name, s.client_name), s.client_phone, s.item_name,
    s.amount_outstanding, s.amount_outstanding, v_rate, COALESCE(auth.uid(), s.created_by))
  RETURNING id INTO v_plan;
  RETURN v_plan;
END $function$;

CREATE OR REPLACE FUNCTION public._spiro_month_days(p_start date, p_month integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$ SELECT 30 $function$;

CREATE OR REPLACE FUNCTION public._spiro_lease_month(p_base numeric, p_term integer, p_month integer)
 RETURNS TABLE(opening_principal numeric, principal_due numeric, fee_due numeric, total_due numeric, daily numeric)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE n int := LEAST(GREATEST(COALESCE(p_term,1),1),24); base numeric := GREATEST(round(COALESCE(p_base,0)),0);
  k int := LEAST(GREATEST(p_month,1), LEAST(GREATEST(COALESCE(p_term,1),1),24));
BEGIN
  -- Exact slice base/n (not rounded up). Fee = 28% of principal still owed at the start of the month.
  opening_principal := base * (n - k + 1) / n;
  principal_due := base / n;
  fee_due := opening_principal * 0.28;
  total_due := principal_due + fee_due;
  -- Quote for a lease starting today (Kampala). Live recovery uses the lease's own start date.
  daily := round(total_due / public._spiro_month_days((now() AT TIME ZONE 'Africa/Kampala')::date, k));
  RETURN NEXT;
END $function$;

CREATE OR REPLACE FUNCTION public._spiro_lease_fee_total(p_base numeric, p_term integer)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT round(GREATEST(round(COALESCE(p_base,0)),0) * 0.28 * (LEAST(GREATEST(COALESCE(p_term,1),1),24) + 1) / 2.0)
$function$;

CREATE OR REPLACE FUNCTION public._smartphone_recovery_split(p_plan_id uuid, p_amount numeric, p_on date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
-- Accounting split of ONE smartphone recovery (CFO decision 2026-11-03): principal -> A12, monthly charge -> R1.
-- Reads only; posts nothing. The charge share is the share of charge in the schedule month that contains p_on
-- (charge_due / total_due), the same rule the bike engine uses (_merch_bike_day fee_ratio). Schedule, in order:
--   1. the stored schedule (smartphone_repayment_schedules) when it adds up to the plan's original_amount;
--   2. otherwise the schedule rebuilt with smartphone_reducing_schedule(principal, months, starts_on) for the
--      number of months (1-12) whose total equals original_amount (plans with no or stale stored rows);
--   3. otherwise one average ratio (original_amount - principal) / original_amount;
--   4. no principal known: everything is principal.
-- Caps, from this plan's earlier recoveries in the ledger (source merchandise_recovery_plans): charge never exceeds
-- the schedule's charges still unrecognised; principal never exceeds the principal still unrecovered while charges
-- remain, so a plan that is paid off has recognised exactly its principal and its charges.
DECLARE
  v_plan record; v_base numeric; v_m int; v_i int; v_n int := 0; v_rows jsonb; v_basis text; v_row jsonb;
  v_amount numeric := round(COALESCE(p_amount, 0));
  v_charges numeric; v_principal_total numeric; v_ratio numeric := 0;
  v_prior_charge numeric := 0; v_prior_principal numeric := 0;
  v_charge numeric; v_principal numeric; v_rem_p numeric; v_shift numeric;
BEGIN
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('principal', 0, 'charge', 0, 'basis', 'nothing', 'ratio', 0);
  END IF;
  SELECT p.id, p.sale_id, p.original_amount, p.starts_on, s.disbursed_amount, s.total_revenue
    INTO v_plan
  FROM public.merchandise_recovery_plans p LEFT JOIN public.merchandise_sales s ON s.id = p.sale_id
  WHERE p.id = p_plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'smartphone recovery split: plan % not found', p_plan_id;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('ps', r.period_start, 'pe', r.period_end, 'c', r.charge_due, 't', r.total_due,
                                      'p', r.principal_due) ORDER BY r.month_index), count(*)
    INTO v_rows, v_n
  FROM public.smartphone_repayment_schedules r WHERE r.sale_id = v_plan.sale_id;
  IF v_n > 0 AND (SELECT sum((e->>'t')::numeric) FROM jsonb_array_elements(v_rows) e) = v_plan.original_amount THEN
    v_basis := 'stored_schedule';
  ELSE
    v_rows := NULL;
    v_base := COALESCE(NULLIF(v_plan.disbursed_amount, 0), NULLIF(v_plan.total_revenue, 0));
    IF v_base > 0 AND v_plan.starts_on IS NOT NULL THEN
      FOR v_i IN 1..12 LOOP
        v_m := v_i;
        SELECT jsonb_agg(jsonb_build_object('ps', s.period_start, 'pe', s.period_end, 'c', s.charge_due, 't', s.total_due,
                                            'p', s.principal_due) ORDER BY s.month_index)
          INTO v_rows
        FROM public.smartphone_reducing_schedule(v_base, v_i, v_plan.starts_on) s;
        EXIT WHEN (SELECT sum((e->>'t')::numeric) FROM jsonb_array_elements(v_rows) e) = v_plan.original_amount;
        v_rows := NULL;
      END LOOP;
    END IF;
    IF v_rows IS NOT NULL THEN
      v_basis := 'rebuilt_schedule_' || v_m || 'm';
    ELSIF v_base > 0 AND v_plan.original_amount > v_base THEN
      v_basis := 'plan_average';
      v_rows := jsonb_build_array(jsonb_build_object('ps', NULL, 'pe', NULL, 'c', v_plan.original_amount - v_base,
                                                     't', v_plan.original_amount, 'p', v_base));
    ELSE
      v_basis := 'no_charge_known';
      v_rows := jsonb_build_array(jsonb_build_object('ps', NULL, 'pe', NULL, 'c', 0, 't', v_amount, 'p', v_amount));
    END IF;
  END IF;

  SELECT e INTO v_row FROM jsonb_array_elements(v_rows) WITH ORDINALITY x(e, i)
  WHERE e->>'ps' IS NULL OR p_on BETWEEN (e->>'ps')::date AND (e->>'pe')::date
  ORDER BY i LIMIT 1;
  IF v_row IS NULL THEN
    v_row := CASE WHEN p_on < (v_rows->0->>'ps')::date THEN v_rows->0 ELSE v_rows->-1 END;
  END IF;
  IF COALESCE((v_row->>'t')::numeric, 0) > 0 THEN
    v_ratio := (v_row->>'c')::numeric / (v_row->>'t')::numeric;
  END IF;
  SELECT sum((e->>'c')::numeric), sum((e->>'p')::numeric) INTO v_charges, v_principal_total
  FROM jsonb_array_elements(v_rows) e;
  IF v_basis = 'no_charge_known' THEN v_principal_total := NULL; END IF;

  SELECT COALESCE(sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END)
                    FILTER (WHERE g.category = 'access_fee_collected'), 0),
         COALESCE(sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END)
                    FILTER (WHERE g.category = 'merchandise_recovery_repayment'), 0)
    INTO v_prior_charge, v_prior_principal
  FROM public.general_ledger g
  WHERE g.source_table = 'merchandise_recovery_plans' AND g.source_id = p_plan_id AND g.ledger_scope = 'platform'
    AND g.category IN ('access_fee_collected', 'merchandise_recovery_repayment');

  v_charge := LEAST(round(v_amount * v_ratio), GREATEST(v_charges - v_prior_charge, 0));
  v_principal := v_amount - v_charge;
  IF v_principal_total IS NOT NULL THEN
    v_rem_p := GREATEST(v_principal_total - v_prior_principal, 0);
    IF v_principal > v_rem_p THEN
      v_shift := LEAST(v_principal - v_rem_p, GREATEST(v_charges - v_prior_charge - v_charge, 0));
      v_charge := v_charge + v_shift;
      v_principal := v_principal - v_shift;
    END IF;
  END IF;
  RETURN jsonb_build_object('principal', v_principal, 'charge', v_charge, 'basis', v_basis, 'ratio', v_ratio,
                            'charges_total', v_charges, 'principal_total', v_principal_total,
                            'prior_charge', v_prior_charge, 'prior_principal', v_prior_principal);
END $function$;

CREATE OR REPLACE FUNCTION public._smartphone_recovery_split_safe(p_plan_id uuid, p_amount numeric, p_on date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
-- The split for the live recovery paths: if the split cannot be worked out, the whole amount goes to A12 (principal)
-- so a collection never fails or changes because of accounting. Outcome is visible in the returned basis.
DECLARE v jsonb;
BEGIN
  BEGIN
    v := public._smartphone_recovery_split(p_plan_id, p_amount, p_on);
    IF (v->>'principal')::numeric < 0 OR (v->>'charge')::numeric < 0
       OR (v->>'principal')::numeric + (v->>'charge')::numeric <> round(COALESCE(p_amount, 0)) THEN
      RAISE EXCEPTION 'inconsistent split %', v;
    END IF;
    RETURN v;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('principal', round(COALESCE(p_amount, 0)), 'charge', 0, 'basis', 'fallback: ' || SQLERRM, 'ratio', 0);
  END;
END $function$;

CREATE OR REPLACE FUNCTION public.merchandise_plan_ineligible_reason(p_plan_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p.id IS NULL THEN 'plan_not_found'
    WHEN p.status <> 'active' THEN 'plan_not_active'
    WHEN COALESCE(p.outstanding_balance,0) <= 0 THEN 'nothing_outstanding'
    WHEN p.sale_id IS NULL THEN NULL
    WHEN s.id IS NULL THEN 'order_missing'
    WHEN s.order_status NOT IN ('approved','processing','issued','completed') THEN 'order_' || COALESCE(s.order_status,'unknown')
    WHEN s.fulfilment_type = 'company_issued' AND s.handed_over_at IS NULL THEN 'awaiting_handover'
    WHEN s.fulfilment_type = 'outsourced' AND s.cfo_disbursed_at IS NULL THEN 'awaiting_cfo_disbursement'
    ELSE NULL END
  FROM (SELECT p_plan_id AS id) x
  LEFT JOIN public.merchandise_recovery_plans p ON p.id = x.id
  LEFT JOIN public.merchandise_sales s ON s.id = p.sale_id
$function$;

CREATE OR REPLACE FUNCTION public.merchandise_plan_recovery_eligible(p_plan_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE id = p_plan_id)
     AND public.merchandise_plan_ineligible_reason(p_plan_id) IS NULL
$function$;

CREATE OR REPLACE FUNCTION public.smartphone_reducing_schedule(p_amount numeric, p_months integer, p_start date DEFAULT CURRENT_DATE)
 RETURNS TABLE(month_index integer, period_start date, period_end date, days_in_period integer, opening_principal numeric, principal_due numeric, charge_due numeric, total_due numeric, daily_deduction numeric)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_amount numeric := GREATEST(0, round(COALESCE(p_amount, 0)));
  v_months integer := COALESCE(p_months, 12);
  v_start date := COALESCE(p_start, current_date);
  v_rate numeric := public.smartphone_monthly_charge_pct();
  v_per numeric;
  v_open numeric;
  v_m integer;
  v_ps date;
  v_ns date;
BEGIN
  IF v_months NOT BETWEEN 1 AND 12 THEN
    RETURN;
  END IF;
  IF v_amount <= 0 THEN
    RETURN;
  END IF;

  v_per := floor(v_amount / v_months);
  v_open := v_amount;

  FOR v_m IN 1..v_months LOOP
    v_ps := v_start + ((v_m - 1) || ' months')::interval;
    v_ns := v_start + (v_m || ' months')::interval;

    month_index := v_m;
    period_start := v_ps;
    period_end := v_ns - 1;
    days_in_period := GREATEST(1, (v_ns - v_ps));
    opening_principal := v_open;
    principal_due := CASE WHEN v_m = v_months THEN v_open ELSE v_per END;
    charge_due := round(v_open * v_rate / 100);
    total_due := principal_due + charge_due;
    daily_deduction := ceil(total_due / days_in_period);

    RETURN NEXT;

    v_open := v_open - principal_due;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.smartphone_monthly_charge_pct()
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT 28::numeric
$function$;
