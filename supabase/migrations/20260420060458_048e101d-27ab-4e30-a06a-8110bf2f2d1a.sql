
ALTER TABLE public.agent_landlord_float
  ADD COLUMN IF NOT EXISTS region text;

CREATE TABLE IF NOT EXISTS public.landlord_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  landlord_id uuid NOT NULL,
  tenant_id uuid,
  rent_request_id uuid,
  amount numeric NOT NULL CHECK (amount > 0),
  landlord_phone text NOT NULL,
  landlord_name text NOT NULL,
  mobile_money_provider text NOT NULL,
  otp_verified_at timestamptz NOT NULL DEFAULT now(),
  sla_deadline timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  status text NOT NULL DEFAULT 'otp_verified'
    CHECK (status IN ('otp_verified','disbursing','completed','failed','escalated')),
  attempts int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text,
  disbursed_at timestamptz,
  external_reference text,
  escalated_at timestamptz,
  escalated_reason text,
  agent_latitude numeric,
  agent_longitude numeric,
  property_latitude numeric,
  property_longitude numeric,
  gps_match boolean,
  gps_distance_meters numeric,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_landlord_payouts_agent ON public.landlord_payouts(agent_id);
CREATE INDEX IF NOT EXISTS idx_landlord_payouts_landlord ON public.landlord_payouts(landlord_id);
CREATE INDEX IF NOT EXISTS idx_landlord_payouts_status ON public.landlord_payouts(status);
CREATE INDEX IF NOT EXISTS idx_landlord_payouts_sla_deadline ON public.landlord_payouts(sla_deadline)
  WHERE status IN ('otp_verified','disbursing');
CREATE INDEX IF NOT EXISTS idx_landlord_payouts_created ON public.landlord_payouts(created_at DESC);

CREATE OR REPLACE FUNCTION public.touch_landlord_payouts_meta()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  IF TG_OP = 'INSERT' THEN
    NEW.sla_deadline = NEW.otp_verified_at + interval '5 minutes';
  ELSIF NEW.otp_verified_at IS DISTINCT FROM OLD.otp_verified_at THEN
    NEW.sla_deadline = NEW.otp_verified_at + interval '5 minutes';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_landlord_payouts_meta_ins ON public.landlord_payouts;
CREATE TRIGGER trg_landlord_payouts_meta_ins
  BEFORE INSERT ON public.landlord_payouts
  FOR EACH ROW EXECUTE FUNCTION public.touch_landlord_payouts_meta();

DROP TRIGGER IF EXISTS trg_landlord_payouts_meta_upd ON public.landlord_payouts;
CREATE TRIGGER trg_landlord_payouts_meta_upd
  BEFORE UPDATE ON public.landlord_payouts
  FOR EACH ROW EXECUTE FUNCTION public.touch_landlord_payouts_meta();

CREATE OR REPLACE FUNCTION public.enforce_landlord_payout_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_landlord_verified boolean;
  v_landlord_phone text;
  v_float_balance numeric;
  v_kampala_hour int;
BEGIN
  v_kampala_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala'));
  IF v_kampala_hour >= 10 THEN
    RAISE EXCEPTION 'Landlord payout cutoff reached (after 10:00 AM Africa/Kampala). Try again tomorrow before 10 AM.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT verified, phone INTO v_landlord_verified, v_landlord_phone
  FROM public.landlords WHERE id = NEW.landlord_id;

  IF v_landlord_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'Landlord is not verified — Landlord Ops must verify the phone number first.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_landlord_phone IS NULL OR length(trim(v_landlord_phone)) < 8 THEN
    RAISE EXCEPTION 'Landlord has no usable phone number on file.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float WHERE agent_id = NEW.agent_id;

  IF v_float_balance IS NULL THEN
    RAISE EXCEPTION 'Agent has no landlord float account.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_float_balance < NEW.amount THEN
    RAISE EXCEPTION 'Insufficient landlord float (balance: %, requested: %).', v_float_balance, NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_landlord_payout_eligibility ON public.landlord_payouts;
CREATE TRIGGER trg_enforce_landlord_payout_eligibility
  BEFORE INSERT ON public.landlord_payouts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_landlord_payout_eligibility();

