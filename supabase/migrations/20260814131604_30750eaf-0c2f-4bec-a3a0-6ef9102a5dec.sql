CREATE OR REPLACE FUNCTION public.get_coo_system_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  -- Unified active-book definition. MUST stay identical to ACTIVE_STATUSES in
  -- src/lib/activeTenantsReportPdf.ts (shared with the Tenants Report and the
  -- Agent Daily Performance report) so the numbers reconcile across the app.
  v_active_statuses text[] := ARRAY['funded','disbursed','repaying','active','approved'];
  -- Payout statuses already used by get_coo_overview_snapshot.money.landlord_float_disbursed
  v_payout_statuses text[] := ARRAY['completed','awaiting_agent_receipt'];
  v_total_tenants bigint;
  v_active_tenants bigint;
  v_total_paid numeric;
  v_first_op timestamptz;
  v_days numeric;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid, 'manager') OR has_role(v_uid, 'coo') OR has_role(v_uid, 'ceo')
       OR has_role(v_uid, 'cfo') OR has_role(v_uid, 'cto') OR has_role(v_uid, 'super_admin')
     ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT count(DISTINCT tenant_id) INTO v_total_tenants
  FROM rent_requests WHERE tenant_id IS NOT NULL;

  SELECT count(DISTINCT tenant_id) INTO v_active_tenants
  FROM rent_requests
  WHERE tenant_id IS NOT NULL AND status = ANY (v_active_statuses);

  SELECT COALESCE(sum(amount), 0), min(created_at)
    INTO v_total_paid, v_first_op
  FROM landlord_payouts
  WHERE status = ANY (v_payout_statuses);

  v_days := CASE
    WHEN v_first_op IS NULL THEN 0
    ELSE floor(date_part('epoch', now() - v_first_op) / 86400.0)
  END;

  RETURN jsonb_build_object(
    'total_tenants_ever', v_total_tenants,
    'active_tenants_now', v_active_tenants,
    'total_paid_to_landlords', v_total_paid,
    'first_operation_date', v_first_op,
    'days_in_operation', v_days,
    'avg_daily_paid', v_total_paid / GREATEST(v_days, 1),
    'generated_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_coo_system_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_coo_system_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_coo_system_overview() TO service_role;