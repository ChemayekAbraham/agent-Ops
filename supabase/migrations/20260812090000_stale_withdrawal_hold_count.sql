-- Lightweight, broadly-visible count for the "stale withdrawal holds" badge
-- in Financial Ops. The existing get_stale_withdrawal_hold_queue() (and the
-- settle/cancel action, cfo_reconcile_stale_withdrawal) are correctly
-- restricted to is_withdrawal_hold_reviewer() (cfo/ceo/manager/super_admin/
-- financial_ops) -- those move real money and stay exactly as gated.
--
-- But that role set is NARROWER than who can see Financial Ops at all
-- (super_admin/manager/coo/cfo/employee/operations, per the RoleGuard on
-- /admin/financial-ops). The whole point of this badge is that a stale hold
-- shouldn't be able to sit unnoticed for months again -- which means anyone
-- working Financial Ops should be able to SEE the count and escalate, even
-- if they're not personally authorized to resolve it. Hence a separate,
-- read-only, count-only function with a broader (but still real) role gate.
CREATE OR REPLACE FUNCTION public.get_stale_withdrawal_hold_count()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stale integer;
  v_critical integer;
  v_count integer;
  v_critical_count integer;
  v_oldest_age integer;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'employee')
    OR public.has_role(auth.uid(), 'operations')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT c.stale_after_days, c.critical_after_days
    INTO v_stale, v_critical
  FROM public.withdrawal_hold_reconciliation_config c
  ORDER BY c.created_at LIMIT 1;

  v_stale := COALESCE(v_stale, 14);
  v_critical := COALESCE(v_critical, 30);

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE h.is_pre_anchor OR h.age_days >= v_critical),
    MAX(h.age_days)
  INTO v_count, v_critical_count, v_oldest_age
  FROM public.v_withdrawal_holds_unbacked h
  WHERE h.age_days >= v_stale
    AND NOT EXISTS (
      SELECT 1 FROM public.withdrawal_hold_reconciliations r
      WHERE r.withdrawal_id = h.withdrawal_id
    );

  RETURN json_build_object(
    'count', COALESCE(v_count, 0),
    'critical_count', COALESCE(v_critical_count, 0),
    'oldest_age_days', COALESCE(v_oldest_age, 0),
    'stale_after_days', v_stale
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_stale_withdrawal_hold_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stale_withdrawal_hold_count() TO authenticated;
