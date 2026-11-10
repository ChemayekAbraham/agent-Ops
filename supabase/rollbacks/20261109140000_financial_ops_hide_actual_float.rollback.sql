-- Rolls back 20261109140000_financial_ops_hide_actual_float.sql: lifts every restriction, puts the two RPCs back as they were.

-- Lift all restrictions (kept as history: revoked, not deleted).
UPDATE public.staff_permissions
   SET revoked_at = now(), revoke_reason = 'rollback of 20261109140000'
 WHERE permitted_dashboard = 'financial-ops-float-hidden' AND revoked_at IS NULL;

-- Cash at hand as it was.
CREATE OR REPLACE FUNCTION public.get_cash_at_hand_total()
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric;
  v_count integer;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  WITH latest AS (
    SELECT DISTINCT ON (v.deposit_request_id) v.deposit_request_id, v.amount, v.status
    FROM public.cash_deposit_verifications v
    ORDER BY v.deposit_request_id, v.created_at DESC
  )
  SELECT COALESCE(SUM(l.amount), 0), COUNT(*)
  INTO v_total, v_count
  FROM latest l
  JOIN public.deposit_requests dr ON dr.id = l.deposit_request_id
  WHERE l.status = 'verified'
    AND COALESCE(dr.purpose_audit->>'cash_location', 'cash_at_hand') = 'cash_at_hand';

  RETURN json_build_object('cash_at_hand_total', v_total, 'verified_count', v_count, 'computed_at', now());
END;
$function$;

-- Line balances as they were.
CREATE OR REPLACE FUNCTION public.get_phone_platform_reconciliation()
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$ begin if not (pg_trigger_depth() > 0 or public.can_view_staff_reports(auth.uid())) then raise exception 'not authorized' using errcode = '42501'; end if; return public.get_phone_platform_reconciliation__impl(); end $function$;

-- The key list as it was.
CREATE OR REPLACE FUNCTION public.dashboard_access_keys()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'ceo','cto','cfo','coo','cmo','crm','director','financial-ops','company-ops',
    'platform-users','agent-ops','tenant-ops','landlord-ops','partner-ops','hr',
    'rd','kyc','agents-space'
  ]::text[];
$function$;

DROP FUNCTION IF EXISTS public.can_view_actual_float();
DROP FUNCTION IF EXISTS public.actual_float_hidden_for(uuid);
