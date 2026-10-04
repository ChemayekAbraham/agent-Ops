CREATE OR REPLACE FUNCTION public.merchant_config_allows_payout(
  p_config jsonb,
  p_reason text,
  p_payout_method text,
  p_bank_name text,
  p_momo_provider text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_reason text := lower(coalesce(p_reason, ''));
  v_method text := lower(coalesce(p_payout_method, ''));
  v_bank text := lower(regexp_replace(coalesce(p_bank_name, ''), '[^a-zA-Z]+', ' ', 'g'));
  v_momo text := lower(coalesce(p_momo_provider, ''));
  v_channel text;
  v_provider text;
  v_cats jsonb;
  v_ok boolean;
BEGIN
  IF p_config IS NULL OR p_config = '{}'::jsonb THEN
    RETURN true;
  END IF;

  IF v_method IN ('bank_transfer', 'bank') THEN
    v_channel := 'bank';
    v_provider := CASE
      WHEN v_bank LIKE '%stanbic%' THEN 'stanbic'
      WHEN v_bank LIKE '%centenary%' OR v_bank LIKE '%centinary%' OR v_bank LIKE '%cente%' THEN 'centenary'
      WHEN v_bank LIKE '%dfcu%' THEN 'dfcu'
      WHEN v_bank LIKE '%equity%' THEN 'equity'
      WHEN v_bank LIKE '%post bank%' OR v_bank LIKE '%postbank%' THEN 'postbank'
      WHEN v_bank LIKE '%housing finance%' THEN 'housing_finance'
      ELSE NULL END;
  ELSIF v_method = 'cash' THEN
    v_channel := 'cash';
    v_provider := NULL;
  ELSE
    v_channel := 'momo';
    v_provider := CASE
      WHEN v_momo LIKE '%mtn%' THEN 'mtn'
      WHEN v_momo LIKE '%airtel%' THEN 'airtel'
      ELSE NULL END;
  END IF;

  IF coalesce((p_config -> 'channels' ->> v_channel)::boolean, false) IS NOT TRUE THEN
    RETURN false;
  END IF;

  IF v_provider IS NOT NULL THEN
    IF v_channel = 'momo' AND coalesce((p_config -> 'networks' ->> v_provider)::boolean, false) IS NOT TRUE THEN
      RETURN false;
    END IF;
    IF v_channel = 'bank' AND coalesce((p_config -> 'banks' ->> v_provider)::boolean, false) IS NOT TRUE THEN
      RETURN false;
    END IF;
  END IF;

  v_cats := coalesce(p_config -> 'categories', '{}'::jsonb);

  IF v_reason LIKE '%proxy%' OR v_reason LIKE '%roi%' OR v_reason LIKE '%return%' THEN
    v_ok := coalesce((v_cats ->> 'proxy_partner_withdrawal')::boolean, false);
  ELSIF v_reason LIKE 'landlord float payout%' THEN
    v_ok := coalesce((v_cats ->> 'landlord_payouts')::boolean, false);
  ELSIF v_reason LIKE '%salary%' OR v_reason LIKE '%payroll%' THEN
    v_ok := coalesce((v_cats ->> 'payroll_payments')::boolean, false);
  ELSIF v_reason LIKE '%commission%' THEN
    v_ok := coalesce((v_cats ->> 'cashout_commission')::boolean, false)
         OR coalesce((v_cats ->> 'rent_collection_commission')::boolean, false)
         OR coalesce((v_cats ->> 'partner_commission')::boolean, false);
  ELSE
    v_ok := coalesce((v_cats ->> 'wallet_withdrawals')::boolean, false);
  END IF;

  RETURN coalesce(v_ok, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.merchant_agent_allows_withdrawal(
  p_agent_id uuid,
  p_reason text,
  p_payout_method text,
  p_bank_name text,
  p_momo_provider text
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_cfg jsonb;
  v_found boolean := false;
BEGIN
  IF p_agent_id IS NULL THEN RETURN true; END IF;
  SELECT ca.config, true INTO v_cfg, v_found
  FROM public.cashout_agents ca
  WHERE ca.id = p_agent_id OR ca.user_id = p_agent_id
  ORDER BY (ca.id = p_agent_id) DESC
  LIMIT 1;

  IF NOT coalesce(v_found, false) THEN RETURN true; END IF;
  RETURN public.merchant_config_allows_payout(v_cfg, p_reason, p_payout_method, p_bank_name, p_momo_provider);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_nonconforming_merchant_claims(
  p_agent_id uuid,
  p_reason text DEFAULT 'Permission matrix updated'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg jsonb;
  v_user uuid;
  v_ids uuid[] := '{}';
  r record;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'ceo') OR
    public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'financial_ops') OR
    public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT config, user_id INTO v_cfg, v_user FROM public.cashout_agents WHERE id = p_agent_id;
  IF v_cfg IS NULL THEN RETURN jsonb_build_object('count', 0, 'ids', '[]'::jsonb); END IF;

  FOR r IN
    SELECT id, reason, payout_method, bank_name, mobile_money_provider
    FROM public.withdrawal_requests
    WHERE status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved','processing')
      AND (assigned_cashout_agent_id = p_agent_id
           OR preferred_cashout_agent_id = p_agent_id
           OR dispatch_claimed_by = v_user)
  LOOP
    IF NOT public.merchant_config_allows_payout(v_cfg, r.reason, r.payout_method, r.bank_name, r.mobile_money_provider) THEN
      UPDATE public.withdrawal_requests
      SET assigned_cashout_agent_id = NULL,
          preferred_cashout_agent_id = NULL,
          dispatch_claimed_by = NULL,
          dispatch_claimed_at = NULL,
          dispatch_expires_at = NULL,
          updated_at = now()
      WHERE id = r.id;
      v_ids := array_append(v_ids, r.id);
    END IF;
  END LOOP;

  IF array_length(v_ids, 1) > 0 THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (auth.uid(), 'merchant_claims_revoked_by_permission_change', 'withdrawal_requests', p_agent_id,
            jsonb_build_object('revoked_ids', to_jsonb(v_ids), 'reason', p_reason));
  END IF;

  RETURN jsonb_build_object('count', coalesce(array_length(v_ids, 1), 0), 'ids', to_jsonb(v_ids));
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_nonconforming_merchant_claims(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.merchant_config_allows_payout(jsonb, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.merchant_agent_allows_withdrawal(uuid, text, text, text, text) TO authenticated, service_role;