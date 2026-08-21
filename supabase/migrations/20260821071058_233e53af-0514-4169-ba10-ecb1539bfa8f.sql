ALTER TABLE public.proxy_agent_assignments
  DROP CONSTRAINT IF EXISTS proxy_agent_assignments_beneficiary_role_check;

ALTER TABLE public.proxy_agent_assignments
  ADD CONSTRAINT proxy_agent_assignments_beneficiary_role_check
  CHECK (beneficiary_role = ANY (ARRAY['landlord'::text, 'supporter'::text, 'tenant'::text]));