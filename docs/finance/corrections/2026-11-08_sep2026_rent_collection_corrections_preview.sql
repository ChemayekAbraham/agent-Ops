-- READ-ONLY PREVIEW of batch acct_corr_202611 (same selection rules as the posting script, CTEs only; safe in a
-- READ ONLY transaction). One row per correction line: k = item, v = JSON detail. Field rulings are not applied here.
WITH fd AS (SELECT NULL::uuid AS receipt_id, NULL::text AS decision WHERE false),
rcpt AS (
  -- Receipts still marked genuine on Rent Plans collected above their total, plus any receipt the field team ruled
  -- 'not_received'. Evidence: E1 mobile-money/deposit, E2 agent float or wallet debited for it, E3 cash-in-transit only.
  SELECT ac.id, ac.rent_request_id AS rid, ac.agent_id, ac.amount, ac.created_at, ac.tracking_id,
         rr.total_repayment AS tot, pl.live,
         (ac.momo_transaction_id IS NOT NULL OR ac.deposit_request_id IS NOT NULL) AS e1,
         EXISTS (SELECT 1 FROM public.general_ledger g
                  WHERE g.source_table = 'agent_collections' AND g.source_id IN (ac.id, ac.rent_request_id)
                    AND g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
                    AND g.category IN ('agent_float_used_for_rent', 'rent_payment_for_tenant', 'tenant_repayment')
                    AND abs(g.amount - ac.amount) < 1
                    AND g.created_at BETWEEN ac.created_at - interval '3 seconds' AND ac.created_at + interval '3 seconds') AS e2,
         a5.id AS a5_leg, a5.transaction_group_id AS a5_group, a5.transaction_date AS a5_date, a3.id AS a3_leg,
         EXISTS (SELECT 1 FROM public.rent_amount_change_log c
                  WHERE c.rent_request_id = ac.rent_request_id
                    AND c.changed_at BETWEEN ac.created_at - interval '5 seconds' AND ac.created_at + interval '5 seconds'
                    AND c.new_amount_repaid - c.old_amount_repaid = ac.amount) AS landed,
         fd.decision
  FROM public.agent_collections ac
  JOIN (SELECT x.rent_request_id, sum(x.amount) AS live FROM public.agent_collections x
         WHERE x.reversed_at IS NULL AND x.rent_request_id IS NOT NULL GROUP BY 1) pl ON pl.rent_request_id = ac.rent_request_id
  JOIN public.rent_requests rr ON rr.id = ac.rent_request_id
  LEFT JOIN LATERAL (SELECT g.id, g.transaction_group_id, g.transaction_date FROM public.general_ledger g
       WHERE g.source_table = 'agent_collections' AND g.source_id IN (ac.id, ac.rent_request_id) AND g.ledger_scope = 'platform'
         AND g.category = 'cash_receipt_in_transit' AND g.direction = 'cash_in' AND abs(g.amount - ac.amount) < 1
         AND g.created_at BETWEEN ac.created_at - interval '3 seconds' AND ac.created_at + interval '3 seconds'
       ORDER BY abs(extract(epoch FROM g.created_at - ac.created_at)), g.id LIMIT 1) a5 ON true
  LEFT JOIN LATERAL (SELECT g.id FROM public.general_ledger g
       WHERE g.source_table = 'agent_collections' AND g.source_id IN (ac.id, ac.rent_request_id) AND g.ledger_scope = 'platform'
         AND g.category = 'tenant_repayment_collected' AND g.direction = 'cash_out' AND abs(g.amount - ac.amount) < 1
         AND g.created_at BETWEEN ac.created_at - interval '3 seconds' AND ac.created_at + interval '3 seconds'
       ORDER BY abs(extract(epoch FROM g.created_at - ac.created_at)), g.id LIMIT 1) a3 ON true
  LEFT JOIN fd ON fd.receipt_id = ac.id
  WHERE ac.reversed_at IS NULL
    AND ((rr.total_repayment > 0 AND pl.live > rr.total_repayment + 1) OR fd.decision = 'not_received')
),
b AS (
  -- Unsupported receipts to contra. A receipt ruled 'not_received' is taken in full. Otherwise only an over-collected
  -- Rent Plan's excess (receipts - total) is taken, from E3 receipts only (never E1/E2, never one ruled 'received'),
  -- balance-landed receipts first, newest first, so the receipts the tenant credit (item A) rests on are taken last.
  SELECT q.*,
         CASE WHEN q.decision = 'not_received' THEN q.amount
              ELSE LEAST(q.amount, GREATEST(0, GREATEST(q.live - q.tot, q.rejected) - (q.cum - q.amount))) END AS take
  FROM (SELECT r.*,
               sum(r.amount) OVER (PARTITION BY r.rid ORDER BY (r.decision = 'not_received') DESC NULLS LAST, r.landed DESC,
                                   r.created_at DESC, r.id) AS cum,
               COALESCE(sum(r.amount) FILTER (WHERE r.decision = 'not_received') OVER (PARTITION BY r.rid), 0) AS rejected
        FROM rcpt r
        WHERE NOT r.e1 AND NOT r.e2 AND r.a5_leg IS NOT NULL AND r.a3_leg IS NOT NULL
          AND COALESCE(r.decision, '') <> 'received') q
),
a AS (
  -- Tenants on the 29 Sep clean-up list whose balance is below their genuine receipts (after item B), capped at the
  -- Rent Plan total. Only receipts the guard dropped (15-16 Sep, balance never moved) can explain the credit.
  SELECT rr.id AS rid, rr.tenant_id, rr.amount_repaid AS before, rr.total_repayment AS tot, rr.status,
         pl.live, COALESCE(bt.b, 0) AS b_taken,
         LEAST(pl.live - COALESCE(bt.b, 0), rr.total_repayment) - rr.amount_repaid AS credit,
         COALESCE(un.unlanded_amount, 0) AS unlanded_amount, un.receipts
  FROM public.plan_balance_duplicate_correction_20260929 k
  JOIN public.rent_requests rr ON rr.id = k.rent_request_id
  JOIN (SELECT x.rent_request_id, sum(x.amount) AS live FROM public.agent_collections x
         WHERE x.reversed_at IS NULL AND x.rent_request_id IS NOT NULL GROUP BY 1) pl ON pl.rent_request_id = rr.id
  LEFT JOIN (SELECT b.rid, sum(b.take) AS b FROM b GROUP BY 1) bt ON bt.rid = rr.id
  LEFT JOIN LATERAL (
    SELECT sum(u.amount - COALESCE(bb.take, 0)) AS unlanded_amount,
           jsonb_agg(jsonb_build_object('receipt_id', u.id, 'tracking_id', u.tracking_id, 'amount', u.amount,
                       'recorded_at', u.created_at, 'contra_by_item_b', COALESCE(bb.take, 0),
                       'a5_leg', (SELECT g.id FROM public.general_ledger g WHERE g.source_table = 'agent_collections'
                                    AND g.source_id IN (u.id, u.rent_request_id) AND g.ledger_scope = 'platform'
                                    AND g.category = 'cash_receipt_in_transit' AND g.direction = 'cash_in' AND abs(g.amount - u.amount) < 1
                                    AND g.created_at BETWEEN u.created_at - interval '3 seconds' AND u.created_at + interval '3 seconds'
                                  ORDER BY abs(extract(epoch FROM g.created_at - u.created_at)), g.id LIMIT 1),
                       'a3_leg', (SELECT g.id FROM public.general_ledger g WHERE g.source_table = 'agent_collections'
                                    AND g.source_id IN (u.id, u.rent_request_id) AND g.ledger_scope = 'platform'
                                    AND g.category = 'tenant_repayment_collected' AND g.direction = 'cash_out' AND abs(g.amount - u.amount) < 1
                                    AND g.created_at BETWEEN u.created_at - interval '3 seconds' AND u.created_at + interval '3 seconds'
                                  ORDER BY abs(extract(epoch FROM g.created_at - u.created_at)), g.id LIMIT 1))
                     ORDER BY u.created_at) AS receipts
    FROM public.agent_collections u LEFT JOIN b bb ON bb.id = u.id
    WHERE u.rent_request_id = rr.id AND u.reversed_at IS NULL
      AND u.created_at BETWEEN TIMESTAMPTZ '2026-09-15 15:12:23+00' AND TIMESTAMPTZ '2026-09-16 06:03:51+00'
      AND NOT EXISTS (SELECT 1 FROM public.rent_amount_change_log c
                       WHERE c.rent_request_id = u.rent_request_id
                         AND c.changed_at BETWEEN u.created_at - interval '5 seconds' AND u.created_at + interval '5 seconds'
                         AND c.new_amount_repaid - c.old_amount_repaid = u.amount)
  ) un ON true
  WHERE LEAST(pl.live - COALESCE(bt.b, 0), rr.total_repayment) > rr.amount_repaid
),
c2 AS (
  -- Older-path fee postings above the Rent Plan fee: each non-reversed allocation's correct fee is the fee share of the
  -- cash inside the total it added (cumulative capped at the basis total); the excess is reversed and the correct fee rebooked.
  SELECT q.*, (q.rf - q.rf_ok) + (q.af - q.af_ok) AS excess
  FROM (SELECT la.id AS alloc, la.rent_request_id AS rid, la.source_table, la.source_id, la.transaction_group_id AS grp,
               la.instalment_amount, la.cum, la.bt, la.registration_fee_component AS rf, la.access_fee_component AS af,
               (SELECT c.registration_fee_component FROM public.compute_instalment_allocation(la.rent_request_id, LEAST(la.cum, la.bt)) c)
                 - COALESCE((SELECT c.registration_fee_component FROM public.compute_instalment_allocation(la.rent_request_id, LEAST(la.cum - la.instalment_amount, la.bt)) c), 0) AS rf_ok,
               (SELECT c.access_fee_component FROM public.compute_instalment_allocation(la.rent_request_id, LEAST(la.cum, la.bt)) c)
                 - COALESCE((SELECT c.access_fee_component FROM public.compute_instalment_allocation(la.rent_request_id, LEAST(la.cum - la.instalment_amount, la.bt)) c), 0) AS af_ok
        FROM (SELECT ia.*, sum(ia.instalment_amount) OVER (PARTITION BY ia.rent_request_id ORDER BY ia.created_at, ia.id) AS cum,
                     (SELECT c.basis_total FROM public.compute_instalment_allocation(ia.rent_request_id, 1) c) AS bt
              FROM public.instalment_allocations ia
              WHERE ia.reversed_at IS NULL AND COALESCE(ia.split_version, '') <> 'four_part_v1') la
        WHERE la.cum > la.bt AND la.transaction_group_id IS NOT NULL) q
  WHERE (q.rf - q.rf_ok) + (q.af - q.af_ok) > 0
),
c3 AS (
  -- Allocations whose collection was reversed but whose fee posting never was.
  SELECT ia.id AS alloc, ia.rent_request_id AS rid, ia.source_table, ia.source_id, ia.transaction_group_id AS grp,
         ia.registration_fee_component + ia.access_fee_component AS fees, ia.reversed_at, ia.reversal_reason
  FROM public.instalment_allocations ia
  WHERE ia.reversed_at IS NOT NULL AND ia.reversal_group_id IS NULL AND ia.transaction_group_id IS NOT NULL
)
SELECT 'A' AS k, jsonb_build_object('rent_plan', a.rid, 'tenant_id', a.tenant_id, 'status', a.status, 'total', a.tot, 'repaid_before', a.before,
         'credit', a.credit, 'repaid_after', a.before + a.credit, 'receipts_marked_genuine', a.live, 'contra_by_item_b', a.b_taken,
         'dropped_receipts_amount', a.unlanded_amount, 'receipts', a.receipts)::text AS v FROM a
