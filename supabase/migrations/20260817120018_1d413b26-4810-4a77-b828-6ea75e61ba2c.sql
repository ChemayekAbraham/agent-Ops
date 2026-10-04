CREATE OR REPLACE FUNCTION public.normalize_payout_bank_id(p_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE s text;
BEGIN
  s := lower(coalesce(p_name, ''));
  s := regexp_replace(s, '[^a-z]+', ' ', 'g');
  s := btrim(s);
  IF s = '' THEN RETURN NULL; END IF;
  IF s LIKE '%absa%' THEN RETURN 'absa'; END IF;
  IF s LIKE '%bank of africa%' OR s LIKE '%boa uganda%' THEN RETURN 'bank_of_africa'; END IF;
  IF s LIKE '%baroda%' THEN RETURN 'baroda'; END IF;
  IF s LIKE '%bank of india%' THEN RETURN 'bank_of_india'; END IF;
  IF s LIKE '%cairo%' THEN RETURN 'cairo'; END IF;
  IF s LIKE '%centenary%' OR s LIKE '%centinary%' THEN RETURN 'centenary'; END IF;
  IF s LIKE '%citibank%' OR s LIKE '%citi bank%' THEN RETURN 'citibank'; END IF;
  IF s LIKE '%dfcu%' THEN RETURN 'dfcu'; END IF;
  IF s LIKE '%diamond trust%' OR s LIKE '%dtb%' THEN RETURN 'dtb'; END IF;
  IF s LIKE '%ecobank%' OR s LIKE '%eco bank%' THEN RETURN 'ecobank'; END IF;
  IF s LIKE '%equity%' THEN RETURN 'equity'; END IF;
  IF s LIKE '%exim%' THEN RETURN 'exim'; END IF;
  IF s LIKE '%housing finance%' OR s LIKE '%housingfinance%' THEN RETURN 'housing_finance'; END IF;
  IF s LIKE '%i m bank%' OR s LIKE '%i and m bank%' OR s LIKE '%im bank%' THEN RETURN 'im_bank'; END IF;
  IF s LIKE '%kcb%' OR s LIKE '%kenya commercial bank%' THEN RETURN 'kcb'; END IF;
  IF s LIKE '%ncba%' OR s LIKE '%nc bank%' THEN RETURN 'ncba'; END IF;
  IF s LIKE '%pearl%' THEN RETURN 'pearl'; END IF;
  IF s LIKE '%salaam%' THEN RETURN 'salaam'; END IF;
  IF s LIKE '%stanbic%' THEN RETURN 'stanbic'; END IF;
  IF s LIKE '%standard chartered%' OR s LIKE '%stanchart%' OR s LIKE '%scb%' THEN RETURN 'stanchart'; END IF;
  IF s LIKE '%tropical%' THEN RETURN 'tropical'; END IF;
  IF s LIKE '%united bank for africa%' OR s LIKE '%uba%' THEN RETURN 'uba'; END IF;
  IF s LIKE '%post bank%' OR s LIKE '%postbank%' THEN RETURN 'postbank'; END IF;
  RETURN NULL;
END;
$$;

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
    v_provider := public.normalize_payout_bank_id(p_bank_name);
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
  IF v_cats = '{}'::jsonb THEN
    RETURN true;
  END IF;

  IF v_reason LIKE '%proxy%' OR v_reason LIKE '%roi%' OR v_reason LIKE '%return%' THEN
    v_ok := coalesce((v_cats ->> 'proxy_partner_withdrawal')::boolean, false);
  ELSIF v_reason LIKE 'landlord float payout%' THEN
    v_ok := coalesce((v_cats ->> 'landlord_payouts')::boolean, false);
  ELSIF v_reason LIKE '%salary%' OR v_reason LIKE '%payroll%' THEN
    v_ok := coalesce((v_cats ->> 'payroll_payments')::boolean, false);
  ELSE
    v_ok := coalesce((v_cats ->> 'wallet_withdrawals')::boolean, false);
  END IF;

  RETURN v_ok;
END;
$$;

GRANT EXECUTE ON FUNCTION public.normalize_payout_bank_id(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.merchant_config_allows_payout(jsonb, text, text, text, text) TO authenticated, service_role;