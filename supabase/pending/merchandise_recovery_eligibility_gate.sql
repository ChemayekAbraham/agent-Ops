-- PENDING REVIEW (2026-10-07). NOT APPLIED. Gates merchandise recovery + receivables on order approval/handover/disbursement; adds 20-unit cap to storefront purchase RPCs. Does not touch ledger, wallets, or any existing order.

CREATE OR REPLACE FUNCTION public.merchandise_sale_recognition_eligible(p_sale_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_sale_id IS NULL THEN true ELSE COALESCE((
    SELECT s.order_status IN ('approved','processing','issued','completed')
       AND CASE s.fulfilment_type
             WHEN 'company_issued' THEN s.handed_over_at IS NOT NULL
             WHEN 'outsourced'     THEN s.cfo_disbursed_at IS NOT NULL
             ELSE true END
    FROM public.merchandise_sales s WHERE s.id = p_sale_id), false) END
$$;

CREATE OR REPLACE FUNCTION public.merchandise_plan_ineligible_reason(p_plan_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
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
$$;

CREATE OR REPLACE FUNCTION public.merchandise_plan_recovery_eligible(p_plan_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE id = p_plan_id)
     AND public.merchandise_plan_ineligible_reason(p_plan_id) IS NULL
$$;

REVOKE ALL ON FUNCTION public.merchandise_sale_recognition_eligible(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.merchandise_plan_ineligible_reason(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.merchandise_plan_recovery_eligible(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merchandise_sale_recognition_eligible(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.merchandise_plan_ineligible_reason(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.merchandise_plan_recovery_eligible(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.recover_merchandise_from_wallets(p_test_agent uuid DEFAULT NULL::uuid, p_as_of date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enabled boolean; v_today date; v_plan record; v_bike record; v_is_bike boolean; v_v2 boolean;
  v_daily numeric; v_today_daily numeric; v_fee_ratio numeric; v_day date; v_due numeric; v_start date; v_term_end date;
  v_avail numeric; v_amount numeric; v_closing numeric; v_entries jsonb; v_idem text; v_desc text;
  v_fee_part numeric; v_prin_part numeric; v_streak int; v_arrears numeric; v_outcome text;
  v_results jsonb := '[]'::jsonb; v_touched int := 0; v_total numeric := 0; v_fail int := 0; v_err text;
  v_agent_name text;
BEGIN
  IF p_as_of IS NOT NULL AND p_test_agent IS NULL THEN RAISE EXCEPTION 'p_as_of is only allowed in test mode'; END IF;
  IF p_test_agent IS NOT NULL AND NOT COALESCE((SELECT is_test FROM public.profiles WHERE id = p_test_agent), false) THEN
    RAISE EXCEPTION 'Test mode requires an agent flagged is_test';
  END IF;
  SELECT enabled INTO v_enabled FROM public.treasury_controls WHERE control_key = 'merchandise_recovery_enabled';
  IF p_test_agent IS NULL AND NOT COALESCE(v_enabled, false) THEN
    RETURN jsonb_build_object('disabled', true, 'reason', 'merchandise_recovery_enabled is off');
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('recover_merchandise_from_wallets')) THEN
    RETURN jsonb_build_object('skipped', 'another run in progress');
  END IF;
  v_today := COALESCE(p_as_of, (now() AT TIME ZONE 'Africa/Kampala')::date);

  FOR v_plan IN
    SELECT p.*, pr.full_name AS agent_name
    FROM public.merchandise_recovery_plans p
    JOIN public.profiles pr ON pr.id = p.customer_id
    WHERE p.status = 'active' AND p.outstanding_balance > 0
      AND COALESCE(p.is_bike_lease, false) = true      -- bike leases only; merchandise/phones paused
      AND NOT COALESCE(p.recovery_hold, false)          -- plans on hold are never collected
      AND CASE WHEN p_test_agent IS NULL THEN NOT COALESCE(pr.is_test, false) ELSE p.customer_id = p_test_agent END
    ORDER BY p.customer_id, p.created_at ASC
    FOR UPDATE OF p SKIP LOCKED
  LOOP
    IF NOT public.merchandise_plan_recovery_eligible(v_plan.id) THEN
      UPDATE public.merchandise_recovery_plans SET last_attempt_result = 'skipped_ineligible_order' WHERE id = v_plan.id;
      v_results := v_results || jsonb_build_object('plan_id', v_plan.id, 'item', v_plan.item_name, 'day', v_today,
        'taken', 0, 'outcome', 'skipped_ineligible_order',
        'reason', public.merchandise_plan_ineligible_reason(v_plan.id));
      CONTINUE;
    END IF;
    IF v_plan.starts_on IS NOT NULL AND v_plan.starts_on > v_today THEN CONTINUE; END IF;
    IF v_plan.last_success_on IS NOT NULL AND v_plan.last_success_on >= v_today THEN CONTINUE; END IF;
    v_is_bike := COALESCE(v_plan.is_bike_lease, false);
    IF NOT v_is_bike THEN CONTINUE; END IF;
    v_v2 := COALESCE(v_plan.pricing_basis, '') = 'spiro_28pct_v2';

    IF v_plan.recovery_started_on IS NULL THEN
      SELECT * INTO v_bike FROM public._merch_bike_day(v_plan.sale_id, v_v2, v_today);
      IF NOT COALESCE(v_bike.active, false) THEN CONTINUE; END IF;
      v_term_end := v_bike.term_end;
      UPDATE public.merchandise_recovery_plans
        SET recovery_started_on = v_today, due_accrued_through = v_today - 1, due_balance = 0,
            term_end_on = v_term_end, miss_alert_sent = false, updated_at = now()
        WHERE id = v_plan.id;
      v_plan.recovery_started_on := v_today; v_plan.due_accrued_through := v_today - 1;
      v_plan.due_balance := 0; v_plan.term_end_on := v_term_end;
    END IF;

    v_due := COALESCE(v_plan.due_balance, 0);
    v_day := COALESCE(v_plan.due_accrued_through, v_today - 1) + 1;
    WHILE v_day <= v_today LOOP
      IF v_day >= v_plan.term_end_on THEN v_due := v_plan.outstanding_balance; EXIT; END IF;
      SELECT b.daily INTO v_daily FROM public._merch_bike_day(v_plan.sale_id, v_v2, v_day) b;
      v_due := v_due + COALESCE(v_daily, 0);
      v_day := v_day + 1;
    END LOOP;
    v_due := LEAST(v_due, v_plan.outstanding_balance);

    v_fee_ratio := 0;
    SELECT b.daily, b.fee_ratio INTO v_today_daily, v_fee_ratio
      FROM public._merch_bike_day(v_plan.sale_id, v_v2, LEAST(v_today, v_plan.term_end_on - 1)) b;
    v_today_daily := COALESCE(v_today_daily, 0);

    UPDATE public.merchandise_recovery_plans SET due_balance = v_due, due_accrued_through = v_today, last_attempt_on = v_today
      WHERE id = v_plan.id;

    v_avail := COALESCE(public.get_user_available_balance(v_plan.customer_id), 0);
    v_amount := floor(LEAST(v_due, 2 * v_today_daily, v_avail, v_plan.outstanding_balance));
    v_outcome := NULL;

    IF v_amount > 0 THEN
      v_idem := 'merch_recover_v3_' || v_plan.id::text || '_' || to_char(v_today, 'YYYYMMDD');
      v_desc := 'Bike Lease Payment - ' || COALESCE(v_plan.item_name, 'Bike') || ' (daily instalment)';
      v_fee_part := 0; v_prin_part := v_amount;
      IF v_v2 THEN
        v_fee_part := LEAST(round(v_amount * v_fee_ratio), GREATEST(COALESCE(v_plan.fee_total,0) - COALESCE(v_plan.fee_recovered,0), 0));
        v_prin_part := v_amount - v_fee_part;
      END IF;
      v_entries := jsonb_build_array(jsonb_build_object(
        'user_id', v_plan.customer_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
        'amount', v_amount, 'category', 'agent_repayment', 'recipient_type', 'user',
        'wallet_bucket', 'withdrawable', 'source_table', 'merchandise_recovery_plans',
        'source_id', v_plan.id, 'description', v_desc, 'currency', 'UGX',
        'metadata', jsonb_build_object('source', 'merchandise_daily_recovery', 'rules', 'v3_bike_only', 'plan_id', v_plan.id,
          'sale_id', v_plan.sale_id, 'kampala_day', v_today, 'principal_part', v_prin_part, 'fee_part', v_fee_part)));
      IF v_prin_part > 0 THEN
        v_entries := v_entries || jsonb_build_array(jsonb_build_object(
          'user_id', v_plan.customer_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_prin_part, 'category', 'bike_recovery_repayment',
          'recipient_type', 'operational_wallet', 'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id,
          'description', 'Bike lease cost recovered from agent wallet: ' || COALESCE(v_plan.item_name, 'Bike'),
          'currency', 'UGX',
          'metadata', jsonb_build_object('source', 'merchandise_daily_recovery', 'plan_id', v_plan.id,
            'sale_id', v_plan.sale_id, 'from_customer', v_plan.customer_id, 'item_name', v_plan.item_name, 'part', 'principal')));
      END IF;
      IF v_fee_part > 0 THEN
        v_entries := v_entries || jsonb_build_array(jsonb_build_object(
          'user_id', v_plan.customer_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_fee_part, 'category', 'access_fee_collected', 'recipient_type', 'operational_wallet',
          'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id,
          'description', 'Bike lease access fee collected: ' || COALESCE(v_plan.item_name, 'Bike'),
          'currency', 'UGX',
          'metadata', jsonb_build_object('source', 'bike_lease_access_fee', 'plan_id', v_plan.id,
            'sale_id', v_plan.sale_id, 'from_customer', v_plan.customer_id, 'item_name', v_plan.item_name, 'part', 'access_fee')));
      END IF;

      BEGIN
        PERFORM public.create_ledger_transaction(entries => v_entries, idempotency_key => v_idem);
        v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);
        v_arrears := GREATEST(0, v_due - v_amount);
        INSERT INTO public.merchandise_recovery_deductions (plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after, transaction_ref)
          VALUES (v_plan.id, v_plan.customer_id, v_plan.item_name, v_amount, v_avail, v_closing, gen_random_uuid());
        UPDATE public.merchandise_recovery_plans
          SET outstanding_balance = v_closing, amount_recovered = amount_recovered + v_amount,
              fee_recovered = COALESCE(fee_recovered,0) + v_fee_part,
              principal_recovered = COALESCE(principal_recovered,0) + CASE WHEN v_v2 THEN v_prin_part ELSE 0 END,
              due_balance = v_arrears, last_success_on = v_today, last_attempt_result = 'collected',
              last_bike_recovery_on = v_today,
              last_recovery_at = now(), miss_alert_sent = false,
              status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
              completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END, updated_at = now()
          WHERE id = v_plan.id;
        IF v_plan.sale_id IS NOT NULL THEN
          UPDATE public.merchandise_sales SET amount_paid = COALESCE(amount_paid,0) + v_amount, amount_outstanding = v_closing,
            payment_status = CASE WHEN v_closing <= 0 THEN 'paid' ELSE 'partial' END, updated_at = now()
          WHERE id = v_plan.sale_id;
        END IF;
        INSERT INTO public.notifications (user_id, title, message, type, metadata, link_path)
        VALUES (v_plan.customer_id, 'Bike lease payment collected',
          'UGX ' || to_char(v_amount, 'FM999,999,999,990') || ' was taken from your wallet for ' || COALESCE(v_plan.item_name,'your bike')
          || '. Arrears: UGX ' || to_char(v_arrears, 'FM999,999,999,990')
          || '. Balance left: UGX ' || to_char(v_closing, 'FM999,999,999,990') || '.',
          'merchandise_recovery',
          jsonb_build_object('kind','merchandise_recovery','plan_id',v_plan.id,'amount',v_amount,'arrears',v_arrears,'balance_left',v_closing,'kampala_day',v_today),
          '/merchandise');
        v_touched := v_touched + 1; v_total := v_total + v_amount; v_outcome := 'collected';
      EXCEPTION WHEN OTHERS THEN
        v_fail := v_fail + 1; v_err := SQLERRM; v_outcome := 'failed';
        UPDATE public.merchandise_recovery_plans SET last_attempt_result = left('failed: ' || SQLERRM, 300) WHERE id = v_plan.id;
      END;
    ELSE
      v_outcome := CASE WHEN v_due <= 0 THEN 'nothing_due' ELSE 'wallet_short' END;
      UPDATE public.merchandise_recovery_plans SET last_attempt_result = v_outcome WHERE id = v_plan.id;
    END IF;

    IF v_outcome IN ('wallet_short','failed') THEN
      v_streak := (v_today - 1) - GREATEST(COALESCE(v_plan.last_success_on, v_plan.recovery_started_on - 1), v_plan.recovery_started_on - 1);
      IF v_streak >= 3 AND NOT COALESCE(v_plan.miss_alert_sent, false) THEN
        INSERT INTO public.notifications (user_id, title, message, type, metadata, link_path)
        VALUES (v_plan.customer_id, 'Bike lease payment missed',
          'Nothing has been collected for ' || COALESCE(v_plan.item_name,'your bike') || ' for ' || v_streak
          || ' days. Arrears: UGX ' || to_char(v_due, 'FM999,999,999,990') || '. Please add money to your wallet.',
          'merchandise_recovery', jsonb_build_object('kind','merchandise_recovery_missed','plan_id',v_plan.id,'days',v_streak,'arrears',v_due), '/merchandise');
        INSERT INTO public.notifications (user_id, title, message, type, metadata)
        SELECT DISTINCT ur.user_id, 'Agent bike lease payments missed',
          COALESCE(v_plan.agent_name,'An agent') || ': nothing collected for ' || COALESCE(v_plan.item_name,'bike') || ' for ' || v_streak
          || ' days. Arrears UGX ' || to_char(v_due, 'FM999,999,999,990') || '.',
          'merchandise_recovery', jsonb_build_object('kind','merchandise_recovery_missed_ops','plan_id',v_plan.id,'agent_id',v_plan.customer_id,'days',v_streak,'arrears',v_due)
        FROM public.user_roles ur WHERE ur.role = 'agent_ops' AND COALESCE(ur.enabled, true);
        UPDATE public.merchandise_recovery_plans SET miss_alert_sent = true WHERE id = v_plan.id;
        v_outcome := v_outcome || '+alert';
      END IF;
    END IF;

    v_results := v_results || jsonb_build_object('plan_id', v_plan.id, 'item', v_plan.item_name, 'day', v_today,
      'today_daily', v_today_daily, 'due', v_due, 'wallet', v_avail, 'taken', CASE WHEN v_outcome LIKE 'collected%' THEN v_amount ELSE 0 END,
      'outcome', v_outcome);
  END LOOP;

  RETURN jsonb_build_object('day', v_today, 'plans_collected', v_touched, 'recovered_total', v_total,
    'failures', v_fail, 'last_error', v_err, 'plans', v_results);
END $function$;

CREATE OR REPLACE VIEW public.v_receivables_lines AS
SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'agent_advance'::text AS product_key,
    'Agent Advances'::text AS product_label,
    'agent_advances'::text AS source_table,
    a.id AS item_id,
    a.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST(COALESCE(a.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(a.daily_installment, (0)::numeric), NULLIF(a.installment_amount, (0)::numeric), (0)::numeric) AS daily_amount,
    a.status,
    a.created_at
   FROM (agent_advances a
     LEFT JOIN profiles p ON ((p.id = a.agent_id)))
  WHERE ((a.status = ANY (ARRAY['active'::text, 'overdue'::text])) AND (COALESCE(a.outstanding_balance, (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'agent_advance_access_fee'::text AS product_key,
    'Agent Advance Access Fees'::text AS product_label,
    'agent_advances.access_fee'::text AS source_table,
    a.id AS item_id,
    a.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST((COALESCE(a.access_fee, (0)::numeric) - COALESCE(a.access_fee_collected, (0)::numeric)), (0)::numeric) AS outstanding_amount,
    (a.expires_at)::date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    COALESCE(a.access_fee_status, a.status) AS status,
    a.created_at
   FROM (agent_advances a
     LEFT JOIN profiles p ON ((p.id = a.agent_id)))
  WHERE ((a.status = ANY (ARRAY['active'::text, 'overdue'::text])) AND (GREATEST((COALESCE(a.access_fee, (0)::numeric) - COALESCE(a.access_fee_collected, (0)::numeric)), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'credit_access_draw'::text AS product_key,
    'Credit Access Draws'::text AS product_label,
    'credit_access_draws'::text AS source_table,
    d.id AS item_id,
    COALESCE(d.agent_id, d.user_id) AS counterparty_id,
    COALESCE(p.full_name, 'Unknown borrower'::text) AS counterparty_name,
    GREATEST(COALESCE(d.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(d.daily_charge, (0)::numeric), (0)::numeric) AS daily_amount,
    d.status,
    d.created_at
   FROM (credit_access_draws d
     LEFT JOIN profiles p ON ((p.id = COALESCE(d.agent_id, d.user_id))))
  WHERE ((d.status = ANY (ARRAY['active'::text, 'overdue'::text])) AND (COALESCE(d.outstanding_balance, (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'bike_recovery'::text AS product_key,
    'Bike Recoveries'::text AS product_label,
    'merchandise_recovery_plans'::text AS source_table,
    r.id AS item_id,
    r.customer_id AS counterparty_id,
    COALESCE(NULLIF(r.customer_name, ''::text), p.full_name, 'Unknown customer'::text) AS counterparty_name,
    GREATEST(COALESCE(r.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(r.daily_deduction_amount, (0)::numeric), NULLIF(r.daily_rate, (0)::numeric), (0)::numeric) AS daily_amount,
    r.status,
    r.created_at
   FROM (merchandise_recovery_plans r
     LEFT JOIN profiles p ON ((p.id = r.customer_id)))
  WHERE ((r.status = 'active'::text) AND (COALESCE(r.outstanding_balance, (0)::numeric) > (0)::numeric) AND public.merchandise_plan_recovery_eligible(r.id) AND ((lower(r.item_name) ~~ '%spiro%'::text) OR (lower(r.item_name) ~~ '%bike%'::text)))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'merchandise_recovery'::text AS product_key,
    'Merchandise & Smartphone Recovery'::text AS product_label,
    'merchandise_recovery_plans'::text AS source_table,
    r.id AS item_id,
    r.customer_id AS counterparty_id,
    COALESCE(NULLIF(r.customer_name, ''::text), p.full_name, 'Unknown customer'::text) AS counterparty_name,
    GREATEST(COALESCE(r.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(r.daily_deduction_amount, (0)::numeric), NULLIF(r.daily_rate, (0)::numeric), (0)::numeric) AS daily_amount,
    r.status,
    r.created_at
   FROM (merchandise_recovery_plans r
     LEFT JOIN profiles p ON ((p.id = r.customer_id)))
  WHERE ((r.status = 'active'::text) AND (COALESCE(r.outstanding_balance, (0)::numeric) > (0)::numeric) AND public.merchandise_plan_recovery_eligible(r.id) AND (NOT ((lower(r.item_name) ~~ '%spiro%'::text) OR (lower(r.item_name) ~~ '%bike%'::text))))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'merchandise_credit_sale'::text AS product_key,
    'Merchandise Credit Sales'::text AS product_label,
    'merchandise_sales'::text AS source_table,
    s.id AS item_id,
    s.customer_id AS counterparty_id,
    COALESCE(NULLIF(s.client_name, ''::text), p.full_name, 'Unknown customer'::text) AS counterparty_name,
    GREATEST(COALESCE(s.amount_outstanding, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(s.access_daily_amount, (0)::numeric), (0)::numeric) AS daily_amount,
    s.payment_status AS status,
    s.created_at
   FROM (merchandise_sales s
     LEFT JOIN profiles p ON ((p.id = s.customer_id)))
  WHERE ((COALESCE(s.amount_outstanding, (0)::numeric) > (0)::numeric) AND public.merchandise_sale_recognition_eligible(s.id) AND (COALESCE(s.payment_status, ''::text) <> 'paid'::text) AND (NOT (EXISTS ( SELECT 1
           FROM merchandise_recovery_plans rp
          WHERE ((rp.sale_id = s.id) AND (rp.status = 'active'::text))))))
UNION ALL
 SELECT 'tenant'::text AS category_key,
    'Tenant Products & Services'::text AS category_label,
    'service_centre_advance'::text AS product_key,
    'Service Centre Advances'::text AS product_label,
    'service_centre_advances'::text AS source_table,
    sa.id AS item_id,
    sa.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST((COALESCE(sa.principal_amount, (0)::numeric) - COALESCE(sa.amount_recovered, (0)::numeric)), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(sa.daily_deduction, (0)::numeric), (0)::numeric) AS daily_amount,
    sa.status,
    sa.created_at
   FROM (service_centre_advances sa
     LEFT JOIN profiles p ON ((p.id = sa.agent_id)))
  WHERE ((sa.status = 'active'::text) AND (GREATEST((COALESCE(sa.principal_amount, (0)::numeric) - COALESCE(sa.amount_recovered, (0)::numeric)), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'tenant'::text AS category_key,
    'Tenant Products & Services'::text AS category_label,
    'service_centre_receivable'::text AS product_key,
    'Service Centre Receivables'::text AS product_label,
    'service_centre_receivables'::text AS source_table,
    r.id AS item_id,
    r.service_centre_id AS counterparty_id,
    COALESCE(NULLIF(s.location_name, ''::text), ('Service centre '::text || (r.service_centre_id)::text)) AS counterparty_name,
    GREATEST(COALESCE(r.recoverable_amount, (0)::numeric), (0)::numeric) AS outstanding_amount,
    r.start_date AS due_date,
    'scheduled'::text AS due_kind,
    COALESCE(NULLIF(r.daily_amount, (0)::numeric), (0)::numeric) AS daily_amount,
    r.status,
    r.created_at
   FROM (service_centre_receivables r
     LEFT JOIN service_centre_setups s ON ((s.id = r.service_centre_id)))
  WHERE ((r.status = 'active'::text) AND (GREATEST(COALESCE(r.recoverable_amount, (0)::numeric), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'tenant'::text AS category_key,
    'Tenant Products & Services'::text AS category_label,
    'rent_plan'::text AS product_key,
    'Rent Access Plans'::text AS product_label,
    'rent_requests'::text AS source_table,
    rr.id AS item_id,
    rr.tenant_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown tenant'::text) AS counterparty_name,
    GREATEST((COALESCE(NULLIF(rr.total_repayment, (0)::numeric), ((COALESCE(rr.rent_amount, (0)::numeric) + COALESCE(rr.access_fee, (0)::numeric)) + COALESCE(rr.request_fee, (0)::numeric))) - COALESCE(rr.amount_repaid, (0)::numeric)), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(rr.daily_repayment, (0)::numeric), (0)::numeric) AS daily_amount,
    rr.status,
    rr.created_at
   FROM (rent_requests rr
     LEFT JOIN profiles p ON ((p.id = rr.tenant_id)))
  WHERE ((rr.status = ANY (ARRAY['funded'::text, 'disbursed'::text, 'repaying'::text])) AND (GREATEST((COALESCE(NULLIF(rr.total_repayment, (0)::numeric), ((COALESCE(rr.rent_amount, (0)::numeric) + COALESCE(rr.access_fee, (0)::numeric)) + COALESCE(rr.request_fee, (0)::numeric))) - COALESCE(rr.amount_repaid, (0)::numeric)), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'tenant'::text AS category_key,
    'Tenant Products & Services'::text AS category_label,
    'tenant_service_charge'::text AS product_key,
    'Tenant Service Charges'::text AS product_label,
    'subscription_charges'::text AS source_table,
    sc.id AS item_id,
    sc.tenant_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown tenant'::text) AS counterparty_name,
    GREATEST(COALESCE(sc.accumulated_debt, (0)::numeric), (0)::numeric) AS outstanding_amount,
    sc.next_charge_date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    sc.status,
    sc.created_at
   FROM (subscription_charges sc
     LEFT JOIN profiles p ON ((p.id = sc.tenant_id)))
  WHERE ((sc.status = 'active'::text) AND (COALESCE(sc.accumulated_debt, (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'tenant'::text AS category_key,
    'Tenant Products & Services'::text AS category_label,
    'business_advance'::text AS product_key,
    'Business Advances'::text AS product_label,
    'business_advances'::text AS source_table,
    ba.id AS item_id,
    ba.tenant_id AS counterparty_id,
    COALESCE(p.full_name, NULLIF(ba.business_name, ''::text), 'Unknown business'::text) AS counterparty_name,
    GREATEST(COALESCE(ba.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    round((GREATEST(COALESCE(ba.outstanding_balance, (0)::numeric), (0)::numeric) * COALESCE(ba.daily_rate, (0)::numeric)), 2) AS daily_amount,
    (ba.status)::text AS status,
    ba.created_at
   FROM (business_advances ba
     LEFT JOIN profiles p ON ((p.id = ba.tenant_id)))
  WHERE (((ba.status)::text = ANY (ARRAY['active'::text, 'defaulted'::text])) AND (COALESCE(ba.outstanding_balance, (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Products & Services'::text AS category_label,
    'welile_homes'::text AS product_key,
    'Welile Homes Subscriptions'::text AS product_label,
    'welile_homes_subscriptions'::text AS source_table,
    w.id AS item_id,
    w.landlord_id AS counterparty_id,
    COALESCE(NULLIF(w.landlord_name, ''::text), p.full_name, 'Unknown landlord'::text) AS counterparty_name,
    GREATEST(COALESCE(w.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    w.next_due_date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    w.subscription_status AS status,
    w.created_at
   FROM (welile_homes_subscriptions w
     LEFT JOIN profiles p ON ((p.id = w.landlord_id)))
  WHERE (COALESCE(w.outstanding_balance, (0)::numeric) > (0)::numeric)
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Products & Services'::text AS category_label,
    'landlord_float_receivable'::text AS product_key,
    'Landlord Float Receivables'::text AS product_label,
    'landlord_float_receivables'::text AS source_table,
    lfr.id AS item_id,
    lfr.landlord_id AS counterparty_id,
    COALESCE(NULLIF(lfr.landlord_name, ''::text), p.full_name, 'Unknown landlord'::text) AS counterparty_name,
    GREATEST(COALESCE(lfr.amount, (0)::numeric), (0)::numeric) AS outstanding_amount,
    lfr.promised_deposit_date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    lfr.status,
    lfr.created_at
   FROM (landlord_float_receivables lfr
     LEFT JOIN profiles p ON ((p.id = lfr.landlord_id)))
  WHERE ((COALESCE(lfr.amount, (0)::numeric) > (0)::numeric) AND (COALESCE(lfr.status, ''::text) <> ALL (ARRAY['settled'::text, 'cancelled'::text])))
UNION ALL
 SELECT 'partner'::text AS category_key,
    'Partner Products & Services'::text AS category_label,
    'promissory_note'::text AS product_key,
    'Promissory Notes'::text AS product_label,
    'promissory_notes'::text AS source_table,
    n.id AS item_id,
    COALESCE(n.partner_user_id, n.agent_id) AS counterparty_id,
    COALESCE(NULLIF(n.partner_name, ''::text), 'Unknown partner'::text) AS counterparty_name,
    GREATEST((COALESCE(n.amount, (0)::numeric) - COALESCE(n.total_collected, (0)::numeric)), (0)::numeric) AS outstanding_amount,
    n.next_deduction_date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    n.status,
    n.created_at
   FROM promissory_notes n
  WHERE ((n.status = 'activated'::text) AND (GREATEST((COALESCE(n.amount, (0)::numeric) - COALESCE(n.total_collected, (0)::numeric)), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'other'::text AS category_key,
    'Unclassified / Other'::text AS category_label,
    'field_collection_pending'::text AS product_key,
    'Unconfirmed Field Collections'::text AS product_label,
    'field_collections'::text AS source_table,
    fc.id AS item_id,
    fc.agent_id AS counterparty_id,
    COALESCE(NULLIF(fc.tenant_name, ''::text), p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST(COALESCE(fc.amount, (0)::numeric), (0)::numeric) AS outstanding_amount,
    (fc.captured_at)::date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    fc.status,
    fc.created_at
   FROM (field_collections fc
     LEFT JOIN profiles p ON ((p.id = fc.agent_id)))
  WHERE ((fc.status = 'pending'::text) AND (COALESCE(fc.amount, (0)::numeric) > (0)::numeric));

CREATE OR REPLACE FUNCTION public.agent_purchase_merchandise(p_catalog_id uuid, p_quantity integer, p_payment_mode text DEFAULT 'full'::text, p_size text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_item     record;
  v_total    numeric;
  v_avail    numeric;
  v_name     text;
  v_phone    text;
  v_sale_id  uuid;
  v_mode     text := lower(COALESCE(p_payment_mode, 'full'));
  v_down     numeric;
  v_out      numeric;
  v_status   text;
  v_dupe     uuid;
  v_size     text := NULLIF(btrim(COALESCE(p_size, '')), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;
  -- Same per-order ceiling already enforced by agent_order_merchandise.
  IF p_quantity > 20 THEN
    RAISE EXCEPTION 'Maximum 20 units per order. Contact operations for bulk orders.';
  END IF;
  IF v_mode NOT IN ('full','installment') THEN
    RAISE EXCEPTION 'Invalid payment mode';
  END IF;

  SELECT * INTO v_item
  FROM public.merchandise_catalog
  WHERE id = p_catalog_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This item is not available';
  END IF;

  IF COALESCE(array_length(v_item.sizes, 1), 0) > 0 THEN
    IF v_size IS NULL THEN
      RAISE EXCEPTION 'Please choose a size for this item';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM unnest(v_item.sizes) s WHERE lower(btrim(s)) = lower(v_size)
    ) THEN
      RAISE EXCEPTION 'Size % is not in stock for this item', v_size;
    END IF;
    SELECT s INTO v_size FROM unnest(v_item.sizes) s WHERE lower(btrim(s)) = lower(v_size) LIMIT 1;
  ELSE
    v_size := NULL;
  END IF;

  v_total := COALESCE(v_item.unit_price, 0) * p_quantity;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Invalid order total';
  END IF;

  SELECT id INTO v_dupe
  FROM public.merchandise_sales
  WHERE customer_id = v_uid
    AND item_name = v_item.item_name
    AND quantity = p_quantity
    AND COALESCE(selected_size, '') = COALESCE(v_size, '')
    AND created_at > now() - interval '5 minutes'
    AND COALESCE(order_status, 'submitted') NOT IN ('rejected','failed')
  LIMIT 1;
  IF v_dupe IS NOT NULL THEN
    RAISE EXCEPTION 'You already placed this exact order moments ago. Check your orders before trying again.';
  END IF;

  v_avail := COALESCE(public.get_user_available_balance(v_uid), 0);

  IF v_mode = 'full' THEN
    IF v_avail < v_total THEN
      RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Your wallet has UGX % but this order needs UGX %', v_avail, v_total
        USING ERRCODE = 'P0001';
    END IF;
    v_down := v_total;
  ELSE
    v_down := GREATEST(0, LEAST(COALESCE(v_avail, 0), GREATEST(round(v_total * 0.25), 1)));
  END IF;

  v_out := v_total - v_down;
  v_status := CASE
    WHEN v_out <= 0 THEN 'paid'
    WHEN v_down <= 0 THEN 'credit'
    ELSE 'partial'
  END;

  SELECT full_name, phone INTO v_name, v_phone
  FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, unit_cost, total_revenue,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, created_by, notes,
    order_status, payment_plan, selected_size
  ) VALUES (
    v_item.item_name, p_quantity, v_item.unit_price, COALESCE(v_item.unit_cost, 0), v_total,
    v_name, v_phone, v_uid, v_status,
    v_down, v_out, current_date, v_uid,
    (CASE WHEN v_mode = 'installment' AND v_down <= 0
      THEN 'Agent store - installment plan, zero wallet balance (25% wallet recovery)'
    WHEN v_mode = 'installment'
      THEN 'Agent store - installment plan (25% wallet recovery)'
      ELSE 'Agent store - instant wallet debit' END)
      || COALESCE(' | Size: ' || v_size, ''),
    'pending_approval', v_mode, v_size
  ) RETURNING id INTO v_sale_id;

  IF v_down > 0 THEN
    PERFORM public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'user_id', v_uid,
          'ledger_scope', 'wallet',
          'direction', 'cash_out',
          'amount', v_down,
          'category', 'agent_repayment',
          'recipient_type', 'user',
          'wallet_bucket', 'withdrawable',
          'source_table', 'merchandise_sales',
          'source_id', v_sale_id,
          'description', CASE WHEN v_mode = 'installment'
            THEN 'Merchandise Installment (25%) - ' || v_item.item_name
            ELSE 'Merchandise Purchase - ' || v_item.item_name END,
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'source', CASE WHEN v_mode = 'installment' THEN 'merchandise_installment_downpayment' ELSE 'merchandise_instant_purchase' END,
            'sale_id', v_sale_id,
            'catalog_id', v_item.id,
            'quantity', p_quantity,
            'payment_plan', v_mode,
            'order_total', v_total,
            'selected_size', v_size
          )
        ),
        jsonb_build_object(
          'ledger_scope', 'platform',
          'direction', 'cash_in',
          'amount', v_down,
          'category', 'merchandise_revenue',
          'source_table', 'merchandise_sales',
          'source_id', v_sale_id,
          'description', 'Merchandise sale - ' || v_item.item_name,
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'sale_id', v_sale_id,
            'catalog_id', v_item.id,
            'quantity', p_quantity,
            'payment_plan', v_mode,
            'selected_size', v_size
          )
        )
      )
    );
  END IF;

  -- NOTE: the recovery plan is created by trg_create_merchandise_recovery_plan
  -- on merchandise_sales (with customer name, phone and the correct daily rate).
  -- Inserting one here as well produced duplicate plans and double-counted exposure.

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'total', v_total,
    'paid_now', v_down,
    'outstanding', v_out,
    'payment_plan', v_mode,
    'selected_size', v_size
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.agent_purchase_merchandise_plan(p_catalog_id uuid, p_quantity integer, p_size text DEFAULT NULL::text, p_term_months integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_item      record;
  v_total     numeric;
  v_name      text;
  v_phone     text;
  v_sale_id   uuid;
  v_size      text := NULLIF(btrim(COALESCE(p_size, '')), '');
  v_months    integer := COALESCE(p_term_months, 1);
  v_dupe      uuid;
  v_sched     jsonb;
  v_repayable numeric;
  v_daily     numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;
  -- Same per-order ceiling already enforced by agent_order_merchandise.
  IF p_quantity > 20 THEN
    RAISE EXCEPTION 'Maximum 20 units per order. Contact operations for bulk orders.';
  END IF;
  IF v_months NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'Choose a repayment period between 1 and 12 months';
  END IF;

  SELECT * INTO v_item
  FROM public.merchandise_catalog
  WHERE id = p_catalog_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This item is not available';
  END IF;

  IF COALESCE(array_length(v_item.sizes, 1), 0) > 0 THEN
    IF v_size IS NULL THEN
      RAISE EXCEPTION 'Please choose a size for this item';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM unnest(v_item.sizes) s WHERE lower(btrim(s)) = lower(v_size)
    ) THEN
      RAISE EXCEPTION 'Size % is not in stock for this item', v_size;
    END IF;
    SELECT s INTO v_size FROM unnest(v_item.sizes) s WHERE lower(btrim(s)) = lower(v_size) LIMIT 1;
  ELSE
    v_size := NULL;
  END IF;

  v_total := COALESCE(v_item.unit_price, 0) * p_quantity;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Invalid order total';
  END IF;

  SELECT id INTO v_dupe
  FROM public.merchandise_sales
  WHERE customer_id = v_uid
    AND item_name = v_item.item_name
    AND quantity = p_quantity
    AND COALESCE(selected_size, '') = COALESCE(v_size, '')
    AND created_at > now() - interval '5 minutes'
    AND COALESCE(order_status, 'submitted') NOT IN ('rejected','failed')
  LIMIT 1;
  IF v_dupe IS NOT NULL THEN
    RAISE EXCEPTION 'You already placed this exact order moments ago. Check your orders before trying again.';
  END IF;

  SELECT full_name, phone INTO v_name, v_phone
  FROM public.profiles WHERE id = v_uid;

  -- Nothing is taken at checkout: the whole price is financed over the chosen
  -- period and recovered daily from the wallet, so no ledger legs are posted here.
  INSERT INTO public.merchandise_sales (
    item_name, quantity, unit_price, unit_cost, total_revenue,
    client_name, client_phone, customer_id, payment_status,
    amount_paid, amount_outstanding, sale_date, created_by, notes,
    order_status, payment_plan, selected_size
  ) VALUES (
    v_item.item_name, p_quantity, v_item.unit_price, COALESCE(v_item.unit_cost, 0), v_total,
    v_name, v_phone, v_uid, 'credit',
    0, v_total, current_date, v_uid,
    'Agent store - ' || v_months || '-month instalment plan (reducing balance, daily wallet recovery)'
      || COALESCE(' | Size: ' || v_size, ''),
    'pending_approval', 'installment', v_size
  ) RETURNING id INTO v_sale_id;

  -- Build the reducing-balance schedule the daily recovery run reads.
  v_sched := public.smartphone_rebuild_repayment_schedule(v_sale_id, v_total, v_months, current_date);
  v_repayable := GREATEST(v_total, COALESCE((v_sched->>'total_repayable')::numeric, v_total));
  v_daily := GREATEST(1, COALESCE((v_sched->>'first_daily')::numeric, 0));

  -- The recovery plan is created by trg_create_merchandise_recovery_plan on the
  -- insert above with the price only. Restate it against the financed total so
  -- recovery collects the monthly charges as well, and pin the month-1 daily
  -- amount (later months are read from the schedule).
  UPDATE public.merchandise_recovery_plans
     SET original_amount = v_repayable,
         outstanding_balance = v_repayable,
         daily_deduction_amount = v_daily,
         starts_on = COALESCE(starts_on, current_date),
         updated_at = now()
   WHERE sale_id = v_sale_id;

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'total', v_total,
    'paid_now', 0,
    'outstanding', v_repayable,
    'term_months', v_months,
    'total_repayable', v_repayable,
    'first_daily', v_daily,
    'last_daily', COALESCE((v_sched->>'last_daily')::numeric, v_daily),
    'payment_plan', 'installment',
    'selected_size', v_size
  );
END;
$function$;
