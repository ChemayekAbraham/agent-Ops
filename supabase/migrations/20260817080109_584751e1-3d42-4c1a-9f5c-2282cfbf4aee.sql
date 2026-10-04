-- 1. Stop mislabelling real ledger-posted corrections as display-only.
CREATE OR REPLACE FUNCTION public.stamp_merchant_reconciliation_truth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_stored numeric := 0;
  v_ledger numeric := 0;
BEGIN
  -- Only assume display_only when the caller did not declare a real ledger post.
  IF COALESCE(NEW.ledger_effect, '') <> 'ledger_posted' THEN
    NEW.ledger_effect := 'display_only';
  END IF;

  IF NEW.agent_id IS NOT NULL THEN
    SELECT COALESCE(GREATEST(float_balance, 0), 0) INTO v_stored
    FROM public.wallets WHERE user_id = NEW.agent_id;
    v_ledger := public.merchant_ledger_float(NEW.agent_id);
  END IF;

  NEW.stored_float_at_post := COALESCE(v_stored, 0);
  NEW.ledger_float_at_post := COALESCE(v_ledger, 0);
  NEW.variance_at_post := COALESCE(v_stored, 0) - COALESCE(v_ledger, 0);
  RETURN NEW;
END;
$function$;

-- 2. Float board: derive "posted vs display-only" from the ledger itself, so
-- historically mislabelled rows are treated correctly and never double counted.
CREATE OR REPLACE FUNCTION public.get_merchant_float_positions()
RETURNS TABLE(
  desk_id uuid, agent_id uuid, agent_name text, agent_phone text, label text, is_active boolean,
  paid_out_total numeric, reimbursed_total numeric, float_credits_recorded numeric,
  email_matched_total numeric, adjustments_total numeric, owed_to_agent numeric,
  company_cash_with_agent numeric, ledger_float_held numeric, offledger_adjustments numeric,
  payouts_without_float_evidence numeric,
  last_payout_at timestamptz, last_reimbursed_at timestamptz,
  clamp_artifact_amount numeric, evidenced_amount numeric, asserted_only_amount numeric,
  evidence_status text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_anchor date;
  v_is_finance boolean;
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
  paid AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(w.amount), 0) AS total,
           MAX(COALESCE(w.processed_at, w.updated_at)) AS last_at
    FROM desks d
    LEFT JOIN public.withdrawal_requests w
      ON w.status = 'completed'
     AND COALESCE(w.processed_at, w.updated_at) >= v_anchor
     AND (w.assigned_cashout_agent_id = d.id OR w.processed_by = d.agent_id)
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
    -- Display-only adjustments ONLY: anything that reached the ledger is already
    -- inside the books figure and must not be added a second time.
    SELECT d.id AS desk_id,
           COALESCE(SUM(CASE WHEN r.adjustment_type = 'payout_correction' THEN -r.amount ELSE r.amount END), 0) AS total
    FROM desks d
    LEFT JOIN recon r ON r.desk_id = d.id AND NOT r.posted
    GROUP BY d.id
  ),
  held AS (
    SELECT d.id AS desk_id, COALESCE(GREATEST(w.float_balance, 0), 0) AS ledger_float
    FROM desks d
    LEFT JOIN public.wallets w ON w.user_id = d.agent_id
  ),
  unbacked AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(GREATEST(f.own_cash_principal, 0)), 0) AS total
    FROM desks d
    LEFT JOIN public.merchant_payout_funding f
      ON f.agent_id = d.agent_id
     AND f.funding_source IN ('own_cash', 'mixed', 'needs_review')
    GROUP BY d.id
  ),
  -- "The books" measured EXACTLY as the wallet projection measures it.
  raw_float_net AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(CASE WHEN g.direction IN ('cash_in','credit') THEN g.amount ELSE -g.amount END), 0) AS net
    FROM desks d
    LEFT JOIN public.general_ledger g
      ON g.user_id = d.agent_id
     AND g.ledger_scope = 'wallet'
     AND g.wallet_bucket = 'float'
     AND (
       g.classification IS NULL
       OR g.classification = 'production'
       OR (
         g.classification = 'admin_correction'
         AND g.category = 'system_balance_correction'
         AND g.direction = ANY (ARRAY['debit','cash_out'])
       )
     )
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
  -- A ledger-posted correction carrying written evidence of what was actually
  -- seen on the agent's phone is corroboration in its own right.
  cfo_evidence AS (
    SELECT r.desk_id, TRUE AS confirmed
    FROM recon r
    WHERE r.posted AND char_length(COALESCE(r.evidence_note, '')) >= 20
    GROUP BY r.desk_id
  ),
  evidence AS (
    SELECT h.desk_id,
           LEAST(h.ledger_float, GREATEST(0, h.ledger_float - r.net)) AS clamp_artifact,
           GREATEST(0, LEAST(h.ledger_float, r.net)) AS supportable,
           CASE WHEN ce.confirmed THEN GREATEST(0, LEAST(h.ledger_float, r.net))
                ELSE COALESCE(pe.total, 0) END AS provider_total
    FROM held h
    JOIN raw_float_net r ON r.desk_id = h.desk_id
    LEFT JOIN provider_evidence pe ON pe.desk_id = h.desk_id
    LEFT JOIN cfo_evidence ce ON ce.desk_id = h.desk_id
  ),
  evidence_split AS (
    SELECT e.desk_id,
           e.clamp_artifact,
           LEAST(e.provider_total, e.supportable) AS evidenced,
           GREATEST(0, e.supportable - LEAST(e.provider_total, e.supportable)) AS asserted_only
    FROM evidence e
  )
  SELECT d.id, d.agent_id, d.full_name, d.phone, d.label, d.is_active,
         pd.total, fc.total + aj.total, fc.total, em.total, aj.total,
         GREATEST(pd.total - (fc.total + aj.total), 0),
         hd.ledger_float, hd.ledger_float, aj.total, ub.total,
         pd.last_at, GREATEST(fc.last_at, em.last_at),
         es.clamp_artifact, es.evidenced, es.asserted_only,
         CASE
           WHEN (CASE WHEN es.clamp_artifact > 0 THEN 1 ELSE 0 END
               + CASE WHEN es.evidenced > 0 THEN 1 ELSE 0 END
               + CASE WHEN es.asserted_only > 0 THEN 1 ELSE 0 END) > 1 THEN 'mixed'
           WHEN es.asserted_only > 0 THEN 'asserted_only'
           WHEN es.clamp_artifact > 0 THEN 'clamp_artifact'
           ELSE 'evidenced'
         END::text
  FROM desks d
  JOIN paid pd ON pd.desk_id = d.id
  JOIN float_credits fc ON fc.desk_id = d.id
  JOIN emails em ON em.desk_id = d.id
  JOIN adj aj ON aj.desk_id = d.id
  JOIN held hd ON hd.desk_id = d.id
  JOIN unbacked ub ON ub.desk_id = d.id
  JOIN evidence_split es ON es.desk_id = d.id
  ORDER BY hd.ledger_float DESC, GREATEST(pd.total - (fc.total + aj.total), 0) DESC;
END;
$function$;