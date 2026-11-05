-- 2026-11-04: Merchandise receivable controls (A12 / A13) - so the 3-4 Nov corrections never recur. Production apply
-- needs explicit CFO approval. ORDER: apply 20261104090000_merchandise_a12_a13_corrections FIRST (the preflight refuses
-- otherwise, and 20261104090000 refuses once this is applied, because both pin the CFO report functions).
-- ACCOUNTING ONLY: wallet legs, amounts taken or paid, who is paid, order / plan statuses and eligibility are unchanged.
--   1. cfo_disburse_bike_lease: the bike price paid to the supplier is posted DR A13 (bike_recovery_repayment, the leg
--      cfo_cancel_bike_lease and correction J3 use) instead of DR X1 equipment_expense. Supplier wallet leg unchanged.
--   2. cfo_issue_boutique_order (out-sourced): the funds paid to the agent are posted DR A12 (smartphone_advance_receivable,
--      as correction J2 and the smartphone payout) instead of DR X1. Agent wallet leg unchanged.
--   3. agent_pay_merchandise_plan: the platform leg is split - principal to A12 / A13 (same categories as before), the
--      charge to R1 access_fee_collected (smartphone / scheduled plans: the smartphone split; v2 bike leases: the bike
--      engine's fee ratio, and the plan's fee_recovered / principal_recovered are kept as the engine keeps them).
--      Wallet leg, amount, deductions, plan / order balances and statuses unchanged.
--   4. Rejection, cancellation or deletion of an order / plan that still carries an A12 / A13 receivable or customer cash
--      is queued in merchandise_receivable_derecognitions in the same transaction (all paths: triggers), with the
--      receivable left, the cash collected (possible refund - flagged, never paid) and an audit_logs row. The counterpart
--      is a CFO decision: cfo_post_merchandise_derecognition(review, 'E3' | 'X4', reason) posts exactly what is left,
--      once (key merch_recv_derecog:<review>). merchandise_accounting_controls.auto_derecognition_counterpart (starts
--      NULL) lets the CFO make one standing choice so rejections / cancellations post automatically.
--   5. The CFO "Money received" reports skip the derecognition groups (they move no money).
-- Not changed (CFO decisions, see the report): smartphone payout (X1 + L1 advance credit), company-stock issue (no
-- counterpart decided), Returns-pledge eligibility (operational).
-- Rollback: supabase/rollbacks/20261104100000_merchandise_receivable_controls.rollback.sql (functions and triggers; the tables and any posted entries stay).
-- Tests: src/test/merchandiseReceivableControls.test.ts. TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
BEGIN
  -- the one-off corrections (20261104090000) come first: they install the report versions pinned here
  IF (SELECT count(DISTINCT transaction_group_id) FROM public.general_ledger
      WHERE left(COALESCE(idempotency_key, ''), 34) = 'merch_a12_a13_correction_20261104:') <> 27 THEN
    RAISE EXCEPTION 'merchandise controls: apply 20261104090000_merchandise_a12_a13_corrections first';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_disburse_bike_lease(uuid, numeric, text)'))
       IS DISTINCT FROM '5cf5ce0d544f197672ea0c9f6a87b322'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_issue_boutique_order(uuid)'))
       IS DISTINCT FROM '5f70e9460916a188ae592b62b5e59a59'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.agent_pay_merchandise_plan(uuid, numeric)'))
       IS DISTINCT FROM 'ecb3442334c8489213d4b5f7aa8cad89'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_agent_products_breakdown(date, date)'))
       IS DISTINCT FROM 'fb673e6c61738bdb1c25359fe605b06b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_page(date, date, text, text, text, integer, integer)'))
       IS DISTINCT FROM '6ff0d64da4142b425c0022663fcb0643'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_totals(date, date)'))
       IS DISTINCT FROM '7cb4ad64e743816e8130e398735b30c6'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.create_ledger_transaction(jsonb, text, boolean)'))
       IS DISTINCT FROM '8e570ba579b151ac17788c0ee668a93b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.sofp_ledger_legs(timestamp with time zone)'))
       IS DISTINCT FROM '843ccf477014f8c7a8e0b5c6f14a1ba0'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_bike_day(uuid, boolean, date)'))
       IS DISTINCT FROM '4376546b4fc22b52a7d5ff0183099d99'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._smartphone_recovery_split_safe(uuid, numeric, date)'))
       IS DISTINCT FROM 'decb6400590313e77fd2ddf3ed7ffd54'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.merchandise_sale_cascade_recovery()'))
       IS DISTINCT FROM '6fb061bdb07e1bc3335584ace6c1d8df' THEN
    RAISE EXCEPTION 'merchandise controls: preflight refused - a function differs from the production definition of 2026-11-04';
  END IF;
  IF (SELECT count(*) FROM public.ledger_account_map m WHERE m.wallet_bucket IS NULL AND (m.ledger_scope, m.category, m.account_code, m.debit_when) IN (
        ('platform', 'bike_recovery_repayment', 'A13', 'cash_out'),
        ('platform', 'smartphone_advance_receivable', 'A12', 'cash_out'),
        ('platform', 'merchandise_recovery_repayment', 'A12', 'cash_out'),
        ('platform', 'access_fee_collected', 'R1', 'cash_out'),
        ('platform', 'receivable_restatement_equity', 'E3', 'cash_in'),
        ('bridge', 'merchandise_recovery_receivable_opening', 'A12', 'cash_in'),
        ('bridge', 'bike_recovery_receivable_opening', 'A13', 'cash_in'),
        ('platform', 'platform_loss_writeoff', 'X4', 'cash_out'))) <> 8
     OR EXISTS (SELECT 1 FROM public.ledger_account_map m WHERE m.wallet_bucket IS NOT NULL AND m.category IN ('bike_recovery_repayment', 'smartphone_advance_receivable', 'merchandise_recovery_repayment', 'access_fee_collected', 'receivable_restatement_equity', 'merchandise_recovery_receivable_opening', 'bike_recovery_receivable_opening', 'platform_loss_writeoff'))
     OR NOT (public.ledger_category_allowlist() @> ARRAY['bike_recovery_repayment', 'smartphone_advance_receivable', 'merchandise_recovery_repayment', 'access_fee_collected', 'receivable_restatement_equity', 'merchandise_recovery_receivable_opening', 'bike_recovery_receivable_opening', 'platform_loss_writeoff']) THEN
    RAISE EXCEPTION 'merchandise controls: ledger_account_map / allowlist not as expected';
  END IF;
  IF to_regclass('public.merchandise_receivable_derecognitions') IS NOT NULL OR to_regclass('public.merchandise_accounting_controls') IS NOT NULL THEN
    RAISE EXCEPTION 'merchandise controls: already applied';
  END IF;
  IF to_regprocedure('public.has_role(uuid, app_role)') IS NULL OR to_regprocedure('public.staff_mfa_ok()') IS NULL THEN
    RAISE EXCEPTION 'merchandise controls: has_role(uuid, app_role) / staff_mfa_ok() missing';
  END IF;
