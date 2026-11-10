CREATE OR REPLACE FUNCTION public.landlord_float_lock_message(p_agent_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  cur_ok boolean; exp_ok boolean; has_exp boolean;
  cur_need numeric; exp_need numeric;
  lines text := '';
  fmt constant text := 'FM999,999,999,990';
BEGIN
  SELECT * INTO r FROM public.agent_payout_weekly_performance(p_agent_id);
  IF r.in_window_required_pct IS NULL AND r.expired_required_pct IS NULL THEN
    RETURN 'Landlord float is locked. ' || COALESCE(r.reason, '') || ' Collect more to unlock it. The week resets every Thursday.';
  END IF;
  has_exp := COALESCE(r.expired_due, 0) > 0;
  cur_ok := COALESCE(r.in_window_pct, 0) >= COALESCE(r.in_window_required_pct, 0);
  exp_ok := NOT has_exp OR COALESCE(r.expired_pct, 0) >= COALESCE(r.expired_required_pct, 0);
  cur_need := GREATEST(0, ceil(COALESCE(r.in_window_due,0) * COALESCE(r.in_window_required_pct,0) / 100.0) - COALESCE(r.in_window_collected,0));
  exp_need := GREATEST(0, ceil(COALESCE(r.expired_due,0) * COALESCE(r.expired_required_pct,0) / 100.0) - COALESCE(r.expired_collected,0));

  lines := 'Landlord float is locked this week (' || to_char(r.week_start, 'FMDD Mon') || ' to ' || to_char(r.week_end, 'FMDD Mon') || '). ';
  lines := lines || 'Current Rent Plans: ' || COALESCE(r.in_window_pct, 0)::text || '% collected, target ' || COALESCE(r.in_window_required_pct, 0)::text || '% — '
    || CASE WHEN cur_ok THEN 'target met.' ELSE 'collect UGX ' || to_char(cur_need, fmt) || ' more.' END || ' ';
  IF has_exp THEN
    lines := lines || 'Expired Rent Plans: ' || COALESCE(r.expired_pct, 0)::text || '% collected (UGX ' || to_char(COALESCE(r.expired_collected,0), fmt) || ' of UGX ' || to_char(r.expired_due, fmt) || '), target ' || COALESCE(r.expired_required_pct, 0)::text || '% — '
      || CASE WHEN exp_ok THEN 'target met.' ELSE 'collect UGX ' || to_char(exp_need, fmt) || ' more.' END || ' ';
  END IF;
  RETURN lines || 'Both targets must be met to unlock. The week resets every Thursday.';
END;
$function$;