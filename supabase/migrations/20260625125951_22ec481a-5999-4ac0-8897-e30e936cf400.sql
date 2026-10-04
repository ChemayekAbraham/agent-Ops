CREATE TABLE public.dashboard_missions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dashboard_role TEXT NOT NULL,
  period_month DATE NOT NULL,
  mission TEXT,
  goals JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (dashboard_role, period_month)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.dashboard_missions TO authenticated;
GRANT ALL ON public.dashboard_missions TO service_role;

ALTER TABLE public.dashboard_missions ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read missions (so they show on every dashboard)
CREATE POLICY "Authenticated can read dashboard missions"
ON public.dashboard_missions
FOR SELECT
TO authenticated
USING (true);

-- Only CEO / super_admin / manager may write missions
CREATE POLICY "Leadership can insert dashboard missions"
ON public.dashboard_missions
FOR INSERT
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'manager')
);

CREATE POLICY "Leadership can update dashboard missions"
ON public.dashboard_missions
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'manager')
)
WITH CHECK (
  public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'manager')
);

CREATE POLICY "Leadership can delete dashboard missions"
ON public.dashboard_missions
FOR DELETE
TO authenticated
USING (
  public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'manager')
);

CREATE TRIGGER update_dashboard_missions_updated_at
BEFORE UPDATE ON public.dashboard_missions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();