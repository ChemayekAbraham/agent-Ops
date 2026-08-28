-- 1. CEO decision columns on staff_requisitions
ALTER TABLE public.staff_requisitions
  ADD COLUMN IF NOT EXISTS ceo_decided_by uuid,
  ADD COLUMN IF NOT EXISTS ceo_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS ceo_note text;

-- 2. Beneficiaries config
CREATE TABLE IF NOT EXISTS public.growth_commission_beneficiaries (
  user_id uuid PRIMARY KEY,
  rate_per_user numeric NOT NULL DEFAULT 50 CHECK (rate_per_user > 0),
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.growth_commission_beneficiaries TO authenticated;
GRANT ALL ON public.growth_commission_beneficiaries TO service_role;
ALTER TABLE public.growth_commission_beneficiaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "beneficiary reads own entitlement"
  ON public.growth_commission_beneficiaries
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

INSERT INTO public.growth_commission_beneficiaries (user_id, rate_per_user, note)
VALUES ('2c6569ce-f236-464f-91b8-e04a9a0c05a6', 50, 'Kalyango Timothy - UGX 50 per new platform user')
ON CONFLICT (user_id) DO NOTHING;

-- 3. Claims
CREATE SEQUENCE IF NOT EXISTS public.growth_commission_claim_seq;

CREATE TABLE IF NOT EXISTS public.growth_commission_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_code text NOT NULL UNIQUE
    DEFAULT 'GCM-' || lpad(nextval('public.growth_commission_claim_seq')::text, 5, '0'),
  user_id uuid NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  user_count integer NOT NULL CHECK (user_count >= 0),
  rate_per_user numeric NOT NULL DEFAULT 50 CHECK (rate_per_user > 0),
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'released')),
  requisition_id uuid REFERENCES public.staff_requisitions(id),
  credited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start)
);

CREATE INDEX IF NOT EXISTS growth_commission_claims_user_idx
  ON public.growth_commission_claims (user_id, window_end DESC);

GRANT SELECT ON public.growth_commission_claims TO authenticated;
GRANT ALL ON public.growth_commission_claims TO service_role;
ALTER TABLE public.growth_commission_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner reads own growth commission claims"
  ON public.growth_commission_claims
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE TRIGGER trg_growth_commission_claims_updated_at
  BEFORE UPDATE ON public.growth_commission_claims
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. Next claimable window
CREATE OR REPLACE FUNCTION public.growth_commission_next_window(_user_id uuid DEFAULT auth.uid())
RETURNS TABLE (
  eligible boolean,
  window_start timestamptz,
  window_end timestamptz,
  user_count integer,
  rate_per_user numeric,
  amount numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rate numeric;
  v_start timestamptz;
  v_end timestamptz := now();
  v_count integer;
BEGIN
  SELECT b.rate_per_user INTO v_rate
  FROM public.growth_commission_beneficiaries b
  WHERE b.user_id = _user_id AND b.active;

  IF v_rate IS NULL THEN
    RETURN QUERY SELECT false, NULL::timestamptz, NULL::timestamptz, 0, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  SELECT max(c.window_end) INTO v_start
  FROM public.growth_commission_claims c
  WHERE c.user_id = _user_id AND c.status <> 'rejected';

  IF v_start IS NULL THEN
    v_start := v_end - interval '30 days';
  END IF;

  SELECT count(*)::integer INTO v_count
  FROM public.profiles p
  WHERE p.created_at > v_start AND p.created_at <= v_end;

  RETURN QUERY SELECT true, v_start, v_end, v_count, v_rate, (v_count * v_rate);
END;
$$;

REVOKE ALL ON FUNCTION public.growth_commission_next_window(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.growth_commission_next_window(uuid) TO authenticated, service_role;