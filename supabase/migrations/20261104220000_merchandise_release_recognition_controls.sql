-- 2026-11-04: merchandise release recognition controls (CFO rule 2026-11-04: every release of money for merchandise on
-- behalf of an agent is recognised at once, in full, as a receivable - A13 for motorcycles, A12 for other merchandise -
-- linked to the responsible agent, never twice, and reduced by recoveries). Production apply needs explicit CFO approval.
-- ACCOUNTING ONLY: the money each payout moves (wallet legs, amounts, recipients), order / plan / lease rows and statuses,
-- recoveries and deductions are exactly as before. Existing ledger entries are not touched.
-- Production check 2026-11-04 (read-only): the three payout routes already recognise the full release in the payout's own
-- transaction (smartphone and out-sourced boutique -> A12, motorcycle -> A13) with no proof-of-purchase gate, and recoveries
-- credit the same account (A12 / A13 principal, R1 charges). What changes:
--   1. The receivable leg carries the agent / leaseholder (merchandise_sales.customer_id), not the approving CFO
--      (cfo_disburse_smartphone_order, cfo_disburse_bike_lease: auth.uid(); cfo_issue_boutique_order: auth.uid()). The
--      approver stays on the order (cfo_disbursed_by) and in audit_logs.
--   2. Duplicates: with the agent on the leg, the existing unique index uq_general_ledger_reference_dedupe
--      (user_id, category, reference_id, direction, ledger_scope) refuses a second recognition of the same release at the
--      database, on top of each function's one-reference-per-order guard.
--   3. The account follows the product (_merch_release_receivable_category): motorcycle -> bike_recovery_repayment (A13),
--      anything else -> smartphone_advance_receivable (A12), whichever payout route is used.
-- Rollback: supabase/rollbacks/20261104220000_merchandise_release_recognition_controls.rollback.sql (production definitions).
-- Tests: src/test/spiroBikeReleaseA13.test.ts. TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_disburse_smartphone_order(uuid, numeric, text)'))
       IS DISTINCT FROM '2034e5c247e2cf8eacfbd5573873f3f3'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_disburse_bike_lease(uuid, numeric, text)'))
       IS DISTINCT FROM '4fa8771db4ab7e0cbf0c47b34cbcbcf0'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_issue_boutique_order(uuid)'))
       IS DISTINCT FROM 'f9f0e813de2f65be67b864dde6b733a4' THEN
    RAISE EXCEPTION 'release controls: production payout definitions differ from 2026-11-04 - re-read before applying';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_general_ledger_reference_dedupe') THEN
    RAISE EXCEPTION 'release controls: uq_general_ledger_reference_dedupe missing';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public._merch_release_receivable_category(p_item_name text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- the receivable a merchandise release opens: motorcycles in A13 (bike_recovery_repayment), everything else in A12
  -- (smartphone_advance_receivable). The same classifier the Agent Products pages use.
  SELECT CASE WHEN public.agent_product_category(p_item_name) = 'motor_bike' THEN 'bike_recovery_repayment'
              ELSE 'smartphone_advance_receivable' END
$function$;
REVOKE ALL ON FUNCTION public._merch_release_receivable_category(text) FROM PUBLIC, anon, authenticated;

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
      -- 2026-11-04 (CFO): the phone is given to the agent on credit, so its cost is the receivable (A12), not an
      -- expense (X1). The supplier's wallet credit is unchanged.
      -- 2026-11-04 (CFO release rule): the receivable is the agent's (not the approver's) and its account follows the
      -- product - A13 for a motorcycle, A12 for anything else.
      jsonb_build_object(
        'user_id', v_agent, 'amount', v_price, 'direction', 'cash_out',
        'category', public._merch_release_receivable_category(v_sale.item_name), 'ledger_scope', 'platform',
        'source_table', 'merchandise_sales', 'source_id', p_sale_id,
        'reference_id', v_ref, 'currency', 'UGX',
        'description', 'Smartphone receivable (A12): phone bought from ' || COALESCE(v_supplier_name, 'supplier')
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
        -- 2026-11-04 (CFO): the advance shown on the agent's wallet (advance_credit) is a display of what the agent owes,
        -- not money owed to the agent; offset it in L1. The receivable is recognised once, in the supplier group above.
        jsonb_build_object(
          'user_id', v_agent, 'amount', v_price, 'direction', 'cash_out',
          'category', 'merchandise_advance_memo_offset', 'ledger_scope', 'platform',
          'source_table', 'merchandise_sales', 'source_id', p_sale_id,
          'reference_id', v_adv_ref, 'currency', 'UGX',
          'description', 'Offset of the smartphone advance shown on ' || COALESCE(v_agent_name, 'agent')
                         || '''s wallet (not money owed to the agent)',
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
        -- 2026-11-04 (CFO release rule): the receivable is the leaseholder agent's (not the approver's); motorcycle -> A13.
        jsonb_build_object(
          'user_id', v_customer, 'amount', v_valuation, 'direction', 'cash_out',
          'category', public._merch_release_receivable_category(v_sale.item_name), 'ledger_scope', 'platform',
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
          -- 2026-11-04 (CFO release rule): the receivable is the agent's (not the approver's); account by product.
          jsonb_build_object('user_id', v_sale.customer_id, 'amount', v_amt, 'direction', 'cash_out',
            'category', public._merch_release_receivable_category(v_sale.item_name), 'ledger_scope', 'platform',
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

DO $post$
BEGIN
  IF public._merch_release_receivable_category('Welile Spiro Bike') <> 'bike_recovery_repayment'
     OR public._merch_release_receivable_category('Welile Smartphone') <> 'smartphone_advance_receivable'
     OR public._merch_release_receivable_category('waiting chair') <> 'smartphone_advance_receivable' THEN
    RAISE EXCEPTION 'release controls: account routing post-check failed';
  END IF;
  IF has_function_privilege('authenticated', 'public._merch_release_receivable_category(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'release controls: helper must not be callable by app users';
  END IF;
END $post$;
