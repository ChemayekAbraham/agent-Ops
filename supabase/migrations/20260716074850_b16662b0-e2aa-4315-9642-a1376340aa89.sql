
CREATE OR REPLACE FUNCTION public.enforce_collection_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_locked_at timestamptz;
BEGIN
  SELECT collection_locked_at
    INTO v_locked_at
  FROM public.rent_requests
  WHERE tenant_id = NEW.tenant_id
    AND agent_id  = NEW.agent_id
    AND tenancy_status = 'active'
    AND collection_locked_at IS NOT NULL
  LIMIT 1;

  IF v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Tenant is locked from collection since %. Agent Ops must transfer this tenant to another agent.', v_locked_at
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_collection_lock ON public.agent_collections;
CREATE TRIGGER trg_enforce_collection_lock
  BEFORE INSERT ON public.agent_collections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_collection_lock();
