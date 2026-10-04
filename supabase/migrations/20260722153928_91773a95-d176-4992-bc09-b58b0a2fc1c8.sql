CREATE OR REPLACE FUNCTION public.enforce_daytime_house_listing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hour_eat integer;
  v_is_agent boolean;
  v_is_privileged boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role IN ('agent','sub_agent','senior_agent')
  ) INTO v_is_agent;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role IN (
        'manager','admin','super_admin','ceo','cfo','cto','coo','cmo',
        'tenant_ops','landlord_ops','agent_ops','financial_ops',
        'partner_ops','crm','hr'
      )
  ) INTO v_is_privileged;

  IF v_is_privileged OR NOT v_is_agent THEN
    RETURN NEW;
  END IF;

  v_hour_eat := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala'))::int;

  IF v_hour_eat < 6 OR v_hour_eat >= 18 THEN
    RAISE EXCEPTION 'House listing is only allowed between 6:00 AM and 6:00 PM (EAT). Please list this house during the day so photos and location can be captured clearly.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;