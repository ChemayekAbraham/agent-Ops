-- AutoCreditSuccessRateTile (Financial Ops dashboard, mounted in
-- FinancialOpsCommandCenter.tsx) calls get_deposit_autocredit_success_rate,
-- which does not exist -- the component's own comment already anticipated
-- this ("data stays undefined... e.g. a migration hasn't been applied yet").
--
-- "Attempted" and "successful" mirror auto_create_deposits_from_gmail_impl's
-- own candidate-selection filter exactly (parsed, an inbound direction, a
-- positive amount, a non-empty transaction_id, within the window) --
-- deliberately the SAME criteria the real auto-credit job uses to pick its
-- candidate pool, not an invented metric. Within that pool, "successful" is
-- whichever rows ended up with linked_deposit_request_id set -- i.e. the job
-- actually created and linked a deposit_requests row for them. Everything
-- else in the pool was attempted and, for one of the impl function's several
-- skip reasons (already a matching deposit_requests row, no phone found, no
-- matching profile, an existing pending duplicate), never got auto-credited.

CREATE OR REPLACE FUNCTION public.get_deposit_autocredit_success_rate(p_window_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_attempted integer;
  v_successful integer;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Financial Ops only.';
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE g.linked_deposit_request_id IS NOT NULL)
  INTO v_attempted, v_successful
  FROM public.gmail_transactions g
  WHERE g.parsed = true
    AND g.direction IN ('in', 'credit')
    AND g.amount IS NOT NULL
    AND g.amount > 0
    AND g.transaction_id IS NOT NULL
    AND length(trim(g.transaction_id)) > 0
    AND g.internal_date >= now() - (greatest(1, coalesce(p_window_hours, 24)) || ' hours')::interval;

  RETURN jsonb_build_object(
    'attempted', coalesce(v_attempted, 0),
    'successful', coalesce(v_successful, 0),
    'success_rate_pct', CASE WHEN coalesce(v_attempted, 0) = 0 THEN NULL
                              ELSE round(100.0 * v_successful / v_attempted, 1) END
  );
END;
$function$;
