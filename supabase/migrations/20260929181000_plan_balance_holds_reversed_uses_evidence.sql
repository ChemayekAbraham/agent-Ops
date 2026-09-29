-- "Plan balance still holds reversed money" now measures the thing it names.
--
-- The old test was: plan has any reversal AND amount_repaid > live collections
-- AND not reconciled — exposure LEAST(reversed, repaid − live). After the doc-161
-- correction all 11 plans it still flagged were false positives: legacy opening
-- balances and manual "mark as paid" edits (plan_balance_unbacked's territory)
-- on plans that also happen to carry a reversal that WAS taken back.
--
-- New test (same evidence doc 161's correction used): a reversed collection whose
-- amount provably landed in amount_repaid (rent_amount_change_log delta equal to
-- the amount within 5 s of the collection), per plan, minus every amount_repaid
-- decrease logged after the first reversal. Positive remainder = reversed money
-- still counted as paid. Any later decrease counts as a take-back, so this
-- errs toward silence; a hit is real.
--
-- plan_reversed_money_still_held() is shared by the check and its drill-down so
-- the two cannot drift. Scoped to reversed collections created since p_since.

CREATE OR REPLACE FUNCTION public.plan_reversed_money_still_held(p_since timestamptz)
RETURNS TABLE(rent_request_id uuid, held numeric, reversed_landed numeric, reversed_count bigint,
              later_decreases numeric, first_reversed_at timestamptz, last_collection_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH rc AS (
    SELECT c.id, c.rent_request_id, c.amount, c.created_at, c.reversed_at
      FROM public.agent_collections c
     WHERE c.reversed_at IS NOT NULL AND c.rent_request_id IS NOT NULL AND c.amount > 0
       AND c.created_at >= p_since
  ),
  lg AS (
    SELECT l.rent_request_id, l.changed_at,
           COALESCE(l.new_amount_repaid,0) - COALESCE(l.old_amount_repaid,0) AS delta
      FROM public.rent_amount_change_log l
     WHERE l.changed_at >= p_since - interval '1 minute'
       AND 'amount_repaid' = ANY (l.changed_fields)
       AND l.rent_request_id IN (SELECT rc.rent_request_id FROM rc)
  ),
  landed AS (
    SELECT rc.* FROM rc
     WHERE EXISTS (SELECT 1 FROM lg
                    WHERE lg.rent_request_id = rc.rent_request_id AND lg.delta = rc.amount
                      AND lg.changed_at BETWEEN rc.created_at - interval '5 seconds'
                                            AND rc.created_at + interval '5 seconds')
  ),
  per AS (
    SELECT landed.rent_request_id, sum(amount) AS landed_amt, count(*) AS n,
           min(reversed_at) AS first_rev, max(created_at) AS last_c
      FROM landed GROUP BY 1
  ),
  dec AS (
    SELECT per.rent_request_id,
           COALESCE(sum(-lg.delta) FILTER (WHERE lg.delta < 0
                    AND lg.changed_at >= per.first_rev - interval '1 minute'), 0) AS sys_dec
      FROM per LEFT JOIN lg ON lg.rent_request_id = per.rent_request_id GROUP BY 1
  )
  SELECT per.rent_request_id, per.landed_amt - dec.sys_dec, per.landed_amt, per.n, dec.sys_dec,
         per.first_rev, per.last_c
    FROM per JOIN dec USING (rent_request_id)
   WHERE per.landed_amt > dec.sys_dec;
$function$;

REVOKE ALL ON FUNCTION public.plan_reversed_money_still_held(timestamptz) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.plan_reversed_money_still_held(timestamptz) IS
'Per plan: reversed collections (since p_since) that provably raised amount_repaid, minus later logged decreases. Positive = reversed money still counted as paid. Used by agent_collections_monitor / _detail (doc 161).';

CREATE OR REPLACE FUNCTION public.agent_collections_monitor(p_days integer DEFAULT 14)
 RETURNS TABLE(check_key text, label text, severity text, hits bigint, exposure_ugx numeric, oldest timestamp with time zone, newest timestamp with time zone, guidance text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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

  SELECT 'collection_no_ledger_leg'::text AS check_key, 'Collection with no ledger entry'::text AS label,
         'critical'::text AS severity, count(*)::bigint AS hits, COALESCE(sum(c.amount),0) AS exposure_ugx,
         min(c.created_at) AS oldest, max(c.created_at) AS newest,
         'The collection exists but posted nothing. Replay the allocation for this plan.'::text AS guidance
  FROM public.agent_collections c
  WHERE c.created_at >= v_since AND c.reversed_at IS NULL AND c.amount > 0
    AND NOT EXISTS (SELECT 1 FROM public.general_ledger gl
                     WHERE gl.source_table='agent_collections' AND gl.source_id = c.rent_request_id)

  UNION ALL
  SELECT 'orphan_collection', 'Collection against a missing Rent Plan', 'critical',
         count(*)::bigint, COALESCE(sum(c.amount),0), min(c.created_at), max(c.created_at),
         'rent_request_id has no matching plan. The cash is real; the attribution is not.'
  FROM public.agent_collections c
  WHERE c.created_at >= v_since AND c.rent_request_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.id = c.rent_request_id)

  UNION ALL
  SELECT 'plan_overpaid', 'Tenant repaid more than the plan total', 'high',
         count(*)::bigint,
         COALESCE(sum(rr.amount_repaid - rr.total_repayment),0),
         min(rr.funded_at), max(rr.updated_at),
         'amount_repaid exceeds total_repayment. Refund or reallocate the excess.'
  FROM public.rent_requests rr
  WHERE COALESCE(rr.total_repayment,0) > 0
    AND COALESCE(rr.amount_repaid,0) > COALESCE(rr.total_repayment,0)

  UNION ALL
  SELECT 'reversed_still_counted', 'Reversed collections still countable', 'high',
         count(*)::bigint, COALESCE(sum(c.amount),0), min(c.created_at), max(c.created_at),
         'A reversed collection keeps its amount. Any SUM(amount) without a reversal filter overstates by this much.'
  FROM public.agent_collections c
  WHERE c.created_at >= v_since
    AND (c.reversed_at IS NOT NULL OR COALESCE(c.notes,'') ILIKE '%[REVERSED:%')

  UNION ALL
  SELECT 'plan_balance_holds_reversed', 'Plan balance still holds reversed money', 'high',
         count(*)::bigint, COALESCE(sum(h.held),0), min(h.first_reversed_at), max(h.last_collection_at),
         'A reversed collection raised amount_repaid and nothing took it back — the tenant reads as having paid it. Subtract it from amount_repaid (reopen the plan if it only reads completed because of it); the ledger already carries the reversal.'
  FROM public.plan_reversed_money_still_held(v_since) h

  UNION ALL
  SELECT 'negative_float', 'Agent float went negative', 'high',
         count(*)::bigint, COALESCE(sum(ABS(c.float_after)),0), min(c.created_at), max(c.created_at),
         'float_after is negative. An agent cannot spend float they do not have.'
  FROM public.agent_collections c
  WHERE c.created_at >= v_since AND c.float_after < 0

  UNION ALL
  SELECT 'collection_on_dead_plan', 'Collection on a cancelled or unfunded plan', 'medium',
         count(*)::bigint, COALESCE(sum(c.amount),0), min(c.created_at), max(c.created_at),
         'The plan is not repaying or completed. Check whether the plan was unwound after the cash came in.'
  FROM public.agent_collections c
  JOIN public.rent_requests rr ON rr.id = c.rent_request_id
  WHERE c.created_at >= v_since AND c.reversed_at IS NULL
    AND rr.status NOT IN ('repaying','completed')

  UNION ALL
  SELECT 'missing_commission', 'Collection with no commission leg', 'medium',
         count(*)::bigint, COALESCE(sum(c.amount),0), min(c.created_at), max(c.created_at),
         'No agent_commission_earned leg for this plan. Mostly tenant self-payments — confirm the collector was still paid.'
  FROM public.agent_collections c
  WHERE c.created_at >= v_since AND c.reversed_at IS NULL AND c.amount > 0
    AND NOT EXISTS (SELECT 1 FROM public.general_ledger gl
                     WHERE gl.ledger_scope='wallet' AND gl.category='agent_commission_earned'
                       AND gl.source_table='agent_collections' AND gl.source_id = c.rent_request_id)

  UNION ALL
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

CREATE OR REPLACE FUNCTION public.agent_collections_monitor_detail(p_check_key text, p_days integer DEFAULT 14, p_limit integer DEFAULT 100)
 RETURNS TABLE(collection_id uuid, occurred_at timestamp with time zone, agent_name text, agent_phone text, tenant_name text, rent_request_id uuid, amount numeric, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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

  IF p_check_key = 'plan_balance_holds_reversed' THEN
    RETURN QUERY
    SELECT NULL::uuid, h.last_collection_at, ap.full_name, ap.phone, tp.full_name, rr.id,
           h.held,
           format('%s reversed collections worth %s raised the balance; %s taken back since. Plan reads %s repaid of %s (%s)',
                  h.reversed_count, round(h.reversed_landed), round(h.later_decreases),
                  round(rr.amount_repaid), round(COALESCE(rr.total_repayment,0)), rr.status)
    FROM public.plan_reversed_money_still_held(v_since) h
    JOIN public.rent_requests rr ON rr.id = h.rent_request_id
    LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    ORDER BY h.held DESC LIMIT v_lim;
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
