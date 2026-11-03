-- Rollback of 20261103200000_smartphone_recovery_to_a12: restores the two recovery functions to the production definitions of 2026-11-03
-- (verbatim) and drops the split helpers. The reclassification groups posted by the migration STAY (append-only
-- ledger); after a rollback new smartphone recoveries go to A10 again, so a rollback needs a CFO decision on whether
-- to reverse the reclassification with new entries.
SET lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('recover_smartphone_from_wallets'));
CREATE OR REPLACE FUNCTION public.recover_smartphone_from_wallets()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now_kla timestamp := now() AT TIME ZONE 'Africa/Kampala';
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_day_start timestamptz := ((now() AT TIME ZONE 'Africa/Kampala')::date)::timestamp AT TIME ZONE 'Africa/Kampala';
  v_min_take constant numeric := 1000;
  v_plan record; v_due numeric; v_daily numeric; v_avail numeric; v_amount numeric;
  v_taken_today numeric; v_room numeric;
  v_closing numeric; v_arrears numeric; v_idem text; v_err text;
  v_results jsonb := '[]'::jsonb; v_total numeric := 0; v_n int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('recover_smartphone_from_wallets')) THEN
    RETURN jsonb_build_object('skipped', 'another run in progress');
  END IF;
  FOR v_plan IN
    SELECT p.* FROM public.merchandise_recovery_plans p
    JOIN public.profiles pr ON pr.id = p.customer_id
    WHERE p.phone_collection_enabled AND p.status = 'active' AND p.outstanding_balance > 0
      AND NOT COALESCE(p.is_bike_lease, false) AND NOT COALESCE(p.recovery_hold, false)
      AND NOT COALESCE(pr.is_test, false)
      AND p.starts_on IS NOT NULL AND p.starts_on <= v_today
    ORDER BY p.created_at
    FOR UPDATE OF p SKIP LOCKED
  LOOP
    IF NOT public.merchandise_plan_recovery_eligible(v_plan.id) THEN
      UPDATE public.merchandise_recovery_plans SET last_attempt_result = 'skipped_ineligible_order' WHERE id = v_plan.id;
      v_results := v_results || jsonb_build_object('plan_id', v_plan.id, 'outcome', 'skipped_ineligible_order',
        'reason', public.merchandise_plan_ineligible_reason(v_plan.id));
      CONTINUE;
    END IF;
    v_daily := COALESCE(NULLIF(v_plan.daily_deduction_amount, 0), 0);
    IF v_daily <= 0 THEN CONTINUE; END IF;
    v_due := COALESCE(v_plan.due_balance, 0)
             + v_daily * GREATEST(0, v_today - GREATEST(COALESCE(v_plan.due_accrued_through, v_plan.starts_on - 1), v_plan.starts_on - 1));
    v_due := LEAST(v_due, v_plan.outstanding_balance);
    UPDATE public.merchandise_recovery_plans SET due_balance = v_due, due_accrued_through = v_today, last_attempt_on = v_today WHERE id = v_plan.id;
    SELECT COALESCE(sum(d.amount), 0) INTO v_taken_today
    FROM public.merchandise_recovery_deductions d
    WHERE d.plan_id = v_plan.id AND d.created_at >= v_day_start
      AND d.item_name IS NOT DISTINCT FROM v_plan.item_name;
    v_room := GREATEST(0, 2 * v_daily - v_taken_today);
    v_avail := COALESCE(public.get_user_advance_reversal_available(v_plan.customer_id), 0);
    v_amount := floor(LEAST(v_due, v_room, v_avail, v_plan.outstanding_balance));
    IF v_amount <= 0 OR (v_amount < v_min_take AND v_amount < floor(v_due)) THEN
      UPDATE public.merchandise_recovery_plans
        SET last_attempt_result = CASE WHEN v_due <= 0 THEN 'nothing_due'
                                       WHEN v_room <= 0 THEN 'daily_cap_reached'
                                       ELSE 'wallet_short' END
        WHERE id = v_plan.id;
      v_results := v_results || jsonb_build_object('plan_id', v_plan.id, 'due', v_due, 'wallet', v_avail, 'taken_today', v_taken_today, 'taken', 0);
      CONTINUE;
    END IF;
    v_idem := 'phone_recover_v2_' || v_plan.id::text || '_' || to_char(v_now_kla, 'YYYYMMDDHH24MI');
    BEGIN
      PERFORM public.create_ledger_transaction(entries => jsonb_build_array(
        jsonb_build_object('user_id', v_plan.customer_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
          'amount', v_amount, 'category', 'agent_repayment', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
          'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
          'description', 'Smartphone repayment - ' || COALESCE(v_plan.item_name, 'Welile Smartphone') || ' (daily instalment)'),
        jsonb_build_object('user_id', v_plan.customer_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_amount, 'category', 'agent_advance_repayment', 'recipient_type', 'operational_wallet',
          'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
          'description', 'Smartphone advance recovered from agent wallet: ' || COALESCE(v_plan.item_name, 'Welile Smartphone'))
      ), idempotency_key => v_idem);
      v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);
      v_arrears := GREATEST(0, v_due - v_amount);
      INSERT INTO public.merchandise_recovery_deductions (plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after, transaction_ref)
        VALUES (v_plan.id, v_plan.customer_id, v_plan.item_name, v_amount, v_avail, v_closing, gen_random_uuid());
      UPDATE public.merchandise_recovery_plans
        SET outstanding_balance = v_closing, amount_recovered = amount_recovered + v_amount,
            due_balance = v_arrears, last_success_on = v_today, last_attempt_result = 'collected',
            last_recovery_at = now(),
            status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
            completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END, updated_at = now()
        WHERE id = v_plan.id;
      IF v_plan.sale_id IS NOT NULL THEN
        UPDATE public.merchandise_sales SET amount_paid = COALESCE(amount_paid,0) + v_amount, amount_outstanding = v_closing,
          payment_status = CASE WHEN v_closing <= 0 THEN 'paid' ELSE 'partial' END, updated_at = now()
        WHERE id = v_plan.sale_id;
      END IF;
      INSERT INTO public.notifications (user_id, title, message, type, metadata, link_path)
      VALUES (v_plan.customer_id, 'Smartphone payment collected',
        'UGX ' || to_char(v_amount, 'FM999,999,999,990') || ' was taken from your wallet for your smartphone. Balance left: UGX '
        || to_char(v_closing, 'FM999,999,999,990') || '.', 'merchandise_recovery',
        jsonb_build_object('kind','smartphone_recovery','plan_id',v_plan.id,'amount',v_amount,'arrears',v_arrears,'balance_left',v_closing,'kampala_day',v_today),
        '/merchandise');
      INSERT INTO public.system_events (event_type, user_id, metadata)
      VALUES ('payment_made', v_plan.customer_id, jsonb_build_object('source','smartphone_recovery','plan_id',v_plan.id,'amount',v_amount));
      v_n := v_n + 1; v_total := v_total + v_amount;
      v_results := v_results || jsonb_build_object('plan_id', v_plan.id, 'due', v_due, 'wallet', v_avail, 'taken', v_amount, 'balance_left', v_closing);
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      UPDATE public.merchandise_recovery_plans SET last_attempt_result = left('failed: ' || SQLERRM, 300) WHERE id = v_plan.id;
      v_results := v_results || jsonb_build_object('plan_id', v_plan.id, 'error', v_err);
    END;
  END LOOP;
  RETURN jsonb_build_object('day', v_today, 'plans_collected', v_n, 'recovered_total', v_total, 'last_error', v_err, 'plans', v_results);
