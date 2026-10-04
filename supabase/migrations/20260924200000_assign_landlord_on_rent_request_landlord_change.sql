-- agent_landlord_assignments was only written AFTER INSERT on rent_requests.
-- Re-pointing an existing plan to a different landlord (ops correction,
-- doc 128: Kalule Brian) left the agent with no assignment for the new
-- landlord, so the plan vanished from the agent's Landlord Payout Float
-- withdrawal list (AgentFloatPayoutWizard reads assignments first).
-- auto_assign_landlord_to_agent() is idempotent (ON CONFLICT DO NOTHING),
-- so it is safe to also run it when landlord_id / agent_id changes.
DROP TRIGGER IF EXISTS trg_auto_assign_landlord_on_rent_request_update ON public.rent_requests;
CREATE TRIGGER trg_auto_assign_landlord_on_rent_request_update
AFTER UPDATE OF landlord_id, agent_id ON public.rent_requests
FOR EACH ROW
WHEN (NEW.landlord_id IS DISTINCT FROM OLD.landlord_id OR NEW.agent_id IS DISTINCT FROM OLD.agent_id)
EXECUTE FUNCTION public.auto_assign_landlord_to_agent();