UNION ALL
SELECT 'B', jsonb_build_object('receipt_id', b.id, 'rent_plan', b.rid, 'agent_id', b.agent_id, 'tracking_id', b.tracking_id, 'recorded_at', b.created_at,
         'amount', b.amount, 'contra', b.take, 'plan_total', b.tot, 'plan_receipts', b.live, 'landed', b.landed,
         'a5_leg', b.a5_leg, 'a3_leg', b.a3_leg, 'original_group', b.a5_group, 'original_date', b.a5_date)::text FROM b WHERE b.take > 0
UNION ALL
SELECT 'B-plan', jsonb_build_object('rent_plan', r.rid, 'total', max(r.tot), 'receipts', max(r.live), 'excess', max(r.live) - max(r.tot),
         'e1', sum(r.amount) FILTER (WHERE r.e1), 'e2', sum(r.amount) FILTER (WHERE NOT r.e1 AND r.e2),
         'e3', sum(r.amount) FILTER (WHERE NOT r.e1 AND NOT r.e2 AND r.a5_leg IS NOT NULL AND r.a3_leg IS NOT NULL),
         'other', sum(r.amount) FILTER (WHERE NOT r.e1 AND NOT r.e2 AND (r.a5_leg IS NULL OR r.a3_leg IS NULL)),
         'contra', (SELECT coalesce(sum(b.take), 0) FROM b WHERE b.rid = r.rid))::text FROM rcpt r GROUP BY r.rid
