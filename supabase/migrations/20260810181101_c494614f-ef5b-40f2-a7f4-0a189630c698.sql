CREATE TABLE IF NOT EXISTS public.payout_delivery_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL REFERENCES public.withdrawal_requests(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL,
  merchant_user_id uuid,
  cashout_agent_id uuid,
  amount numeric NOT NULL DEFAULT 0,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payout_delivery_disputes_open_uq
  ON public.payout_delivery_disputes (withdrawal_id)
  WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS payout_delivery_disputes_merchant_idx
  ON public.payout_delivery_disputes (merchant_user_id, status);

GRANT SELECT, INSERT, UPDATE ON public.payout_delivery_disputes TO authenticated;
GRANT ALL ON public.payout_delivery_disputes TO service_role;

ALTER TABLE public.payout_delivery_disputes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Reporters view own payout disputes"
ON public.payout_delivery_disputes FOR SELECT TO authenticated
USING (reporter_id = auth.uid());

CREATE POLICY "Merchants view disputes against them"
ON public.payout_delivery_disputes FOR SELECT TO authenticated
USING (merchant_user_id = auth.uid());

CREATE POLICY "Finance staff view payout disputes"
ON public.payout_delivery_disputes FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(),'financial_ops') OR public.has_role(auth.uid(),'cfo')
  OR public.has_role(auth.uid(),'coo') OR public.has_role(auth.uid(),'ceo')
  OR public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'super_admin')
  OR public.has_role(auth.uid(),'agent_ops')
);

CREATE OR REPLACE FUNCTION public.touch_payout_delivery_disputes()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_touch_payout_delivery_disputes ON public.payout_delivery_disputes;
CREATE TRIGGER trg_touch_payout_delivery_disputes
BEFORE UPDATE ON public.payout_delivery_disputes
FOR EACH ROW EXECUTE FUNCTION public.touch_payout_delivery_disputes();

CREATE OR REPLACE FUNCTION public.report_payout_not_received(
  p_withdrawal_id uuid,
  p_message text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_wr record; v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF coalesce(length(trim(p_message)), 0) < 10 THEN
    RAISE EXCEPTION 'Please describe what happened (at least 10 characters).';
  END IF;

  SELECT id, user_id, amount, status, processed_by, assigned_cashout_agent_id
    INTO v_wr
  FROM public.withdrawal_requests WHERE id = p_withdrawal_id;

  IF v_wr.id IS NULL THEN RAISE EXCEPTION 'Withdrawal not found'; END IF;
  IF v_wr.user_id <> auth.uid() THEN RAISE EXCEPTION 'You can only report your own withdrawals'; END IF;
  IF v_wr.status NOT IN ('completed','approved') THEN
    RAISE EXCEPTION 'This payout is not marked as paid yet, so there is nothing to dispute.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payout_delivery_disputes
    WHERE withdrawal_id = p_withdrawal_id AND status <> 'resolved'
  ) THEN
    RAISE EXCEPTION 'You already reported this payout. The merchant agent has been alerted.';
  END IF;

  INSERT INTO public.payout_delivery_disputes (
    withdrawal_id, reporter_id, merchant_user_id, cashout_agent_id, amount, message
  ) VALUES (
    p_withdrawal_id, auth.uid(), v_wr.processed_by, v_wr.assigned_cashout_agent_id,
    coalesce(v_wr.amount, 0), trim(p_message)
  ) RETURNING id INTO v_id;

  RETURN v_id;
END; $$;

REVOKE ALL ON FUNCTION public.report_payout_not_received(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.report_payout_not_received(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.respond_payout_dispute(
  p_dispute_id uuid,
  p_status text,
  p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_d record; v_allowed boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_status NOT IN ('acknowledged','resolved') THEN RAISE EXCEPTION 'Invalid status'; END IF;

  SELECT * INTO v_d FROM public.payout_delivery_disputes WHERE id = p_dispute_id;
  IF v_d.id IS NULL THEN RAISE EXCEPTION 'Report not found'; END IF;

  v_allowed := v_d.merchant_user_id = auth.uid()
    OR public.has_role(auth.uid(),'financial_ops') OR public.has_role(auth.uid(),'cfo')
    OR public.has_role(auth.uid(),'coo') OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'agent_ops');
  IF NOT v_allowed THEN RAISE EXCEPTION 'Not authorised to respond to this report'; END IF;

  IF p_status = 'resolved' AND coalesce(length(trim(p_note)), 0) < 10 THEN
    RAISE EXCEPTION 'A resolution note of at least 10 characters is required.';
  END IF;

  UPDATE public.payout_delivery_disputes SET
    status = p_status,
    acknowledged_at = coalesce(acknowledged_at, now()),
    acknowledged_by = coalesce(acknowledged_by, auth.uid()),
    resolved_at = CASE WHEN p_status = 'resolved' THEN now() ELSE resolved_at END,
    resolved_by = CASE WHEN p_status = 'resolved' THEN auth.uid() ELSE resolved_by END,
    resolution_note = coalesce(nullif(trim(p_note), ''), resolution_note)
  WHERE id = p_dispute_id;
END; $$;

REVOKE ALL ON FUNCTION public.respond_payout_dispute(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.respond_payout_dispute(uuid, text, text) TO authenticated;