END $pre$;

-- ---------------------------------------------------------------- 1-3. payouts and manual payments
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
        -- 2026-11-04 (CFO): the bike is leased to the agent, so its price is a receivable (A13), not an expense (X1).
        jsonb_build_object(
          'user_id', v_uid, 'amount', v_valuation, 'direction', 'cash_out',
          'category', 'bike_recovery_repayment', 'ledger_scope', 'platform',
          'source_table', 'merchandise_sales', 'source_id', p_sale_id,
          'reference_id', v_ref, 'currency', 'UGX',
          'description', 'Bike lease receivable (A13): bike bought from ' || COALESCE(v_supplier_name, 'supplier') || ' for ' || COALESCE(v_name, 'agent'),
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
          -- 2026-11-04 (CFO): the agent repays these funds, so they are a receivable (A12), not an expense (X1).
          jsonb_build_object('user_id', auth.uid(), 'amount', v_amt, 'direction', 'cash_out',
            'category', 'smartphone_advance_receivable', 'ledger_scope', 'platform',
            'source_table', 'merchandise_sales', 'source_id', p_sale_id,
            'reference_id', v_ref, 'currency', 'UGX',
            'description', 'Out-sourced merchandise receivable (A12) for ' || COALESCE(v_name,'agent') || ' - ' || COALESCE(v_sale.item_name,'item'),
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
  v_split   jsonb; v_prin numeric; v_fee numeric; v_v2 boolean;
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

  -- 2026-11-04 (CFO): principal -> A12 / A13, charge -> R1 (was: the whole payment to A12 / A13). Wallet leg unchanged.
  v_split := public._merch_manual_split_safe(v_plan.id, v_amount, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_prin := (v_split->>'principal')::numeric;
  v_fee := (v_split->>'charge')::numeric;
  v_v2 := COALESCE(v_plan.item_name, '') ILIKE '%bike%' AND COALESCE(v_plan.pricing_basis, '') = 'spiro_28pct_v2';

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
        'amount', v_prin,
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
    ) - CASE WHEN v_prin > 0 THEN 99 ELSE 1 END  -- drop the principal leg (index 1) only when the whole payment is charge
      || CASE WHEN v_fee > 0 THEN jsonb_build_array(jsonb_build_object(
        'user_id', v_uid, 'ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_fee,
        'category', 'access_fee_collected', 'recipient_type', 'operational_wallet',
        'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id,
        'description', 'Merchandise charge collected from agent wallet: ' || COALESCE(v_plan.item_name, 'Item'),
        'currency', 'UGX')) ELSE '[]'::jsonb END,
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
      -- v2 bike leases track principal and fee recovered (as the daily bike engine does) so its fee cap stays right
      fee_recovered = CASE WHEN v_v2 THEN COALESCE(fee_recovered, 0) + v_fee ELSE fee_recovered END,
      principal_recovered = CASE WHEN v_v2 THEN COALESCE(principal_recovered, 0) + v_prin ELSE principal_recovered END,
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

-- ---------------------------------------------------------------- 4. derecognition review queue + controls
CREATE TABLE public.merchandise_accounting_controls (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- NULL (default): every event is queued for the CFO; 'E3' or 'X4': post automatically with that counterpart.
  auto_derecognition_counterpart text CHECK (auto_derecognition_counterpart IN ('E3', 'X4')),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
INSERT INTO public.merchandise_accounting_controls (id) VALUES (true);
COMMENT ON TABLE public.merchandise_accounting_controls IS
  'Merchandise receivable controls. auto_derecognition_counterpart is a CFO decision (NULL = queue every event for the CFO).';
ALTER TABLE public.merchandise_accounting_controls ENABLE ROW LEVEL SECURITY;
CREATE POLICY cfo_reads_merch_accounting_controls ON public.merchandise_accounting_controls FOR SELECT TO authenticated
  USING ((select public.has_role((select auth.uid()), 'cfo'::app_role)) OR (select public.has_role((select auth.uid()), 'ceo'::app_role))
      OR (select public.has_role((select auth.uid()), 'coo'::app_role)) OR (select public.has_role((select auth.uid()), 'super_admin'::app_role)));
create policy mfa_required_for_staff on public.merchandise_accounting_controls as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
REVOKE ALL ON public.merchandise_accounting_controls FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.merchandise_accounting_controls TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchandise_accounting_controls TO service_role;

CREATE TABLE public.merchandise_receivable_derecognitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL,                       -- the order (sale) id, or the plan id when the plan has no order
  sale_id uuid, plan_ids uuid[] NOT NULL DEFAULT '{}',
  item_name text, customer_id uuid, is_bike boolean NOT NULL DEFAULT false,
  events jsonb NOT NULL DEFAULT '[]',             -- [{event, at, by, status}] rejection / cancellation / deletion
  a12_net numeric NOT NULL DEFAULT 0,             -- receivable still in A12 for the subject when queued / posted
  a13_net numeric NOT NULL DEFAULT 0,
  cash_collected_net numeric NOT NULL DEFAULT 0,  -- customer payments on the subject less refunds recorded on it
  flags text[] NOT NULL DEFAULT '{}',             -- receivable_open, credit_balance, possible_refund, deleted
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'no_action')),
  counterpart text CHECK (counterpart IN ('E3', 'X4')),
  ledger_group_id uuid, idempotency_key text,
  decided_by uuid, decided_at timestamptz, decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX merchandise_receivable_derecognitions_one_pending
  ON public.merchandise_receivable_derecognitions (subject_id) WHERE status = 'pending';
COMMENT ON TABLE public.merchandise_receivable_derecognitions IS
  'One row per merchandise order / plan that was rejected, cancelled or deleted while carrying an A12 / A13 receivable or '
  'customer cash: what is left, whether a refund may be due, and how the CFO derecognised it. Written only by the '
  'merchandise receivable controls (20261104100000).';
ALTER TABLE public.merchandise_receivable_derecognitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY cfo_reads_merch_receivable_derecognitions ON public.merchandise_receivable_derecognitions FOR SELECT TO authenticated
  USING ((select public.has_role((select auth.uid()), 'cfo'::app_role)) OR (select public.has_role((select auth.uid()), 'ceo'::app_role))
      OR (select public.has_role((select auth.uid()), 'coo'::app_role)) OR (select public.has_role((select auth.uid()), 'super_admin'::app_role)));
create policy mfa_required_for_staff on public.merchandise_receivable_derecognitions as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
REVOKE ALL ON public.merchandise_receivable_derecognitions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.merchandise_receivable_derecognitions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchandise_receivable_derecognitions TO service_role;

-- The A12 / A13 receivable still carried by an order and its plans, resolved as the balance sheet does
-- (sofp_ledger_legs: base mapping, plus platform agent_repayment from a plan -> A12, or A13 for a bike), and the
-- customer cash taken on them less refunds recorded on them.
CREATE OR REPLACE FUNCTION public._merch_receivable_net(p_sale uuid, p_plans uuid[], p_bike boolean)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH legs AS (
    SELECT g.ledger_scope sc, g.category cat, g.source_table src, g.direction dir, g.amount amt, g.wallet_bucket bk,
           g.transaction_group_id gid, g.classification cls
    FROM public.general_ledger g
    WHERE (g.source_table = 'merchandise_sales' AND g.source_id = p_sale)
       OR (g.source_table = 'merchandise_recovery_plans' AND g.source_id = ANY (COALESCE(p_plans, '{}')))
  ), acc AS (
    SELECT l.*,
      CASE WHEN l.sc = 'platform' AND l.cat = 'agent_repayment' AND l.src = 'merchandise_recovery_plans'
           THEN CASE WHEN p_bike THEN 'A13' ELSE 'A12' END
           ELSE COALESCE(mb.account_code, mw.account_code) END AS acct,
      COALESCE(mb.debit_when, mw.debit_when, 'cash_in') AS dw,
      CASE WHEN l.gid IS NULL THEN l.cls IN ('production', 'legacy_real')
           ELSE EXISTS (SELECT 1 FROM public.general_ledger x WHERE x.transaction_group_id = l.gid
                        AND x.classification IN ('production', 'legacy_real')) END AS reportable
    FROM legs l
    LEFT JOIN public.ledger_account_map mb ON mb.ledger_scope = l.sc AND mb.category = l.cat
         AND mb.wallet_bucket IS NOT NULL AND mb.wallet_bucket = l.bk
    LEFT JOIN public.ledger_account_map mw ON mw.ledger_scope = l.sc AND mw.category = l.cat AND mw.wallet_bucket IS NULL
  )
  SELECT jsonb_build_object(
    'a12', COALESCE(sum(CASE WHEN dir = dw THEN amt ELSE -amt END) FILTER (WHERE reportable AND acct = 'A12'), 0),
    'a13', COALESCE(sum(CASE WHEN dir = dw THEN amt ELSE -amt END) FILTER (WHERE reportable AND acct = 'A13'), 0),
    'cash', COALESCE(sum(CASE WHEN dir = 'cash_out' THEN amt ELSE -amt END)
              FILTER (WHERE sc = 'wallet' AND cat IN ('agent_repayment', 'system_balance_correction')), 0))
  FROM acc
$function$;

-- Post (or close) one queued derecognition: recomputes what is left now and removes exactly that, against the counterpart
-- the CFO chose. E3 = receivable restatement equity (a receivable that should never have been recognised: goods not
-- delivered, legacy restatement); X4 = loss write-off (a genuine receivable that will not be collected).
CREATE OR REPLACE FUNCTION public._merch_post_derecognition(p_review uuid, p_counterpart text, p_note text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_plans uuid[]; v_net jsonb; v_entries jsonb := '[]'::jsonb; v_key text; v_group uuid;
  v_acct text; v_amt numeric; v_src_table text; v_src uuid; v_desc text;
BEGIN
  IF p_counterpart NOT IN ('E3', 'X4') THEN RAISE EXCEPTION 'counterpart must be E3 or X4'; END IF;
  SELECT * INTO r FROM public.merchandise_receivable_derecognitions WHERE id = p_review FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'derecognition % not found', p_review; END IF;
  IF r.status <> 'pending' THEN
    RETURN jsonb_build_object('id', r.id, 'status', r.status, 'ledger_group_id', r.ledger_group_id, 'already', true);
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x), '{}') INTO v_plans
  FROM unnest(r.plan_ids || COALESCE((SELECT array_agg(p.id) FROM public.merchandise_recovery_plans p WHERE p.sale_id = r.sale_id), '{}')) x;
  v_net := public._merch_receivable_net(r.sale_id, v_plans, r.is_bike);
  v_src_table := CASE WHEN r.sale_id IS NOT NULL THEN 'merchandise_sales' ELSE 'merchandise_recovery_plans' END;
  v_src := COALESCE(r.sale_id, r.subject_id);
  v_key := 'merch_recv_derecog:' || r.id::text;
  FOREACH v_acct IN ARRAY ARRAY['A12', 'A13'] LOOP
    v_amt := (v_net->>lower(v_acct))::numeric;
    CONTINUE WHEN v_amt = 0;
    v_desc := 'Receivable derecognised (' || v_acct || ', CFO ' || CASE p_counterpart WHEN 'E3' THEN 'restatement' ELSE 'write-off' END
              || '): ' || COALESCE(r.item_name, 'merchandise') || ' - ' || COALESCE(p_note, '');
    -- a positive balance is removed with a credit to the receivable; a credit balance with a debit
    IF p_counterpart = 'E3' THEN
      v_entries := v_entries || jsonb_build_array(
        jsonb_build_object('ledger_scope', 'platform', 'category', 'receivable_restatement_equity',
          'direction', CASE WHEN v_amt > 0 THEN 'cash_in' ELSE 'cash_out' END, 'amount', abs(v_amt),
          'source_table', v_src_table, 'source_id', v_src, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc),
        jsonb_build_object('ledger_scope', 'bridge',
          'category', CASE v_acct WHEN 'A12' THEN 'merchandise_recovery_receivable_opening' ELSE 'bike_recovery_receivable_opening' END,
          'direction', CASE WHEN v_amt > 0 THEN 'cash_out' ELSE 'cash_in' END, 'amount', abs(v_amt),
          'source_table', v_src_table, 'source_id', v_src, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc));
    ELSE
      v_entries := v_entries || jsonb_build_array(
        jsonb_build_object('ledger_scope', 'platform', 'category', 'platform_loss_writeoff',
          'direction', CASE WHEN v_amt > 0 THEN 'cash_out' ELSE 'cash_in' END, 'amount', abs(v_amt),
          'source_table', v_src_table, 'source_id', v_src, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc),
        jsonb_build_object('ledger_scope', 'platform',
          'category', CASE v_acct WHEN 'A12' THEN 'merchandise_recovery_repayment' ELSE 'bike_recovery_repayment' END,
          'direction', CASE WHEN v_amt > 0 THEN 'cash_in' ELSE 'cash_out' END, 'amount', abs(v_amt),
          'source_table', v_src_table, 'source_id', v_src, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc));
    END IF;
  END LOOP;
  IF jsonb_array_length(v_entries) > 0 THEN
    v_group := public.create_ledger_transaction(entries => v_entries, idempotency_key => v_key);
  END IF;
  UPDATE public.merchandise_receivable_derecognitions
  SET status = CASE WHEN v_group IS NULL THEN 'no_action' ELSE 'posted' END,
      counterpart = CASE WHEN v_group IS NULL THEN NULL ELSE p_counterpart END,
      a12_net = (v_net->>'a12')::numeric, a13_net = (v_net->>'a13')::numeric,
      ledger_group_id = v_group, idempotency_key = CASE WHEN v_group IS NULL THEN NULL ELSE v_key END,
      decided_by = p_actor, decided_at = now(), decision_note = p_note, updated_at = now()
  WHERE id = r.id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (p_actor, 'merchandise_receivable_derecognised', 'merchandise_receivable_derecognitions', r.id::text, p_note,
          jsonb_build_object('subject_id', r.subject_id, 'sale_id', r.sale_id, 'plan_ids', v_plans, 'counterpart', p_counterpart,
                             'a12', v_net->'a12', 'a13', v_net->'a13', 'ledger_group_id', v_group, 'idempotency_key', v_key));
  RETURN jsonb_build_object('id', r.id, 'status', CASE WHEN v_group IS NULL THEN 'no_action' ELSE 'posted' END,
    'ledger_group_id', v_group, 'a12', v_net->'a12', 'a13', v_net->'a13', 'counterpart', p_counterpart);
