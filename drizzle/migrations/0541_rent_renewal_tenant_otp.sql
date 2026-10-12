CREATE TABLE public.rent_renewal_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prev_request_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  verified_at timestamptz,
  consumed_at timestamptz,
  consumed_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.rent_renewal_otps TO service_role;
ALTER TABLE public.rent_renewal_otps ENABLE ROW LEVEL SECURITY;
CREATE INDEX rent_renewal_otps_lookup ON public.rent_renewal_otps (tenant_id, agent_id, created_at DESC);

-- Who may renew a completed plan (same rules as renew_rent_request).
CREATE OR REPLACE FUNCTION public._can_renew_rent_request(p_prev public.rent_requests, p_actor uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF COALESCE(p_prev.assigned_agent_id, p_prev.agent_id) = p_actor OR p_prev.agent_id = p_actor THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM rent_requests r WHERE r.tenant_id = p_prev.tenant_id AND (r.agent_id = p_actor OR r.assigned_agent_id = p_actor)) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM agent_subagents s WHERE s.status = 'verified' AND (
      (s.parent_agent_id = p_actor AND s.sub_agent_id IN (p_prev.agent_id, p_prev.assigned_agent_id))
   OR (s.sub_agent_id = p_actor AND s.parent_agent_id IN (p_prev.agent_id, p_prev.assigned_agent_id)))) THEN RETURN true; END IF;
  RETURN has_role(p_actor,'agent_ops') OR has_role(p_actor,'tenant_ops') OR has_role(p_actor,'operations')
      OR has_role(p_actor,'manager') OR has_role(p_actor,'super_admin');
END $$;
REVOKE ALL ON FUNCTION public._can_renew_rent_request(public.rent_requests, uuid) FROM PUBLIC, anon, authenticated;

-- Context for sending the renewal code; called by the edge function as the signed-in agent.
CREATE OR REPLACE FUNCTION public.rent_renewal_otp_context(p_prev_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_prev rent_requests%ROWTYPE; v_phone text; v_tname text; v_aname text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT * INTO v_prev FROM rent_requests WHERE id = p_prev_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PREVIOUS_REQUEST_NOT_FOUND'; END IF;
  IF v_prev.status <> 'completed' THEN RAISE EXCEPTION 'PLAN_NOT_COMPLETED: only a completed Rent Plan can be renewed'; END IF;
  IF NOT _can_renew_rent_request(v_prev, v_actor) THEN RAISE EXCEPTION 'NOT_YOUR_REQUEST'; END IF;
  SELECT phone, full_name INTO v_phone, v_tname FROM profiles WHERE id = v_prev.tenant_id;
  SELECT full_name INTO v_aname FROM profiles WHERE id = v_actor;
  RETURN jsonb_build_object('tenant_id', v_prev.tenant_id, 'tenant_phone', v_phone, 'tenant_name', v_tname,
    'agent_id', v_actor, 'agent_name', v_aname);
END $$;
REVOKE ALL ON FUNCTION public.rent_renewal_otp_context(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rent_renewal_otp_context(uuid) TO authenticated;

-- Server-side gate: no renewal is created without a fresh tenant-confirmed code.
CREATE OR REPLACE FUNCTION public.enforce_rent_renewal_otp()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_otp uuid; v_actor uuid := COALESCE(auth.uid(), NEW.agent_id);
BEGIN
  IF NEW.registration_type IS DISTINCT FROM 'renewal' THEN RETURN NEW; END IF;
  SELECT id INTO v_otp FROM rent_renewal_otps
   WHERE tenant_id = NEW.tenant_id AND agent_id = v_actor
     AND verified_at IS NOT NULL AND consumed_at IS NULL
     AND verified_at > now() - interval '30 minutes'
   ORDER BY verified_at DESC LIMIT 1 FOR UPDATE;
  IF v_otp IS NULL THEN
    RAISE EXCEPTION 'RENEWAL_OTP_REQUIRED: the tenant must confirm this renewal with the code sent to their phone' USING ERRCODE = '42501';
  END IF;
  UPDATE rent_renewal_otps SET consumed_at = now(), consumed_request_id = NEW.id WHERE id = v_otp;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_enforce_rent_renewal_otp ON public.rent_requests;
CREATE TRIGGER trg_enforce_rent_renewal_otp BEFORE INSERT ON public.rent_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rent_renewal_otp();