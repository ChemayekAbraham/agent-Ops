-- PENDING (not applied). Reporting-only: Money Out lunch allowance classification.
-- Counts verified lunch corrections for recipients without an hr_staff record,
-- keeping the wallet-credit, amount, reversal and duplicate checks. Adds a
-- read-only list of those recipients so HR can verify them. No data changes.

CREATE OR REPLACE FUNCTION public._cfo_paid_lunch_correction_ok(p_id uuid, p_group uuid, p_amount numeric, p_ts timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
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
          AND (o.transaction_date AT TIME ZONE 'Africa/Kampala')::date = (p_ts AT TIME ZONE 'Africa/Kampala')::date
          AND (o.category = 'payroll_expense' OR o.transaction_date < p_ts OR (o.transaction_date = p_ts AND o.id < p_id))
      )
  )
$$;
REVOKE ALL ON FUNCTION public._cfo_paid_lunch_correction_ok(uuid, uuid, numeric, timestamptz) FROM PUBLIC, anon, authenticated;

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
    AND public._cfo_paid_lunch_correction_ok(g.id, g.transaction_group_id, g.amount, g.transaction_date)
  GROUP BY w.user_id, p.full_name, p.phone;
END $$;
REVOKE ALL ON FUNCTION public.get_cfo_lunch_unlisted_recipients(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_lunch_unlisted_recipients(date, date) TO authenticated;
