-- Money-with-merchant-agents board: stop re-summing float once per claim.
--
-- get_merchant_float_positions was cancelled by the authenticated 8s
-- statement_timeout. Of 36 timeouts in the last day, 27 were inside
-- merchant_float_position_at while the unbacked CTE ran, and 9 were the
-- RETURN QUERY around that same step. The freshen loop is not involved
-- (about 6ms, no timeout stacks) and is left as it is.
--
-- unbacked used to call merchant_float_position_at once per pending
-- out-of-pocket advance (~507). That helper is STABLE SECURITY DEFINER,
-- so it is not inlined, and each call re-sums the desk's float legs
-- (~1,400 rows, ~439k buffer hits, 0.6s warm / 1.9s in the triage).
--
-- This rewrite keeps the same rule and does it once per agent:
--   sum of wallet/float legs with transaction_date <= payout time,
--   cash_in and credit positive, every other direction negative,
--   position <= 0 counts (doc 229, including exact zero).
-- Claims are walked in the same order as the legs. At a shared timestamp
-- the legs come first, which is the inclusive <= test. No earlier leg
-- reads as 0. Checked read-only on live: 507 pending advances, 0 position
-- mismatches against merchant_float_position_at, same 194 qualifying
-- claims, same unbacked total 520750. The ordered pass ran in 152ms
-- (12,429 buffers) versus 592ms / 439,521 buffers for the helper on a
-- warm cache.
--
-- A LATERAL lookup of the running balance was slower (1,188ms): the
-- materialized leg list has no index, so each advance re-sorted its rows.
-- merchant_float_position_at is unchanged for its other callers.
-- No statement_timeout change, global or on this function.
--
-- Covering index: the leg read is an index scan on
-- idx_general_ledger_user_wallet_bucket (user_id, wallet_bucket) then a
-- sort by transaction_date, id, with a heap fetch per leg. A hypothetical
-- index on (user_id, transaction_date, id) INCLUDE (amount, direction)
-- WHERE ledger_scope = 'wallet' AND wallet_bucket = 'float' is planned as
-- an Index Only Scan (cost 2.31 vs 9.35). Not built on live here.
-- CREATE INDEX takes a ShareLock on general_ledger for the build
-- (writes wait, reads do not). It is not CONCURRENTLY because this
-- migration runs in a transaction.

CREATE INDEX IF NOT EXISTS idx_gl_wallet_float_user_txdate
  ON public.general_ledger (user_id, transaction_date, id)
  INCLUDE (amount, direction)
  WHERE ledger_scope = 'wallet'
    AND wallet_bucket = 'float';