END $function$;

-- Queue (and, if the CFO set a standing counterpart, post) the receivable left on an order / plan that was rejected,
-- cancelled or deleted. Runs inside the operation's own transaction. Nothing is queued when nothing is left.
CREATE OR REPLACE FUNCTION public._merch_receivable_event(p_sale uuid, p_plan uuid, p_event text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_subject uuid := COALESCE(p_sale, p_plan); v_plans uuid[]; v_item text; v_customer uuid; v_bike boolean;
  v_net jsonb; v_a12 numeric; v_a13 numeric; v_cash numeric; v_row record; v_flags text[]; v_auto text; v_id uuid;
  v_ev jsonb;
BEGIN
  IF v_subject IS NULL THEN RETURN; END IF;
  SELECT COALESCE(array_agg(p.id), '{}') INTO v_plans FROM public.merchandise_recovery_plans p
  WHERE (p_sale IS NOT NULL AND p.sale_id = p_sale) OR p.id = p_plan;
  IF p_plan IS NOT NULL AND NOT p_plan = ANY (v_plans) THEN v_plans := v_plans || p_plan; END IF;
  SELECT s.item_name, s.customer_id INTO v_item, v_customer FROM public.merchandise_sales s WHERE s.id = p_sale;
  IF v_item IS NULL THEN
    SELECT p.item_name, p.customer_id INTO v_item, v_customer FROM public.merchandise_recovery_plans p
    WHERE p.id = ANY (v_plans) ORDER BY p.created_at LIMIT 1;
  END IF;
  -- bike or not exactly as the balance-sheet resolver decides it (agent_product_category of the plan's item)
  v_bike := EXISTS (SELECT 1 FROM public.merchandise_recovery_plans p WHERE p.id = ANY (v_plans)
                    AND public.agent_product_category(p.item_name) = 'motor_bike');
  SELECT * INTO v_row FROM public.merchandise_receivable_derecognitions
  WHERE subject_id = v_subject AND status = 'pending' FOR UPDATE;
  IF FOUND THEN
    SELECT COALESCE(array_agg(DISTINCT x), '{}') INTO v_plans FROM unnest(v_row.plan_ids || v_plans) x;
  END IF;
  v_net := public._merch_receivable_net(p_sale, v_plans, v_bike);
  v_a12 := (v_net->>'a12')::numeric; v_a13 := (v_net->>'a13')::numeric; v_cash := (v_net->>'cash')::numeric;
  IF v_row.id IS NULL AND v_a12 = 0 AND v_a13 = 0 AND v_cash <= 0 THEN RETURN; END IF;
  v_flags := '{}';
  IF v_a12 <> 0 OR v_a13 <> 0 THEN v_flags := v_flags || 'receivable_open'::text; END IF;
  IF v_a12 < 0 OR v_a13 < 0 THEN v_flags := v_flags || 'credit_balance'::text; END IF;
  IF v_cash > 0 THEN v_flags := v_flags || 'possible_refund'::text; END IF;
  IF p_event LIKE '%deleted' THEN v_flags := v_flags || 'deleted'::text; END IF;
  v_ev := jsonb_build_object('event', p_event, 'at', now(), 'by', auth.uid());
  IF v_row.id IS NULL THEN
    INSERT INTO public.merchandise_receivable_derecognitions (subject_id, sale_id, plan_ids, item_name, customer_id, is_bike,
      events, a12_net, a13_net, cash_collected_net, flags)
    VALUES (v_subject, p_sale, v_plans, v_item, v_customer, COALESCE(v_bike, false), jsonb_build_array(v_ev),
      v_a12, v_a13, v_cash, v_flags)
    RETURNING id INTO v_id;
  ELSE
    v_id := v_row.id;
    UPDATE public.merchandise_receivable_derecognitions
    SET plan_ids = v_plans, events = events || v_ev, a12_net = v_a12, a13_net = v_a13, cash_collected_net = v_cash,
        -- flags describe the subject now; 'deleted' is kept once seen
        flags = ARRAY(SELECT DISTINCT f FROM unnest(v_flags || CASE WHEN 'deleted' = ANY (flags) THEN ARRAY['deleted'] ELSE '{}'::text[] END) f ORDER BY 1),
        is_bike = is_bike OR COALESCE(v_bike, false), updated_at = now()
    WHERE id = v_id;
  END IF;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 'merchandise_receivable_event', 'merchandise_receivable_derecognitions', v_id::text, p_event,
          jsonb_build_object('subject_id', v_subject, 'sale_id', p_sale, 'plan_id', p_plan, 'a12', v_a12, 'a13', v_a13,
                             'cash_collected_net', v_cash, 'flags', v_flags));
  SELECT auto_derecognition_counterpart INTO v_auto FROM public.merchandise_accounting_controls WHERE id;
  IF v_auto IS NOT NULL AND (v_a12 <> 0 OR v_a13 <> 0) THEN
    PERFORM public._merch_post_derecognition(v_id, v_auto, 'automatic: ' || p_event, auth.uid());
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.trg_merch_receivable_sale_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public._merch_receivable_event(OLD.id, NULL, 'order_deleted');
    RETURN OLD;
  END IF;
  PERFORM public._merch_receivable_event(NEW.id, NULL, 'order_' || NEW.order_status);
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.trg_merch_receivable_plan_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public._merch_receivable_event(OLD.sale_id, OLD.id, 'plan_deleted');
    RETURN OLD;
  END IF;
  PERFORM public._merch_receivable_event(NEW.sale_id, NEW.id, 'plan_cancelled');
  RETURN NEW;
END $function$;

CREATE TRIGGER trg_merch_receivable_sale_status AFTER UPDATE OF order_status ON public.merchandise_sales
  FOR EACH ROW WHEN (OLD.order_status IS DISTINCT FROM NEW.order_status AND NEW.order_status IN ('rejected', 'failed', 'cancelled'))
  EXECUTE FUNCTION public.trg_merch_receivable_sale_event();
CREATE TRIGGER trg_merch_receivable_sale_delete BEFORE DELETE ON public.merchandise_sales
  FOR EACH ROW EXECUTE FUNCTION public.trg_merch_receivable_sale_event();
CREATE TRIGGER trg_merch_receivable_plan_status AFTER UPDATE OF status ON public.merchandise_recovery_plans
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'cancelled')
  EXECUTE FUNCTION public.trg_merch_receivable_plan_event();
