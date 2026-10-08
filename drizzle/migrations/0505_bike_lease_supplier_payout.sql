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

CREATE OR REPLACE FUNCTION public.assign_bike_lease_supplier(p_sale_id uuid, p_supplier_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE v_row public.merchandise_sales; v_name text;
BEGIN
  IF NOT public.can_review_bike_leases(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to assign a supplier to bike leases';
  END IF;
  SELECT * INTO v_row FROM public.merchandise_sales WHERE id = p_sale_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Application not found'; END IF;
  IF lower(COALESCE(v_row.item_name, '')) NOT LIKE '%spiro%' THEN
    RAISE EXCEPTION 'This record is not a bike lease application';
  END IF;
  IF v_row.cfo_disbursed_at IS NOT NULL OR COALESCE(v_row.order_status,'') IN ('approved','rejected','cancelled','completed') THEN
    RAISE EXCEPTION 'Supplier can only be changed before the CFO releases funds';
  END IF;
  IF p_supplier_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_supplier_id) THEN
      RAISE EXCEPTION 'Supplier must be a registered platform user';
    END IF;
    IF p_supplier_id = v_row.customer_id THEN
      RAISE EXCEPTION 'The supplier and the leasing agent cannot be the same person';
    END IF;
    SELECT full_name INTO v_name FROM public.profiles WHERE id = p_supplier_id;
  END IF;
  UPDATE public.merchandise_sales SET supplier_id = p_supplier_id, updated_at = now() WHERE id = p_sale_id;
  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (auth.uid(), 'bike_lease_supplier_assigned', 'merchandise_sales', p_sale_id,
            'Assigned the company supplier who procures this bike',
            jsonb_build_object('supplier_id', p_supplier_id, 'previous_supplier_id', v_row.supplier_id));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('sale_id', p_sale_id, 'supplier_id', p_supplier_id, 'supplier_name', v_name);
END $f$;

CREATE OR REPLACE FUNCTION public.get_bike_lease_suppliers(p_sale_ids uuid[])
RETURNS TABLE(sale_id uuid, supplier_id uuid, supplier_name text, supplier_phone text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $f$
BEGIN
  IF NOT public.can_review_bike_leases(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view bike lease suppliers';
  END IF;
  RETURN QUERY SELECT s.id, s.supplier_id, p.full_name, p.phone
  FROM public.merchandise_sales s LEFT JOIN public.profiles p ON p.id = s.supplier_id
  WHERE s.id = ANY(p_sale_ids) AND s.supplier_id IS NOT NULL;
END $f$;

REVOKE ALL ON FUNCTION public.assign_bike_lease_supplier(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_bike_lease_suppliers(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_bike_lease_supplier(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_bike_lease_suppliers(uuid[]) TO authenticated;