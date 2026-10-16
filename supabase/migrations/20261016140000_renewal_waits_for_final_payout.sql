-- Renewal waits for the final Returns payout (payout-mode portfolios only).
--
-- Problem: a portfolio's last Returns payout usually falls on or just after its
-- maturity date (e.g. matures 14 Oct, payout due 15 Oct). Renewing on the
-- maturity day reset next_roi_date a month ahead, so that final payout was
-- never queued. 14 portfolios lost a final cycle this way, mostly through the
-- Partner Ops "approve renewal" path, which had no payout check at all.
--
-- Rule (enforced here so every caller obeys it):
--   * Payout-mode portfolios renew only once the payout nearest the maturity
--     date has been credited to the partner's or proxy agent's wallet. Approval
--     of a roi_payout advances next_roi_date by a month, so "credited" means
--     next_roi_date has moved more than 15 days past maturity. Until then the
--     call returns skipped = true, reason = 'awaiting_final_payout', and the
--     nightly job renews it once the payout is approved.
--   * Compounding portfolios renew at maturity as before.
--
-- The new term is dated from the old maturity date (when renewing within 31
-- days of it), so waiting for the payout does not push the partner's dates
-- later. Dates are computed in Africa/Kampala time; the old code used the UTC
-- date, which is the previous day when the cron fires at 00:00 EAT.

CREATE OR REPLACE FUNCTION public.apply_portfolio_renewal(p_portfolio_id uuid, p_renewed_by uuid, p_reason text DEFAULT 'Auto-renewal at maturity'::text, p_source text DEFAULT 'manual'::text, p_is_auto boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_port record;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_start_date date;
  v_new_start timestamptz;
  v_new_maturity date;
  v_new_next_roi date;
  v_duration int;
  v_renewal_id uuid;
  v_dupe uuid;
  v_is_compounding boolean;
BEGIN
  SELECT * INTO v_port FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'portfolio_not_found';
  END IF;

  -- Idempotency: never renew the same portfolio twice on the same day
  SELECT id INTO v_dupe
  FROM public.portfolio_renewals
  WHERE portfolio_id = p_portfolio_id
    AND reversed_at IS NULL
    AND created_at >= date_trunc('day', now())
  LIMIT 1;
  IF v_dupe IS NOT NULL THEN
    RETURN jsonb_build_object(
      'portfolio_id', p_portfolio_id,
      'skipped', true,
      'reason', 'already_renewed_today',
      'renewal_id', v_dupe
    );
  END IF;

  -- Final-payout gate: payout-mode portfolios wait until the payout nearest
  -- maturity has been credited (next_roi_date advanced past maturity + 15d).
  v_is_compounding := lower(COALESCE(v_port.roi_mode, '')) IN ('monthly_compounding', 'compound', 'compounding');
  IF NOT v_is_compounding
     AND (v_port.next_roi_date IS NULL
          OR v_port.next_roi_date <= COALESCE(v_port.maturity_date, v_today) + 15) THEN
    RETURN jsonb_build_object(
      'portfolio_id', p_portfolio_id,
      'portfolio_code', v_port.portfolio_code,
      'skipped', true,
      'reason', 'awaiting_final_payout',
      'cycle_date', v_port.next_roi_date,
      'maturity_date', v_port.maturity_date
    );
  END IF;

  -- Date the new term from the old maturity date when renewing shortly after
  -- it, so the wait for the final payout does not shift the partner's dates.
  IF v_port.maturity_date IS NOT NULL
     AND v_port.maturity_date <= v_today
     AND v_port.maturity_date >= v_today - 31 THEN
    v_start_date := v_port.maturity_date;
  ELSE
    v_start_date := v_today;
  END IF;
  v_new_start := CASE
    WHEN v_start_date = v_today THEN now()
    ELSE v_start_date::timestamp AT TIME ZONE 'Africa/Kampala'
  END;

  v_duration := COALESCE(v_port.pending_renewal_duration_months, v_port.duration_months, 12);
  v_new_maturity := (v_start_date + make_interval(months => v_duration))::date;
  v_new_next_roi := (v_start_date + interval '1 month')::date;
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
    top_up_amount,
    is_auto, source,
    old_status, old_next_roi_date, old_total_roi_earned, old_investment_amount
  ) VALUES (
    p_portfolio_id, p_renewed_by, p_reason,
    v_port.created_at, v_new_start,
    v_port.maturity_date::text, v_new_maturity::text,
    v_port.roi_percentage, v_port.roi_percentage,
    COALESCE(v_port.duration_months, v_duration), v_duration,
    0,
    p_is_auto, COALESCE(p_source, 'manual'),
    v_port.status, v_port.next_roi_date, COALESCE(v_port.total_roi_earned, 0), v_port.investment_amount
  )
  RETURNING id INTO v_renewal_id;

  RETURN jsonb_build_object(
    'portfolio_id', p_portfolio_id,
    'renewal_id', v_renewal_id,
    'portfolio_code', v_port.portfolio_code,
    'account_name', v_port.account_name,
    'investor_id', v_port.investor_id,
    'investment_amount', v_port.investment_amount,
    'roi_percentage', v_port.roi_percentage,
    'new_start', v_new_start,
    'new_maturity_date', v_new_maturity,
    'duration_months', v_duration,
    'skipped', false
  );
END;
$function$;

-- Only the edge functions (service role) call this. It was executable by
-- anon/authenticated with no role check, letting any signed-in user renew any
-- portfolio.
REVOKE EXECUTE ON FUNCTION public.apply_portfolio_renewal(uuid, uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_portfolio_renewal(uuid, uuid, text, text, boolean) TO service_role;
