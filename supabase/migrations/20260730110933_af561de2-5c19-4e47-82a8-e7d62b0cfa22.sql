CREATE TABLE public.rent_repayment_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL REFERENCES public.rent_requests(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  subscription_id uuid REFERENCES public.subscription_charges(id),
  pause_days integer NOT NULL CHECK (pause_days IN (7, 14, 30)),
  reason text NOT NULL,
  paused_by uuid,
  paused_at timestamptz NOT NULL DEFAULT now(),
  resume_on date NOT NULL,
  resumed_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resumed','cancelled')),
  previous_next_charge_date date,
  previous_end_date date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.rent_repayment_pauses TO authenticated;
GRANT ALL ON public.rent_repayment_pauses TO service_role;

ALTER TABLE public.rent_repayment_pauses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops can view repayment pauses"
ON public.rent_repayment_pauses FOR SELECT TO authenticated
USING (
  public.is_ops_role(auth.uid())
  OR tenant_id = auth.uid()
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Ops can create repayment pauses"
ON public.rent_repayment_pauses FOR INSERT TO authenticated
WITH CHECK (
  public.is_ops_role(auth.uid())
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Ops can update repayment pauses"
ON public.rent_repayment_pauses FOR UPDATE TO authenticated
USING (
  public.is_ops_role(auth.uid())
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE UNIQUE INDEX uniq_active_pause_per_request
  ON public.rent_repayment_pauses (rent_request_id)
  WHERE status = 'active';

CREATE INDEX idx_rent_repayment_pauses_resume
  ON public.rent_repayment_pauses (status, resume_on);

CREATE TRIGGER trg_rent_repayment_pauses_updated_at
BEFORE UPDATE ON public.rent_repayment_pauses
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Pause collections for an outstanding-balance rent plan
CREATE OR REPLACE FUNCTION public.pause_tenant_repayment(
  p_rent_request_id uuid,
  p_days integer,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rr record;
  v_sub record;
  v_resume_on date;
  v_pause_id uuid;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised to pause repayments';
  END IF;

  IF p_days NOT IN (7, 14, 30) THEN
    RAISE EXCEPTION 'Pause duration must be 7, 14 or 30 days';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_rr FROM public.rent_requests WHERE id = p_rent_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  IF coalesce(v_rr.registration_type, '') <> 'outstanding_balance' THEN
    RAISE EXCEPTION 'Only outstanding balance repayments can be paused';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.rent_repayment_pauses
    WHERE rent_request_id = p_rent_request_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'This repayment is already paused';
  END IF;

  SELECT * INTO v_sub
  FROM public.subscription_charges
  WHERE rent_request_id = p_rent_request_id
    AND status IN ('active', 'paused')
  ORDER BY created_at DESC
  LIMIT 1;

  v_resume_on := (CURRENT_DATE + p_days)::date;

  INSERT INTO public.rent_repayment_pauses (
    rent_request_id, tenant_id, subscription_id, pause_days, reason,
    paused_by, resume_on, previous_next_charge_date, previous_end_date
  ) VALUES (
    p_rent_request_id, v_rr.tenant_id, v_sub.id, p_days, btrim(p_reason),
    auth.uid(), v_resume_on, v_sub.next_charge_date, v_sub.end_date
  ) RETURNING id INTO v_pause_id;

  IF v_sub.id IS NOT NULL THEN
    UPDATE public.subscription_charges
    SET status = 'paused',
        next_charge_date = v_resume_on,
        end_date = CASE WHEN end_date IS NULL THEN NULL ELSE (end_date + p_days)::date END,
        updated_at = now()
    WHERE id = v_sub.id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    auth.uid(), 'repayment_pause', 'rent_requests', p_rent_request_id, btrim(p_reason),
    jsonb_build_object('pause_id', v_pause_id, 'pause_days', p_days, 'resume_on', v_resume_on, 'subscription_id', v_sub.id)
  );

  RETURN jsonb_build_object('success', true, 'pause_id', v_pause_id, 'resume_on', v_resume_on);
END;
$$;

GRANT EXECUTE ON FUNCTION public.pause_tenant_repayment(uuid, integer, text) TO authenticated;

-- Cancel an active pause early
CREATE OR REPLACE FUNCTION public.cancel_tenant_repayment_pause(
  p_rent_request_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pause record;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised to resume repayments';
  END IF;

  SELECT * INTO v_pause
  FROM public.rent_repayment_pauses
  WHERE rent_request_id = p_rent_request_id AND status = 'active'
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active pause on this repayment';
  END IF;

  UPDATE public.rent_repayment_pauses
  SET status = 'cancelled', resumed_at = now(),
      metadata = metadata || jsonb_build_object('cancelled_by', auth.uid(), 'cancel_reason', coalesce(btrim(p_reason), 'manual resume'))
  WHERE id = v_pause.id;

  IF v_pause.subscription_id IS NOT NULL THEN
    UPDATE public.subscription_charges
    SET status = 'active',
        next_charge_date = CURRENT_DATE,
        updated_at = now()
    WHERE id = v_pause.subscription_id AND status = 'paused';
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    auth.uid(), 'repayment_pause_cancelled', 'rent_requests', p_rent_request_id,
    coalesce(nullif(btrim(p_reason), ''), 'Manual early resume'),
    jsonb_build_object('pause_id', v_pause.id)
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_tenant_repayment_pause(uuid, text) TO authenticated;

-- Auto-resume expired pauses (cron)
CREATE OR REPLACE FUNCTION public.resume_expired_repayment_pauses()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pause record;
  v_count integer := 0;
BEGIN
  FOR v_pause IN
    SELECT * FROM public.rent_repayment_pauses
    WHERE status = 'active' AND resume_on <= CURRENT_DATE
  LOOP
    UPDATE public.rent_repayment_pauses
    SET status = 'resumed', resumed_at = now()
    WHERE id = v_pause.id;

    IF v_pause.subscription_id IS NOT NULL THEN
      UPDATE public.subscription_charges
      SET status = 'active',
          next_charge_date = GREATEST(CURRENT_DATE, next_charge_date),
          updated_at = now()
      WHERE id = v_pause.subscription_id AND status = 'paused';
    END IF;

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (
      v_pause.paused_by, 'repayment_pause_auto_resumed', 'rent_requests', v_pause.rent_request_id,
      'Pause period elapsed - collections resumed',
      jsonb_build_object('pause_id', v_pause.id, 'pause_days', v_pause.pause_days)
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('resumed', v_count);
END;
$$;

SELECT cron.schedule(
  'resume-expired-repayment-pauses',
  '10 0 * * *',
  $$SELECT public.resume_expired_repayment_pauses();$$
);