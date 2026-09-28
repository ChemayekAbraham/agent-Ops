-- Agent collections health monitor
--
-- A named set of checks over the collection path, so a fault is found while it
-- is still small rather than when someone notices a figure looks wrong.
--
-- EVERY CHECK HERE FIRES ON REAL PRODUCTION DATA. Measured 28 September before
-- writing it — a monitor built from imagination is a monitor nobody trusts:
--
--   plan_overpaid                 2 plans     265,731
--   reversed_still_counted    1,273 rows   98,647,719   (10-16 Sep cleanup)
--   ledger_imbalance             88 groups   6,142,066   (14 days)
--   missing_commission           23 rows       264,100
--   possible_duplicate           16 rows       265,302
--   orphan_collection             0
--   collection_no_ledger_leg      0
--   negative_float                0
--   collection_on_dead_plan       0
--
-- WHAT IS DELIBERATELY *NOT* A CHECK
--
-- "Collected more than today's bill" looks like the obvious over-collection
-- test and it is wrong. It fires 734 times in 14 days for 35.7m, and every one
-- of those is a tenant clearing ARREARS — paying more than one day because they
-- owe more than one day. That is the behaviour we want, not a fault. Flagging
-- it would bury the five real findings under normal business.
--
-- The honest over-collection test is per PLAN, not per day: amount_repaid
-- exceeding total_repayment means the tenant has paid more than the Rent Plan
-- was ever worth. That fires twice, and both are worth a look.
--
-- ON reversed_still_counted
--
-- A reversed collection keeps its `amount`. Most tiles are SUM(amount) with no
-- filter, so 98.6m of reversed money is still countable — almost all of it the
-- cleanup of the 10-16 September event, which is also why 16 September shows
-- 52.8m "collected" in one day. It is not a bug in the collection path; it is a
-- live reporting hazard, and the monitor's job is to keep it visible.
--
-- ON ledger_imbalance
--
-- These are mostly FALSE POSITIVES against the published balance sheet and the
-- check says so. The enforcement trigger judges base mapping only, and the
-- collection journal is designed not to balance there: sofp_ledger_legs flips
-- the wallet float leg to DR A2 and the repayment leg to CR A3, then injects a
-- synthetic DR A5 + DR L4. `assert_money_path_intact` states this as an
-- invariant. The residual comes from two categories with OPPOSITE debit_when —
-- tenant_repayment (cash_out) and tenant_repayment_collected (cash_in) — so the
-- shape that uses the older category logs a violation and the other does not.
-- Worth watching for a change in rate, not for the absolute number.

CREATE OR REPLACE FUNCTION public.agent_collections_monitor(
  p_days integer DEFAULT 14)
