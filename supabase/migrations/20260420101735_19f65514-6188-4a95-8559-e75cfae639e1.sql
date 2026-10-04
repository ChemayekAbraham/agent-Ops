
-- Landlord payout OTP challenges (pre-verification staging)
CREATE TABLE IF NOT EXISTS public.landlord_payout_otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  landlord_id uuid NOT NULL,
  tenant_id uuid,
  rent_request_id uuid,
  amount numeric NOT NULL CHECK (amount > 0),
  landlord_name text NOT NULL,
  landlord_phone text NOT NULL,
  tenant_name text,
  tenant_phone text,
  mobile_money_provider text NOT NULL CHECK (mobile_money_provider IN ('MTN','Airtel')),
  otp_hash text NOT NULL,
  otp_expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','failed','expired','cancelled')),
  verified_at timestamptz,
  resulting_payout_id uuid REFERENCES public.landlord_payouts(id) ON DELETE SET NULL,
  agent_latitude numeric,
  agent_longitude numeric,
  property_latitude numeric,
  property_longitude numeric,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lp_otp_agent ON public.landlord_payout_otp_challenges (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_lp_otp_active ON public.landlord_payout_otp_challenges (otp_expires_at) WHERE status = 'pending';

ALTER TABLE public.landlord_payout_otp_challenges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own OTP challenges"
  ON public.landlord_payout_otp_challenges FOR SELECT
  TO authenticated
  USING (agent_id = auth.uid());

-- Inserts/updates only via edge functions (service role bypasses RLS); no policies needed for write.

CREATE OR REPLACE FUNCTION public.touch_lp_otp_meta()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lp_otp_meta ON public.landlord_payout_otp_challenges;
CREATE TRIGGER trg_lp_otp_meta
  BEFORE UPDATE ON public.landlord_payout_otp_challenges
  FOR EACH ROW EXECUTE FUNCTION public.touch_lp_otp_meta();
