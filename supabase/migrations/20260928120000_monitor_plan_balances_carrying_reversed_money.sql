-- Monitor: reversed money that is still sitting inside a tenant's plan balance
--
-- WHY THIS IS A SEPARATE CHECK FROM `reversed_still_counted`
--
-- `reversed_still_counted` watches the RECEIPT BOOK: a reversed
-- `agent_collections` row keeps its `amount`, so any SUM(amount) without a
-- reversal filter overstates. That is a reporting hazard, and the 72-function
-- sweep of 10-16 September fixed the readers.
--
-- This check watches the PLAN BALANCE, which that sweep never touched. Every
-- surface that reads `rent_requests.amount_repaid` — the Service Centre
-- "Collection rankings" board, a tenant's own progress bar, the arrears view —
-- is downstream of a column, not of a filterable row, so no amount of
-- filtering in the readers can correct it.
--
-- WHAT WAS FOUND, 28 September
--
-- 20260916180000 stated that the duplicates were kept out of the tenant
-- balances, on the evidence that "zero plans are credited beyond their own
-- total". That test was too weak: staying under `total_repayment` is not the
-- same as not being credited. 25 plans carry an `amount_repaid` that equals
-- live + reversed collections TO THE SHILLING, worth UGX 8,180,000, and every
-- reversal behind them is dated 2026-09-16. None of the 25 appears in the
-- `repayment_restored_after_guard_drop` audit set, so this is not the restore.
--
--   The clearest case: one plan holds 59 reversed rows worth 2,537,000 against
--   64,000 of real collections, and reads 2,601,000 of a 2,680,000 plan — a
--   tenant shown 97% repaid who has actually paid 64,000.
--
-- Widened to "amount_repaid exceeds live collections and the plan has
-- reversals at all", it is 57 plans and UGX 19,090,568. That wider figure is
-- an UPPER BOUND, not a diagnosis: a plan can legitimately be repaid through
-- deposit settlement or tenant self-payment, neither of which writes an
-- `agent_collections` row. The 8,180,000 exact-match subset is the part that
-- is certain, and the guidance says so on the row.
--
-- ON `plan_balance_unbacked`, AND WHY IT SHIPS AS info
--
-- `amount_repaid` is a denormalised balance with FIFTEEN writers, including
-- administrative completion and ops balance edits. Platform-wide it totals
-- UGX 658,861,483 against UGX 374,136,222 of live collections and
-- UGX 119,681,158 of `repayments` rows. Even crediting both sources in full,
-- UGX 257m across 215 plans has no recorded cash behind it.
--
-- That is a real question and it is NOT a fault in the collection path — it is
-- mostly historical, and some of it will be legitimate settlement the two
-- tables do not record. Shipping it as `high` would swamp the panel and train
-- people to ignore it, which is the same reasoning that kept "collected more
-- than today's bill" out of the monitor entirely. It ships as `info`, scoped
-- to the window, so the rate is visible without crying wolf.

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
  WITH plan_coll AS (
    SELECT c.rent_request_id AS rr_id,
           COALESCE(sum(c.amount) FILTER (
             WHERE c.reversed_at IS NULL
               AND COALESCE(c.notes,'') NOT ILIKE '%[REVERSED:%'), 0) AS live_amt,
           COALESCE(sum(c.amount) FILTER (
             WHERE c.reversed_at IS NOT NULL
                OR COALESCE(c.notes,'') ILIKE '%[REVERSED:%'), 0) AS rev_amt
    FROM public.agent_collections c
    WHERE c.rent_request_id IS NOT NULL
    GROUP BY c.rent_request_id
  ),
  plan_repay AS (
    SELECT rp.rent_request_id AS rr_id, COALESCE(sum(rp.amount), 0) AS rep_amt
    FROM public.repayments rp
    WHERE rp.rent_request_id IS NOT NULL
    GROUP BY rp.rent_request_id
  )
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
  -- 5. Reversed money that is still inside the tenant's plan balance.
  --    Not filterable by any reader: `amount_repaid` is a column, not a row.
  SELECT 'plan_balance_holds_reversed', 'Plan balance still holds reversed money', 'high',
         count(*)::bigint,
         COALESCE(sum(LEAST(pc.rev_amt, rr.amount_repaid - pc.live_amt)),0),
         min(rr.funded_at), max(rr.updated_at),
         'amount_repaid sits above live collections on a plan that has reversals. Upper bound — deposit settlement also writes this column; the exact live+reversed matches are certain.'
  FROM plan_coll pc
  JOIN public.rent_requests rr ON rr.id = pc.rr_id
  WHERE pc.rev_amt > 0 AND rr.amount_repaid > pc.live_amt

  UNION ALL
  -- 6. Float driven below zero.
  SELECT 'negative_float', 'Agent float went negative', 'high',
         count(*)::bigint, COALESCE(sum(ABS(c.float_after)),0), min(c.created_at), max(c.created_at),
         'float_after is negative. An agent cannot spend float they do not have.'
  FROM public.agent_collections c
  WHERE c.created_at >= v_since AND c.float_after < 0

  UNION ALL
  -- 7. Collected against a plan that is not repaying or completed.
  SELECT 'collection_on_dead_plan', 'Collection on a cancelled or unfunded plan', 'medium',
         count(*)::bigint, COALESCE(sum(c.amount),0), min(c.created_at), max(c.created_at),
         'The plan is not repaying or completed. Check whether the plan was unwound after the cash came in.'
  FROM public.agent_collections c
  JOIN public.rent_requests rr ON rr.id = c.rent_request_id
  WHERE c.created_at >= v_since AND c.reversed_at IS NULL
    AND rr.status NOT IN ('repaying','completed')

  UNION ALL
  -- 8. The agent collected and was not paid for it.
  SELECT 'missing_commission', 'Collection with no commission leg', 'medium',
         count(*)::bigint, COALESCE(sum(c.amount),0), min(c.created_at), max(c.created_at),
         'No agent_commission_earned leg for this plan. Mostly tenant self-payments — confirm the collector was still paid.'
  FROM public.agent_collections c
  WHERE c.created_at >= v_since AND c.reversed_at IS NULL AND c.amount > 0
    AND NOT EXISTS (SELECT 1 FROM public.general_ledger gl
                     WHERE gl.ledger_scope='wallet' AND gl.category='agent_commission_earned'
                       AND gl.source_table='agent_collections' AND gl.source_id = c.rent_request_id)

  UNION ALL
  -- 9. Same plan, same amount, seconds apart.
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
  -- 10. Plan balance above every cash record we hold. Informational by design —
  --     see the header: this is a question about a 15-writer column, not a
  --     fault in the collection path.
  SELECT 'plan_balance_unbacked', 'Plan balance above recorded cash', 'info',
         count(*)::bigint,
         COALESCE(sum(rr.amount_repaid - COALESCE(pc.live_amt,0) - GREATEST(COALESCE(prp.rep_amt,0),0)),0),
         min(rr.funded_at), max(rr.updated_at),
         'amount_repaid exceeds live collections plus repayments by more than 50,000. Mostly historical and partly legitimate settlement. Watch the rate, not the number.'
  FROM public.rent_requests rr
  LEFT JOIN plan_coll pc ON pc.rr_id = rr.id
  LEFT JOIN plan_repay prp ON prp.rr_id = rr.id
  WHERE rr.amount_repaid > 0
    AND rr.updated_at >= v_since
    AND rr.amount_repaid - COALESCE(pc.live_amt,0) - GREATEST(COALESCE(prp.rep_amt,0),0) > 50000

  UNION ALL
  -- 11. Ledger balance violations. Mostly expected — see the original header.
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
  'times in 14 days and every one is a tenant clearing arrears. '
  'plan_balance_holds_reversed and plan_balance_unbacked watch '
  'rent_requests.amount_repaid, which no reader-side reversal filter can reach.';

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

  -- Both plan-balance checks list PLANS, not collection rows, so they answer
  -- from `rent_requests` and leave `collection_id` null.
  IF p_check_key = 'plan_balance_holds_reversed' THEN
    RETURN QUERY
    WITH pc AS (
      SELECT c.rent_request_id AS rr_id,
             COALESCE(sum(c.amount) FILTER (
               WHERE c.reversed_at IS NULL
                 AND COALESCE(c.notes,'') NOT ILIKE '%[REVERSED:%'), 0) AS live_amt,
             COALESCE(sum(c.amount) FILTER (
               WHERE c.reversed_at IS NOT NULL
                  OR COALESCE(c.notes,'') ILIKE '%[REVERSED:%'), 0) AS rev_amt,
             count(*) FILTER (WHERE c.reversed_at IS NOT NULL) AS rev_rows
      FROM public.agent_collections c
      WHERE c.rent_request_id IS NOT NULL
      GROUP BY c.rent_request_id
    )
    SELECT NULL::uuid, rr.updated_at, ap.full_name, ap.phone, tp.full_name, rr.id,
           LEAST(pc.rev_amt, rr.amount_repaid - pc.live_amt),
           format('%s reversed rows worth %s; plan reads %s repaid on %s of real collections%s',
                  pc.rev_rows, round(pc.rev_amt), round(rr.amount_repaid), round(pc.live_amt),
                  CASE WHEN abs(rr.amount_repaid - (pc.live_amt + pc.rev_amt)) <= 1
                       THEN ' — exact live+reversed match, certain' ELSE '' END)
    FROM pc
    JOIN public.rent_requests rr ON rr.id = pc.rr_id
    LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    WHERE pc.rev_amt > 0 AND rr.amount_repaid > pc.live_amt
    ORDER BY LEAST(pc.rev_amt, rr.amount_repaid - pc.live_amt) DESC LIMIT v_lim;
    RETURN;
  END IF;

  IF p_check_key = 'plan_balance_unbacked' THEN
    RETURN QUERY
    WITH pc AS (
      SELECT c.rent_request_id AS rr_id,
             COALESCE(sum(c.amount) FILTER (
               WHERE c.reversed_at IS NULL
                 AND COALESCE(c.notes,'') NOT ILIKE '%[REVERSED:%'), 0) AS live_amt
      FROM public.agent_collections c
      WHERE c.rent_request_id IS NOT NULL
      GROUP BY c.rent_request_id
    ),
    prp AS (
      SELECT rp.rent_request_id AS rr_id, COALESCE(sum(rp.amount),0) AS rep_amt
      FROM public.repayments rp WHERE rp.rent_request_id IS NOT NULL GROUP BY rp.rent_request_id
    )
    SELECT NULL::uuid, rr.updated_at, ap.full_name, ap.phone, tp.full_name, rr.id,
           (rr.amount_repaid - COALESCE(pc.live_amt,0) - GREATEST(COALESCE(prp.rep_amt,0),0)),
           format('plan reads %s repaid; collections %s, repayments %s, status %s',
                  round(rr.amount_repaid), round(COALESCE(pc.live_amt,0)),
                  round(COALESCE(prp.rep_amt,0)), rr.status)
    FROM public.rent_requests rr
    LEFT JOIN pc ON pc.rr_id = rr.id
    LEFT JOIN prp ON prp.rr_id = rr.id
    LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    WHERE rr.amount_repaid > 0
      AND rr.updated_at >= v_since
      AND rr.amount_repaid - COALESCE(pc.live_amt,0) - GREATEST(COALESCE(prp.rep_amt,0),0) > 50000
    ORDER BY (rr.amount_repaid - COALESCE(pc.live_amt,0) - GREATEST(COALESCE(prp.rep_amt,0),0)) DESC
    LIMIT v_lim;
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
