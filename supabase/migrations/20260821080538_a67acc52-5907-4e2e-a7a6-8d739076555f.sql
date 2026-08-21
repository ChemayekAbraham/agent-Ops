CREATE OR REPLACE FUNCTION public.wallet_self_route_allowed(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user_id IN (
    'cb798acb-68bc-4b4e-a414-a3d374e030b6'::uuid, -- JOSHUA WANDA
    '59d45ad2-0d44-433c-b4ec-20927a25c281'::uuid, -- Nankambo sharimah
    'cfa56623-e6cb-4023-b601-3dbd4fdbc027'::uuid, -- Bayo Mercy
    '6b7d9eee-4bc8-47ac-a2e6-b84cbaac8bb4'::uuid  -- Mercy Bayo
  );
$$;

GRANT EXECUTE ON FUNCTION public.wallet_self_route_allowed(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_platform_wallet_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_operator boolean;
BEGIN
  IF v_actor IS NOT NULL THEN
    IF NEW.created_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'WALLET_CORRECTION_AUTHOR_MISMATCH: the correction must be recorded under the signed-in author'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  v_operator := public.merchant_float_fix_authorized(NEW.created_by);

  IF NOT (
    public.has_role(NEW.created_by, 'cfo')
    OR public.has_role(NEW.created_by, 'financial_ops')
    OR public.has_role(NEW.created_by, 'super_admin')
    OR v_operator
  ) THEN
    RAISE EXCEPTION 'WALLET_CORRECTION_NOT_AUTHORIZED: only the CFO, Financial Ops or a super admin can record a platform wallet correction'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Self-authorship block: never correct your own wallet, EXCEPT for a
  -- float -> withdrawable reclass posted by a designated merchant-desk
  -- operator, or for accounts explicitly allowlisted for self routing.
  IF NOT NEW.system_authored
     AND NEW.created_by = NEW.target_user_id
     AND NOT (v_operator AND NEW.tool = 'admin_float_to_withdrawable')
     AND NOT public.wallet_self_route_allowed(NEW.created_by) THEN
    RAISE EXCEPTION 'WALLET_CORRECTION_SELF_BLOCKED: you cannot record a wallet correction for your own account'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT NEW.system_authored AND NEW.created_by = NEW.target_user_id THEN
    NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_build_object('self_authored_operator', true);
  END IF;

  IF NEW.evidence IS NULL OR length(btrim(NEW.evidence)) < 20 THEN
    RAISE EXCEPTION 'WALLET_CORRECTION_EVIDENCE_REQUIRED: written evidence of at least 20 characters is required'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;