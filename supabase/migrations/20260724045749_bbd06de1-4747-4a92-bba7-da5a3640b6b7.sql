
CREATE TABLE public.roi_payout_schedules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES public.investor_portfolios(id) ON DELETE CASCADE,
  previous_date DATE,
  scheduled_date DATE NOT NULL,
  scheduled_by UUID NOT NULL REFERENCES auth.users(id),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_roi_payout_schedules_portfolio ON public.roi_payout_schedules(portfolio_id, created_at DESC);

GRANT SELECT, INSERT ON public.roi_payout_schedules TO authenticated;
GRANT ALL ON public.roi_payout_schedules TO service_role;

ALTER TABLE public.roi_payout_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops roles can view roi schedules"
  ON public.roi_payout_schedules FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

CREATE POLICY "Ops roles can insert roi schedules"
  ON public.roi_payout_schedules FOR INSERT
  TO authenticated
  WITH CHECK (
    scheduled_by = auth.uid() AND (
      public.has_role(auth.uid(), 'tenant_ops'::app_role)
      OR public.has_role(auth.uid(), 'coo'::app_role)
      OR public.has_role(auth.uid(), 'cfo'::app_role)
      OR public.has_role(auth.uid(), 'manager'::app_role)
      OR public.has_role(auth.uid(), 'super_admin'::app_role)
    )
  );

CREATE OR REPLACE FUNCTION public.schedule_roi_payout(
  p_portfolio_id UUID,
  p_new_date DATE,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_prev DATE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF NOT (
    public.has_role(v_user, 'tenant_ops'::app_role)
    OR public.has_role(v_user, 'coo'::app_role)
    OR public.has_role(v_user, 'cfo'::app_role)
    OR public.has_role(v_user, 'manager'::app_role)
    OR public.has_role(v_user, 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'forbidden: only Tenant Ops, COO, CFO, or manager may schedule ROI payouts';
  END IF;

  IF p_new_date IS NULL THEN
    RAISE EXCEPTION 'scheduled_date_required';
  END IF;

  IF p_new_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'scheduled_date_cannot_be_in_past';
  END IF;

  SELECT next_roi_date INTO v_prev
  FROM public.investor_portfolios
  WHERE id = p_portfolio_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'portfolio_not_found';
  END IF;

  UPDATE public.investor_portfolios
  SET next_roi_date = p_new_date,
      updated_at = now()
  WHERE id = p_portfolio_id;

  INSERT INTO public.roi_payout_schedules (portfolio_id, previous_date, scheduled_date, scheduled_by, reason)
  VALUES (p_portfolio_id, v_prev, p_new_date, v_user, p_reason);

  INSERT INTO public.system_events (event_type, entity_type, entity_id, actor_id, payload)
  VALUES (
    'roi.payout.rescheduled',
    'investor_portfolio',
    p_portfolio_id,
    v_user,
    jsonb_build_object('previous_date', v_prev, 'scheduled_date', p_new_date, 'reason', p_reason)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'portfolio_id', p_portfolio_id,
    'previous_date', v_prev,
    'scheduled_date', p_new_date
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.schedule_roi_payout(UUID, DATE, TEXT) TO authenticated;