CREATE OR REPLACE FUNCTION public.get_merchant_float_positions(p_include_retired boolean DEFAULT false)
 RETURNS TABLE(desk_id uuid, agent_id uuid, agent_name text, agent_phone text, label text, is_active boolean, paid_out_total numeric, reimbursed_total numeric, float_credits_recorded numeric, email_matched_total numeric, adjustments_total numeric, owed_to_agent numeric, company_cash_with_agent numeric, ledger_float_held numeric, offledger_adjustments numeric, payouts_without_float_evidence numeric, last_payout_at timestamp with time zone, last_reimbursed_at timestamp with time zone, clamp_artifact_amount numeric, evidenced_amount numeric, asserted_only_amount numeric, clamped_shortfall_amount numeric, evidence_status text, is_stale boolean, stale_since timestamp with time zone, own_cash_under_review numeric, unattested_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_anchor date;
  v_is_finance boolean;
  v_agent_id uuid;
  v_prev_lock_timeout text;
BEGIN
  PERFORM public.assert_financial_ops_area('float');

  SELECT COALESCE(NULLIF(value, '')::date, '2026-08-01'::date) INTO v_anchor
  FROM public.treasury_controls WHERE control_key = 'merchant_float_anchor_date';
  v_anchor := COALESCE(v_anchor, '2026-08-01'::date);

  v_is_finance := public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.is_service_role_request();

  IF NOT v_is_finance THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Best-effort freshen: never wait on a row a background job is writing.
  v_prev_lock_timeout := current_setting('lock_timeout');
  PERFORM set_config('lock_timeout', '250ms', true);
  FOR v_agent_id IN
    SELECT ag.agent_id
    FROM (
      SELECT DISTINCT ca.agent_id
      FROM public.cashout_agents ca
      WHERE ca.agent_id IS NOT NULL
        AND (p_include_retired OR ca.is_active = true)
    ) ag
    LEFT JOIN public.wallet_balances_projection w ON w.user_id = ag.agent_id
    WHERE w.user_id IS NULL
       OR w.updated_at < COALESCE((
            SELECT MAX(g.created_at) FROM public.general_ledger g
            WHERE g.user_id = ag.agent_id AND g.ledger_scope = 'wallet'
          ), w.updated_at)
  LOOP
    BEGIN
      PERFORM public.refresh_wallet_projection_for(v_agent_id);
    EXCEPTION WHEN lock_not_available THEN
      -- Row busy: keep the stored projection; is_stale reports it below.
      NULL;
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', v_prev_lock_timeout, true);

  RETURN QUERY
  WITH desks AS (
    SELECT ca.id, ca.agent_id, ca.label, ca.is_active,
           COALESCE(p.full_name, '') AS full_name,
           COALESCE(p.phone, '') AS phone,
           right(regexp_replace(COALESCE(ca.float_phone, p.phone, ''), '\D', '', 'g'), 9) AS phone9
    FROM public.cashout_agents ca
    LEFT JOIN public.profiles p ON p.id = ca.agent_id
    WHERE (p_include_retired OR ca.is_active = true)
  ),
  recon AS (
    SELECT r.id, r.desk_id, r.adjustment_type, r.amount, r.evidence_note,
           EXISTS (
             SELECT 1 FROM public.general_ledger g
             WHERE g.source_table = 'merchant_float_reconciliations'
               AND g.source_id = r.id
           ) AS posted
    FROM public.merchant_float_reconciliations r
  ),
  attributed AS (
    SELECT w.id AS withdrawal_id,
           w.amount,
           COALESCE(w.processed_at, w.updated_at) AS at,
           COALESCE(
             w.assigned_cashout_agent_id,
             (SELECT d2.id FROM desks d2 WHERE d2.agent_id = w.processed_by ORDER BY d2.id LIMIT 1)
           ) AS desk_id
    FROM public.withdrawal_requests w
    WHERE w.status = 'completed'
      AND COALESCE(w.processed_at, w.updated_at) >= v_anchor
      AND w.payout_method = 'mobile_money'
  ),
  paid AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(a.amount), 0) AS total,
           MAX(a.at) AS last_at
    FROM desks d
    LEFT JOIN attributed a ON a.desk_id = d.id
    GROUP BY d.id
  ),
  float_credits AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(g.amount), 0) AS total,
           MAX(g.transaction_date) AS last_at
    FROM desks d
    LEFT JOIN public.general_ledger g
      ON g.user_id = d.agent_id
     AND g.wallet_bucket = 'float'
     AND g.direction = 'cash_in'
     AND g.category IN ('agent_float_deposit', 'agent_float_assignment')
     AND g.classification <> 'admin_correction'
     AND g.transaction_date >= v_anchor
    GROUP BY d.id
  ),
  emails AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(g.amount), 0) AS total,
           MAX(g.internal_date) AS last_at
    FROM desks d
    LEFT JOIN public.gmail_transactions g
      ON g.direction = 'out'
     AND g.channel IN ('mtn_momo', 'airtel_money')
     AND g.amount IS NOT NULL
     AND d.phone9 <> ''
     AND right(regexp_replace(COALESCE(g.counterparty, ''), '\D', '', 'g'), 9) = d.phone9
     AND g.internal_date >= v_anchor
    GROUP BY d.id
  ),
  adj AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(CASE WHEN r.adjustment_type = 'payout_correction' THEN -r.amount ELSE r.amount END), 0) AS total
    FROM desks d
    LEFT JOIN recon r ON r.desk_id = d.id AND NOT r.posted
    GROUP BY d.id
  ),
  held AS (
    SELECT d.id AS desk_id,
           COALESCE(GREATEST(wp.float_balance, 0), 0) AS ledger_float,
           COALESCE(wp.float_balance_raw, wp.float_balance, 0) AS net,
           GREATEST(0, -COALESCE(wp.float_balance_raw, 0)) AS clamped_shortfall,
           wp.updated_at AS stored_at,
           (SELECT MAX(g.created_at) FROM public.general_ledger g
             WHERE g.user_id = d.agent_id AND g.ledger_scope = 'wallet') AS last_leg_at
    FROM desks d
    LEFT JOIN public.wallet_balances_projection wp ON wp.user_id = d.agent_id
  ),
  unbacked_walk AS MATERIALIZED (
    -- One ordered pass per desk agent. A claim at time T sees every wallet
    -- float leg with transaction_date <= T: legs (kind 0) sort before the
    -- claim (kind 1) when the timestamps are equal. Sign matches
    -- merchant_float_position_at exactly (cash_in/credit add, every other
    -- direction subtracts, corrections included). If no leg is <= T, the position is 0.
    SELECT e.desk_id,
           e.advance_id,
           e.shortfall_amount,
           SUM(e.delta) OVER (
             PARTITION BY e.user_id
             ORDER BY e.ts, e.kind, e.leg_id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS running
    FROM (
      SELECT g.user_id,
             g.transaction_date AS ts,
             g.id AS leg_id,
             CASE WHEN g.direction IN ('cash_in', 'credit') THEN g.amount ELSE -g.amount END AS delta,
             0 AS kind,
             NULL::uuid AS desk_id,
             NULL::uuid AS advance_id,
             NULL::numeric AS shortfall_amount
      FROM public.general_ledger g
      WHERE g.ledger_scope = 'wallet'
        AND g.wallet_bucket = 'float'
        AND g.user_id IN (SELECT ds.agent_id FROM desks ds WHERE ds.agent_id IS NOT NULL)
      UNION ALL
      SELECT o.agent_id,
             COALESCE(w2.processed_at, w2.updated_at, o.created_at),
             NULL::uuid,
             NULL::numeric,
             1,
             d2.id,
             o.id,
             o.shortfall_amount
      FROM public.merchant_out_of_pocket_advances o
      JOIN desks d2 ON d2.agent_id = o.agent_id
      LEFT JOIN public.withdrawal_requests w2 ON w2.id = o.withdrawal_id
      WHERE o.status = 'pending_reimbursement'
        AND o.reimbursed_at IS NULL
    ) e
  ),
  unbacked AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(w.shortfall_amount) FILTER (
             WHERE w.advance_id IS NOT NULL
               AND COALESCE(w.running, 0) <= 0 /* doc 229: exact zero still owed */
           ), 0) AS total
    FROM desks d
    LEFT JOIN unbacked_walk w
      ON w.desk_id = d.id
     AND w.advance_id IS NOT NULL
    GROUP BY d.id
  ),
  under_review AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(o.shortfall_amount) FILTER (WHERE o.status = 'needs_review'), 0) AS total,
           COUNT(o.id) FILTER (
             WHERE o.status IN ('needs_review', 'pending_reimbursement')
               AND o.attested_at IS NULL
           ) AS unattested
    FROM desks d
    LEFT JOIN public.merchant_out_of_pocket_advances o
      ON o.agent_id = d.agent_id
     AND o.reimbursed_at IS NULL
    GROUP BY d.id
  ),
  provider_evidence AS (
    SELECT d.id AS desk_id, COALESCE(SUM(g.amount), 0) AS total
    FROM desks d
    JOIN public.general_ledger g
      ON g.user_id = d.agent_id
     AND g.ledger_scope = 'wallet'
     AND g.wallet_bucket = 'float'
     AND g.direction = 'cash_in'
     AND g.classification = 'production'
     AND g.reference_id IS NOT NULL
     AND g.reference_id <> ''
    WHERE EXISTS (
      SELECT 1 FROM public.gmail_transactions t
      WHERE t.transaction_id = g.reference_id
    )
    GROUP BY d.id
  ),
  cfo_evidence AS (
    SELECT r.desk_id AS ev_desk_id, TRUE AS confirmed
    FROM recon r
    WHERE r.posted AND char_length(COALESCE(r.evidence_note, '')) >= 20
    GROUP BY r.desk_id
    UNION
    SELECT (a.metadata->>'desk_id')::uuid AS ev_desk_id, TRUE
    FROM public.audit_logs a
    WHERE a.action_type = 'merchant_desk_float_set'
      AND a.metadata ? 'desk_id'
      AND char_length(COALESCE(a.metadata->>'evidence', '')) >= 20
    GROUP BY 1
  ),
  cfo_evidence_agg AS (
    SELECT ce.ev_desk_id, bool_or(ce.confirmed) AS confirmed
    FROM cfo_evidence ce
    GROUP BY ce.ev_desk_id
  ),
  evidence AS (
    SELECT h.desk_id AS ev_desk_id,
           LEAST(h.ledger_float, GREATEST(0, h.ledger_float - h.net)) AS clamp_artifact,
           GREATEST(0, LEAST(h.ledger_float, h.net)) AS supportable,
           CASE WHEN cea.confirmed THEN GREATEST(0, LEAST(h.ledger_float, h.net))
                ELSE COALESCE(pe.total, 0) END AS provider_total,
           h.clamped_shortfall
    FROM held h
    LEFT JOIN provider_evidence pe ON pe.desk_id = h.desk_id
    LEFT JOIN cfo_evidence_agg cea ON cea.ev_desk_id = h.desk_id
  ),
  evidence_split AS (
    SELECT e.ev_desk_id,
           e.clamp_artifact,
           LEAST(e.provider_total, e.supportable) AS evidenced,
           GREATEST(0, e.supportable - LEAST(e.provider_total, e.supportable)) AS asserted_only,
           e.clamped_shortfall
    FROM evidence e
  )
  SELECT d.id, d.agent_id, d.full_name, d.phone, d.label, d.is_active,
         pd.total, fc.total + aj.total, fc.total, em.total, aj.total,
         GREATEST(0, -hd.net) + ub.total,
         GREATEST(0, hd.net),
         hd.ledger_float,
         aj.total, ub.total,
         pd.last_at, GREATEST(fc.last_at, em.last_at),
         es.clamp_artifact, es.evidenced, es.asserted_only, es.clamped_shortfall,
         CASE
           WHEN (CASE WHEN es.clamp_artifact > 0 THEN 1 ELSE 0 END
               + CASE WHEN es.evidenced > 0 THEN 1 ELSE 0 END
               + CASE WHEN es.asserted_only > 0 THEN 1 ELSE 0 END) > 1 THEN 'mixed'
           WHEN es.asserted_only > 0 THEN 'asserted_only'
           WHEN es.clamp_artifact > 0 THEN 'clamp_artifact'
           ELSE 'evidenced'
         END::text,
         (hd.last_leg_at IS NOT NULL AND (hd.stored_at IS NULL OR hd.stored_at < hd.last_leg_at)),
         hd.stored_at,
         ur.total,
         ur.unattested
  FROM desks d
  JOIN paid pd ON pd.desk_id = d.id
  JOIN float_credits fc ON fc.desk_id = d.id
  JOIN emails em ON em.desk_id = d.id
  JOIN adj aj ON aj.desk_id = d.id
  JOIN held hd ON hd.desk_id = d.id
  JOIN unbacked ub ON ub.desk_id = d.id
  JOIN under_review ur ON ur.desk_id = d.id
  JOIN evidence_split es ON es.ev_desk_id = d.id
  ORDER BY hd.ledger_float DESC, (GREATEST(0, -hd.net) + ub.total + ur.total) DESC;
END;
$function$;

-- CREATE OR REPLACE keeps the live grants. Re-affirm the finance callers.
-- anon and PUBLIC stay revoked (live proacl: postgres, authenticated, service_role).
GRANT EXECUTE ON FUNCTION public.get_merchant_float_positions(boolean) TO authenticated, service_role;
