CREATE OR REPLACE FUNCTION public._dormant_bike_leases(p_agent uuid DEFAULT NULL)
RETURNS TABLE(lease_id uuid, agent_id uuid, agent_name text, agent_phone text, bike_model text,
  last_deduction_at timestamptz, days_since_last_deduction int, amount_outstanding numeric,
  lease_days_remaining int, is_dormant boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH active AS (
    SELECT l.* FROM agent_bike_leases l
    WHERE l.lease_activated_at IS NOT NULL
      AND COALESCE(l.amount_outstanding,0) > 0
      AND l.status NOT IN ('rejected','completed','cancelled','cleared','returned')
      AND (p_agent IS NULL OR l.agent_id = p_agent)
  ), last_d AS (
    SELECT a.id, (SELECT max(d.created_at) FROM merchandise_recovery_deductions d
                  JOIN merchandise_recovery_plans p ON p.id = d.plan_id
                  WHERE p.sale_id = a.sale_id) AS last_at
    FROM active a
  )
  SELECT a.id, a.agent_id, COALESCE(pr.full_name, a.agent_name), COALESCE(a.agent_phone, pr.phone),
    trim(concat_ws(' ', a.brand, a.model)),
    ld.last_at,
    (current_date - (COALESCE(ld.last_at, a.lease_activated_at) AT TIME ZONE 'Africa/Kampala')::date)::int,
    a.amount_outstanding,
    GREATEST(0, ((a.lease_activated_at + make_interval(months => COALESCE(a.lease_term_months,12)))::date - current_date))::int,
    (current_date - (COALESCE(ld.last_at, a.lease_activated_at) AT TIME ZONE 'Africa/Kampala')::date) >= 7
  FROM active a JOIN last_d ld ON ld.id = a.id
  LEFT JOIN profiles pr ON pr.id = a.agent_id;
$$;
REVOKE ALL ON FUNCTION public._dormant_bike_leases(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_dormant_bike_leases()
RETURNS SETOF record LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$ BEGIN RETURN; END $$;
DROP FUNCTION public.get_dormant_bike_leases();

CREATE FUNCTION public.get_dormant_bike_leases()
RETURNS TABLE(lease_id uuid, agent_id uuid, agent_name text, agent_phone text, bike_model text,
  last_deduction_at timestamptz, days_since_last_deduction int, amount_outstanding numeric, lease_days_remaining int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.is_ops_role(auth.uid())
          OR public.has_role(auth.uid(),'agent_ops') OR public.has_role(auth.uid(),'cfo')
          OR public.has_role(auth.uid(),'cto') OR public.has_role(auth.uid(),'ceo')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY SELECT x.lease_id, x.agent_id, x.agent_name, x.agent_phone, x.bike_model, x.last_deduction_at,
    x.days_since_last_deduction, x.amount_outstanding, x.lease_days_remaining
  FROM public._dormant_bike_leases(NULL) x WHERE x.is_dormant
  ORDER BY x.days_since_last_deduction DESC, x.amount_outstanding DESC;
END $$;
REVOKE ALL ON FUNCTION public.get_dormant_bike_leases() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dormant_bike_leases() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_dormant_bike_leases()
RETURNS TABLE(lease_id uuid, bike_model text, days_since_last_deduction int, amount_outstanding numeric, lease_days_remaining int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT x.lease_id, x.bike_model, x.days_since_last_deduction, x.amount_outstanding, x.lease_days_remaining
  FROM public._dormant_bike_leases(auth.uid()) x WHERE x.is_dormant AND auth.uid() IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.get_my_dormant_bike_leases() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_dormant_bike_leases() TO authenticated;

-- One reminder per dormancy period: event_key is tied to the last deduction (or activation) timestamp,
-- so a new deduction starts a new period and only then can a new reminder be sent.
CREATE OR REPLACE FUNCTION public.notify_dormant_bike_leases()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int := 0;
BEGIN
  WITH d AS (
    SELECT x.*, 'bike_lease_dormant:' || x.lease_id || ':' ||
      COALESCE(to_char(x.last_deduction_at,'YYYYMMDDHH24MISS'),'activated') AS ek
    FROM public._dormant_bike_leases(NULL) x WHERE x.is_dormant
  ), ins AS (
    INSERT INTO notifications (user_id, title, message, type, metadata, event_key, link_path)
    SELECT d.agent_id, 'A quick reminder about your bike lease',
      'Your bike lease payments have been paused for ' || d.days_since_last_deduction ||
      ' days. Collect rent to keep your repayment on track. Balance left: UGX ' ||
      to_char(d.amount_outstanding,'FM999,999,999') || ', ' || d.lease_days_remaining || ' days remaining on your lease.',
      'bike_lease_reminder',
      jsonb_build_object('lease_id', d.lease_id, 'days_since_last_deduction', d.days_since_last_deduction,
                         'amount_outstanding', d.amount_outstanding, 'last_deduction_at', d.last_deduction_at),
      d.ek, '/dashboard'
    FROM d WHERE NOT EXISTS (SELECT 1 FROM notifications n2 WHERE n2.event_key = d.ek)
    RETURNING 1
  ) SELECT count(*) INTO n FROM ins;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.notify_dormant_bike_leases() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  IF COALESCE(NEW.type, '') IN (
    'merchandise_recovery','director_requisition','advance_arrears','budget',
    'staff_requisition','hr_birthday','rd_alert','lending_repayment',
    'float','bike_lease_reminder'
  ) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.metadata->>'action','') IN ('listing_rejected','subagent_listing_rejected') THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$;