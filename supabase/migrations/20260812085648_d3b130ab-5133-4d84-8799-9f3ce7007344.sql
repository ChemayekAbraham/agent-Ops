CREATE TABLE IF NOT EXISTS public.merchant_out_of_pocket_advances (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid NOT NULL,
  withdrawal_id uuid,
  kind text NOT NULL DEFAULT 'payout',
  payout_amount numeric NOT NULL DEFAULT 0,
  telecom_charge numeric NOT NULL DEFAULT 0,
  float_used numeric NOT NULL DEFAULT 0,
  shortfall_amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending_reimbursement',
  note text,
  reimbursed_at timestamptz,
  reimbursed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_oop_kind_check CHECK (kind IN ('payout','telecom')),
  CONSTRAINT merchant_oop_status_check CHECK (status IN ('pending_reimbursement','reimbursed','written_off'))
);

CREATE INDEX IF NOT EXISTS idx_merchant_oop_agent ON public.merchant_out_of_pocket_advances(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_merchant_oop_status ON public.merchant_out_of_pocket_advances(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_oop_withdrawal_kind ON public.merchant_out_of_pocket_advances(withdrawal_id, kind) WHERE withdrawal_id IS NOT NULL;

GRANT SELECT ON public.merchant_out_of_pocket_advances TO authenticated;
GRANT UPDATE ON public.merchant_out_of_pocket_advances TO authenticated;
GRANT ALL ON public.merchant_out_of_pocket_advances TO service_role;

ALTER TABLE public.merchant_out_of_pocket_advances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "merchant reads own out of pocket" ON public.merchant_out_of_pocket_advances;
CREATE POLICY "merchant reads own out of pocket"
ON public.merchant_out_of_pocket_advances FOR SELECT TO authenticated
USING (agent_id = auth.uid());

DROP POLICY IF EXISTS "finance reads all out of pocket" ON public.merchant_out_of_pocket_advances;
CREATE POLICY "finance reads all out of pocket"
ON public.merchant_out_of_pocket_advances FOR SELECT TO authenticated
USING (
  public.is_ops_role(auth.uid())
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'super_admin')
);

DROP POLICY IF EXISTS "finance updates out of pocket" ON public.merchant_out_of_pocket_advances;
CREATE POLICY "finance updates out of pocket"
ON public.merchant_out_of_pocket_advances FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'super_admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE OR REPLACE FUNCTION public.touch_merchant_oop_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_merchant_oop ON public.merchant_out_of_pocket_advances;
CREATE TRIGGER trg_touch_merchant_oop
BEFORE UPDATE ON public.merchant_out_of_pocket_advances
FOR EACH ROW EXECUTE FUNCTION public.touch_merchant_oop_updated_at();

CREATE OR REPLACE FUNCTION public.get_merchant_out_of_pocket_summary(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_owed numeric := 0;
  v_reimbursed numeric := 0;
  v_tel_today numeric := 0;
  v_tel_month numeric := 0;
  v_tel_total numeric := 0;
  v_count integer := 0;
BEGIN
  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('owed_to_agent', 0, 'reimbursed_total', 0,
      'telecom_today', 0, 'telecom_month', 0, 'telecom_total', 0, 'pending_count', 0);
  END IF;

  IF v_agent <> auth.uid()
     AND NOT (public.has_role(auth.uid(), 'cfo')
              OR public.has_role(auth.uid(), 'financial_ops')
              OR public.has_role(auth.uid(), 'super_admin')
              OR public.is_ops_role(auth.uid())) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT COALESCE(SUM(CASE WHEN status = 'pending_reimbursement' THEN shortfall_amount ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN status = 'reimbursed' THEN shortfall_amount ELSE 0 END), 0),
         COUNT(*) FILTER (WHERE status = 'pending_reimbursement')
    INTO v_owed, v_reimbursed, v_count
    FROM public.merchant_out_of_pocket_advances
   WHERE agent_id = v_agent;

  SELECT COALESCE(SUM(gl.amount), 0)
    INTO v_tel_total
    FROM public.general_ledger gl
   WHERE gl.user_id = v_agent
     AND gl.ledger_scope = 'wallet'
     AND gl.reference_id LIKE '%-merchant-telecom-charge';

  SELECT COALESCE(SUM(gl.amount), 0)
    INTO v_tel_today
    FROM public.general_ledger gl
   WHERE gl.user_id = v_agent
     AND gl.ledger_scope = 'wallet'
     AND gl.reference_id LIKE '%-merchant-telecom-charge'
     AND (gl.transaction_date AT TIME ZONE 'Africa/Kampala')::date = v_today;

  SELECT COALESCE(SUM(gl.amount), 0)
    INTO v_tel_month
    FROM public.general_ledger gl
   WHERE gl.user_id = v_agent
     AND gl.ledger_scope = 'wallet'
     AND gl.reference_id LIKE '%-merchant-telecom-charge'
     AND (gl.transaction_date AT TIME ZONE 'Africa/Kampala')::date
         >= date_trunc('month', v_today)::date;

  RETURN jsonb_build_object(
    'owed_to_agent', v_owed,
    'reimbursed_total', v_reimbursed,
    'telecom_today', v_tel_today,
    'telecom_month', v_tel_month,
    'telecom_total', v_tel_total,
    'pending_count', v_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_merchant_out_of_pocket_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_merchant_out_of_pocket_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_merchant_out_of_pocket_summary(uuid) TO service_role;