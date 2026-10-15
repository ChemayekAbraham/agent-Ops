ALTER TABLE public.food_meals ADD COLUMN IF NOT EXISTS is_daily boolean NOT NULL DEFAULT false;

-- Default meal time for auto-listing: "Any time" if active, else the earliest active one.
CREATE OR REPLACE FUNCTION public._food_default_period()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM public.food_service_periods WHERE active
  ORDER BY (name = 'Any time') DESC, ordering_opens_at, created_at LIMIT 1
$$;

-- Put one published meal on a day's menu (published), unless already there.
CREATE OR REPLACE FUNCTION public._food_list_meal_on_day(p_meal_id uuid, p_day date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_period uuid := public._food_default_period();
BEGIN
  IF v_period IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.food_service_closures WHERE closure_date = p_day) THEN RETURN; END IF;
  -- already listed on some meal time that day: just make sure it is visible
  IF EXISTS (SELECT 1 FROM public.food_menu_items WHERE meal_id = p_meal_id AND service_date = p_day) THEN
    UPDATE public.food_menu_items SET published_at = COALESCE(published_at, now())
     WHERE meal_id = p_meal_id AND service_date = p_day;
    RETURN;
  END IF;
  INSERT INTO public.food_menu_items (service_date, period_id, meal_id, price_ugx, published_at, created_by)
  SELECT p_day, v_period, m.id, m.price_ugx, now(), m.created_by
    FROM public.food_meals m WHERE m.id = p_meal_id AND m.status = 'published'
  ON CONFLICT (service_date, period_id, meal_id) DO NOTHING;
END $$;

-- Daily roll: every published daily meal goes onto today's menu.
CREATE OR REPLACE FUNCTION public.food_roll_daily_menu()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_day date := (now() AT TIME ZONE 'Africa/Kampala')::date; r record; n int := 0;
BEGIN
  FOR r IN SELECT id FROM public.food_meals WHERE status = 'published' AND is_daily AND archived_at IS NULL LOOP
    PERFORM public._food_list_meal_on_day(r.id, v_day); n := n + 1;
  END LOOP;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.food_set_meal_status(p_meal_id uuid, p_status text, p_reason text DEFAULT NULL::text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_actor uuid := public.food_require_active_coordinator(); v_before jsonb;
BEGIN
  IF p_status NOT IN ('draft','published','archived') THEN
    RAISE EXCEPTION 'Unknown meal status %', p_status USING ERRCODE='22023'; END IF;
  SELECT to_jsonb(m) INTO v_before FROM public.food_meals m WHERE m.id=p_meal_id;
  IF v_before IS NULL THEN RAISE EXCEPTION 'Meal not found' USING ERRCODE='P0002'; END IF;

  UPDATE public.food_meals
     SET status=p_status,
         archived_at = CASE WHEN p_status='archived' THEN now() ELSE NULL END,
         updated_at=now()
   WHERE id=p_meal_id;
  -- Publishing puts the meal straight onto today's staff menu.
  IF p_status = 'published' THEN
    PERFORM public._food_list_meal_on_day(p_meal_id, (now() AT TIME ZONE 'Africa/Kampala')::date);
  END IF;
  PERFORM public.food_audit_write('meal', p_meal_id, 'status_'||p_status, v_before,
    (SELECT to_jsonb(m) FROM public.food_meals m WHERE m.id=p_meal_id), p_reason, v_actor);
END $function$;

CREATE OR REPLACE FUNCTION public.food_set_meal_daily(p_meal_id uuid, p_daily boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator(); v_before jsonb;
BEGIN
  SELECT to_jsonb(m) INTO v_before FROM public.food_meals m WHERE m.id=p_meal_id;
  IF v_before IS NULL THEN RAISE EXCEPTION 'Meal not found' USING ERRCODE='P0002'; END IF;
  UPDATE public.food_meals SET is_daily = p_daily, updated_at = now() WHERE id = p_meal_id;
  IF p_daily THEN
    PERFORM public._food_list_meal_on_day(p_meal_id, (now() AT TIME ZONE 'Africa/Kampala')::date);
  END IF;
  PERFORM public.food_audit_write('meal', p_meal_id, CASE WHEN p_daily THEN 'daily_on' ELSE 'daily_off' END,
    v_before, (SELECT to_jsonb(m) FROM public.food_meals m WHERE m.id=p_meal_id), NULL, v_actor);
END $$;

REVOKE ALL ON FUNCTION public._food_default_period() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._food_list_meal_on_day(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.food_roll_daily_menu() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.food_set_meal_daily(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.food_set_meal_daily(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.food_roll_daily_menu() TO service_role;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'food-roll-daily-menu';
SELECT cron.schedule('food-roll-daily-menu', '1 * * * *', $$SELECT public.food_roll_daily_menu()$$);