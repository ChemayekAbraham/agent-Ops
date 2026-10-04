CREATE OR REPLACE FUNCTION public.compute_withdrawal_intent_key(
  p_partner_id uuid,
  p_agent_id uuid,
  p_amount numeric,
  p_payout_method text,
  p_route_ref text,
  p_momo_number text,
  p_bank_account_number text,
  p_created_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dest text;
  v_cycle text;
  v_portfolio_id uuid;
  v_code text;
  v_next_roi date;
BEGIN
  v_dest := coalesce(
    nullif(regexp_replace(coalesce(p_bank_account_number, ''), '\D', '', 'g'), ''),
    nullif(regexp_replace(coalesce(p_momo_number, ''), '\D', '', 'g'), ''),
    'nodest'
  );

  IF p_route_ref LIKE 'portfolio:%' THEN
    BEGIN
      v_portfolio_id := substring(p_route_ref from 11)::uuid;
    EXCEPTION WHEN others THEN
      v_portfolio_id := NULL;
    END;
  END IF;

  IF v_portfolio_id IS NOT NULL THEN
    SELECT portfolio_code, next_roi_date
      INTO v_code, v_next_roi
    FROM public.investor_portfolios
    WHERE id = v_portfolio_id;
  END IF;

  IF v_code IS NOT NULL THEN
    v_cycle := 'pf:' || v_code || '#' || coalesce(v_next_roi::text, 'nocycle');
  ELSIF p_route_ref IS NOT NULL THEN
    v_cycle := p_route_ref || '#' || to_char(coalesce(p_created_at, now()), 'YYYY-MM');
  ELSE
    v_cycle := 'noroute#' || to_char(coalesce(p_created_at, now()), 'YYYY-MM-DD');
  END IF;

  RETURN md5(
    concat_ws('|',
      'proxy_withdrawal_v1',
      p_partner_id::text,
      coalesce(p_agent_id::text, 'noagent'),
      trim(to_char(round(coalesce(p_amount, 0)), 'FM9999999999999')),
      coalesce(p_payout_method, 'nomethod'),
      v_dest,
      v_cycle
    )
  );
END;
$$;