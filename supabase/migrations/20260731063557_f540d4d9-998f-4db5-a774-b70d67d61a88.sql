-- 1. Audit/reversal columns on the renewal log
ALTER TABLE public.portfolio_renewals
  ADD COLUMN IF NOT EXISTS is_auto boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS old_status text,
  ADD COLUMN IF NOT EXISTS old_next_roi_date date,
  ADD COLUMN IF NOT EXISTS old_total_roi_earned numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS old_investment_amount numeric,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason text;

CREATE INDEX IF NOT EXISTS idx_portfolio_renewals_portfolio_created
  ON public.portfolio_renewals (portfolio_id, created_at DESC);

-- Partner ops / agent ops read access
DROP POLICY IF EXISTS "Ops roles read renewals" ON public.portfolio_renewals;
CREATE POLICY "Ops roles read renewals" ON public.portfolio_renewals
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role = ANY (ARRAY['manager','operations','coo','cfo','ceo','super_admin','partner_ops']::app_role[])
  )
);

-- 2. Renewal writer: capture full before-state + same-day idempotency
CREATE OR REPLACE FUNCTION public.apply_portfolio_renewal(
  p_portfolio_id uuid,
  p_renewed_by uuid,
  p_reason text DEFAULT 'Auto-renewal at maturity'::text,
  p_source text DEFAULT 'manual',
  p_is_auto boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_port record;
  v_new_start timestamptz := now();
  v_new_maturity date;
  v_new_next_roi date;
  v_duration int;
  v_renewal_id uuid;
  v_dupe uuid;
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

-- 3. Batch auto-renewal of every due portfolio
CREATE OR REPLACE FUNCTION public.auto_renew_due_portfolios(p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid;
  r record;
  v_res jsonb;
  v_renewed int := 0;
  v_skipped int := 0;
  v_failed int := 0;
  v_ids jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
BEGIN
  v_actor := COALESCE(
    auth.uid(),
    (SELECT user_id FROM public.user_roles WHERE role = 'cfo'::app_role LIMIT 1),
    (SELECT user_id FROM public.user_roles WHERE role = 'manager'::app_role LIMIT 1)
  );
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_system_actor');
  END IF;

  FOR r IN
    SELECT id, status
    FROM public.investor_portfolios
    WHERE (
        (pending_renewal_effective_date IS NOT NULL AND pending_renewal_effective_date <= current_date)
        OR status = 'matured'
        OR (status = 'active' AND maturity_date IS NOT NULL AND maturity_date <= current_date)
      )
      AND status <> 'cancelled'
    ORDER BY maturity_date NULLS LAST
    LIMIT GREATEST(p_limit, 1)
  LOOP
    BEGIN
      v_res := public.apply_portfolio_renewal(
        r.id, v_actor,
        'Automatic renewal — portfolio reached maturity',
        'auto_batch', true
      );
      IF COALESCE((v_res->>'skipped')::boolean, false) THEN
        v_skipped := v_skipped + 1;
      ELSE
        v_renewed := v_renewed + 1;
        v_ids := v_ids || to_jsonb(r.id);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_errors := v_errors || jsonb_build_object('portfolio_id', r.id, 'error', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'renewed', v_renewed, 'skipped', v_skipped,
    'failed', v_failed, 'renewed_ids', v_ids, 'errors', v_errors
  );
END;
$function$;

-- 4. Reversal
CREATE OR REPLACE FUNCTION public.reverse_portfolio_renewal(
  p_renewal_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ren record;
  v_latest uuid;
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_actor
      AND ur.role = ANY (ARRAY['manager','operations','coo','cfo','ceo','super_admin','partner_ops']::app_role[])
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'reason_required_min_10_chars';
  END IF;

  SELECT * INTO v_ren FROM public.portfolio_renewals WHERE id = p_renewal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'renewal_not_found';
  END IF;
  IF v_ren.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_reversed';
  END IF;

  SELECT id INTO v_latest
  FROM public.portfolio_renewals
  WHERE portfolio_id = v_ren.portfolio_id AND reversed_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1;
  IF v_latest IS DISTINCT FROM p_renewal_id THEN
    RAISE EXCEPTION 'not_latest_renewal';
  END IF;

  PERFORM 1 FROM public.investor_portfolios WHERE id = v_ren.portfolio_id FOR UPDATE;

  UPDATE public.investor_portfolios SET
    created_at = v_ren.old_created_at,
    maturity_date = NULLIF(v_ren.old_maturity_date, '')::date,
    next_roi_date = v_ren.old_next_roi_date,
    duration_months = v_ren.old_duration_months,
    total_roi_earned = COALESCE(v_ren.old_total_roi_earned, 0),
    status = COALESCE(v_ren.old_status, 'matured')
  WHERE id = v_ren.portfolio_id;

  UPDATE public.portfolio_renewals
  SET reversed_at = now(), reversed_by = v_actor, reversal_reason = btrim(p_reason)
  WHERE id = p_renewal_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, details)
  VALUES (
    v_actor, 'portfolio_renewal_reversed', 'portfolio_renewals', p_renewal_id, btrim(p_reason),
    jsonb_build_object(
      'portfolio_id', v_ren.portfolio_id,
      'restored', jsonb_build_object(
        'created_at', v_ren.old_created_at,
        'maturity_date', v_ren.old_maturity_date,
        'next_roi_date', v_ren.old_next_roi_date,
        'duration_months', v_ren.old_duration_months,
        'total_roi_earned', v_ren.old_total_roi_earned,
        'status', v_ren.old_status
      ),
      'undone', jsonb_build_object(
        'new_created_at', v_ren.new_created_at,
        'new_maturity_date', v_ren.new_maturity_date,
        'new_duration_months', v_ren.new_duration_months
      )
    )
  );

  RETURN jsonb_build_object('ok', true, 'renewal_id', p_renewal_id, 'portfolio_id', v_ren.portfolio_id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.auto_renew_due_portfolios(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reverse_portfolio_renewal(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_portfolio_renewal(uuid, uuid, text, text, boolean) TO authenticated, service_role;