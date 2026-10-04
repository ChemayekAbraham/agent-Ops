-- Backend-controlled Angel Pool shareholder action used by the CEO dashboard.
-- Returns the number of investments touched and the share/amount delta so the
-- UI can confirm the action actually changed anything before claiming success.

CREATE OR REPLACE FUNCTION public.ceo_angel_pool_shareholder_action(
  p_investor_id uuid,
  p_action text,
  p_reason text,
  p_new_shares integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_affected integer := 0;
  v_shares_before integer := 0;
  v_amount_before bigint := 0;
  v_price bigint := 0;
  v_total_shares integer := 0;
  v_pool_pct numeric := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_caller, 'ceo'::app_role)
    OR public.has_role(v_caller, 'manager'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only CEO or manager can perform this action';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  IF p_action NOT IN ('delete','suspend','edit') THEN
    RAISE EXCEPTION 'Invalid action: %', p_action;
  END IF;

  -- Snapshot current confirmed totals for audit + share-release reporting.
  SELECT COALESCE(SUM(shares),0), COALESCE(SUM(amount),0)
  INTO v_shares_before, v_amount_before
  FROM public.angel_pool_investments
  WHERE investor_id = p_investor_id
    AND status = 'confirmed';

  IF p_action = 'delete' THEN
    UPDATE public.angel_pool_investments
    SET status = 'deleted'
    WHERE investor_id = p_investor_id
      AND status = 'confirmed';
    GET DIAGNOSTICS v_affected = ROW_COUNT;

  ELSIF p_action = 'suspend' THEN
    UPDATE public.angel_pool_investments
    SET status = 'suspended'
    WHERE investor_id = p_investor_id
      AND status = 'confirmed';
    GET DIAGNOSTICS v_affected = ROW_COUNT;

  ELSIF p_action = 'edit' THEN
    IF p_new_shares IS NULL OR p_new_shares < 0 THEN
      RAISE EXCEPTION 'p_new_shares must be a non-negative integer for edit';
    END IF;

    SELECT total_shares, price_per_share, pool_equity_percent
    INTO v_total_shares, v_price, v_pool_pct
    FROM public.angel_pool_config
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1;

    IF v_total_shares IS NULL OR v_total_shares <= 0 THEN
      v_total_shares := 25000;
    END IF;
    IF v_price IS NULL OR v_price <= 0 THEN
      v_price := 20000;
    END IF;
    IF v_pool_pct IS NULL OR v_pool_pct <= 0 THEN
      v_pool_pct := 8;
    END IF;

    UPDATE public.angel_pool_investments
    SET shares = p_new_shares,
        amount = (p_new_shares::bigint) * v_price,
        pool_ownership_percent = (p_new_shares::numeric / v_total_shares) * 100,
        company_ownership_percent = (p_new_shares::numeric / v_total_shares) * v_pool_pct
    WHERE investor_id = p_investor_id
      AND status = 'confirmed';
    GET DIAGNOSTICS v_affected = ROW_COUNT;
  END IF;

  IF v_affected = 0 THEN
    RAISE EXCEPTION 'No confirmed investments found for this shareholder';
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_caller,
    'angel_pool_shareholder_' || p_action,
    'angel_pool_investments',
    p_investor_id,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'affected_rows', v_affected,
      'shares_before', v_shares_before,
      'amount_before', v_amount_before,
      'new_shares', p_new_shares
    )
  );

  RETURN jsonb_build_object(
    'affected', v_affected,
    'shares_released', CASE WHEN p_action = 'delete' OR p_action = 'suspend' THEN v_shares_before ELSE 0 END,
    'amount_released', CASE WHEN p_action = 'delete' OR p_action = 'suspend' THEN v_amount_before ELSE 0 END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ceo_angel_pool_shareholder_action(uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ceo_angel_pool_shareholder_action(uuid, text, text, integer) TO authenticated;