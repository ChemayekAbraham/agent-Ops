-- Financial Ops: a per-person switch that hides the "Actual Money" figures (MTN and Airtel line balances, cash at hand).
--
-- WHY: Financial Ops access was all-or-nothing. Anyone with a Financial Ops grant or a finance role could read the actual
-- float. The CTO now needs to withhold it from named people without taking their whole Financial Ops access away.
--
-- HOW: a restriction key, 'financial-ops-float-hidden', in the existing staff_permissions allowlist. It is granted and
-- revoked from the CTO platform (Dashboard Permissions) through the existing grant_dashboard_access / revoke_dashboard_access
-- functions, which already audit every change. A person WITH the key cannot read the figures; everyone else is unchanged
-- (about 41 people can read them today, and none of them changes).
--
-- ENFORCEMENT is in the database, not only the screen:
--   * get_cash_at_hand_total()              refuses a restricted caller.
--   * get_phone_platform_reconciliation()   refuses a restricted caller (trigger and system calls are unaffected).
--   * can_view_actual_float()               lets the screen ask "may I see this?" so it can hide the card instead of showing 0.
--
-- NOT covered: the forwarded SMS and bank emails themselves sit in gmail_transactions and each one prints its own balance
-- line ("bal UGX ..."). A restricted person who can open Email Transactions can still read those lines. Hiding them needs a
-- separate decision (restrict the Email Transactions panel too).
--
-- Applies the restriction to NATASHA AROTIN (+256777404157), as requested. Remove it from her Dashboard Permissions to undo.
-- Roll back with 20261109140000_financial_ops_hide_actual_float.rollback.sql.

-- 1. The new key is a valid dashboard_access key (grant_dashboard_access rejects keys that are not in this list).
CREATE OR REPLACE FUNCTION public.dashboard_access_keys()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'ceo','cto','cfo','coo','cmo','crm','director','financial-ops','company-ops',
    'platform-users','agent-ops','tenant-ops','landlord-ops','partner-ops','hr',
    'rd','kyc','agents-space','financial-ops-float-hidden'
  ]::text[];
$function$;

-- 2. Is this person restricted? Internal helper for the checks below.
CREATE OR REPLACE FUNCTION public.actual_float_hidden_for(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.staff_permissions sp
    WHERE sp.user_id = _user_id
      AND sp.permitted_dashboard = 'financial-ops-float-hidden'
      AND sp.revoked_at IS NULL
  );
$function$;

-- 3. The screen asks about the signed-in person only.
CREATE OR REPLACE FUNCTION public.can_view_actual_float()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL AND NOT public.actual_float_hidden_for(auth.uid());
$function$;

-- 4. Cash at hand: same body as before plus the restriction check.
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
  IF public.actual_float_hidden_for(auth.uid()) THEN
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

-- 5. MTN / Airtel line balances: same wrapper as before plus the restriction check. Trigger-depth calls stay allowed.
CREATE OR REPLACE FUNCTION public.get_phone_platform_reconciliation()
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if not (pg_trigger_depth() > 0 or public.can_view_staff_reports(auth.uid())) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_trigger_depth() = 0 and public.actual_float_hidden_for(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return public.get_phone_platform_reconciliation__impl();
end
$function$;

-- 6. Grants. CREATE OR REPLACE keeps the grants on the two existing RPCs; the new ones are closed by default.
REVOKE ALL ON FUNCTION public.actual_float_hidden_for(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_view_actual_float() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_actual_float() TO authenticated;

-- 7. Restrict NATASHA AROTIN (+256777404157). Idempotent: skipped if she is already restricted or her profile is not found.
DO $$
DECLARE
  v_user uuid;
  v_id uuid;
BEGIN
  SELECT p.id INTO v_user FROM public.profiles p WHERE p.phone IN ('+256777404157', '256777404157', '0777404157') LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'financial_ops_hide_actual_float: no profile for the phone, nothing restricted';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.staff_permissions WHERE user_id = v_user AND permitted_dashboard = 'financial-ops-float-hidden' AND revoked_at IS NULL) THEN
    RETURN;
  END IF;
  INSERT INTO public.staff_permissions (user_id, permitted_dashboard, granted_by, granted_at)
  VALUES (v_user, 'financial-ops-float-hidden', NULL, now())
  RETURNING id INTO v_id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, new_values)
  VALUES (NULL, 'dashboard_access_granted', 'staff_permissions', v_id::text,
          'Granted financial-ops-float-hidden (hide Actual Money) via migration 20261109140000',
          'CTO request: not supposed to see the actual float',
          jsonb_build_object('user_id', v_user, 'dashboard', 'financial-ops-float-hidden'));
END
$$;
