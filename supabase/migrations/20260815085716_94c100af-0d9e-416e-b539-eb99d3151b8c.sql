CREATE OR REPLACE FUNCTION public.get_coo_rent_coverage_statement()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid, 'manager') OR has_role(v_uid, 'coo') OR has_role(v_uid, 'ceo')
       OR has_role(v_uid, 'cfo') OR has_role(v_uid, 'super_admin')
       OR has_role(v_uid, 'financial_ops')
     ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  WITH col AS (
    SELECT rent_request_id, sum(amount) AS amt, count(*) AS cnt
    FROM agent_collections
    WHERE rent_request_id IS NOT NULL
    GROUP BY rent_request_id
  ),
  col_all AS (
    SELECT COALESCE(sum(amount), 0) AS collected_total,
           count(*)                 AS collection_count,
           min(created_at)          AS first_collection_at,
           max(created_at)          AS last_collection_at
    FROM agent_collections
  ),
  -- Every real rent plan CYCLE ever activated (renewals are separate rows by design)
  real_plans AS (
    SELECT rr.id, rr.tenant_id, rr.status, rr.created_at,
           COALESCE(rr.registration_type, 'normal') AS registration_type,
           COALESCE(rr.rent_amount, 0)     AS rent_amount,
           COALESCE(rr.total_repayment, 0) AS total_repayment,
           GREATEST(COALESCE(rr.amount_repaid, 0), COALESCE(c.amt, 0)) AS effective_repaid
    FROM rent_requests rr
    LEFT JOIN col c ON c.rent_request_id = rr.id
    WHERE rr.status IN ('repaying', 'funded', 'completed')
      AND (rr.funded_at IS NOT NULL OR COALESCE(rr.amount_repaid, 0) > 0 OR c.rent_request_id IS NOT NULL)
  ),
  -- One row per tenant: their LATEST cycle decides their current lifecycle state,
  -- so a tenant who completed a plan and renewed is not double counted.
  tenant_latest AS (
    SELECT DISTINCT ON (tenant_id) tenant_id, status
    FROM real_plans
    WHERE tenant_id IS NOT NULL
    ORDER BY tenant_id, created_at DESC, id
  ),
  tenant_cycles AS (
    SELECT tenant_id, count(*) AS cycles
    FROM real_plans
    WHERE tenant_id IS NOT NULL
    GROUP BY tenant_id
  ),
  tenant_totals AS (
    SELECT
      (SELECT count(*) FROM tenant_latest)                                              AS tenants_total,
      (SELECT count(*) FROM tenant_latest WHERE status = 'repaying')                    AS tenants_repaying,
      (SELECT count(*) FROM tenant_latest WHERE status = 'funded')                      AS tenants_funded,
      (SELECT count(*) FROM tenant_latest WHERE status = 'completed')                   AS tenants_completed,
      (SELECT count(*) FROM tenant_cycles WHERE cycles > 1)                             AS tenants_repeat,
      (SELECT COALESCE(sum(cycles), 0) FROM tenant_cycles)                              AS cycles_total
  ),
  plan_totals AS (
    SELECT
      count(*)                                                                     AS plans_total,
      count(*) FILTER (WHERE status = 'repaying')                                   AS plans_repaying,
      count(*) FILTER (WHERE status = 'funded')                                     AS plans_funded,
      count(*) FILTER (WHERE status = 'completed')                                  AS plans_completed,
      count(*) FILTER (WHERE registration_type = 'renewal')                          AS plans_renewal,
      count(*) FILTER (WHERE registration_type <> 'renewal')                         AS plans_first_time,
      COALESCE(sum(rent_amount), 0)                                                 AS rent_funded_total,
      COALESCE(sum(rent_amount) FILTER (WHERE registration_type = 'renewal'), 0)     AS rent_funded_renewal,
      COALESCE(sum(rent_amount) FILTER (WHERE registration_type <> 'renewal'), 0)    AS rent_funded_first_time,
      COALESCE(sum(total_repayment), 0)                                             AS total_repayment_booked,
      COALESCE(sum(effective_repaid), 0)                                            AS total_repaid_recorded,
      COALESCE(sum(GREATEST(total_repayment - effective_repaid, 0))
               FILTER (WHERE status IN ('repaying', 'funded')), 0)                   AS outstanding
    FROM real_plans
  ),
  disbursed AS (
    SELECT
      (SELECT COALESCE(sum(amount), 0) FROM landlord_payouts
         WHERE status IN ('completed', 'awaiting_agent_receipt'))                      AS landlord_float_disbursed,
      (SELECT count(*) FROM landlord_payouts
         WHERE status IN ('completed', 'awaiting_agent_receipt'))                      AS landlord_payout_count,
      (SELECT count(DISTINCT landlord_id) FROM landlord_payouts
         WHERE status IN ('completed', 'awaiting_agent_receipt'))                      AS landlords_paid,
      (SELECT count(DISTINCT rent_request_id) FROM landlord_payouts
         WHERE status IN ('completed', 'awaiting_agent_receipt')
           AND rent_request_id IS NOT NULL)                                            AS plans_with_payout
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'tenants', jsonb_build_object(
      'total', t.tenants_total,
      'repaying', t.tenants_repaying,
      'funded', t.tenants_funded,
      'completed', t.tenants_completed,
      'repeat', t.tenants_repeat
    ),
    'plans', jsonb_build_object(
      'total', p.plans_total,
      'repaying', p.plans_repaying,
      'funded', p.plans_funded,
      'completed', p.plans_completed,
      'renewal', p.plans_renewal,
      'first_time', p.plans_first_time,
      'cycles_total', t.cycles_total,
      'with_landlord_payout', d.plans_with_payout
    ),
    'money', jsonb_build_object(
      'rent_approved_total', p.rent_funded_total,
      'rent_funded_total', p.rent_funded_total,
      'rent_funded_first_time', p.rent_funded_first_time,
      'rent_funded_renewal', p.rent_funded_renewal,
      'landlord_float_disbursed', d.landlord_float_disbursed,
      'landlord_payout_count', d.landlord_payout_count,
      'landlords_paid', d.landlords_paid,
      'total_repayment_booked', p.total_repayment_booked,
      'collected_total', c.collected_total,
      'collection_count', c.collection_count,
      'recorded_repaid', p.total_repaid_recorded,
      'outstanding', p.outstanding,
      'coverage_rate', CASE WHEN d.landlord_float_disbursed > 0
                            THEN round((c.collected_total / d.landlord_float_disbursed) * 100, 2)
                            ELSE 0 END,
      'coverage_of_booked', CASE WHEN p.total_repayment_booked > 0
                            THEN round((p.total_repaid_recorded / p.total_repayment_booked) * 100, 2)
                            ELSE 0 END,
      'coverage_of_rent_funded', CASE WHEN p.rent_funded_total > 0
                            THEN round((p.total_repaid_recorded / p.rent_funded_total) * 100, 2)
                            ELSE 0 END,
      'first_collection_at', c.first_collection_at,
      'last_collection_at', c.last_collection_at
    )
  )
  INTO v_result
  FROM tenant_totals t, plan_totals p, disbursed d, col_all c;

  RETURN v_result;
END;
$function$;