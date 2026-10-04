CREATE OR REPLACE FUNCTION public.get_referral_progress(p_referred_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_houses_verified int := 0;
  v_rent_submitted int := 0;
  v_rent_approved_paid int := 0;
  v_landlords_total int := 0;
  v_landlords_verified int := 0;
  v_lc1_total int := 0;
  v_lc1_verified int := 0;
  v_persona text := 'general';
  v_phone text;
  v_tenant_funded int := 0;
  v_portfolios int := 0;
  v_landlord_self_verified int := 0;
  v_qualified boolean := false;
BEGIN
  IF p_referred_id IS NULL THEN
    RETURN jsonb_build_object('qualified', false, 'persona', 'unknown');
  END IF;

  SELECT phone INTO v_phone FROM public.profiles WHERE id = p_referred_id;

  SELECT CASE
    WHEN bool_or(role IN ('agent','senior_agent','sub_agent')) THEN 'agent'
    WHEN bool_or(role = 'landlord') THEN 'landlord'
    WHEN bool_or(role = 'supporter') THEN 'funder'
    WHEN bool_or(role = 'tenant') THEN 'tenant'
    ELSE 'general'
  END
  INTO v_persona
  FROM public.user_roles WHERE user_id = p_referred_id;
  v_persona := COALESCE(v_persona, 'general');

  SELECT count(*) INTO v_houses_verified
  FROM public.house_listings
  WHERE agent_id = p_referred_id AND COALESCE(verified, false) = true;

  SELECT count(*) INTO v_rent_submitted
  FROM public.rent_requests
  WHERE agent_id = p_referred_id
    AND status NOT IN ('rejected','deleted_by_agent');

  SELECT count(*) INTO v_rent_approved_paid
  FROM public.rent_requests
  WHERE agent_id = p_referred_id
    AND status IN ('funded','repaying','completed');

  SELECT count(*) INTO v_landlords_total FROM public.landlords WHERE registered_by = p_referred_id;
  SELECT count(*) INTO v_landlords_verified FROM public.landlords
   WHERE registered_by = p_referred_id AND COALESCE(verified, false) = true;

  SELECT count(*) INTO v_lc1_total FROM public.lc1_chairpersons WHERE registered_by = p_referred_id;
  SELECT count(*) INTO v_lc1_verified FROM public.lc1_chairpersons
   WHERE registered_by = p_referred_id AND COALESCE(verified, false) = true;

  SELECT count(*) INTO v_tenant_funded
  FROM public.rent_requests
  WHERE tenant_id = p_referred_id
    AND status IN ('funded','repaying','completed');

  SELECT count(*) INTO v_portfolios
  FROM public.investor_portfolios
  WHERE investor_id = p_referred_id
    AND COALESCE(status, '') IN ('active','completed','repaying','matured');

  IF v_phone IS NOT NULL AND length(v_phone) >= 9 THEN
    SELECT count(*) INTO v_landlord_self_verified
    FROM public.landlords
    WHERE COALESCE(verified, false) = true
      AND right(regexp_replace(COALESCE(phone,''), '\D', '', 'g'), 9)
        = right(regexp_replace(v_phone, '\D', '', 'g'), 9);
  END IF;

  -- First real milestone of ANY kind unlocks the referrer's bonus
  v_qualified :=
       v_tenant_funded >= 1
    OR v_houses_verified >= 1
    OR v_rent_approved_paid >= 1
    OR v_portfolios >= 1
    OR v_landlord_self_verified >= 1;

  RETURN jsonb_build_object(
    'qualified', v_qualified,
    'persona', v_persona,
    'milestone_required', 1,
    'houses_verified', v_houses_verified,
    'houses_required', 0,
    'rent_submitted', v_rent_submitted,
    'rent_submitted_required', 0,
    'rent_approved_paid', v_rent_approved_paid,
    'rent_approved_paid_required', 0,
    'tenant_rent_funded', v_tenant_funded,
    'tenant_rent_funded_required', 0,
    'portfolios_active', v_portfolios,
    'portfolios_required', 0,
    'landlord_verified_self', v_landlord_self_verified,
    'landlord_verified_required', 0,
    'landlords_total', v_landlords_total,
    'landlords_verified', v_landlords_verified,
    'landlords_required', 0,
    'lc1_total', v_lc1_total,
    'lc1_verified', v_lc1_verified,
    'lc1_required', 0
  );
END;
$function$;