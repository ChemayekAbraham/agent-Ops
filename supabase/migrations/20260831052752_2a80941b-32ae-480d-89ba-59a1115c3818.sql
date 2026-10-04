CREATE OR REPLACE FUNCTION public.get_proxy_target_mode(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent uuid := public.proxy_cc_resolve_agent(p_agent_id);
  v_e public.proxy_target_mode_enrollments;
  v_target integer := 1200;
  v_reward numeric := 2000000;
  v_min_notes integer := 200;
  v_min_reward numeric := 300000;
  v_daily_min integer := 10;
  v_month_start date := date_trunc('month', (now() AT TIME ZONE 'Africa/Kampala'))::date;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_days integer;
  v_day integer;
  v_notes integer;
  v_notes_today integer;
  v_active_days integer;
  v_zero_days integer;
  v_daily numeric;
  v_expected numeric;
  v_missed numeric;
  v_earned numeric;
  v_rate numeric;
  v_available numeric;
  v_start_day date;
BEGIN
  SELECT * INTO v_e FROM public.proxy_target_mode_enrollments WHERE agent_id = v_agent;
  IF v_e.agent_id IS NOT NULL THEN
    v_target := v_e.monthly_note_target;
    v_reward := v_e.monthly_reward;
    v_min_notes := v_e.min_notes;
    v_min_reward := v_e.min_reward;
  END IF;

  v_days := EXTRACT(DAY FROM (date_trunc('month', v_month_start) + interval '1 month - 1 day'))::int;
  v_day := EXTRACT(DAY FROM v_today)::int;

  SELECT count(*) INTO v_notes
  FROM public.promissory_notes
  WHERE agent_id = v_agent
    AND (created_at AT TIME ZONE 'Africa/Kampala')::date >= v_month_start;

  SELECT count(*) INTO v_notes_today
  FROM public.promissory_notes
  WHERE agent_id = v_agent
    AND (created_at AT TIME ZONE 'Africa/Kampala')::date = v_today;

  -- Benefits rule: at least one promissory note must be recorded on every
  -- completed day since enrolment (or month start, whichever is later).
  v_start_day := GREATEST(v_month_start, COALESCE((v_e.decided_at AT TIME ZONE 'Africa/Kampala')::date, v_month_start));

  SELECT count(*) INTO v_active_days
  FROM (
    SELECT DISTINCT (created_at AT TIME ZONE 'Africa/Kampala')::date AS d
    FROM public.promissory_notes
    WHERE agent_id = v_agent
      AND (created_at AT TIME ZONE 'Africa/Kampala')::date >= v_start_day
      AND (created_at AT TIME ZONE 'Africa/Kampala')::date < v_today
  ) s;

  v_zero_days := GREATEST((v_today - v_start_day) - v_active_days, 0);

  v_daily := v_daily_min;
  v_expected := LEAST(v_daily * v_day, v_target);
  v_missed := GREATEST(v_expected - v_notes, 0);

  -- Payout curve: 0 -> 0, min tier -> min reward, full target -> full reward.
  v_rate := (v_reward - v_min_reward) / GREATEST(v_target - v_min_notes, 1);
  v_earned := CASE
    WHEN v_notes >= v_target THEN v_reward
    WHEN v_notes >= v_min_notes THEN v_min_reward + (v_notes - v_min_notes) * v_rate
    ELSE v_notes * (v_min_reward / GREATEST(v_min_notes,1))
  END;

  v_available := GREATEST(v_earned, LEAST(v_reward, v_reward - v_missed * v_rate));
  v_available := GREATEST(v_available, 0);

  -- Hitting the 10-note daily minimum today guarantees the minimum income.
  IF v_notes_today >= v_daily_min THEN
    v_available := GREATEST(v_available, v_min_reward);
  END IF;

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'status', COALESCE(v_e.status, 'undecided'),
    'decided_at', v_e.decided_at,
    'monthly_note_target', v_target,
    'monthly_reward', v_reward,
    'min_notes', v_min_notes,
    'min_reward', v_min_reward,
    'rate_per_note', round(v_rate),
    'days_in_month', v_days,
    'day_of_month', v_day,
    'daily_target', v_daily,
    'daily_min', v_daily_min,
    'stretch_daily', ceil(v_target::numeric / GREATEST(v_days,1)),
    'notes_month', v_notes,
    'notes_today', v_notes_today,
    'daily_min_hit_today', (v_notes_today >= v_daily_min),
    'behind_today', (v_notes_today < v_daily_min),
    'today_shortfall', GREATEST(v_daily_min - v_notes_today, 0),
    'zero_note_days', v_zero_days,
    'benefits_active', (v_zero_days = 0),
    'expected_to_date', v_expected,
    'missed_notes', v_missed,
    'earned_now', round(v_earned),
    'available_income', round(v_available),
    'guaranteed_min_income', CASE WHEN v_notes_today >= v_daily_min THEN v_min_reward ELSE 0 END,
    'tier_hit', (v_notes >= v_min_notes),
    'target_hit', (v_notes >= v_target),
    'on_track', (v_notes >= v_expected),
    'month_start', v_month_start
  );
END; $$;

REVOKE ALL ON FUNCTION public.get_proxy_target_mode(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_proxy_target_mode(uuid) TO authenticated;