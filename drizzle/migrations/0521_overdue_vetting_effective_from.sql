CREATE OR REPLACE FUNCTION public.get_my_overdue_vetting()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_pol public.service_center_vetting_policy%ROWTYPE;
  v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_pol FROM public.service_center_vetting_policy WHERE id;

  IF NOT COALESCE(v_pol.enabled, false) THEN
    RETURN jsonb_build_object('enabled', false, 'overdue_hours', v_pol.overdue_hours, 'warn_hours', v_pol.warn_hours, 'effective_from', v_pol.effective_from,
      'remind_after_seconds', 60, 'overdue_count', 0, 'due_soon_count', 0, 'escalated_count', 0,
      'oldest_age_hours', 0, 'by_kind', jsonb_build_object('rent_plan', 0, 'landlord', 0, 'lc1', 0), 'oldest', '[]'::jsonb);
  END IF;

  WITH mine AS (
    SELECT kind, item_id, label, extract(epoch FROM (now() - clock_at)) / 3600.0 AS age_h
      FROM public.service_center_vetting_items() WHERE manager_id = v_uid
  ), overdue AS (SELECT * FROM mine WHERE age_h >= v_pol.overdue_hours)
  SELECT jsonb_build_object(
    'enabled', true,
    'overdue_hours', v_pol.overdue_hours,
    'warn_hours', v_pol.warn_hours,
    'effective_from', v_pol.effective_from,
    'remind_after_seconds', 60,
    'overdue_count', (SELECT count(*) FROM overdue),
    'due_soon_count', (SELECT count(*) FROM mine WHERE age_h >= v_pol.warn_hours AND age_h < v_pol.overdue_hours),
    'escalated_count', (SELECT count(*) FROM mine WHERE age_h >= v_pol.overdue_hours * 1.5),
    'oldest_age_hours', COALESCE((SELECT round(max(age_h)::numeric, 1) FROM overdue), 0),
    'by_kind', jsonb_build_object(
      'rent_plan', (SELECT count(*) FROM overdue WHERE kind = 'rent_plan'),
      'landlord',  (SELECT count(*) FROM overdue WHERE kind = 'landlord'),
      'lc1',       (SELECT count(*) FROM overdue WHERE kind = 'lc1')),
    'oldest', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'id', item_id, 'label', label,
                          'age_hours', round(age_h::numeric, 1)) ORDER BY age_h DESC)
                        FROM (SELECT * FROM overdue ORDER BY age_h DESC LIMIT 3) t), '[]'::jsonb)
  ) INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.get_my_overdue_vetting() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_overdue_vetting() TO authenticated;