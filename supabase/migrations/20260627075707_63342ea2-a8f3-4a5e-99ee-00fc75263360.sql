CREATE TABLE public.standing_order_audit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scheduled_payout_id uuid,
  action text NOT NULL CHECK (action IN ('create','pause','resume','cancel')),
  acted_by uuid REFERENCES auth.users,
  acted_by_name text,
  target_user_id uuid,
  recipient_name text,
  amount numeric,
  reason text,
  schedule_description text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.standing_order_audit_log TO authenticated;
GRANT ALL ON public.standing_order_audit_log TO service_role;

ALTER TABLE public.standing_order_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "CFO and finance roles can view standing order audit"
ON public.standing_order_audit_log
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Authenticated users log their own standing order actions"
ON public.standing_order_audit_log
FOR INSERT
TO authenticated
WITH CHECK (acted_by = auth.uid());

CREATE INDEX idx_standing_order_audit_payout ON public.standing_order_audit_log (scheduled_payout_id);
CREATE INDEX idx_standing_order_audit_created ON public.standing_order_audit_log (created_at DESC);