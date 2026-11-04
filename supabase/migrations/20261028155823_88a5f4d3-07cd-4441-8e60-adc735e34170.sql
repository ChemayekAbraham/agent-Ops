CREATE TABLE public.cfo_lunch_reclass_log (
  original_leg_id uuid PRIMARY KEY,
  correction_group_id uuid NOT NULL,
  amount numeric NOT NULL,
  approved_by uuid NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.cfo_lunch_reclass_log TO authenticated;
GRANT ALL ON public.cfo_lunch_reclass_log TO service_role;
ALTER TABLE public.cfo_lunch_reclass_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY cfo_read ON public.cfo_lunch_reclass_log FOR SELECT TO authenticated
  USING ((select has_role((select auth.uid()), 'cfo'::app_role)) OR (select has_role((select auth.uid()), 'super_admin'::app_role)));
CREATE POLICY mfa_required_for_staff ON public.cfo_lunch_reclass_log AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

DO $$
DECLARE r record; v_gid uuid; v_n int := 0; v_t numeric := 0; v_cn int; v_ct numeric;
  v_approver uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
BEGIN
  CREATE TEMP TABLE _lr ON COMMIT DROP AS
  SELECT g.id, g.amount, g.transaction_date, p.full_name
  FROM general_ledger g
  LEFT JOIN LATERAL (SELECT w.user_id FROM general_ledger w WHERE w.transaction_group_id = g.transaction_group_id
     AND w.ledger_scope='wallet' AND w.direction='cash_in' AND w.amount = g.amount LIMIT 1) w ON true
  LEFT JOIN profiles p ON p.id = w.user_id
  WHERE g.direction='cash_out' AND g.classification='admin_correction' AND g.category='system_balance_correction'
    AND g.ledger_scope='platform' AND g.description ILIKE '%automated%lunch allowance%'
    AND (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date BETWEEN '2026-10-21' AND '2026-10-28'
    AND public._cfo_paid_lunch_correction_ok(g.id, g.transaction_group_id, g.amount, g.transaction_date);

  SELECT count(*), coalesce(sum(amount),0) INTO v_cn, v_ct FROM _lr;
  IF v_cn <> 219 OR v_ct <> 798000 THEN
    RAISE EXCEPTION 'population changed: % / %, expected 219 / 798000', v_cn, v_ct;
  END IF;

  FOR r IN SELECT * FROM _lr ORDER BY transaction_date, id LOOP
    v_gid := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('amount', r.amount, 'direction','cash_out', 'category','payroll_expense',
        'ledger_scope','platform', 'classification','production',
        'source_table','cfo_lunch_reclass', 'source_id', r.id, 'transaction_date', r.transaction_date,
        'linked_party', r.full_name,
        'description', 'Lunch allowance reclassified to operating expense — ' || coalesce(r.full_name,'staff') || ' (orig ' || r.id || ')'),
      jsonb_build_object('amount', r.amount, 'direction','cash_in', 'category','system_balance_correction',
        'ledger_scope','platform', 'classification','production',
        'source_table','cfo_lunch_reclass', 'source_id', r.id, 'transaction_date', r.transaction_date,
        'description', 'Lunch allowance reclass — reverses equity correction (orig ' || r.id || ')')
    ), 'cfo_lunch_reclass:' || r.id, false);
    INSERT INTO cfo_lunch_reclass_log(original_leg_id, correction_group_id, amount, approved_by)
    VALUES (r.id, v_gid, r.amount, v_approver);
    v_n := v_n + 1; v_t := v_t + r.amount;
  END LOOP;

  INSERT INTO audit_logs(action_type, table_name, record_id, reason, user_id, metadata)
  VALUES ('cfo_lunch_reclass_post', 'general_ledger', 'lunch-reclass-2026-10-21..28',
    'CFO-approved reclass of automated lunch allowance from equity correction to operating expense',
    v_approver, jsonb_build_object('count', v_n, 'total', v_t, 'held_duplicate_ugx', 3000));
  INSERT INTO system_events(event_type, user_id, metadata)
  VALUES ('ledger_classification_backfilled', v_approver,
    jsonb_build_object('kind','lunch_allowance_reclass','count',v_n,'total',v_t));
END $$;

-- Money Out: originals stop counting once reclassed (the new payroll_expense leg counts instead).
CREATE OR REPLACE FUNCTION public._cfo_paid_lunch_correction_ok(p_id uuid, p_group uuid, p_amount numeric, p_ts timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT NOT EXISTS (SELECT 1 FROM cfo_lunch_reclass_log l WHERE l.original_leg_id = p_id)
  AND EXISTS (
    SELECT 1 FROM general_ledger w
    WHERE w.transaction_group_id = p_group AND w.ledger_scope = 'wallet' AND w.direction = 'cash_in'
      AND w.category = 'wallet_deposit' AND w.amount = p_amount
      AND NOT EXISTS (SELECT 1 FROM platform_wallet_corrections c
                      WHERE c.operation = 'debit'
                        AND c.metadata->>'sub_category' IN ('lunch_allowance_reversal:' || w.id::text, 'lunch_allowance_reversal:' || p_id::text))
      AND NOT EXISTS (
        SELECT 1 FROM general_ledger o
        JOIN general_ledger ow ON ow.transaction_group_id = o.transaction_group_id AND ow.ledger_scope = 'wallet'
             AND ow.direction = 'cash_in' AND ow.user_id = w.user_id
        WHERE o.ledger_scope = 'platform' AND o.direction = 'cash_out' AND o.id <> p_id
          AND o.description ILIKE '%lunch allowance%'
          AND o.category IN ('payroll_expense', 'system_balance_correction')
          AND o.source_table <> 'cfo_lunch_reclass'
          AND (o.transaction_date AT TIME ZONE 'Africa/Kampala')::date = (p_ts AT TIME ZONE 'Africa/Kampala')::date
          AND (o.category = 'payroll_expense' OR o.transaction_date < p_ts OR (o.transaction_date = p_ts AND o.id < p_id))
      )
  )
$$;
REVOKE ALL ON FUNCTION public._cfo_paid_lunch_correction_ok(uuid, uuid, numeric, timestamptz) FROM PUBLIC, anon, authenticated;

-- HR-verification list keeps covering reclassed payments.
CREATE OR REPLACE FUNCTION public.get_cfo_lunch_unlisted_recipients(p_from date, p_to date)
RETURNS TABLE(user_id uuid, full_name text, phone text, payments bigint, amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY
  SELECT w.user_id, p.full_name, p.phone, count(*), sum(g.amount)
  FROM general_ledger g
  JOIN LATERAL (SELECT x.user_id FROM general_ledger x WHERE x.transaction_group_id = g.transaction_group_id
                AND x.ledger_scope = 'wallet' AND x.direction = 'cash_in' AND x.category = 'wallet_deposit'
                AND x.amount = g.amount LIMIT 1) w ON true
  LEFT JOIN profiles p ON p.id = w.user_id
  WHERE g.direction = 'cash_out' AND g.classification = 'admin_correction' AND g.category = 'system_balance_correction'
    AND g.ledger_scope = 'platform' AND g.description ILIKE '%automated%lunch allowance%'
    AND (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    AND NOT EXISTS (SELECT 1 FROM hr_staff s WHERE s.user_id = w.user_id)
    AND (EXISTS (SELECT 1 FROM cfo_lunch_reclass_log l WHERE l.original_leg_id = g.id)
         OR public._cfo_paid_lunch_correction_ok(g.id, g.transaction_group_id, g.amount, g.transaction_date))
  GROUP BY w.user_id, p.full_name, p.phone;
END $$;