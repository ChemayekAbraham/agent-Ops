-- 1. Point-in-time float position for a merchant desk, from the ledger only.
CREATE OR REPLACE FUNCTION public.merchant_float_position_at(p_agent_id uuid, p_at timestamptz)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(
           CASE WHEN g.direction IN ('cash_in', 'credit') THEN g.amount ELSE -g.amount END
         ), 0)
  FROM public.general_ledger g
  WHERE g.user_id = p_agent_id
    AND g.ledger_scope = 'wallet'
    AND g.wallet_bucket = 'float'
    AND COALESCE(g.classification, 'production') <> 'admin_correction'
    AND COALESCE(g.category, '') <> 'system_balance_correction'
    AND g.transaction_date <= p_at;
$$;

GRANT EXECUTE ON FUNCTION public.merchant_float_position_at(uuid, timestamptz) TO authenticated, service_role;

-- 2. Evidence listing: every claim with the payout that created it.
CREATE OR REPLACE VIEW public.v_merchant_oop_evidence
WITH (security_invoker = true) AS
SELECT
  o.id                                AS advance_id,
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
  w.transaction_id                    AS payout_tid,
  COALESCE(w.mobile_money_name, w.bank_account_name, p.full_name) AS recipient_name,
  COALESCE(w.mobile_money_number, w.bank_account_number, p.phone) AS recipient_phone,
  w.mobile_money_provider             AS provider,
  w.amount                            AS withdrawal_amount,
  public.merchant_float_position_at(
    o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)
  )                                   AS float_position_at_payout,
  (o.kind = 'telecom' AND COALESCE(o.evidence->>'telecom_charge_ref', '') = '') AS is_estimate,
  (
    public.merchant_float_position_at(
      o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)
    ) < 0
    AND NOT (o.kind = 'telecom' AND COALESCE(o.evidence->>'telecom_charge_ref', '') = '')
  )                                   AS is_evidenced,
  LEAST(
    o.shortfall_amount,
    GREATEST(0, -public.merchant_float_position_at(
      o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)
    ))
  )                                   AS evidenced_amount
FROM public.merchant_out_of_pocket_advances o
LEFT JOIN public.withdrawal_requests w ON w.id = o.withdrawal_id
LEFT JOIN public.profiles p ON p.id = w.user_id;

GRANT SELECT ON public.v_merchant_oop_evidence TO authenticated, service_role;

-- 3. Merchant-facing summary: owed counts only ledger-evidenced claims.
CREATE OR REPLACE FUNCTION public.get_merchant_out_of_pocket_summary(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_owed numeric := 0;
  v_unsupported numeric := 0;
  v_review numeric := 0;
  v_rejected numeric := 0;
  v_reimbursed numeric := 0;
  v_estimates numeric := 0;
  v_tel_today numeric := 0;
  v_tel_month numeric := 0;
  v_tel_total numeric := 0;
  v_count integer := 0;
  v_review_count integer := 0;
BEGIN
  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('owed_to_agent', 0, 'under_review', 0, 'rejected_total', 0,
      'reimbursed_total', 0, 'telecom_today', 0, 'telecom_month', 0, 'telecom_total', 0,
      'pending_count', 0, 'under_review_count', 0, 'unsupported_total', 0, 'estimated_telecom_total', 0);
  END IF;

  IF v_agent <> auth.uid()
     AND NOT (public.has_role(auth.uid(), 'cfo')
              OR public.has_role(auth.uid(), 'financial_ops')
              OR public.has_role(auth.uid(), 'super_admin')
              OR public.is_ops_role(auth.uid())) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  -- Only a claim the ledger supports at the payout's own timestamp is money we owe.
  SELECT
    COALESCE(SUM(CASE WHEN e.status = 'pending_reimbursement' AND e.is_evidenced
                      THEN e.evidenced_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN e.status = 'pending_reimbursement' AND NOT e.is_evidenced
                      THEN e.shortfall_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN e.status = 'needs_review' THEN e.shortfall_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN e.status = 'rejected' THEN e.shortfall_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN e.status = 'reimbursed' THEN e.shortfall_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN e.is_estimate AND e.status IN ('needs_review', 'pending_reimbursement')
                      THEN e.shortfall_amount ELSE 0 END), 0),
    COUNT(*) FILTER (WHERE e.status = 'pending_reimbursement' AND e.is_evidenced),
    COUNT(*) FILTER (WHERE e.status = 'needs_review')
    INTO v_owed, v_unsupported, v_review, v_rejected, v_reimbursed, v_estimates,
         v_count, v_review_count
    FROM public.v_merchant_oop_evidence e
   WHERE e.agent_id = v_agent;

  SELECT COALESCE(SUM(gl.amount), 0)
    INTO v_tel_total
    FROM public.general_ledger gl
   WHERE gl.user_id = v_agent
     AND gl.ledger_scope = 'wallet'
     AND gl.reference_id LIKE '%-merchant-telecom-charge';

  SELECT COALESCE(SUM(gl.amount), 0)
    INTO v_tel_today
    FROM public.general_ledger gl
   WHERE gl.user_id = v_agent
     AND gl.ledger_scope = 'wallet'
     AND gl.reference_id LIKE '%-merchant-telecom-charge'
     AND (gl.transaction_date AT TIME ZONE 'Africa/Kampala')::date = v_today;

  SELECT COALESCE(SUM(gl.amount), 0)
    INTO v_tel_month
    FROM public.general_ledger gl
   WHERE gl.user_id = v_agent
     AND gl.ledger_scope = 'wallet'
     AND gl.reference_id LIKE '%-merchant-telecom-charge'
     AND (gl.transaction_date AT TIME ZONE 'Africa/Kampala')::date
         >= date_trunc('month', v_today)::date;

  RETURN jsonb_build_object(
    'owed_to_agent', v_owed,
    'unsupported_total', v_unsupported,
    'under_review', v_review + v_unsupported,
    'estimated_telecom_total', v_estimates,
    'rejected_total', v_rejected,
    'reimbursed_total', v_reimbursed,
    'telecom_today', v_tel_today,
    'telecom_month', v_tel_month,
    'telecom_total', v_tel_total,
    'pending_count', v_count,
    'under_review_count', v_review_count
  );
END;
$$;

-- 4. Financial Ops board: same gate on the per-desk owed figure.
CREATE OR REPLACE FUNCTION public.get_merchant_oop_evidenced_owed(p_agent_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
    AND NOT (o.kind = 'telecom' AND COALESCE(o.evidence->>'telecom_charge_ref', '') = '')
    AND public.merchant_float_position_at(
          o.agent_id, COALESCE(w.processed_at, w.updated_at, o.created_at)) < 0;
$$;

GRANT EXECUTE ON FUNCTION public.get_merchant_oop_evidenced_owed(uuid) TO authenticated, service_role;