CREATE OR REPLACE FUNCTION public.deduct_agent_float_for_payout(p_payout_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout public.landlord_payouts%ROWTYPE;
  v_float_balance numeric;
  v_new_balance numeric;
BEGIN
  SELECT * INTO v_payout FROM public.landlord_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout % not found', p_payout_id; END IF;

  IF v_payout.status NOT IN ('otp_verified','disbursing') THEN
    RAISE EXCEPTION 'Payout % not in deductible status (%)', p_payout_id, v_payout.status;
  END IF;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float
  WHERE agent_id = v_payout.agent_id
  FOR UPDATE;

  IF v_float_balance IS NULL THEN
    RAISE EXCEPTION 'Agent % has no float account', v_payout.agent_id;
  END IF;

  IF v_float_balance < v_payout.amount THEN
    RAISE EXCEPTION 'Insufficient float (balance %, requested %)', v_float_balance, v_payout.amount;
  END IF;

  v_new_balance := v_float_balance - v_payout.amount;

  UPDATE public.agent_landlord_float
  SET balance = v_new_balance,
      total_paid_out = COALESCE(total_paid_out, 0) + v_payout.amount,
      updated_at = now()
  WHERE agent_id = v_payout.agent_id;

  UPDATE public.landlord_payouts
  SET status = 'disbursing',
      attempts = attempts + 1,
      last_attempt_at = now()
  WHERE id = p_payout_id;

  RETURN jsonb_build_object('ok', true, 'previous_balance', v_float_balance, 'new_balance', v_new_balance, 'deducted', v_payout.amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_agent_float_for_payout(p_payout_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout public.landlord_payouts%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(p_reason) < 10 THEN
    RAISE EXCEPTION 'Refund reason must be at least 10 characters';
  END IF;

  SELECT * INTO v_payout FROM public.landlord_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout % not found', p_payout_id; END IF;

  IF v_payout.status = 'completed' THEN
    RAISE EXCEPTION 'Cannot refund a completed payout';
  END IF;

  PERFORM 1 FROM public.agent_landlord_float WHERE agent_id = v_payout.agent_id FOR UPDATE;

  UPDATE public.agent_landlord_float
  SET balance = COALESCE(balance, 0) + v_payout.amount,
      total_paid_out = GREATEST(COALESCE(total_paid_out, 0) - v_payout.amount, 0),
      updated_at = now()
  WHERE agent_id = v_payout.agent_id;

  RETURN jsonb_build_object('ok', true, 'refunded', v_payout.amount, 'reason', p_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.check_landlord_payout_eligibility(
  p_agent_id uuid,
  p_landlord_id uuid,
  p_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_landlord_verified boolean;
  v_landlord_phone text;
  v_float_balance numeric;
  v_kampala_hour int;
  v_cutoff_ok boolean;
  v_float_ok boolean;
  v_landlord_ok boolean;
BEGIN
  v_kampala_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala'));
  v_cutoff_ok := v_kampala_hour < 10;

  SELECT verified, phone INTO v_landlord_verified, v_landlord_phone
  FROM public.landlords WHERE id = p_landlord_id;

  v_landlord_ok := COALESCE(v_landlord_verified, false)
                   AND v_landlord_phone IS NOT NULL
                   AND length(trim(v_landlord_phone)) >= 8;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float WHERE agent_id = p_agent_id;
  v_float_ok := COALESCE(v_float_balance, 0) >= p_amount;

  RETURN jsonb_build_object(
    'eligible', v_cutoff_ok AND v_landlord_ok AND v_float_ok,
    'cutoff_ok', v_cutoff_ok,
    'kampala_hour', v_kampala_hour,
    'landlord_verified', v_landlord_ok,
    'landlord_phone_present', v_landlord_phone IS NOT NULL,
    'float_ok', v_float_ok,
    'float_balance', COALESCE(v_float_balance, 0),
    'amount_required', p_amount
  );
END;
$$;

ALTER TABLE public.landlord_payouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Agents view own landlord payouts" ON public.landlord_payouts;
CREATE POLICY "Agents view own landlord payouts"
  ON public.landlord_payouts FOR SELECT
  TO authenticated
  USING (agent_id = auth.uid());

DROP POLICY IF EXISTS "Ops roles view all landlord payouts" ON public.landlord_payouts;
CREATE POLICY "Ops roles view all landlord payouts"
  ON public.landlord_payouts FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'operations'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.staff_permissions sp
      WHERE sp.user_id = auth.uid()
        AND sp.permitted_dashboard IN ('financial_ops','landlord_ops','executive_hub','agent_ops')
    )
  );

DROP POLICY IF EXISTS "Financial ops can update landlord payouts" ON public.landlord_payouts;
CREATE POLICY "Financial ops can update landlord payouts"
  ON public.landlord_payouts FOR UPDATE
  TO authenticated
  USING (
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.staff_permissions sp
      WHERE sp.user_id = auth.uid()
        AND sp.permitted_dashboard IN ('financial_ops','executive_hub')
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'landlord_payouts'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.landlord_payouts';
  END IF;
END $$;

ALTER TABLE public.landlord_payouts REPLICA IDENTITY FULL;
