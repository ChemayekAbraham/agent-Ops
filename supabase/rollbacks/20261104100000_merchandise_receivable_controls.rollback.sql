-- Rollback of 20261104100000_merchandise_receivable_controls: restores the payout, manual-payment and report functions to their definitions before it
-- (verbatim), drops the triggers and functions. The two tables and any derecognition entries stay (append-only ledger).
SET lock_timeout = '5s';
DROP TRIGGER trg_merch_receivable_sale_status ON public.merchandise_sales;
DROP TRIGGER trg_merch_receivable_sale_delete ON public.merchandise_sales;
DROP TRIGGER trg_merch_receivable_plan_status ON public.merchandise_recovery_plans;
DROP TRIGGER trg_merch_receivable_plan_delete ON public.merchandise_recovery_plans;
DROP FUNCTION public.cfo_post_merchandise_derecognition(uuid, text, text);
DROP FUNCTION public.trg_merch_receivable_sale_event();
DROP FUNCTION public.trg_merch_receivable_plan_event();
DROP FUNCTION public._merch_receivable_event(uuid, uuid, text);
DROP FUNCTION public._merch_post_derecognition(uuid, text, text, uuid);
DROP FUNCTION public._merch_receivable_net(uuid, uuid[], boolean);
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

DROP FUNCTION public._merch_manual_split_safe(uuid, numeric, date);
DO $post$
BEGIN
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
       IS DISTINCT FROM '7cb4ad64e743816e8130e398735b30c6' THEN
    RAISE EXCEPTION 'rollback post-check failed';
  END IF;
END $post$;
