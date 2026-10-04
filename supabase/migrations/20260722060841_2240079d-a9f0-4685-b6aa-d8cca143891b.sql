
ALTER TABLE public.investor_portfolios
  ADD COLUMN IF NOT EXISTS pending_renewal_effective_date date,
  ADD COLUMN IF NOT EXISTS pending_renewal_duration_months integer,
  ADD COLUMN IF NOT EXISTS pending_renewal_request_id uuid;

CREATE INDEX IF NOT EXISTS idx_investor_portfolios_pending_renewal_effective_date
  ON public.investor_portfolios (pending_renewal_effective_date)
  WHERE pending_renewal_effective_date IS NOT NULL;

CREATE OR REPLACE FUNCTION public.apply_portfolio_renewal(
  p_portfolio_id uuid,
  p_renewed_by uuid,
  p_reason text DEFAULT 'Auto-renewal at maturity'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_port record;
  v_new_start timestamptz := now();
  v_new_maturity date;
  v_new_next_roi date;
  v_duration int;
BEGIN
  SELECT * INTO v_port FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'portfolio_not_found';
  END IF;

  v_duration := COALESCE(v_port.pending_renewal_duration_months, v_port.duration_months, 12);
  v_new_maturity := (v_new_start + make_interval(months => v_duration))::date;
  v_new_next_roi := (v_new_start + interval '1 month')::date;
  IF v_port.payout_day IS NOT NULL THEN
    v_new_next_roi := (date_trunc('month', v_new_next_roi)::date + (v_port.payout_day - 1));
  END IF;

  UPDATE public.investor_portfolios SET
    created_at = v_new_start,
    maturity_date = v_new_maturity,
    next_roi_date = v_new_next_roi,
    total_roi_earned = 0,
    duration_months = v_duration,
    status = 'active',
    pending_renewal_effective_date = NULL,
    pending_renewal_duration_months = NULL,
    pending_renewal_request_id = NULL
  WHERE id = p_portfolio_id;

  INSERT INTO public.portfolio_renewals (
    portfolio_id, renewed_by, reason,
    old_created_at, new_created_at,
    old_maturity_date, new_maturity_date,
    old_roi_percentage, new_roi_percentage,
    old_duration_months, new_duration_months,
    top_up_amount
  ) VALUES (
    p_portfolio_id, p_renewed_by, p_reason,
    v_port.created_at, v_new_start,
    v_port.maturity_date::text, v_new_maturity::text,
    v_port.roi_percentage, v_port.roi_percentage,
    COALESCE(v_port.duration_months, v_duration), v_duration,
    0
  );

  RETURN jsonb_build_object(
    'portfolio_id', p_portfolio_id,
    'portfolio_code', v_port.portfolio_code,
    'account_name', v_port.account_name,
    'investor_id', v_port.investor_id,
    'investment_amount', v_port.investment_amount,
    'roi_percentage', v_port.roi_percentage,
    'new_start', v_new_start,
    'new_maturity_date', v_new_maturity,
    'duration_months', v_duration
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_portfolio_renewal(uuid, uuid, text) TO service_role;
