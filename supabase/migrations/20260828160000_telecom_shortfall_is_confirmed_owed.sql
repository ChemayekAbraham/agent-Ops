-- Telecom-charge shortfalls are deterministic platform debt, not an estimate to
-- distrust. The telecom sending fee is not looked up externally — it's the
-- company's OWN fixed tier schedule (getTelecomSendingCharge / 100-2,000 UGX),
-- reserved against float in the exact same breath as the payout principal
-- (reserve_merchant_float: v_need := amount + telecom). When float covers it,
-- that computed figure is deducted from float without question. The evidence
-- gate previously required a `telecom_charge_ref` before a telecom shortfall
-- could count as confirmed owed (`is_estimate` in v_merchant_oop_evidence) —
-- appropriate caution for a shortfall figure the ledger truly cannot verify on
-- its own, but wrong for telecom specifically: there is nothing to verify
-- against, since the company itself set the number. Requiring a reference that
-- (per production data) never gets attached left 1,445 legitimate telecom
-- shortfalls (UGX 1,016,600) stuck in `needs_review` indefinitely, while the
-- comparable `payout` (principal) shortfalls -- which DO warrant a human
-- judgment call, since a missing float credit or timing issue could produce a
-- false reading -- are untouched by this change.
--
-- This migration: (1) stops `is_estimate` from suppressing `is_evidenced` for
-- telecom-kind claims (the column itself is left in place, still informational
-- for `get_merchant_out_of_pocket_summary`'s estimated_telecom_total figure);
-- (2) auto-confirms telecom shortfalls at file time going forward (see the
-- companion `approve-withdrawal` edge function change); (3) backfills the
-- existing needs_review backlog.

CREATE OR REPLACE VIEW public.v_merchant_oop_evidence
WITH (security_invoker = true) AS
SELECT
  o.id AS advance_id,
  o.agent_id,
  o.withdrawal_id,
  o.kind,
  o.status,
  o.shortfall_amount,
  o.payout_amount,
  o.telecom_charge,
  o.float_used,
  o.note,
  o.evidence,
  o.created_at,
  o.attested_at,
  o.reviewed_at,
  o.reimbursed_at,
  COALESCE(w.processed_at, w.updated_at, o.created_at) AS payout_at,
  w.transaction_id AS payout_tid,
  COALESCE(w.mobile_money_name, w.bank_account_name, p.full_name) AS recipient_name,
  COALESCE(w.mobile_money_number, w.bank_account_number, p.phone) AS recipient_phone,
  w.mobile_money_provider AS provider,
  w.amount AS withdrawal_amount,
  public.merchant_float_position_at(o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)) AS float_position_at_payout,
  -- Informational only from here on: still true when no telecom_charge_ref is
  -- attached, but no longer subtracted from is_evidenced (see note above).
  (o.kind = 'telecom' AND COALESCE(o.evidence ->> 'telecom_charge_ref', '') = '') AS is_estimate,
  (public.merchant_float_position_at(o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)) < 0::numeric) AS is_evidenced,
  LEAST(o.shortfall_amount, GREATEST(0::numeric, -public.merchant_float_position_at(o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)))) AS evidenced_amount
FROM public.merchant_out_of_pocket_advances o
LEFT JOIN public.withdrawal_requests w ON w.id = o.withdrawal_id
LEFT JOIN public.profiles p ON p.id = w.user_id;

CREATE OR REPLACE FUNCTION public.get_merchant_oop_evidenced_owed(p_agent_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(
           LEAST(o.shortfall_amount,
                 GREATEST(0, -public.merchant_float_position_at(
                   o.agent_id,
                   COALESCE(w.processed_at, w.updated_at, o.created_at))))
         ), 0)
  FROM public.merchant_out_of_pocket_advances o
  LEFT JOIN public.withdrawal_requests w ON w.id = o.withdrawal_id
  WHERE o.agent_id = p_agent_id
    AND o.status = 'pending_reimbursement'
    AND o.reimbursed_at IS NULL
    AND public.merchant_float_position_at(
          o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)) < 0;
$function$;

-- get_merchant_float_positions's `unbacked` CTE carried the identical inline
-- exclusion. Reproduce the function with only that one clause removed.
CREATE OR REPLACE FUNCTION public.get_merchant_float_positions(p_include_retired boolean DEFAULT false)
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
    OR public.has_role(auth.uid(), 'coo')
    OR public.is_service_role_request();

  IF NOT v_is_finance THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

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
  unbacked AS (
    -- Telecom-kind shortfalls no longer require a telecom_charge_ref before
    -- counting here -- see migration header note.
    SELECT d.id AS desk_id,
           COALESCE(SUM(o.shortfall_amount), 0) AS total
    FROM desks d
    LEFT JOIN public.merchant_out_of_pocket_advances o
      ON o.agent_id = d.agent_id
     AND o.status = 'pending_reimbursement'
     AND o.reimbursed_at IS NULL
     AND public.merchant_float_position_at(
           o.agent_id,
           COALESCE(
             (SELECT COALESCE(w2.processed_at, w2.updated_at)
                FROM public.withdrawal_requests w2 WHERE w2.id = o.withdrawal_id),
             o.created_at)) < 0
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

-- Backfill: the 1,445 telecom-kind rows stuck in needs_review purely for lack
-- of a telecom_charge_ref are, under the corrected rule, already-confirmed
-- debt -- the point-in-time float-deficit check below re-verifies each one
-- individually rather than promoting the whole backlog blind.
UPDATE public.merchant_out_of_pocket_advances o
SET status = 'pending_reimbursement',
    reviewed_at = now(),
    review_note = 'Auto-confirmed 2026-08-28: telecom sending charge is a fixed platform fee tier (not independently disputable), reserved against float in the same breath as the payout principal. See mem/constraints/merchant-owed-point-in-time-evidence.md.'
WHERE o.status = 'needs_review'
  AND o.kind = 'telecom'
  AND o.reimbursed_at IS NULL
  AND public.merchant_float_position_at(
        o.agent_id,
        COALESCE(
          (SELECT COALESCE(w.processed_at, w.updated_at) FROM public.withdrawal_requests w WHERE w.id = o.withdrawal_id),
          o.created_at)) < 0;
