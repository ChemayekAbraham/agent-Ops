CREATE OR REPLACE FUNCTION public.tenant_self_repayment_plan(p_tenant_id uuid)
 RETURNS TABLE(rent_request_id uuid, agent_id uuid, landlord_id uuid, landlord_name text, total_repayment numeric, amount_repaid numeric, outstanding numeric, daily_repayment numeric, expected_due numeric, days_elapsed integer, status text, other_active_plans integer)
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
    SELECT a.*, GREATEST(0, COALESCE(a.total_repayment, 0) - a.amount_repaid) AS outstanding
      FROM active a
  )
  SELECT c.id, c.agent_id, c.landlord_id, l.name,
         COALESCE(c.total_repayment, 0), c.amount_repaid, c.outstanding,
         c.daily_repayment,
         -- STRICTLY DAILY: one instalment only, never arrears/catch-up.
         CASE WHEN c.daily_repayment <= 0 THEN c.outstanding
              ELSE LEAST(c.outstanding, c.daily_repayment) END,
         c.days_elapsed,
         c.status,
         (SELECT count(*)::int - 1 FROM calc)
    FROM calc c
    LEFT JOIN public.landlords l ON l.id = c.landlord_id
   ORDER BY c.created_at ASC
   LIMIT 1;
$function$;