-- =====================================================================
-- Merchant float: correct the owed figures from the ledger (19 Aug 2026)
-- No wallet writes, no general_ledger writes. Display/classification only.
-- =====================================================================

-- 1. Revert auto-promoted out-of-pocket claims that the books do not support.
--    Ledger test: the desk's float must be negative (own money advanced and
--    not yet returned) for a claim to remain payable.
WITH unsupported AS (
  SELECT a.id
  FROM public.merchant_out_of_pocket_advances a
  LEFT JOIN public.wallet_balances_projection wp ON wp.user_id = a.agent_id
  WHERE a.status = 'pending_reimbursement'
    AND a.reimbursed_at IS NULL
    AND COALESCE(wp.float_balance_raw, 0) >= 0
), upd AS (
  UPDATE public.merchant_out_of_pocket_advances a
  SET status = 'needs_review',
      note = COALESCE(a.note, '') ||
        ' | Ledger correction 2026-08-19: returned to review. The books show this desk is not holding a negative float, so no unreturned own money is evidenced. Not payable until re-confirmed.',
      updated_at = now()
  FROM unsupported u
  WHERE a.id = u.id
  RETURNING a.id, a.agent_id, a.shortfall_amount
)
INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, metadata)
SELECT 'merchant_oop_ledger_correction', 'merchant_out_of_pocket_advances', upd.id::text,
       'Ledger truth correction: desk float not negative, claim not payable',
       jsonb_build_object('agent_id', upd.agent_id, 'shortfall_amount', upd.shortfall_amount,
                          'corrected_on', '2026-08-19', 'previous_status', 'pending_reimbursement')
FROM upd;

-- 2. Rebuild the position RPC so owed is ledger-derived.
CREATE OR REPLACE FUNCTION public.get_merchant_float_positions()
 RETURNS TABLE(desk_id uuid, agent_id uuid, agent_name text, agent_phone text, label text, is_active boolean, paid_out_total numeric, reimbursed_total numeric, float_credits_recorded numeric, email_matched_total numeric, adjustments_total numeric, owed_to_agent numeric, company_cash_with_agent numeric, ledger_float_held numeric, offledger_adjustments numeric, payouts_without_float_evidence numeric, last_payout_at timestamp with time zone, last_reimbursed_at timestamp with time zone, clamp_artifact_amount numeric, evidenced_amount numeric, asserted_only_amount numeric, clamped_shortfall_amount numeric, evidence_status text, is_stale boolean, stale_since timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_anchor date;
  v_is_finance boolean;
  v_agent_id uuid;
BEGIN
  SELECT COALESCE(NULLIF(value, '')::date, '2026-08-01'::date) INTO v_anchor
  FROM public.treasury_controls WHERE control_key = 'merchant_float_anchor_date';
  v_anchor := COALESCE(v_anchor, '2026-08-01'::date);

  v_is_finance := public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo');

  IF NOT v_is_finance THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  FOR v_agent_id IN
    SELECT ag.agent_id
    FROM (SELECT DISTINCT ca.agent_id FROM public.cashout_agents ca WHERE ca.agent_id IS NOT NULL) ag
    LEFT JOIN public.wallet_balances_projection w ON w.user_id = ag.agent_id
    WHERE w.user_id IS NULL
       OR w.updated_at < COALESCE((
            SELECT MAX(g.created_at) FROM public.general_ledger g
            WHERE g.user_id = ag.agent_id AND g.ledger_scope = 'wallet'
          ), w.updated_at)
  LOOP
    PERFORM public.refresh_wallet_projection_for(v_agent_id);
  END LOOP;

  RETURN QUERY
  WITH desks AS (
    SELECT ca.id, ca.agent_id, ca.label, ca.is_active,
           COALESCE(p.full_name, '') AS full_name,
           COALESCE(p.phone, '') AS phone,
           right(regexp_replace(COALESCE(ca.float_phone, p.phone, ''), '\D', '', 'g'), 9) AS phone9
    FROM public.cashout_agents ca
    LEFT JOIN public.profiles p ON p.id = ca.agent_id
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
  -- Each completed MOBILE MONEY payout is attributed to exactly ONE desk:
  -- the assigned desk when present, otherwise the processing agent's desk.
  -- Bank transfers never consume a merchant's phone float.
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
  -- Only claims a merchant or Financial Ops actually confirmed count as
  -- unbacked exposure. Auto-classified rows are evidence, not debt.
  unbacked AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(o.shortfall_amount), 0) AS total
    FROM desks d
    LEFT JOIN public.merchant_out_of_pocket_advances o
      ON o.agent_id = d.agent_id
     AND o.status = 'pending_reimbursement'
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
         -- LEDGER TRUTH: an agent is owed money only when the books show
         -- their float below zero (own money advanced, not yet returned),
         -- plus any claim they or Financial Ops explicitly confirmed.
         GREATEST(0, -hd.net) + ub.total,
         GREATEST(0, hd.net),
         hd.ledger_float,
         hd.net,
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
         hd.stored_at
  FROM desks d
  JOIN paid pd ON pd.desk_id = d.id
  JOIN float_credits fc ON fc.desk_id = d.id
  JOIN emails em ON em.desk_id = d.id
  JOIN adj aj ON aj.desk_id = d.id
  JOIN held hd ON hd.desk_id = d.id
  JOIN unbacked ub ON ub.desk_id = d.id
  JOIN evidence_split es ON es.ev_desk_id = d.id
  ORDER BY hd.ledger_float DESC, (GREATEST(0, -hd.net) + ub.total) DESC;
END;
$function$;