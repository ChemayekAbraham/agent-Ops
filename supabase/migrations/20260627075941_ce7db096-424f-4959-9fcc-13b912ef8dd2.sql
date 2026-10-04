CREATE TABLE public.scheduled_payout_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scheduled_payout_id uuid,
  target_user_id uuid,
  recipient_name text,
  amount numeric,
  reason text,
  category_id text,
  status text NOT NULL DEFAULT 'success' CHECK (status IN ('success','failed')),
  error_message text,
  ran_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT ON public.scheduled_payout_runs TO authenticated;
GRANT ALL ON public.scheduled_payout_runs TO service_role;

ALTER TABLE public.scheduled_payout_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "CFO and finance roles can view scheduled payout runs"
ON public.scheduled_payout_runs
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'operations')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE INDEX idx_scheduled_payout_runs_target ON public.scheduled_payout_runs (target_user_id, ran_at DESC);
CREATE INDEX idx_scheduled_payout_runs_payout ON public.scheduled_payout_runs (scheduled_payout_id, ran_at DESC);
CREATE INDEX idx_scheduled_payout_runs_ran_at ON public.scheduled_payout_runs (ran_at DESC);