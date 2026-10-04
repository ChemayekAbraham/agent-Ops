CREATE TABLE public.withdrawal_release_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  withdrawal_id uuid NOT NULL,
  release_reason text NOT NULL,
  triggered_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT withdrawal_release_events_withdrawal_id_key UNIQUE (withdrawal_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.withdrawal_release_events TO authenticated;
GRANT ALL ON public.withdrawal_release_events TO service_role;

ALTER TABLE public.withdrawal_release_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops roles can view withdrawal release events"
ON public.withdrawal_release_events FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role) OR has_role(auth.uid(), 'cto'::app_role));