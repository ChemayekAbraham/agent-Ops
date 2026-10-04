CREATE TABLE public.lending_audit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_display_name text,
  action_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  borrower_user_id uuid,
  lender_agent_id uuid,
  amount_ugx numeric,
  fee_ugx numeric,
  old_status text,
  new_status text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.lending_audit_log TO authenticated;
GRANT ALL ON public.lending_audit_log TO service_role;

ALTER TABLE public.lending_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View own or involved audit records"
  ON public.lending_audit_log FOR SELECT TO authenticated
  USING (
    actor_id = auth.uid()
    OR borrower_user_id = auth.uid()
    OR lender_agent_id = auth.uid()
  );

CREATE POLICY "Create own audit records"
  ON public.lending_audit_log FOR INSERT TO authenticated
  WITH CHECK (actor_id = auth.uid());

CREATE INDEX idx_lending_audit_actor ON public.lending_audit_log(actor_id, created_at DESC);
CREATE INDEX idx_lending_audit_entity ON public.lending_audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_lending_audit_lender ON public.lending_audit_log(lender_agent_id, created_at DESC);