CREATE OR REPLACE FUNCTION public.sync_cashout_agent_capability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.is_active = true THEN
    INSERT INTO public.agent_capabilities (agent_id, capability, status, granted_by, granted_at, updated_at)
    VALUES (NEW.agent_id, 'process_cash_out', 'active', NEW.assigned_by, now(), now())
    ON CONFLICT (agent_id, capability)
    DO UPDATE SET status = 'active', revoked_at = NULL, revoked_by = NULL, updated_at = now();
  ELSIF NEW.is_active = false THEN
    UPDATE public.agent_capabilities
    SET status = 'revoked', revoked_at = now(), updated_at = now()
    WHERE agent_id = NEW.agent_id AND capability = 'process_cash_out' AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_cashout_agent_capability ON public.cashout_agents;
CREATE TRIGGER trg_sync_cashout_agent_capability
AFTER INSERT OR UPDATE OF is_active ON public.cashout_agents
FOR EACH ROW
EXECUTE FUNCTION public.sync_cashout_agent_capability();

INSERT INTO public.agent_capabilities (agent_id, capability, status, granted_at, updated_at)
SELECT ca.agent_id, 'process_cash_out', 'active', now(), now()
FROM public.cashout_agents ca
WHERE ca.is_active = true
ON CONFLICT (agent_id, capability)
DO UPDATE SET status = 'active', revoked_at = NULL, revoked_by = NULL, updated_at = now();