END $function$;

CREATE OR REPLACE FUNCTION public.apply_smartphone_roi_pledge(p_user_id uuid, p_roi_amount numeric, p_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_p record; v_plan record; v_pledged numeric; v_avail numeric; v_amount numeric; v_closing numeric;
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

  PERFORM public.create_ledger_transaction(entries => jsonb_build_array(
    jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
      'amount', v_amount, 'category', 'agent_repayment', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
      'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
      'description', 'Smartphone repayment - ' || COALESCE(v_plan.item_name,'Welile Smartphone') || ' (from monthly Returns)'),
    jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
      'amount', v_amount, 'category', 'agent_advance_repayment', 'recipient_type', 'operational_wallet',
      'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
      'description', 'Smartphone advance recovered from monthly Returns: ' || COALESCE(v_plan.item_name,'Welile Smartphone'))
  ), idempotency_key => 'phone_roi_pledge_' || p_reference);

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
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND public._cfo_received_category_for(g.category) = 'agent'
  )
  SELECT x.k,
    CASE x.k WHEN 'smartphone' THEN 'Smartphone recoveries' WHEN 'bike' THEN 'Bike recoveries'
             WHEN 'rejection' THEN 'Rejection charges' ELSE 'Agent advance repayments' END,
    round(sum(x.amount), 2), count(*)
  FROM x GROUP BY x.k ORDER BY 3 DESC;
END $function$;

DROP FUNCTION public._smartphone_recovery_split_safe(uuid, numeric, date);
DROP FUNCTION public._smartphone_recovery_split(uuid, numeric, date);
DO $post$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.recover_smartphone_from_wallets()'))
       IS DISTINCT FROM 'c2c65f6994e6548f94c41346c6d08722'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.apply_smartphone_roi_pledge(uuid, numeric, text)'))
       IS DISTINCT FROM 'b984f99c1808977646f88bda055619d5'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_totals(date, date)'))
       IS DISTINCT FROM 'd1b7dd4113f0a861fe6da988a8e97008'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_page(date, date, text, text, text, integer, integer)'))
       IS DISTINCT FROM 'af27c0bb9f0507dd12ef581817690f79'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_agent_products_breakdown(date, date)'))
       IS DISTINCT FROM '9353e5d5458d62f6f2413e710134a85e' THEN
    RAISE EXCEPTION 'rollback post-check failed';
  END IF;
END $post$;