UNION ALL
SELECT 'C2', jsonb_build_object('allocation', c2.alloc, 'rent_plan', c2.rid, 'collection_id', c2.source_id, 'original_group', c2.grp,
         'instalment', c2.instalment_amount, 'cumulative', c2.cum, 'basis_total', c2.bt, 'rf', c2.rf, 'af', c2.af,
         'rf_ok', c2.rf_ok, 'af_ok', c2.af_ok, 'excess', c2.excess,
         'legs', (SELECT jsonb_agg(jsonb_build_object('id', g.id, 'category', g.category, 'direction', g.direction, 'amount', g.amount, 'date', g.transaction_date))
                  FROM public.general_ledger g WHERE g.transaction_group_id = c2.grp))::text FROM c2
UNION ALL
SELECT 'C3', jsonb_build_object('allocation', c3.alloc, 'rent_plan', c3.rid, 'collection_id', c3.source_id, 'original_group', c3.grp, 'fees', c3.fees,
         'collection_reversed_at', c3.reversed_at,
         'collection_note', (SELECT left(ac.notes, 160) FROM public.agent_collections ac WHERE ac.id = c3.source_id),
         'legs', (SELECT jsonb_agg(jsonb_build_object('id', g.id, 'category', g.category, 'direction', g.direction, 'amount', g.amount, 'date', g.transaction_date))
                  FROM public.general_ledger g WHERE g.transaction_group_id = c3.grp))::text FROM c3;
