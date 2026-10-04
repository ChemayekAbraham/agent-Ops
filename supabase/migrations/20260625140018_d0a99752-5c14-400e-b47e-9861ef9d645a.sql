CREATE OR REPLACE FUNCTION public.enforce_mission_dashboard_restriction()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF lower(trim(NEW.dashboard_role)) IN ('funder', 'supporter', 'agent', 'tenant', 'landlord') THEN
    RAISE EXCEPTION 'Missions cannot be targeted to restricted dashboards (funder/supporter, agent, tenant, landlord).'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_mission_dashboard_restriction ON public.dashboard_missions;

CREATE TRIGGER trg_enforce_mission_dashboard_restriction
BEFORE INSERT OR UPDATE ON public.dashboard_missions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_mission_dashboard_restriction();