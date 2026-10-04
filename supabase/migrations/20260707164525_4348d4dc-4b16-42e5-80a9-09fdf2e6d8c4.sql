CREATE TABLE public.job_application_communications (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES public.job_applications(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  message TEXT,
  logged_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_app_comms_application ON public.job_application_communications (application_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_application_communications TO authenticated;
GRANT ALL ON public.job_application_communications TO service_role;

ALTER TABLE public.job_application_communications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view application communications"
ON public.job_application_communications FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'hr'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role) OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
);

CREATE POLICY "Staff can add application communications"
ON public.job_application_communications FOR INSERT
TO authenticated
WITH CHECK (
  has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'hr'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role) OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
);

CREATE POLICY "Staff can update application communications"
ON public.job_application_communications FOR UPDATE
TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'hr'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role) OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
);

CREATE POLICY "Staff can delete application communications"
ON public.job_application_communications FOR DELETE
TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'hr'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role) OR has_role(auth.uid(), 'operations'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
);