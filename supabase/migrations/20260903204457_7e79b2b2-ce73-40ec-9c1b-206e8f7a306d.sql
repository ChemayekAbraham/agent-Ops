-- 1. Resolver: also return the expected repayment due to date.
DROP FUNCTION IF EXISTS public.tenant_self_repayment_plan(uuid);

CREATE FUNCTION public.tenant_self_repayment_plan(p_tenant_id uuid)
RETURNS TABLE(
  rent_request_id uuid, agent_id uuid, landlord_id uuid, landlord_name text,
  total_repayment numeric, amount_repaid numeric, outstanding numeric,
  daily_repayment numeric, expected_due numeric, days_elapsed integer,
  status text, other_active_plans integer
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH active AS (
    SELECT rr.id, rr.agent_id, rr.landlord_id, rr.total_repayment,
           COALESCE(rr.amount_repaid, 0) AS amount_repaid,
           COALESCE(rr.daily_repayment, 0) AS daily_repayment,
           rr.status, rr.created_at,
           GREATEST(1, (CURRENT_DATE - COALESCE(rr.disbursed_at, rr.created_at)::date) + 1) AS days_elapsed
      FROM public.rent_requests rr
     WHERE rr.tenant_id = p_tenant_id
       AND rr.status IN ('repaying', 'disbursed', 'funded')
       AND COALESCE(rr.tenancy_status, 'active') <> 'ended'
       AND COALESCE(rr.amount_repaid, 0) < COALESCE(rr.total_repayment, 0)
  ), calc AS (
    SELECT a.*,
           GREATEST(0, COALESCE(a.total_repayment, 0) - a.amount_repaid) AS outstanding
      FROM active a
  )
  SELECT c.id, c.agent_id, c.landlord_id, l.name,
         COALESCE(c.total_repayment, 0), c.amount_repaid, c.outstanding,
         c.daily_repayment,
         -- Expected due today: instalments accrued to date less what is already
         -- repaid, never below one instalment and never above the balance left.
         CASE
           WHEN c.daily_repayment <= 0 THEN c.outstanding
           ELSE LEAST(
             c.outstanding,
             GREATEST(
               c.daily_repayment,
               round(c.daily_repayment * c.days_elapsed - c.amount_repaid, 2)
             )
           )
         END,
         c.days_elapsed,
         c.status,
         (SELECT count(*)::int - 1 FROM calc)
    FROM calc c
    LEFT JOIN public.landlords l ON l.id = c.landlord_id
   ORDER BY c.created_at ASC
   LIMIT 1;
$function$;

-- 2. Settlement: cap the applied amount at the expected due, not the balance.
DO $$
DECLARE
  v_def text;
  v_old text := 'v_applied := round(LEAST(COALESCE(v_dep.amount, 0), v_plan.outstanding, v_float), 2);';
  v_new text := 'v_applied := round(LEAST(COALESCE(v_dep.amount, 0), COALESCE(NULLIF(v_plan.expected_due, 0), v_plan.outstanding), v_float), 2);';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'settle_tenant_rent_from_deposit';

  IF v_def IS NULL OR position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'settle_tenant_rent_from_deposit: expected-due patch target not found';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END $$;