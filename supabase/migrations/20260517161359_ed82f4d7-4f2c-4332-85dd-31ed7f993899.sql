CREATE TABLE IF NOT EXISTS public.business_advance_notification_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id uuid NOT NULL REFERENCES public.business_advances(id) ON DELETE CASCADE,
  tenant_id uuid,
  new_status text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms','email','push')),
  recipient text,
  outcome text NOT NULL CHECK (outcome IN ('sent','failed','skipped','opted_out')),
  http_status int,
  error_message text,
  provider_response text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ban_log_advance_created
  ON public.business_advance_notification_log (advance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ban_log_outcome_created
  ON public.business_advance_notification_log (outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ban_log_tenant_created
  ON public.business_advance_notification_log (tenant_id, created_at DESC);

ALTER TABLE public.business_advance_notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenants view own notification log"
  ON public.business_advance_notification_log
  FOR SELECT
  TO authenticated
  USING (tenant_id = auth.uid());

CREATE POLICY "Ops staff view all notification log"
  ON public.business_advance_notification_log
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
  );
