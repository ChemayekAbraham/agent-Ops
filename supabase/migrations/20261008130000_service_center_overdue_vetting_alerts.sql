-- Service Centre vetting deadline: the server side of the in-app "vetting overdue" alert. In-app only (no SMS, no email).
-- A Rent Plan, Landlord or LC1 chairperson waiting in a manager's Service Centre queue for overdue_hours (48) or more is "overdue".
-- The frontend polls get_my_overdue_vetting() once a minute and shows a dialog while overdue_count > 0, so a refresh cannot dodge it.
--
-- SHIPS SWITCHED OFF. On 8 Oct 2026, 3,790 of 3,798 Rent Plans, 660 of 684 Landlords and 194 of 198 LC1 chairpersons in
-- Service Centre review were already past 48 hours, spread over ~60 managers: switching it on with wall-clock ages would lock every manager on day one.
-- Items created before effective_from are aged from effective_from instead, so the backlog gets a fresh 48 hours from go-live.
-- Turn on with: SELECT set_service_center_vetting_policy(true, 48, now());
--
-- No money moves here. Only reads, one throttled audit insert, and the policy row.

CREATE TABLE IF NOT EXISTS public.service_center_vetting_policy (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),         -- single row
  enabled        boolean NOT NULL DEFAULT false,
  overdue_hours  integer NOT NULL DEFAULT 48 CHECK (overdue_hours BETWEEN 1 AND 720),
  warn_hours     integer NOT NULL DEFAULT 36 CHECK (warn_hours >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warn_before_overdue CHECK (warn_hours < overdue_hours)
);
INSERT INTO public.service_center_vetting_policy (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.service_center_vetting_policy ENABLE ROW LEVEL SECURITY;  -- no policies: reached only through the functions below

CREATE TABLE IF NOT EXISTS public.service_center_overdue_alert_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id       uuid NOT NULL,
  overdue_count    integer NOT NULL,
  oldest_age_hours numeric NOT NULL,
  shown_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_center_overdue_alert_log_mgr_idx
  ON public.service_center_overdue_alert_log (manager_id, shown_at DESC);
ALTER TABLE public.service_center_overdue_alert_log ENABLE ROW LEVEL SECURITY;

-- Every item still waiting on a Service Centre manager, with its policy-adjusted clock. Internal helper, not callable by clients.
CREATE OR REPLACE FUNCTION public.service_center_vetting_items()
RETURNS TABLE (manager_id uuid, kind text, item_id uuid, label text, clock_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH pol AS (SELECT effective_from FROM public.service_center_vetting_policy WHERE id)
  SELECT rr.service_center_manager_id, 'rent_plan'::text, rr.id, tp.full_name,
         GREATEST(rr.created_at, pol.effective_from)
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    CROSS JOIN pol
   WHERE rr.status = 'service_center_review' AND rr.service_center_manager_id IS NOT NULL
  UNION ALL
  SELECT l.service_center_manager_id, 'landlord', l.id, l.name, GREATEST(l.created_at, pol.effective_from)
    FROM public.landlords l CROSS JOIN pol
   WHERE l.service_center_status = 'pending' AND l.service_center_manager_id IS NOT NULL
     AND COALESCE(l.verified, false) = false AND COALESCE(l.verification_status, 'pending') <> 'verified'
  UNION ALL
  SELECT c.service_center_manager_id, 'lc1', c.id, c.name, GREATEST(COALESCE(c.registered_at, c.created_at), pol.effective_from)
    FROM public.lc1_chairpersons c CROSS JOIN pol
   WHERE c.service_center_status = 'pending' AND c.service_center_manager_id IS NOT NULL
     AND COALESCE(c.verified, false) = false AND COALESCE(c.verification_status, 'pending') <> 'verified';
$$;
REVOKE ALL ON FUNCTION public.service_center_vetting_items() FROM PUBLIC, anon, authenticated;

-- The caller's own overdue picture.
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
    RETURN jsonb_build_object('enabled', false, 'overdue_hours', v_pol.overdue_hours, 'warn_hours', v_pol.warn_hours,
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

-- Audit: one row when the dialog is shown, throttled to one per manager per 15 minutes so a once-a-minute reminder does not flood the table.
CREATE OR REPLACE FUNCTION public.log_overdue_vetting_alert_shown()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid(); v_cnt integer; v_oldest numeric;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM public.service_center_overdue_alert_log
              WHERE manager_id = v_uid AND shown_at > now() - interval '15 minutes') THEN
    RETURN false;
  END IF;
  -- Counts come from the server, never from the caller, so the audit cannot be forged.
  SELECT (r->>'overdue_count')::int, (r->>'oldest_age_hours')::numeric
    INTO v_cnt, v_oldest FROM (SELECT public.get_my_overdue_vetting() AS r) x;
  IF COALESCE(v_cnt, 0) = 0 THEN RETURN false; END IF;
  INSERT INTO public.service_center_overdue_alert_log (manager_id, overdue_count, oldest_age_hours)
  VALUES (v_uid, v_cnt, v_oldest);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.log_overdue_vetting_alert_shown() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_overdue_vetting_alert_shown() TO authenticated;

-- Ops view: who is holding overdue items, oldest first. Escalation is in-app: this is the list the 72-hour review works from.
CREATE OR REPLACE FUNCTION public.get_overdue_vetting_overview()
RETURNS TABLE (manager_id uuid, manager_name text, overdue_count bigint, escalated_count bigint,
               oldest_age_hours numeric, rent_plans bigint, landlords bigint, lc1 bigint, last_alert_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_pol public.service_center_vetting_policy%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_ops_role(auth.uid()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  SELECT * INTO v_pol FROM public.service_center_vetting_policy WHERE id;
  IF NOT COALESCE(v_pol.enabled, false) THEN RETURN; END IF;

  RETURN QUERY
  SELECT i.manager_id, p.full_name,
         count(*) FILTER (WHERE age_h >= v_pol.overdue_hours),
         count(*) FILTER (WHERE age_h >= v_pol.overdue_hours * 1.5),
         round(max(age_h)::numeric, 1),
         count(*) FILTER (WHERE kind = 'rent_plan' AND age_h >= v_pol.overdue_hours),
         count(*) FILTER (WHERE kind = 'landlord'  AND age_h >= v_pol.overdue_hours),
         count(*) FILTER (WHERE kind = 'lc1'       AND age_h >= v_pol.overdue_hours),
         (SELECT max(a.shown_at) FROM public.service_center_overdue_alert_log a WHERE a.manager_id = i.manager_id)
    FROM (SELECT t.manager_id, t.kind, extract(epoch FROM (now() - t.clock_at)) / 3600.0 AS age_h
            FROM public.service_center_vetting_items() t) i
    LEFT JOIN public.profiles p ON p.id = i.manager_id
   GROUP BY i.manager_id, p.full_name
  HAVING count(*) FILTER (WHERE age_h >= v_pol.overdue_hours) > 0
   ORDER BY 3 DESC, 5 DESC
   LIMIT 200;
END $$;
REVOKE ALL ON FUNCTION public.get_overdue_vetting_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_overdue_vetting_overview() TO authenticated;

-- Go-live switch (Ops roles only).
CREATE OR REPLACE FUNCTION public.set_service_center_vetting_policy(
  p_enabled boolean, p_overdue_hours integer DEFAULT 48, p_effective_from timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_ops_role(auth.uid()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  UPDATE public.service_center_vetting_policy
     SET enabled = p_enabled, overdue_hours = p_overdue_hours,
         warn_hours = LEAST(warn_hours, p_overdue_hours - 1),
         effective_from = p_effective_from, updated_by = auth.uid(), updated_at = now()
   WHERE id;
  RETURN to_jsonb((SELECT s FROM public.service_center_vetting_policy s WHERE id));
END $$;
REVOKE ALL ON FUNCTION public.set_service_center_vetting_policy(boolean, integer, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_service_center_vetting_policy(boolean, integer, timestamptz) TO authenticated;