RETURNS TABLE (
  check_key    text,
  label        text,
  severity     text,
  hits         bigint,
  exposure_ugx numeric,
  oldest       timestamptz,
  newest       timestamptz,
  guidance     text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_days  int  := GREATEST(1, LEAST(180, COALESCE(p_days, 14)));
  v_since timestamptz := now() - make_interval(days => v_days);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT (
    public.has_role(v_uid, 'cto'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role)
    OR public.has_role(v_uid, 'ceo'::app_role)
    OR public.has_role(v_uid, 'cfo'::app_role)
    OR public.has_role(v_uid, 'coo'::app_role)
    OR public.has_role(v_uid, 'manager'::app_role)
    OR public.has_role(v_uid, 'agent_ops'::app_role)
    OR public.has_role(v_uid, 'operations'::app_role)
  ) THEN
    RAISE EXCEPTION 'Engineering or operations role required' USING ERRCODE = '42501';
  END IF;

  -- The UNION is wrapped: Postgres rejects a CASE expression in ORDER BY that
  -- follows a set operation, so the ranking has to happen outside it.
  RETURN QUERY
  SELECT q.check_key, q.label, q.severity, q.hits, q.exposure_ugx, q.oldest, q.newest, q.guidance
  FROM (

  -- 1. A collection that never reached the ledger. Money recorded, nothing
  --    posted. Nothing else on this list is worse.
  SELECT 'collection_no_ledger_leg'::text AS check_key, 'Collection with no ledger entry'::text AS label,
         'critical'::text AS severity, count(*)::bigint AS hits, COALESCE(sum(c.amount),0) AS exposure_ugx,
         min(c.created_at) AS oldest, max(c.created_at) AS newest,
         'The collection exists but posted nothing. Replay the allocation for this plan.'::text AS guidance
  FROM public.agent_collections c
  WHERE c.created_at >= v_since AND c.reversed_at IS NULL AND c.amount > 0
    AND NOT EXISTS (SELECT 1 FROM public.general_ledger gl
                     WHERE gl.source_table='agent_collections' AND gl.source_id = c.rent_request_id)

  UNION ALL
  -- 2. Points at a Rent Plan that no longer exists.
  SELECT 'orphan_collection', 'Collection against a missing Rent Plan', 'critical',
         count(*)::bigint, COALESCE(sum(c.amount),0), min(c.created_at), max(c.created_at),
         'rent_request_id has no matching plan. The cash is real; the attribution is not.'
  FROM public.agent_collections c
  WHERE c.created_at >= v_since AND c.rent_request_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.id = c.rent_request_id)

  UNION ALL
  -- 3. Tenant has paid more than the plan was ever worth.
  SELECT 'plan_overpaid', 'Tenant repaid more than the plan total', 'high',
         count(*)::bigint,
         COALESCE(sum(rr.amount_repaid - rr.total_repayment),0),
         min(rr.funded_at), max(rr.updated_at),
         'amount_repaid exceeds total_repayment. Refund or reallocate the excess.'
  FROM public.rent_requests rr
  WHERE COALESCE(rr.total_repayment,0) > 0
    AND COALESCE(rr.amount_repaid,0) > COALESCE(rr.total_repayment,0)

  UNION ALL
  -- 4. Reversed rows that unfiltered tiles still add up.
  SELECT 'reversed_still_counted', 'Reversed collections still countable', 'high',
         count(*)::bigint, COALESCE(sum(c.amount),0), min(c.created_at), max(c.created_at),
         'A reversed collection keeps its amount. Any SUM(amount) without a reversal filter overstates by this much.'
  FROM public.agent_collections c
  WHERE c.created_at >= v_since
    AND (c.reversed_at IS NOT NULL OR COALESCE(c.notes,'') ILIKE '%[REVERSED:%')

  UNION ALL
  -- 5. Float driven below zero.
  SELECT 'negative_float', 'Agent float went negative', 'high',
         count(*)::bigint, COALESCE(sum(ABS(c.float_after)),0), min(c.created_at), max(c.created_at),
         'float_after is negative. An agent cannot spend float they do not have.'
  FROM public.agent_collections c
  WHERE c.created_at >= v_since AND c.float_after < 0

  UNION ALL
  -- 6. Collected against a plan that is not repaying or completed.
  SELECT 'collection_on_dead_plan', 'Collection on a cancelled or unfunded plan', 'medium',
         count(*)::bigint, COALESCE(sum(c.amount),0), min(c.created_at), max(c.created_at),
         'The plan is not repaying or completed. Check whether the plan was unwound after the cash came in.'
  FROM public.agent_collections c
  JOIN public.rent_requests rr ON rr.id = c.rent_request_id
  WHERE c.created_at >= v_since AND c.reversed_at IS NULL
    AND rr.status NOT IN ('repaying','completed')

  UNION ALL
  -- 7. The agent collected and was not paid for it.
  SELECT 'missing_commission', 'Collection with no commission leg', 'medium',
         count(*)::bigint, COALESCE(sum(c.amount),0), min(c.created_at), max(c.created_at),
         'No agent_commission_earned leg for this plan. Mostly tenant self-payments — confirm the collector was still paid.'
  FROM public.agent_collections c
  WHERE c.created_at >= v_since AND c.reversed_at IS NULL AND c.amount > 0
    AND NOT EXISTS (SELECT 1 FROM public.general_ledger gl
                     WHERE gl.ledger_scope='wallet' AND gl.category='agent_commission_earned'
                       AND gl.source_table='agent_collections' AND gl.source_id = c.rent_request_id)

  UNION ALL
  -- 8. Same plan, same amount, seconds apart.
  SELECT 'possible_duplicate', 'Possible double-recorded collection', 'medium',
         count(*)::bigint, COALESCE(sum(amount),0), min(created_at), max(created_at),
         'Same plan and amount within 60 seconds. Usually a double tap; confirm before reversing.'
  FROM (
    SELECT c.amount, c.created_at,
           lag(c.created_at) OVER (PARTITION BY c.rent_request_id, c.amount ORDER BY c.created_at) AS prev
    FROM public.agent_collections c
    WHERE c.created_at >= v_since AND c.reversed_at IS NULL
  ) dup
  WHERE prev IS NOT NULL AND created_at - prev < interval '60 seconds'

  UNION ALL
  -- 9. Ledger balance violations. Mostly expected — see the header.
  SELECT 'ledger_imbalance', 'Ledger group flagged unbalanced', 'info',
         count(*)::bigint, COALESCE(sum(ABS(v.residual)),0), min(v.detected_at), max(v.detected_at),
         'Mostly false positives: the collection journal balances only after the resolver. Watch the RATE, not the number.'
  FROM public.ledger_mapped_balance_violations v
  WHERE v.source_table = 'agent_collections' AND v.detected_at >= v_since

  ) q
  ORDER BY CASE q.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
           q.hits DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_collections_monitor(integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.agent_collections_monitor(integer) TO authenticated;

COMMENT ON FUNCTION public.agent_collections_monitor(integer) IS
  'Named health checks over the agent collection path for the CTO Monitor '
  'console. Every check was measured against production before shipping. '
  'Deliberately excludes "collected more than today''s bill" — that fires 734 '
  'times in 14 days and every one is a tenant clearing arrears.';

-- ---------------------------------------------------------------------------
-- Drill-down: the rows behind one check.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_collections_monitor_detail(
  p_check_key text,
  p_days      integer DEFAULT 14,
  p_limit     integer DEFAULT 100)
RETURNS TABLE (
  collection_id   uuid,
  occurred_at     timestamptz,
  agent_name      text,
  agent_phone     text,
  tenant_name     text,
  rent_request_id uuid,
  amount          numeric,
  detail          text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_days  int := GREATEST(1, LEAST(180, COALESCE(p_days, 14)));
  v_lim   int := GREATEST(1, LEAST(500, COALESCE(p_limit, 100)));
  v_since timestamptz := now() - make_interval(days => v_days);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT (
    public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)
    OR public.has_role(v_uid, 'ceo'::app_role) OR public.has_role(v_uid, 'cfo'::app_role)
    OR public.has_role(v_uid, 'coo'::app_role) OR public.has_role(v_uid, 'manager'::app_role)
    OR public.has_role(v_uid, 'agent_ops'::app_role) OR public.has_role(v_uid, 'operations'::app_role)
  ) THEN
    RAISE EXCEPTION 'Engineering or operations role required' USING ERRCODE = '42501';
  END IF;

  IF p_check_key = 'plan_overpaid' THEN
    RETURN QUERY
    SELECT NULL::uuid, rr.updated_at, ap.full_name, ap.phone, tp.full_name, rr.id,
           (rr.amount_repaid - rr.total_repayment),
           format('repaid %s of a %s plan', round(rr.amount_repaid), round(rr.total_repayment))
    FROM public.rent_requests rr
    LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    WHERE COALESCE(rr.total_repayment,0) > 0
      AND COALESCE(rr.amount_repaid,0) > COALESCE(rr.total_repayment,0)
    ORDER BY (rr.amount_repaid - rr.total_repayment) DESC LIMIT v_lim;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.id, c.created_at, ap.full_name, ap.phone, tp.full_name, c.rent_request_id, c.amount,
         COALESCE(NULLIF(btrim(c.notes), ''), c.collection_channel, '')
  FROM public.agent_collections c
  LEFT JOIN public.profiles ap ON ap.id = c.agent_id
  LEFT JOIN public.rent_requests rr ON rr.id = c.rent_request_id
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  WHERE c.created_at >= v_since
    AND CASE p_check_key
      WHEN 'collection_no_ledger_leg' THEN
        c.reversed_at IS NULL AND c.amount > 0
        AND NOT EXISTS (SELECT 1 FROM public.general_ledger gl
                         WHERE gl.source_table='agent_collections' AND gl.source_id=c.rent_request_id)
      WHEN 'orphan_collection' THEN
        c.rent_request_id IS NOT NULL AND rr.id IS NULL
      WHEN 'reversed_still_counted' THEN
        (c.reversed_at IS NOT NULL OR COALESCE(c.notes,'') ILIKE '%[REVERSED:%')
      WHEN 'negative_float' THEN c.float_after < 0
      WHEN 'collection_on_dead_plan' THEN
        c.reversed_at IS NULL AND rr.status IS NOT NULL AND rr.status NOT IN ('repaying','completed')
      WHEN 'missing_commission' THEN
        c.reversed_at IS NULL AND c.amount > 0
        AND NOT EXISTS (SELECT 1 FROM public.general_ledger gl
                         WHERE gl.ledger_scope='wallet' AND gl.category='agent_commission_earned'
                           AND gl.source_table='agent_collections' AND gl.source_id=c.rent_request_id)
      WHEN 'possible_duplicate' THEN
        EXISTS (SELECT 1 FROM public.agent_collections c2
                 WHERE c2.rent_request_id = c.rent_request_id AND c2.amount = c.amount
                   AND c2.id <> c.id AND c2.reversed_at IS NULL
                   AND abs(EXTRACT(epoch FROM (c2.created_at - c.created_at))) < 60)
      ELSE FALSE
    END
  ORDER BY c.created_at DESC LIMIT v_lim;
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_collections_monitor_detail(text, integer, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.agent_collections_monitor_detail(text, integer, integer) TO authenticated;
