-- 1) Ledger-backed opening-balance fix for a merchant agent's float.
--    Posts balanced double-entry legs and moves the float bucket through the
--    sole wallet writer. Records the same row in merchant_float_reconciliations
--    marked ledger_posted so history stays complete.
CREATE OR REPLACE FUNCTION public.post_merchant_opening_float_ledger(
  p_desk_id uuid,
  p_agent_id uuid,
  p_amount numeric,
  p_reason text,
  p_evidence_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_recon_id uuid;
  v_group_id uuid;
  v_desk_agent uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'cfo')
    OR public.has_role(v_actor, 'financial_ops')
    OR public.has_role(v_actor, 'manager')
    OR public.has_role(v_actor, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only finance roles can post a ledger-backed float fix';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero. Use CFO Direct Debit to reduce float.';
  END IF;

  IF char_length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT agent_id INTO v_desk_agent FROM public.cashout_agents WHERE id = p_desk_id;
  IF v_desk_agent IS NULL THEN
    RAISE EXCEPTION 'Merchant desk not found or has no linked agent';
  END IF;
  IF p_agent_id IS NOT NULL AND p_agent_id <> v_desk_agent THEN
    RAISE EXCEPTION 'Agent does not match this merchant desk';
  END IF;

  INSERT INTO public.merchant_float_reconciliations
    (desk_id, agent_id, adjustment_type, amount, reason, evidence_note, created_by, ledger_effect)
  VALUES
    (p_desk_id, v_desk_agent, 'opening_balance', round(p_amount), btrim(p_reason),
     nullif(btrim(coalesce(p_evidence_note, '')), ''), v_actor, 'ledger_posted')
  RETURNING id INTO v_recon_id;

  -- Balanced legs: wallet float leg in, platform leg out (cash_in == cash_out).
  v_group_id := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_desk_agent,
        'amount', round(p_amount),
        'direction', 'cash_in',
        'category', 'agent_float_deposit',
        'ledger_scope', 'wallet',
        'wallet_bucket', 'float',
        'recipient_type', 'operational_wallet',
        'source_table', 'merchant_float_reconciliations',
        'source_id', v_recon_id,
        'description', format('Merchant float opening balance recognised on the books: %s', btrim(p_reason)),
        'currency', 'UGX',
        'transaction_date', now()
      ),
      jsonb_build_object(
        'amount', round(p_amount),
        'direction', 'cash_out',
        'category', 'agent_float_deposit',
        'ledger_scope', 'platform',
        'source_table', 'merchant_float_reconciliations',
        'source_id', v_recon_id,
        'description', 'Platform: merchant float opening balance recognised',
        'currency', 'UGX',
        'transaction_date', now()
      )
    ),
    idempotency_key := 'merchant_opening_float:' || v_recon_id::text,
    skip_balance_check := true
  );

  PERFORM public.apply_wallet_movement(
    p_user_id := v_desk_agent,
    p_category := 'agent_float_deposit',
    p_amount := round(p_amount),
    p_direction := 'cash_in',
    p_recipient_type := 'operational_wallet'
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, 'merchant_opening_float_ledger_posted', 'merchant_float_reconciliations',
          v_recon_id, btrim(p_reason),
          jsonb_build_object('desk_id', p_desk_id, 'agent_id', v_desk_agent,
                             'amount', round(p_amount), 'ledger_group_id', v_group_id));

  RETURN jsonb_build_object('ok', true, 'reconciliation_id', v_recon_id,
                            'ledger_group_id', v_group_id, 'amount', round(p_amount));
END
$function$;

REVOKE ALL ON FUNCTION public.post_merchant_opening_float_ledger(uuid, uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_merchant_opening_float_ledger(uuid, uuid, numeric, text, text) TO authenticated;

-- 2) A ledger-posted fix already shows up through the float/ledger figures, so it
--    must not also be counted as an off-ledger adjustment (double count).
CREATE OR REPLACE FUNCTION public.get_merchant_float_positions()
 RETURNS TABLE(desk_id uuid, agent_id uuid, agent_name text, agent_phone text, label text, is_active boolean, paid_out_total numeric, reimbursed_total numeric, float_credits_recorded numeric, email_matched_total numeric, adjustments_total numeric, owed_to_agent numeric, company_cash_with_agent numeric, ledger_float_held numeric, offledger_adjustments numeric, payouts_without_float_evidence numeric, last_payout_at timestamp with time zone, last_reimbursed_at timestamp with time zone)
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
  paid AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(wr.amount), 0) AS total,
           MAX(wr.processed_at) AS last_at
    FROM desks d
    LEFT JOIN public.withdrawal_requests wr
      ON wr.dispatched_agent_id = d.agent_id
     AND wr.status = 'completed'
     AND wr.processed_at >= v_anchor
    GROUP BY d.id
  ),
  float_credits AS (
    SELECT d.id AS desk_id,
           COALESCE(SUM(gl.amount), 0) AS total,
           MAX(gl.transaction_date) AS last_at
    FROM desks d
    LEFT JOIN public.general_ledger gl
      ON gl.user_id = d.agent_id
     AND gl.wallet_bucket = 'float'
     AND gl.direction = 'cash_in'
     AND gl.category IN ('agent_float_deposit', 'agent_float_assignment')
     AND gl.transaction_date >= v_anchor
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
    LEFT JOIN public.merchant_float_reconciliations r
      ON r.desk_id = d.id
     AND r.ledger_effect = 'display_only'
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
  )
  SELECT d.id, d.agent_id, d.full_name, d.phone, d.label, d.is_active,
         pd.total,
         fc.total + aj.total,
         fc.total,
         em.total,
         aj.total,
         GREATEST(pd.total - (fc.total + aj.total), 0),
         hd.ledger_float,
         hd.ledger_float,
         aj.total,
         ub.total,
         pd.last_at,
         GREATEST(fc.last_at, em.last_at)
  FROM desks d
  JOIN paid pd ON pd.desk_id = d.id
  JOIN float_credits fc ON fc.desk_id = d.id
  JOIN emails em ON em.desk_id = d.id
  JOIN adj aj ON aj.desk_id = d.id
  JOIN held hd ON hd.desk_id = d.id
  JOIN unbacked ub ON ub.desk_id = d.id
  ORDER BY hd.ledger_float DESC, GREATEST(pd.total - (fc.total + aj.total), 0) DESC;
END;
$function$;