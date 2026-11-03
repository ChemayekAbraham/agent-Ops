-- Landlord payouts are graded on collections THROUGH YESTERDAY, never including today (Africa/Kampala).
--
-- The rule week runs Thursday to Wednesday. Payouts happen on Tuesday and Thursday.
--   * Tuesday payout   : graded Thursday through MONDAY (5 days). Tuesday itself is not counted.
--   * Thursday payout  : graded on the week that just ended, previous Thursday through Wednesday (7 days). UNCHANGED.
--   * Any other day    : Thursday through YESTERDAY. Today is never counted.
--
-- Before: the 'week_so_far' branch counted Thursday through TODAY, so a Tuesday payout was graded on Tuesday's still-open collections.
-- After : it counts Thursday through today - 1 (v_through). Three edits only: the v_through declaration, the
-- _agent_weekly_plan_lines upper bound, and the date in the reason label. The Thursday branch, targets
-- (agent_posting_rule_settings), return columns and signature are untouched.
--
-- Blast radius (intended): this function is the grade for 15 other functions (allow selected, allow with exception, reject,
-- landlord float lock and gate, CFO rent-disbursement gate, shortfall, rate lists). They all move together.
-- NOT changed: get_my_weekly_performance (the agent's Weekly Performance page) still counts through today, so it will
-- differ from the payout check until it is changed separately.
--
-- Grants: CREATE OR REPLACE keeps them (service_role only). Never DROP this function: it would reset grants to anon/authenticated.
-- Rollback: 20261103100000_payout_grade_through_yesterday.rollback.sql

CREATE OR REPLACE FUNCTION public.agent_payout_weekly_performance(p_agent_id uuid)
RETURNS TABLE(
  basis text, week_start date, week_end date, book text,
  in_window_due numeric, in_window_collected numeric, in_window_pct numeric, in_window_required_pct numeric,
  expired_due numeric, expired_collected numeric, expired_pct numeric, expired_required_pct numeric,
  expected numeric, collected numeric, rate_pct numeric, passes boolean, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_through date := ((now() AT TIME ZONE 'Africa/Kampala')::date) - 1;
  v_cur date := public._agent_rule_week_start((now() AT TIME ZONE 'Africa/Kampala')::date);
  v_s public.agent_posting_rule_settings;
  v_r public.agent_weekly_posting_eligibility;
  v_in_due numeric := 0; v_in_got numeric := 0; v_ex_due numeric := 0; v_ex_got numeric := 0;
  v_in_req numeric; v_ex_req numeric; v_wk date; v_basis text; v_pass boolean; v_book text; v_reason text; v_label text;
BEGIN
  SELECT * INTO v_s FROM public.agent_posting_rule_settings WHERE id;

  IF v_today = v_cur THEN
    -- First day of the rule week: nothing is billed yet, so judge the week that just ended, exactly as the posting gate does.
    v_basis := 'last_week'; v_wk := v_cur - 7;
    v_r := public._agent_weekly_posting_result(p_agent_id);
    IF v_r.agent_id IS NULL THEN
      v_in_due := 0; v_ex_due := 0; v_book := 'none'; v_pass := true;
      v_reason := 'Nothing was billed on your Rent Plans last week.';
    ELSE
      v_in_due := COALESCE(v_r.in_window_due, 0); v_in_got := COALESCE(v_r.in_window_collected, 0);
      v_ex_due := COALESCE(v_r.expired_due, 0);   v_ex_got := COALESCE(v_r.expired_collected, 0);
      v_in_req := v_r.in_window_required_pct; v_ex_req := v_r.expired_required_pct;
      v_book := v_r.book; v_pass := COALESCE(v_r.passes, true); v_reason := v_r.reason;
    END IF;
  ELSE
    v_basis := 'week_so_far'; v_wk := v_cur;
    SELECT COALESCE(sum(l.due) FILTER (WHERE NOT l.expired), 0), COALESCE(sum(l.collected) FILTER (WHERE NOT l.expired), 0),
           COALESCE(sum(l.due) FILTER (WHERE l.expired), 0),     COALESCE(sum(l.collected) FILTER (WHERE l.expired), 0)
      INTO v_in_due, v_in_got, v_ex_due, v_ex_got
      FROM public._agent_weekly_plan_lines(p_agent_id, v_cur, v_through) l;
    v_in_req := CASE WHEN v_in_due > 0 THEN v_s.in_window_required_pct END;
    v_ex_req := CASE WHEN v_ex_due > 0 AND v_in_due > 0 THEN v_s.expired_required_pct
                     WHEN v_ex_due > 0 THEN v_s.all_expired_required_pct END;
    v_book := CASE WHEN v_in_due > 0 AND v_ex_due > 0 THEN 'mixed' WHEN v_in_due > 0 THEN 'in_window_only'
                   WHEN v_ex_due > 0 THEN 'all_expired' ELSE 'none' END;
    v_pass := (v_in_due = 0 OR v_in_got >= v_in_req * v_in_due) AND (v_ex_due = 0 OR v_ex_got >= v_ex_req * v_ex_due);
    v_label := 'This week so far (' || to_char(v_cur, 'FMDD Mon') || ' to ' || to_char(v_through, 'FMDD Mon') || ')';
    v_reason := CASE WHEN v_book = 'none' THEN 'Nothing has been billed on your Rent Plans this week yet.' ELSE
        v_label || ' you collected '
        || CASE WHEN v_in_due > 0 THEN round(100 * v_in_got / v_in_due, 1)::text || '% of what your current Rent Plans were due (UGX '
             || to_char(v_in_got, 'FM999,999,999,999') || ' of UGX ' || to_char(v_in_due, 'FM999,999,999,999') || '). You need '
             || round(100 * v_in_req)::text || '%.' ELSE '' END
        || CASE WHEN v_in_due > 0 AND v_ex_due > 0 THEN ' On your expired Rent Plans you collected ' ELSE '' END
        || CASE WHEN v_ex_due > 0 THEN round(100 * v_ex_got / v_ex_due, 1)::text || '% of what they were due (UGX ' || to_char(v_ex_got, 'FM999,999,999,999')
             || ' of UGX ' || to_char(v_ex_due, 'FM999,999,999,999') || '). You need ' || round(100 * v_ex_req)::text || '%.' ELSE '' END
      END;
  END IF;

  RETURN QUERY SELECT v_basis, v_wk, v_wk + 6, v_book,
    v_in_due, v_in_got, CASE WHEN v_in_due > 0 THEN round(100.0 * v_in_got / v_in_due, 1) END, CASE WHEN v_in_due > 0 THEN round(100 * v_in_req, 1) END,
    v_ex_due, v_ex_got, CASE WHEN v_ex_due > 0 THEN round(100.0 * v_ex_got / v_ex_due, 1) END, CASE WHEN v_ex_due > 0 THEN round(100 * v_ex_req, 1) END,
    v_in_due + v_ex_due, v_in_got + v_ex_got,
    CASE WHEN v_in_due + v_ex_due > 0 THEN round(100.0 * (v_in_got + v_ex_got) / (v_in_due + v_ex_due), 1) END,
    v_pass, v_reason;
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_payout_weekly_performance(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_payout_weekly_performance(uuid) TO service_role;

COMMENT ON FUNCTION public.agent_payout_weekly_performance(uuid) IS
  'Landlord payout grade (Africa/Kampala, week Thu-Wed). Thursday: the week that just ended (previous Thu-Wed, 7 days). Any other day: Thursday through YESTERDAY; today is never counted (so Tuesday = Thu-Mon, 5 days). Targets from agent_posting_rule_settings.';
