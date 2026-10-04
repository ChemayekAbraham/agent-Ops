DO $mig$
DECLARE d text; nd text;
BEGIN
  d := pg_get_viewdef('public.v_agent_daily_eligibility'::regclass, true);
  nd := d;

  nd := replace(
    nd,
    'COALESCE(pd.pin_today, 0::numeric) AS due_today_amount',
    'CASE WHEN COALESCE(lr.daily_repayment, 0::numeric) > 0::numeric THEN LEAST(COALESCE(pd.pin_today, 0::numeric), COALESCE(lr.daily_repayment, 0::numeric)) ELSE COALESCE(pd.pin_today, 0::numeric) END AS due_today_amount'
  );
  nd := replace(
    nd,
    'COALESCE(pd.pin_yesterday, 0::numeric) AS due_yesterday_amount',
    'CASE WHEN COALESCE(lr.daily_repayment, 0::numeric) > 0::numeric THEN LEAST(COALESCE(pd.pin_yesterday, 0::numeric), COALESCE(lr.daily_repayment, 0::numeric)) ELSE COALESCE(pd.pin_yesterday, 0::numeric) END AS due_yesterday_amount'
  );

  IF nd = d THEN
    RAISE EXCEPTION 'v_agent_daily_eligibility: expected due-amount patterns not found; aborting';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS ' || nd;
END
$mig$;