-- Speed up the merchant float board polls.
--
-- get_merchant_float_positions was ~170ms warm / 32k buffer hits (pg_stat mean
-- 862ms). Two changes inside the same return shape:
--   * provider_evidence looked up gmail with transaction_id = reference_id, so
--     it hash-joined every gmail row and missed uq_gmail_tx_transaction_id
--     (lower(transaction_id)). The lateral lookup uses that index, then keeps
--     the old case-sensitive match.
--   * unbacked_walk materialized every float leg (~18k) and read them back.
--     The window is unchanged (legs before a claim at the same timestamp) but
--     only the claim rows are stored.
-- The freshen loop, auth checks, and every other figure are the live function.
--
-- get_merchant_payout_float summed public.wallets. That view left-joins every
-- physical wallet to the projection and then applies a CURRENT_USER gate this
-- definer never takes (~95ms). The same total is the positive projection
-- withdrawable of wallets that actually exist. A projection with no physical
-- wallet is not in the view, so the EXISTS stays.
--
-- Checked read-only on one snapshot against the live functions, nothing
-- written: positions(false) 16 rows and positions(true) 26 rows, EXCEPT both
-- ways empty; payout JSON identical, including computed_at.
--
-- Indexes are plain CREATE INDEX IF NOT EXISTS because a migration runs in a
-- transaction. On live, build the same names with CREATE INDEX CONCURRENTLY
-- first (especially general_ledger, and the write-hot wallet projection and
-- withdrawal_requests). IF NOT EXISTS then does nothing.

CREATE INDEX IF NOT EXISTS idx_gl_wallet_float_production_ref
  ON public.general_ledger (user_id)
  INCLUDE (amount, reference_id)
  WHERE ledger_scope = 'wallet'
    AND wallet_bucket = 'float'
    AND direction = 'cash_in'
    AND classification = 'production'
    AND reference_id IS NOT NULL
    AND reference_id <> '';

CREATE INDEX IF NOT EXISTS idx_wr_completed_momo_at
  ON public.withdrawal_requests ((COALESCE(processed_at, updated_at)))
  INCLUDE (id, amount, assigned_cashout_agent_id, processed_by)
  WHERE status = 'completed'
    AND payout_method = 'mobile_money';

CREATE INDEX IF NOT EXISTS idx_wr_claimed_unsettled_amount
  ON public.withdrawal_requests (amount)
  WHERE status NOT IN ('completed', 'rejected', 'cancelled', 'failed', 'reversed')
    AND (assigned_cashout_agent_id IS NOT NULL OR dispatch_claimed_by IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_wbp_positive_withdrawable
  ON public.wallet_balances_projection (user_id)
  INCLUDE (withdrawable)
  WHERE withdrawable > 0;

CREATE INDEX IF NOT EXISTS idx_gmail_out_momo_phone9
  ON public.gmail_transactions (
    (right(regexp_replace(COALESCE(counterparty, ''), '\D', '', 'g'), 9)),
    internal_date
  )
  INCLUDE (amount)
  WHERE direction = 'out'
    AND channel IN ('mtn_momo', 'airtel_money')
    AND amount IS NOT NULL;

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
    -- Only the claim rows are kept. The window still reads every leg; storing
    -- those legs and scanning them again was the slow part of this CTE.
    SELECT walked.desk_id,
           walked.advance_id,
           walked.shortfall_amount,
           walked.attested,
           walked.running
    FROM (
      SELECT e.desk_id,
             e.advance_id,
             e.shortfall_amount,
             e.attested,
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
               NULL::numeric AS shortfall_amount,
               false AS attested
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
               o.shortfall_amount,
               COALESCE(o.evidence ->> 'finance_attested', '') = 'true'
        FROM public.merchant_out_of_pocket_advances o
        JOIN desks d2 ON d2.agent_id = o.agent_id
        LEFT JOIN public.withdrawal_requests w2 ON w2.id = o.withdrawal_id
        WHERE o.status = 'pending_reimbursement'
          AND o.reimbursed_at IS NULL
      ) e
    ) walked
    WHERE walked.advance_id IS NOT NULL
  ),
  unbacked AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(w.shortfall_amount) FILTER (
             WHERE w.advance_id IS NOT NULL
               AND (COALESCE(w.running, 0) <= 0 OR w.attested) /* doc 229: exact zero still owed; finance-attested claims are owed whatever the books showed */
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
    -- Index lookup on uq_gmail_tx_transaction_id (lower(transaction_id)).
    -- Joining the found transaction_id back to reference_id keeps the old
    -- case-sensitive evidence test.
    JOIN LATERAL (
      SELECT t.transaction_id
      FROM public.gmail_transactions t
      WHERE t.transaction_id IS NOT NULL
        AND lower(t.transaction_id) = lower(g.reference_id)
      LIMIT 1
    ) hit ON hit.transaction_id = g.reference_id
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

-- CREATE OR REPLACE keeps the live ACL (postgres, authenticated, service_role).
GRANT EXECUTE ON FUNCTION public.get_merchant_float_positions(boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_merchant_payout_float()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_withdrawable numeric := 0;
  v_landlord_float numeric := 0;
  v_claimed numeric := 0;
  v_own jsonb;
BEGIN
  -- Same total as SUM(GREATEST(withdrawable_balance, 0)) FROM wallets.
  -- The view adds a physical/projection join and a staff gate this definer
  -- skips. Rows with no projection, or withdrawable <= 0, add nothing. A
  -- positive projection with no physical wallet is not in the view.
  SELECT COALESCE(SUM(p.withdrawable), 0) INTO v_withdrawable
  FROM public.wallet_balances_projection p
  WHERE p.withdrawable > 0
    AND EXISTS (
      SELECT 1 FROM public.wallets_physical w WHERE w.user_id = p.user_id
    );

  SELECT COALESCE(SUM(GREATEST(balance, 0)), 0) INTO v_landlord_float FROM public.agent_landlord_float;

  -- FIX (Phase 4): claims are stamped by `claim_withdrawal_verified` WITHOUT a
  -- status change, so filtering on approved/processing missed most of them and
  -- overstated available float. Any non-terminal claimed payout is committed
  -- money.
  SELECT COALESCE(SUM(amount), 0) INTO v_claimed
  FROM public.withdrawal_requests
  WHERE status NOT IN ('completed', 'rejected', 'cancelled', 'failed', 'reversed')
    AND (assigned_cashout_agent_id IS NOT NULL OR dispatch_claimed_by IS NOT NULL);

  v_own := public.get_merchant_float_position(auth.uid());

  RETURN jsonb_build_object(
    'withdrawable_total', v_withdrawable,
    'landlord_float_total', v_landlord_float,
    'claimed_unsettled_total', v_claimed,
    'available_float', GREATEST(v_withdrawable + v_landlord_float - v_claimed, 0),
    'own_float_balance', COALESCE((v_own->>'float_balance')::numeric, 0),
    'own_reserved_float', COALESCE((v_own->>'reserved_float')::numeric, 0),
    'own_available_float', COALESCE((v_own->>'available_float')::numeric, 0),
    'own_consumed_today', COALESCE((v_own->>'consumed_float_today')::numeric, 0),
    'own_out_of_pocket_outstanding', COALESCE((v_own->>'out_of_pocket_outstanding')::numeric, 0),
    'computed_at', now()
  );
END;
$function$;

-- CREATE OR REPLACE keeps the live ACL (postgres, authenticated, service_role).
GRANT EXECUTE ON FUNCTION public.get_merchant_payout_float() TO authenticated, service_role;
