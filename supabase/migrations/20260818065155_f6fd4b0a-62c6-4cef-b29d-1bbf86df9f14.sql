CREATE OR REPLACE FUNCTION public.set_merchant_desk_float_to(p_desk_id uuid, p_agent_id uuid, p_target numeric, p_reason text, p_evidence_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_desk_agent uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_evidence text := btrim(coalesce(p_evidence_note, ''));
  v_target numeric;
  v_visible_net numeric;
  v_cache_before numeric;
  v_cache_after numeric;
  v_proj_float numeric;
  v_delta numeric;
  v_recon_id uuid;
  v_group_id uuid;
  v_category text;
  v_classification text;
BEGIN
  PERFORM set_config('statement_timeout', '120s', true);

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'cfo')
    OR public.has_role(v_actor, 'financial_ops')
    OR public.has_role(v_actor, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only the CFO, Financial Ops or a super admin can set a merchant desk float';
  END IF;

  v_target := round(coalesce(p_target, -1));
  IF v_target < 0 THEN
    RAISE EXCEPTION 'Enter the float the agent actually holds. It cannot be negative.';
  END IF;

  IF char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  -- Evidence is now mandatory for EVERY correction (up, down or confirmation).
  -- A correction is the evidence of record for the desk, so it must always say
  -- which agent, what was seen on their phone and when it was checked.
  IF char_length(v_evidence) < 20 THEN
    RAISE EXCEPTION 'Evidence is required for any desk float correction: which agent, what was actually seen on their phone (balance, screenshot reference or provider TID) and the date and time it was checked';
  END IF;

  SELECT agent_id INTO v_desk_agent FROM public.cashout_agents WHERE id = p_desk_id;
  IF v_desk_agent IS NULL THEN
    RAISE EXCEPTION 'Merchant desk not found or has no linked agent';
  END IF;
  IF p_agent_id IS NOT NULL AND p_agent_id <> v_desk_agent THEN
    RAISE EXCEPTION 'Agent does not match this merchant desk';
  END IF;
  IF v_desk_agent = v_actor THEN
    RAISE EXCEPTION 'You cannot set the float on your own merchant desk. Another authorized finance officer must post this entry.';
  END IF;

  v_visible_net := public.merchant_float_visible_net(v_desk_agent);

  SELECT COALESCE(float_balance, 0) INTO v_cache_before
    FROM public.wallets WHERE user_id = v_desk_agent;
  v_cache_before := COALESCE(v_cache_before, 0);

  v_delta := v_target - v_visible_net;

  IF v_delta <> 0 THEN
    IF v_delta > 0 THEN
      v_category := 'agent_float_deposit';
      v_classification := 'production';
    ELSE
      v_category := 'system_balance_correction';
      v_classification := 'admin_correction';
    END IF;

    INSERT INTO public.merchant_float_reconciliations
      (desk_id, agent_id, adjustment_type, amount, reason, evidence_note, created_by, ledger_effect)
    VALUES
      (p_desk_id, v_desk_agent,
       CASE WHEN v_delta > 0 THEN 'opening_balance' ELSE 'evidenced_writedown' END,
       ABS(v_delta), v_reason, v_evidence, v_actor, 'ledger_posted')
    RETURNING id INTO v_recon_id;

    v_group_id := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_desk_agent,
          'amount', ABS(v_delta),
          'direction', CASE WHEN v_delta > 0 THEN 'cash_in' ELSE 'cash_out' END,
          'category', v_category,
          'ledger_scope', 'wallet',
          'wallet_bucket', 'float',
          'recipient_type', 'operational_wallet',
          'classification', v_classification,
          'solvency_bypass_reason', 'other_with_note',
          'source_table', 'merchant_float_reconciliations',
          'source_id', v_recon_id,
          'description', format('Merchant desk float set to %s (books showed %s). Reason: %s | Evidence: %s',
                                v_target, v_visible_net, v_reason, v_evidence),
          'currency', 'UGX',
          'transaction_date', now()
        ),
        jsonb_build_object(
          'amount', ABS(v_delta),
          'direction', CASE WHEN v_delta > 0 THEN 'cash_out' ELSE 'cash_in' END,
          'category', v_category,
          'ledger_scope', 'platform',
          'classification', v_classification,
          'source_table', 'merchant_float_reconciliations',
          'source_id', v_recon_id,
          'description', 'Platform: merchant desk float set to evidenced figure',
          'currency', 'UGX',
          'transaction_date', now()
        )
      ),
      idempotency_key := 'merchant_set_float:' || v_recon_id::text,
      skip_balance_check := true
    );
  END IF;

  -- Recompute the ledger-derived projection, then force the wallet float
  -- bucket the agent UI reads onto exactly that figure so the board and the
  -- agent's own float can never disagree after a correction.
  PERFORM public.refresh_wallet_projection_for(v_desk_agent);

  SELECT COALESCE(float_balance, 0) INTO v_proj_float
    FROM public.wallet_balances_projection WHERE user_id = v_desk_agent;
  v_proj_float := COALESCE(v_proj_float, 0);

  PERFORM set_config('wallet.sync_authorized', 'true', true);
  UPDATE public.wallets
     SET float_balance = v_proj_float,
         updated_at = now()
   WHERE user_id = v_desk_agent
     AND COALESCE(float_balance, 0) IS DISTINCT FROM v_proj_float;
  PERFORM set_config('wallet.sync_authorized', 'false', true);

  SELECT COALESCE(float_balance, 0) INTO v_cache_after
    FROM public.wallets WHERE user_id = v_desk_agent;
  v_cache_after := COALESCE(v_cache_after, 0);

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, 'merchant_desk_float_set', 'merchant_float_reconciliations',
          COALESCE(v_recon_id, p_desk_id), v_reason,
          jsonb_build_object('desk_id', p_desk_id, 'agent_id', v_desk_agent,
                             'target', v_target, 'visible_net_before', v_visible_net,
                             'float_before', v_cache_before, 'float_after', v_cache_after,
                             'projection_float', v_proj_float,
                             'delta', v_delta,
                             'ledger_group_id', v_group_id,
                             'reason', v_reason, 'evidence', v_evidence));

  RETURN jsonb_build_object('ok', true,
                            'no_op', v_delta = 0,
                            'reconciliation_id', v_recon_id,
                            'ledger_group_id', v_group_id,
                            'target', v_target,
                            'raw_net_before', v_visible_net,
                            'float_before', v_cache_before,
                            'float_after', v_cache_after,
                            'delta', v_delta);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_merchant_float_positions()
 RETURNS TABLE(desk_id uuid, agent_id uuid, agent_name text, agent_phone text, label text, is_active boolean, paid_out_total numeric, reimbursed_total numeric, float_credits_recorded numeric, email_matched_total numeric, adjustments_total numeric, owed_to_agent numeric, company_cash_with_agent numeric, ledger_float_held numeric, offledger_adjustments numeric, payouts_without_float_evidence numeric, last_payout_at timestamp with time zone, last_reimbursed_at timestamp with time zone, clamp_artifact_amount numeric, evidenced_amount numeric, asserted_only_amount numeric, clamped_shortfall_amount numeric, evidence_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
  raw_float_net AS (
    SELECT d.id AS desk_id,
           COALESCE(wp.float_balance_raw, wp.float_balance, 0) AS net,
           GREATEST(0, -COALESCE(wp.float_balance_raw, 0)) AS clamped_shortfall
    FROM desks d
    LEFT JOIN public.wallet_balances_projection wp ON wp.user_id = d.agent_id
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
  -- A finance-officer correction (posted reconciliation OR an audited
  -- "Fix balance" confirmation, including a no-change confirmation) is the
  -- evidence of record for the desk. Once it exists, no legacy / asserted-only
  -- float can keep showing for that desk.
  cfo_evidence AS (
    SELECT r.desk_id, TRUE AS confirmed
    FROM recon r
    WHERE r.posted AND char_length(COALESCE(r.evidence_note, '')) >= 20
    GROUP BY r.desk_id
    UNION
    SELECT (a.metadata->>'desk_id')::uuid AS desk_id, TRUE
    FROM public.audit_logs a
    WHERE a.action_type = 'merchant_desk_float_set'
      AND a.metadata ? 'desk_id'
      AND char_length(COALESCE(a.metadata->>'evidence', '')) >= 20
    GROUP BY 1
  ),
  evidence AS (
    SELECT h.desk_id,
           LEAST(h.ledger_float, GREATEST(0, h.ledger_float - r.net)) AS clamp_artifact,
           GREATEST(0, LEAST(h.ledger_float, r.net)) AS supportable,
           CASE WHEN ce.confirmed THEN GREATEST(0, LEAST(h.ledger_float, r.net))
                ELSE COALESCE(pe.total, 0) END AS provider_total,
           r.clamped_shortfall
    FROM held h
    JOIN raw_float_net r ON r.desk_id = h.desk_id
    LEFT JOIN provider_evidence pe ON pe.desk_id = h.desk_id
    LEFT JOIN (SELECT desk_id, bool_or(confirmed) AS confirmed FROM cfo_evidence GROUP BY desk_id) ce
      ON ce.desk_id = h.desk_id
  ),
  evidence_split AS (
    SELECT e.desk_id,
           e.clamp_artifact,
           LEAST(e.provider_total, e.supportable) AS evidenced,
           GREATEST(0, e.supportable - LEAST(e.provider_total, e.supportable)) AS asserted_only,
           e.clamped_shortfall
    FROM evidence e
  )
  SELECT d.id, d.agent_id, d.full_name, d.phone, d.label, d.is_active,
         pd.total, fc.total + aj.total, fc.total, em.total, aj.total,
         GREATEST(pd.total - (fc.total + aj.total), 0),
         hd.ledger_float, hd.ledger_float, aj.total, ub.total,
         pd.last_at, GREATEST(fc.last_at, em.last_at),
         es.clamp_artifact, es.evidenced, es.asserted_only, es.clamped_shortfall,
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