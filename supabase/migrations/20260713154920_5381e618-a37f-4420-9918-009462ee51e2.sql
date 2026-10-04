CREATE OR REPLACE FUNCTION public.get_agent_advance_repayment_monitor(_days int DEFAULT 7)
RETURNS TABLE (
  advance_id uuid,
  agent_id uuid,
  full_name text,
  phone text,
  avatar_url text,
  status text,
  principal numeric,
  outstanding_balance numeric,
  arrears_balance numeric,
  access_fee numeric,
  scheduled_daily numeric,
  issued_at timestamptz,
  expires_at timestamptz,
  is_overdue boolean,
  withdrawable numeric,
  repaid_today numeric,
  deduction_status_today text,
  paid_today boolean,
  repaid_window numeric,
  missed_days_window int,
  paid_days_window int,
  last_deduction_date date,
  last_deduction_amount numeric,
  collections_today numeric,
  collections_count_today bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_since date := (now() AT TIME ZONE 'Africa/Kampala')::date - GREATEST(COALESCE(_days, 7), 1);
BEGIN
  RETURN QUERY
  SELECT
    a.id,
    a.agent_id,
    p.full_name,
    p.phone,
    p.avatar_url,
    a.status,
    a.principal,
    a.outstanding_balance,
    COALESCE(a.arrears_balance, 0)::numeric,
    COALESCE(a.access_fee, 0)::numeric,
    (CASE WHEN COALESCE(a.cycle_days, 30) > 0
          THEN round((a.principal + COALESCE(a.access_fee, 0)) / COALESCE(a.cycle_days, 30))
          ELSE 0 END)::numeric AS scheduled_daily,
    a.issued_at,
    a.expires_at,
    (now() > a.expires_at) AS is_overdue,
    GREATEST(0, COALESCE(public.get_user_available_balance(a.agent_id), 0))::numeric AS withdrawable,
    COALESCE(td.amt, 0)::numeric AS repaid_today,
    td.status AS deduction_status_today,
    (COALESCE(td.amt, 0) > 0) AS paid_today,
    COALESCE(win.repaid, 0)::numeric AS repaid_window,
    COALESCE(win.missed, 0)::int AS missed_days_window,
    COALESCE(win.paid, 0)::int AS paid_days_window,
    last.d AS last_deduction_date,
    last.amt AS last_deduction_amount,
    COALESCE(ct.amt, 0)::numeric AS collections_today,
    COALESCE(ct.cnt, 0)::bigint AS collections_count_today
  FROM public.agent_advances a
  JOIN public.profiles p ON p.id = a.agent_id
  LEFT JOIN LATERAL (
    SELECT l.amount_deducted AS amt, l.deduction_status AS status
    FROM public.agent_advance_ledger l
    WHERE l.advance_id = a.id AND l.date = v_today
    ORDER BY l.date DESC
    LIMIT 1
  ) td ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(l.amount_deducted), 0) AS repaid,
           COUNT(*) FILTER (WHERE l.deduction_status = 'none') AS missed,
           COUNT(*) FILTER (WHERE l.deduction_status IN ('full', 'partial')) AS paid
    FROM public.agent_advance_ledger l
    WHERE l.advance_id = a.id AND l.date >= v_since
  ) win ON true
  LEFT JOIN LATERAL (
    SELECT l.date AS d, l.amount_deducted AS amt
    FROM public.agent_advance_ledger l
    WHERE l.advance_id = a.id AND l.amount_deducted > 0
    ORDER BY l.date DESC
    LIMIT 1
  ) last ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(c.amount), 0) AS amt, COUNT(*) AS cnt
    FROM public.agent_collections c
    WHERE c.agent_id = a.agent_id
      AND (c.created_at AT TIME ZONE 'Africa/Kampala')::date = v_today
  ) ct ON true
  WHERE a.status IN ('active', 'overdue')
  ORDER BY (COALESCE(td.amt, 0) > 0) ASC, COALESCE(a.arrears_balance, 0) DESC, a.outstanding_balance DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_advance_repayment_monitor(int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_advance_repayment_monitor(int) TO service_role;