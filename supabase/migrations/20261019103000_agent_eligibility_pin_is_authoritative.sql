-- Agent daily eligibility: the pinned bill is authoritative.
--
-- Two defects fixed here, both of which made an agent's day look worse than it
-- was and, in one case, swallowed a payment outright.
--
-- 1. `expected` re-read rent_requests.status at QUERY time (added 2026-10-06 so
--    that funded/completed plans stop inflating expected). The pin already only
--    bills `repaying` plans, so the read-time filter bought nothing — but it
--    un-pinned a plan the moment it left `repaying` during the day. An agent who
--    cleared a tenant in full saw that tenant's bill vanish from the denominator
--    while the payment stayed in the numerator, so the day's figures drifted all
--    afternoon. A plan the pin billed today or yesterday now stays in expected
--    for that day whatever its status becomes later; plans the pin never billed
--    (funded, long-completed) still contribute nothing, which is the behaviour
--    2026-10-06 asked for.
--
-- 2. `reversed` excluded a plan if it had EVER had an approved allocation return
--    or a tenant float reversal, with no regard for what happened afterwards. A
--    plan whose first landlord allocation was returned ("Changed landlord") and
--    whose SECOND allocation was then paid out in full stayed permanently
--    excluded, so the pin billed the tenant while the view refused to count the
--    money. 27 plans network-wide were in that state, 20 of them still repaying.
--    A reversal now only disqualifies a plan while it is the latest word: an
--    allocation paid out AFTER the reversal clears it.
DO $mig$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  v_def := pg_get_viewdef('public.v_agent_daily_eligibility'::regclass, true);

  ---------------------------------------------------------------- 2. reversed
  v_old := '                ), reversed AS (
                 SELECT DISTINCT r.rent_request_id
                   FROM agent_tenant_float_reversals r
                UNION
                 SELECT DISTINCT arr.rent_request_id
                   FROM agent_allocation_return_requests arr
                  WHERE arr.status = ''approved''::text AND arr.rent_request_id IS NOT NULL
                ), landlord_settled AS (';

  v_new := '                ), reversal_marks AS (
                 SELECT r.rent_request_id, r.created_at AS reversed_at
                   FROM agent_tenant_float_reversals r
                  WHERE r.rent_request_id IS NOT NULL
                UNION ALL
                 SELECT arr.rent_request_id, COALESCE(arr.cfo_decision_at, arr.updated_at, arr.created_at)
                   FROM agent_allocation_return_requests arr
                  WHERE arr.status = ''approved''::text AND arr.rent_request_id IS NOT NULL
                ), reversal_latest AS (
                 SELECT rm.rent_request_id, max(rm.reversed_at) AS reversed_at
                   FROM reversal_marks rm
                  GROUP BY rm.rent_request_id
                ), reversed AS (
                 SELECT rl.rent_request_id
                   FROM reversal_latest rl
                  WHERE NOT (EXISTS ( SELECT 1
                           FROM agent_landlord_float_allocations al
                          WHERE al.rent_request_id = rl.rent_request_id
                            AND al.paid_out_amount > 0::numeric
                            AND COALESCE(al.updated_at, al.created_at) > rl.reversed_at))
                ), landlord_settled AS (';

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'v_agent_daily_eligibility: reversed CTE not found in the shape this migration expects';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  ------------------------------------------------- 1a. eligible_rents.was_billed
  v_old := '                ), eligible_rents AS (
                 SELECT lr.agent_id,
                    lr.status,
                    lr.rent_request_id,
                    lr.tenant_id,
                    COALESCE(lr.daily_repayment, 0::numeric) AS daily_repayment,';

  v_new := '                ), eligible_rents AS (
                 SELECT lr.agent_id,
                    lr.status,
                    lr.rent_request_id,
                    lr.tenant_id,
                    (pd.rent_request_id IS NOT NULL) AS was_billed,
                    COALESCE(lr.daily_repayment, 0::numeric) AS daily_repayment,';

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'v_agent_daily_eligibility: eligible_rents header not found in the shape this migration expects';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  ------------------------------------------------------- 1b. expected population
  v_old := '                  WHERE er.status = ''repaying''::text
                  GROUP BY er.agent_id';
  v_new := '                  WHERE er.status = ''repaying''::text OR er.was_billed
                  GROUP BY er.agent_id';

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'v_agent_daily_eligibility: expected status filter not found in the shape this migration expects';
  END IF;
  v_def := replace(v_def, v_old, v_new);

  EXECUTE format('CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS %s', v_def);
  -- CREATE OR REPLACE VIEW does not carry reloptions forward, so the view
  -- loses security_invoker unless it is set again. See 20261019110000.
  EXECUTE 'ALTER VIEW public.v_agent_daily_eligibility SET (security_invoker = on)';
END
$mig$;