CREATE TRIGGER trg_merch_receivable_plan_delete BEFORE DELETE ON public.merchandise_recovery_plans
  FOR EACH ROW EXECUTE FUNCTION public.trg_merch_receivable_plan_event();

-- The CFO's decision on one queued item: E3 (should never have been recognised) or X4 (write-off).
CREATE OR REPLACE FUNCTION public.cfo_post_merchandise_derecognition(p_review_id uuid, p_counterpart text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'cfo'::app_role) OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'Only the CFO can derecognise a merchandise receivable';
  END IF;
  IF p_counterpart IS NULL OR p_counterpart NOT IN ('E3', 'X4') THEN
    RAISE EXCEPTION 'Choose E3 (receivable that should not have been recognised) or X4 (write-off)';
  END IF;
  IF length(btrim(COALESCE(p_note, ''))) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters';
  END IF;
  RETURN public._merch_post_derecognition(p_review_id, p_counterpart, btrim(p_note), auth.uid());
END $function$;

-- Split of a manual payment (agent_pay_merchandise_plan). Smartphones and other scheduled plans: the smartphone split
-- (charge share of the schedule month). Bike leases priced spiro_28pct_v2: the bike engine's fee ratio for the day,
-- capped by the plan's fee_total / principal_total less what is already recovered. Older bike leases: all principal
-- (as the bike engine). On any error: all principal, so a payment never fails or changes because of accounting.
CREATE OR REPLACE FUNCTION public._merch_manual_split_safe(p_plan_id uuid, p_amount numeric, p_on date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE p record; v_ratio numeric := 0; v_active boolean; v_fee numeric; v_prin numeric; v_rem numeric; v_shift numeric;
  v_amount numeric := round(COALESCE(p_amount, 0));
BEGIN
  BEGIN
    SELECT * INTO p FROM public.merchandise_recovery_plans WHERE id = p_plan_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'plan % not found', p_plan_id; END IF;
    IF COALESCE(p.item_name, '') NOT ILIKE '%bike%' THEN
      RETURN public._smartphone_recovery_split_safe(p_plan_id, v_amount, p_on);
    END IF;
    IF COALESCE(p.pricing_basis, '') <> 'spiro_28pct_v2' THEN
      RETURN jsonb_build_object('principal', v_amount, 'charge', 0, 'basis', 'bike_without_fee_split');
    END IF;
    SELECT b.fee_ratio, b.active INTO v_ratio, v_active FROM public._merch_bike_day(p.sale_id, true, p_on) b;
    IF NOT COALESCE(v_active, false) THEN v_ratio := 0; END IF;
    v_fee := LEAST(round(v_amount * COALESCE(v_ratio, 0)), GREATEST(COALESCE(p.fee_total, 0) - COALESCE(p.fee_recovered, 0), 0));
    v_prin := v_amount - v_fee;
    IF p.principal_total IS NOT NULL THEN
      v_rem := GREATEST(p.principal_total - COALESCE(p.principal_recovered, 0), 0);
      IF v_prin > v_rem THEN
        v_shift := LEAST(v_prin - v_rem, GREATEST(COALESCE(p.fee_total, 0) - COALESCE(p.fee_recovered, 0) - v_fee, 0));
        v_fee := v_fee + v_shift; v_prin := v_prin - v_shift;
      END IF;
    END IF;
    IF v_fee < 0 OR v_prin < 0 OR v_fee + v_prin <> v_amount THEN RAISE EXCEPTION 'inconsistent bike split'; END IF;
    RETURN jsonb_build_object('principal', v_prin, 'charge', v_fee, 'basis', 'bike_fee_ratio', 'ratio', v_ratio);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('principal', v_amount, 'charge', 0, 'basis', 'fallback: ' || SQLERRM);
  END;
END $function$;

REVOKE ALL ON FUNCTION public._merch_receivable_net(uuid, uuid[], boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._merch_post_derecognition(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._merch_receivable_event(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_merch_receivable_sale_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_merch_receivable_plan_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._merch_manual_split_safe(uuid, numeric, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cfo_post_merchandise_derecognition(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_post_merchandise_derecognition(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------- 5. Money received reports: skip derecognitions
CREATE OR REPLACE FUNCTION public.get_cfo_received_agent_products_breakdown(p_from date, p_to date)
 RETURNS TABLE(product_key text, product_label text, amount numeric, tx_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_from timestamptz; v_to timestamptz;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023'; END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  RETURN QUERY
  WITH x AS (
    SELECT g.amount,
      public._cfo_received_agent_product_for(g.category, g.source_table, mp.is_bike_lease) AS k
    FROM public.general_ledger g
    LEFT JOIN public.merchandise_recovery_plans mp
      ON g.source_table = 'merchandise_recovery_plans' AND mp.id = g.source_id
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production', 'legacy_real')
      AND left(COALESCE(g.idempotency_key, ''), 30) <> 'smartphone_a10_to_a12_reclass:' -- 2026-11-03: not money received (reclassification)
      AND left(COALESCE(g.idempotency_key, ''), 34) <> 'merch_a12_a13_correction_20261104:' -- 2026-11-04: not money received (merchandise correction)
      AND left(COALESCE(g.idempotency_key, ''), 19) <> 'merch_recv_derecog:' -- 2026-11-04: not money received (receivable derecognition)
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND public._cfo_received_category_for(g.category) = 'agent'
  )
  SELECT x.k,
    CASE x.k WHEN 'smartphone' THEN 'Smartphone recoveries' WHEN 'bike' THEN 'Bike recoveries'
             WHEN 'rejection' THEN 'Rejection charges' ELSE 'Agent advance repayments' END,
    round(sum(x.amount), 2), count(*)
  FROM x GROUP BY x.k ORDER BY 3 DESC;
END $function$;

CREATE OR REPLACE FUNCTION public.get_cfo_received_by_category_page(p_from date, p_to date, p_category text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_type text DEFAULT NULL::text, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, transaction_date timestamp with time zone, created_at timestamp with time zone, category_key text, category_label text, ledger_category text, amount numeric, description text, reference_id text, counterparty text, counterparty_phone text, approved_by text, source_table text, transaction_group_id uuid, classification text, total_matched bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_from timestamptz; v_to timestamptz; v_search text := nullif(btrim(p_search), '');
        v_type text := nullif(btrim(lower(p_type)), '');
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023'; END IF;
  IF v_type IS NOT NULL AND v_type NOT IN ('smartphone', 'bike', 'advance') THEN
    RAISE EXCEPTION 'unknown product type %', p_type USING ERRCODE = '22023';
  END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  RETURN QUERY
  WITH base AS MATERIALIZED (
    SELECT g.id AS gid, g.transaction_date AS tdate, g.category AS c, g.source_table AS s,
           mp.is_bike_lease AS bike
    FROM public.general_ledger g
    LEFT JOIN public.merchandise_recovery_plans mp
      ON v_type IS NOT NULL AND g.source_table = 'merchandise_recovery_plans' AND mp.id = g.source_id
    LEFT JOIN public.profiles sp ON v_search IS NOT NULL AND sp.id = g.user_id
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production', 'legacy_real')
      AND left(COALESCE(g.idempotency_key, ''), 30) <> 'smartphone_a10_to_a12_reclass:' -- 2026-11-03: not money received (reclassification)
      AND left(COALESCE(g.idempotency_key, ''), 34) <> 'merch_a12_a13_correction_20261104:' -- 2026-11-04: not money received (merchandise correction)
      AND left(COALESCE(g.idempotency_key, ''), 19) <> 'merch_recv_derecog:' -- 2026-11-04: not money received (receivable derecognition)
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND (v_search IS NULL OR COALESCE(g.description, '') ILIKE '%' || v_search || '%'
           OR COALESCE(g.reference_id, '') ILIKE '%' || v_search || '%'
           OR COALESCE(g.linked_party, '') ILIKE '%' || v_search || '%'
           OR COALESCE(sp.full_name, '') ILIKE '%' || v_search || '%'
           OR COALESCE(sp.phone, '') ILIKE '%' || v_search || '%')
  ), cmap AS MATERIALIZED (
    SELECT d.c, d.s, public._cfo_received_category_for(d.c, d.s) AS ckey,
           public._cfo_received_category_for(d.c) AS plain
    FROM (SELECT DISTINCT b.c, b.s FROM base b) d
  ), pmap AS MATERIALIZED (
    SELECT d.c, d.s, d.bike, public._cfo_received_agent_product_for(d.c, d.s, d.bike) AS pkey
    FROM (SELECT DISTINCT b.c, b.s, b.bike FROM base b WHERE v_type IS NOT NULL) d
  ), f AS (
    SELECT b.gid, b.tdate, cm.ckey,
           CASE WHEN v_type IS NOT NULL AND cm.plain = 'agent' THEN pm.pkey END AS pkey
    FROM base b
    JOIN cmap cm ON cm.c IS NOT DISTINCT FROM b.c AND cm.s IS NOT DISTINCT FROM b.s
    LEFT JOIN pmap pm ON pm.c IS NOT DISTINCT FROM b.c AND pm.s IS NOT DISTINCT FROM b.s
                     AND pm.bike IS NOT DISTINCT FROM b.bike
  ), m AS (
    SELECT f.gid, f.tdate, f.ckey, count(*) OVER () AS n
    FROM f WHERE f.ckey IS NOT NULL AND (p_category IS NULL OR f.ckey = p_category)
      AND (v_type IS NULL OR f.pkey = v_type)
  ), pg AS (
    SELECT m.gid, m.tdate, m.ckey, m.n FROM m ORDER BY m.tdate DESC, m.gid
    LIMIT least(greatest(COALESCE(p_limit, 50), 1), 1000) OFFSET greatest(COALESCE(p_offset, 0), 0)
  )
  SELECT g.id, g.transaction_date, g.created_at, pg.ckey,
         CASE pg.ckey WHEN 'partner' THEN 'Partner Products and Services' WHEN 'land' THEN 'Tenant Products and Services'
           WHEN 'landlord' THEN 'Landlord Products and Services'
           WHEN 'agent' THEN 'Agent Products and Services' WHEN 'fees' THEN 'Revenue Collected'
           WHEN 'other_income' THEN 'Other Income' WHEN 'capital' THEN 'Share Capital' END,
         g.category, round(g.amount, 2), g.description, g.reference_id,
         COALESCE(cp.full_name, p.full_name), COALESCE(cp.phone, p.phone),
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN p.full_name END,
         g.source_table, g.transaction_group_id, g.classification, pg.n
  FROM pg JOIN public.general_ledger g ON g.id = pg.gid
  LEFT JOIN LATERAL (
    SELECT x.user_id FROM public.general_ledger x
    WHERE x.transaction_group_id = g.transaction_group_id
      AND x.ledger_scope = 'wallet' AND x.direction = 'cash_out' AND x.user_id IS NOT NULL
    ORDER BY x.amount DESC, x.id
    LIMIT 1
  ) cpl ON true
  LEFT JOIN public.profiles cp ON cp.id = cpl.user_id
  LEFT JOIN public.profiles p ON p.id = g.user_id
  ORDER BY pg.tdate DESC, pg.gid;
END $function$;

CREATE OR REPLACE FUNCTION public.get_cfo_received_by_category_totals(p_from date, p_to date)
 RETURNS TABLE(category_key text, category_label text, nature text, sort_order integer, amount numeric, tx_count bigint, pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_from timestamptz; v_to timestamptz;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023'; END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  RETURN QUERY
  WITH raw AS MATERIALIZED (
    SELECT g.category AS c, g.source_table AS s, sum(g.amount) AS amt, count(*) AS n
    FROM public.general_ledger g
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production', 'legacy_real')
      AND left(COALESCE(g.idempotency_key, ''), 30) <> 'smartphone_a10_to_a12_reclass:' -- 2026-11-03: not money received (reclassification)
      AND left(COALESCE(g.idempotency_key, ''), 34) <> 'merch_a12_a13_correction_20261104:' -- 2026-11-04: not money received (merchandise correction)
      AND left(COALESCE(g.idempotency_key, ''), 19) <> 'merch_recv_derecog:' -- 2026-11-04: not money received (receivable derecognition)
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
    GROUP BY g.category, g.source_table
  ), agg AS (
    SELECT public._cfo_received_category_for(r.c, r.s) AS cat_key, sum(r.amt) AS amt, sum(r.n) AS n
    FROM raw r GROUP BY 1
  ), agg2 AS (SELECT * FROM agg WHERE agg.cat_key IS NOT NULL),
  grand AS (SELECT COALESCE(sum(a.amt), 0) AS total FROM agg2 a)
  SELECT f.k, f.l, f.nat, f.s, round(COALESCE(a.amt, 0), 2), COALESCE(a.n, 0)::bigint,
         round(CASE WHEN gr.total > 0 THEN COALESCE(a.amt, 0) * 100 / gr.total ELSE 0 END, 2)
  FROM (VALUES
    ('partner', 'Partner Products and Services', 'capital', 1),
    ('land', 'Tenant Products and Services', 'recovery', 2),
    ('landlord', 'Landlord Products and Services', 'recovery', 3),
    ('agent', 'Agent Products and Services', 'recovery', 4),
    ('fees', 'Revenue Collected', 'income', 5),
    ('other_income', 'Other Income', 'income', 6),
    ('capital', 'Share Capital', 'capital', 7)
  ) AS f(k, l, nat, s)
  LEFT JOIN agg2 a ON a.cat_key = f.k
  CROSS JOIN grand gr
  ORDER BY f.s;
END $function$;

-- ---------------------------------------------------------------- 6. post-checks
DO $post$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_disburse_bike_lease(uuid, numeric, text)'))
       IS DISTINCT FROM '4fa8771db4ab7e0cbf0c47b34cbcbcf0'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_issue_boutique_order(uuid)'))
       IS DISTINCT FROM 'f9f0e813de2f65be67b864dde6b733a4'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.agent_pay_merchandise_plan(uuid, numeric)'))
       IS DISTINCT FROM '33263ebb983d0bcc1be47d4a62f99358'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_agent_products_breakdown(date, date)'))
       IS DISTINCT FROM '450e004ffe39bb905cae0a9e3054e973'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_page(date, date, text, text, text, integer, integer)'))
       IS DISTINCT FROM '2af9c35a580e52a264604bae7de1e9f7'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_totals(date, date)'))
       IS DISTINCT FROM '3dbe067c72c0ba48d0770fa44b88b55b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.create_ledger_transaction(jsonb, text, boolean)'))
       IS DISTINCT FROM '8e570ba579b151ac17788c0ee668a93b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.sofp_ledger_legs(timestamp with time zone)'))
       IS DISTINCT FROM '843ccf477014f8c7a8e0b5c6f14a1ba0'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._merch_bike_day(uuid, boolean, date)'))
       IS DISTINCT FROM '4376546b4fc22b52a7d5ff0183099d99'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._smartphone_recovery_split_safe(uuid, numeric, date)'))
       IS DISTINCT FROM 'decb6400590313e77fd2ddf3ed7ffd54'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.merchandise_sale_cascade_recovery()'))
       IS DISTINCT FROM '6fb061bdb07e1bc3335584ace6c1d8df' THEN
    RAISE EXCEPTION 'merchandise controls: post-check failed (function fingerprints)';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_merch_receivable_sale_status', 'trg_merch_receivable_sale_delete',
        'trg_merch_receivable_plan_status', 'trg_merch_receivable_plan_delete') AND tgenabled = 'O') <> 4 THEN
    RAISE EXCEPTION 'merchandise controls: triggers missing';
  END IF;
  IF has_function_privilege('authenticated', 'public._merch_post_derecognition(uuid, text, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._merch_receivable_event(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._merch_manual_split_safe(uuid, numeric, date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cfo_post_merchandise_derecognition(uuid, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cfo_post_merchandise_derecognition(uuid, text, text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.merchandise_receivable_derecognitions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.merchandise_accounting_controls', 'UPDATE')
     OR has_table_privilege('anon', 'public.merchandise_receivable_derecognitions', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.merchandise_receivable_derecognitions', 'SELECT') THEN
    RAISE EXCEPTION 'merchandise controls: grants not as intended';
  END IF;
  IF (SELECT auto_derecognition_counterpart FROM public.merchandise_accounting_controls WHERE id) IS NOT NULL THEN
    RAISE EXCEPTION 'merchandise controls: the standing counterpart must start unset (CFO decision)';
  END IF;
END $post$;
