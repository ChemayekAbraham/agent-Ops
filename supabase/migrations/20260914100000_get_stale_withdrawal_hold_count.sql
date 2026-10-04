-- Two Financial Ops call sites (the sidebar badge and the FinOps home count,
-- both in FinancialOpsCommandCenter.tsx) call get_stale_withdrawal_hold_count(),
-- which was never built -- every call has been failing since those badges
-- shipped. get_stale_withdrawal_hold_queue() already exists and does the
-- heavy per-row work; this mirrors its same thresholds and filter exactly,
-- just aggregated down to the three numbers the badges actually need.
--
-- Auth: same gate as the queue RPC (is_withdrawal_hold_reviewer), which
-- already covers cfo/ceo/manager/super_admin/financial_ops -- the whole
-- Financial Ops leadership set the badge comment says should see this count.

CREATE OR REPLACE FUNCTION public.get_stale_withdrawal_hold_count()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stale integer;
  v_critical integer;
  v_count integer;
  v_critical_count integer;
  v_oldest integer;
BEGIN
  IF NOT public.is_withdrawal_hold_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to review withdrawal holds';
  END IF;

  SELECT c.stale_after_days, c.critical_after_days
    INTO v_stale, v_critical
  FROM public.withdrawal_hold_reconciliation_config c
  ORDER BY c.created_at LIMIT 1;

  v_stale := COALESCE(v_stale, 14);
  v_critical := COALESCE(v_critical, 30);

  SELECT
    count(*),
    count(*) FILTER (WHERE h.is_pre_anchor OR h.age_days >= v_critical),
    COALESCE(max(h.age_days), 0)
  INTO v_count, v_critical_count, v_oldest
  FROM public.v_withdrawal_holds_unbacked h
  WHERE h.age_days >= v_stale
    AND NOT EXISTS (
      SELECT 1 FROM public.withdrawal_hold_reconciliations r
      WHERE r.withdrawal_id = h.withdrawal_id
    );

  RETURN jsonb_build_object(
    'count', v_count,
    'critical_count', v_critical_count,
    'oldest_age_days', v_oldest
  );
END;
$function$;
