CREATE TABLE public.service_centre_advances (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES public.service_centre_entries(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  principal_amount numeric NOT NULL CHECK (principal_amount > 0),
  daily_deduction numeric NOT NULL DEFAULT 0 CHECK (daily_deduction >= 0),
  amount_recovered numeric NOT NULL DEFAULT 0 CHECK (amount_recovered >= 0),
  duration_days integer NOT NULL DEFAULT 30 CHECK (duration_days > 0),
  status text NOT NULL DEFAULT 'attached' CHECK (status IN ('attached','active','paused','completed','cancelled')),
  notes text,
  attached_by uuid REFERENCES auth.users(id),
  attached_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sc_advances_entry ON public.service_centre_advances(entry_id);
CREATE INDEX idx_sc_advances_agent ON public.service_centre_advances(agent_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_centre_advances TO authenticated;
GRANT ALL ON public.service_centre_advances TO service_role;

ALTER TABLE public.service_centre_advances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops roles manage service centre advances"
ON public.service_centre_advances FOR ALL TO authenticated
USING (
  public.has_role((select auth.uid()), 'agent_ops') OR
  public.has_role((select auth.uid()), 'manager') OR
  public.has_role((select auth.uid()), 'ceo') OR
  public.has_role((select auth.uid()), 'coo') OR
  public.has_role((select auth.uid()), 'cfo') OR
  public.has_role((select auth.uid()), 'super_admin')
)
WITH CHECK (
  public.has_role((select auth.uid()), 'agent_ops') OR
  public.has_role((select auth.uid()), 'manager') OR
  public.has_role((select auth.uid()), 'ceo') OR
  public.has_role((select auth.uid()), 'coo') OR
  public.has_role((select auth.uid()), 'cfo') OR
  public.has_role((select auth.uid()), 'super_admin')
);

CREATE POLICY "Agents view their own service centre advances"
ON public.service_centre_advances FOR SELECT TO authenticated
USING (agent_id = (select auth.uid()));

CREATE TRIGGER trg_sc_advances_updated_at
BEFORE UPDATE ON public.service_centre_advances
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();