
CREATE TABLE public.agent_landlord_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  landlord_id UUID NOT NULL REFERENCES public.landlords(id) ON DELETE CASCADE,
  rent_request_id UUID REFERENCES public.rent_requests(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_id, landlord_id)
);

ALTER TABLE public.agent_landlord_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents see own assignments" ON public.agent_landlord_assignments
  FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

CREATE POLICY "Managers see all assignments" ON public.agent_landlord_assignments
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('manager', 'cfo', 'operations'))
  );

CREATE POLICY "System insert assignments" ON public.agent_landlord_assignments
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.auto_assign_landlord_to_agent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.agent_id IS NOT NULL AND NEW.landlord_id IS NOT NULL THEN
    INSERT INTO public.agent_landlord_assignments (agent_id, landlord_id, rent_request_id)
    VALUES (NEW.agent_id, NEW.landlord_id, NEW.id)
    ON CONFLICT (agent_id, landlord_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_assign_landlord_on_rent_request
  AFTER INSERT ON public.rent_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_assign_landlord_to_agent();
