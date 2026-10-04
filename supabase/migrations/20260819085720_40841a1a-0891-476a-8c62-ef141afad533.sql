-- 1. Redemption decision fields on the request row
ALTER TABLE public.portfolio_action_requests
  ADD COLUMN IF NOT EXISTS redemption_scope text,
  ADD COLUMN IF NOT EXISTS redemption_amount numeric,
  ADD COLUMN IF NOT EXISTS remaining_principal numeric,
  ADD COLUMN IF NOT EXISTS processed_by uuid,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_note text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'portfolio_action_requests_redemption_scope_check'
  ) THEN
    ALTER TABLE public.portfolio_action_requests
      ADD CONSTRAINT portfolio_action_requests_redemption_scope_check
      CHECK (redemption_scope IS NULL OR redemption_scope IN ('full','partial'));
  END IF;
END $$;

-- 2. Audit trail of every processed redemption
CREATE TABLE IF NOT EXISTS public.portfolio_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.investor_portfolios(id) ON DELETE CASCADE,
  request_id uuid REFERENCES public.portfolio_action_requests(id) ON DELETE SET NULL,
  partner_id uuid,
  portfolio_code text,
  scope text NOT NULL CHECK (scope IN ('full','partial')),
  redeemed_amount numeric NOT NULL,
  old_principal numeric NOT NULL,
  remaining_principal numeric NOT NULL,
  old_status text,
  new_status text,
  note text,
  processed_by uuid,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portfolio_redemptions_portfolio
  ON public.portfolio_redemptions(portfolio_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_portfolio_redemptions_request
  ON public.portfolio_redemptions(request_id) WHERE request_id IS NOT NULL;

GRANT SELECT ON public.portfolio_redemptions TO authenticated;
GRANT ALL ON public.portfolio_redemptions TO service_role;
ALTER TABLE public.portfolio_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ops view portfolio redemptions" ON public.portfolio_redemptions;
CREATE POLICY "Ops view portfolio redemptions"
  ON public.portfolio_redemptions FOR SELECT TO authenticated
  USING (
    (SELECT public.has_role(auth.uid(), 'manager'::app_role))
    OR (SELECT public.has_role(auth.uid(), 'coo'::app_role))
    OR (SELECT public.has_role(auth.uid(), 'cfo'::app_role))
    OR (SELECT public.has_role(auth.uid(), 'super_admin'::app_role))
    OR (SELECT public.has_role(auth.uid(), 'cto'::app_role))
    OR (SELECT public.has_role(auth.uid(), 'partner_ops'::app_role))
  );

DROP POLICY IF EXISTS "Partners view own portfolio redemptions" ON public.portfolio_redemptions;
CREATE POLICY "Partners view own portfolio redemptions"
  ON public.portfolio_redemptions FOR SELECT TO authenticated
  USING (partner_id = auth.uid());

-- 3. Processing RPC: full or partial redemption
CREATE OR REPLACE FUNCTION public.apply_portfolio_redemption(
  p_request_id uuid,
  p_scope text,
  p_amount numeric DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_processed_by uuid DEFAULT NULL,
  p_is_test boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req record;
  v_port record;
  v_amount numeric;
  v_remaining numeric;
  v_new_status text;
  v_red_id uuid;
BEGIN
  IF p_scope NOT IN ('full','partial') THEN
    RAISE EXCEPTION 'invalid_scope';
  END IF;

  SELECT * INTO v_req FROM public.portfolio_action_requests
   WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found'; END IF;
  IF v_req.request_type <> 'REDEMPTION_REQUEST' THEN
    RAISE EXCEPTION 'not_a_redemption_request';
  END IF;
  IF v_req.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'already_%', v_req.status;
  END IF;

  SELECT * INTO v_port FROM public.investor_portfolios
   WHERE id = v_req.portfolio_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'portfolio_not_found'; END IF;

  IF p_scope = 'full' THEN
    v_amount := v_port.investment_amount;
    v_remaining := 0;
    v_new_status := 'redeemed';
  ELSE
    v_amount := round(COALESCE(p_amount, 0));
    IF v_amount <= 0 THEN RAISE EXCEPTION 'amount_must_be_positive'; END IF;
    IF v_amount > v_port.investment_amount THEN RAISE EXCEPTION 'amount_exceeds_principal'; END IF;
    v_remaining := v_port.investment_amount - v_amount;
    IF v_remaining = 0 THEN
      v_new_status := 'redeemed';
    ELSE
      v_new_status := v_port.status;
    END IF;
  END IF;

  UPDATE public.investor_portfolios
     SET investment_amount = v_remaining,
         status = v_new_status
   WHERE id = v_port.id;

  INSERT INTO public.portfolio_redemptions (
    portfolio_id, request_id, partner_id, portfolio_code, scope,
    redeemed_amount, old_principal, remaining_principal,
    old_status, new_status, note, processed_by, is_test
  ) VALUES (
    v_port.id, p_request_id, v_req.partner_id, v_port.portfolio_code,
    CASE WHEN v_remaining = 0 THEN 'full' ELSE 'partial' END,
    v_amount, v_port.investment_amount, v_remaining,
    v_port.status, v_new_status, p_note, p_processed_by, p_is_test
  )
  RETURNING id INTO v_red_id;

  UPDATE public.portfolio_action_requests
     SET status = 'completed',
         redemption_scope = CASE WHEN v_remaining = 0 THEN 'full' ELSE 'partial' END,
         redemption_amount = v_amount,
         remaining_principal = v_remaining,
         processing_note = p_note,
         processed_by = p_processed_by,
         processed_at = now(),
         updated_at = now()
   WHERE id = p_request_id;

  RETURN jsonb_build_object(
    'redemption_id', v_red_id,
    'portfolio_id', v_port.id,
    'portfolio_code', v_port.portfolio_code,
    'account_name', v_port.account_name,
    'investor_id', v_port.investor_id,
    'scope', CASE WHEN v_remaining = 0 THEN 'full' ELSE 'partial' END,
    'redeemed_amount', v_amount,
    'old_principal', v_port.investment_amount,
    'remaining_principal', v_remaining,
    'roi_percentage', v_port.roi_percentage,
    'maturity_date', v_port.maturity_date,
    'next_roi_date', v_port.next_roi_date,
    'duration_months', v_port.duration_months,
    'new_status', v_new_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_portfolio_redemption(uuid, text, numeric, text, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_portfolio_redemption(uuid, text, numeric, text, uuid, boolean) TO service_role;