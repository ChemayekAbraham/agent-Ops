CREATE FUNCTION public._ledger_can_post_partner_returns(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT _user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.user_roles ur
             WHERE ur.user_id = _user_id
               AND ur.role::text IN ('coo', 'super_admin', 'cto')
               AND COALESCE(ur.enabled, true))
    OR EXISTS (SELECT 1 FROM public.staff_permissions sp
                WHERE sp.user_id = _user_id
                  AND sp.permitted_dashboard IN ('coo', 'partner-ops')
                  AND sp.revoked_at IS NULL));
$$;
REVOKE ALL ON FUNCTION public._ledger_can_post_partner_returns(uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.post_portfolio_roi_ledger(
  p_operation text, p_portfolio_id uuid, p_amount numeric, p_reference text,
  p_description_out text, p_description_in text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_investor uuid; v_principal numeric; v_pct numeric; v_cycle_returns numeric;
  v_recipient uuid; v_keep boolean;
BEGIN
  IF v_actor IS NULL OR NOT public._ledger_can_post_partner_returns(v_actor) THEN
    RAISE EXCEPTION 'Not authorised to post partner Returns' USING ERRCODE = '42501'; END IF;
  IF p_operation IS NULL OR p_operation NOT IN ('compound', 'split_reinvest', 'split_keep_returns') THEN
    RAISE EXCEPTION 'Unknown Returns operation' USING ERRCODE = '22023'; END IF;
  IF p_reference IS NULL OR p_reference !~ '^(CMP|SPL)-[A-Z0-9]{4,20}-[A-Z0-9]{2,8}$' THEN
    RAISE EXCEPTION 'Invalid Returns reference' USING ERRCODE = '22023'; END IF;
  IF length(coalesce(p_description_out, '')) > 2000 OR length(coalesce(p_description_in, '')) > 2000 THEN
    RAISE EXCEPTION 'Description too long' USING ERRCODE = '22023'; END IF;
  IF p_amount IS NULL OR p_amount < 1 OR p_amount <> round(p_amount) THEN
    RAISE EXCEPTION 'Amount must be a whole number of at least 1' USING ERRCODE = '22023'; END IF;

  SELECT ip.investor_id, ip.investment_amount, ip.roi_percentage
    INTO v_investor, v_principal, v_pct
    FROM public.investor_portfolios ip WHERE ip.id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND OR v_investor IS NULL THEN
    RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'P0002'; END IF;
  v_cycle_returns := round(coalesce(v_principal, 0) * coalesce(v_pct, 0) / 100);
  IF p_amount > v_cycle_returns THEN
    RAISE EXCEPTION 'Amount exceeds one cycle of Returns for this portfolio' USING ERRCODE = '22023'; END IF;

  v_keep := p_operation = 'split_keep_returns';
  v_recipient := v_investor;
  IF v_keep THEN
    SELECT CASE WHEN pa.is_managed_account THEN pa.agent_id ELSE v_investor END
      INTO v_recipient
      FROM public.proxy_agent_assignments pa
     WHERE pa.beneficiary_id = v_investor AND pa.is_active AND pa.approval_status = 'approved'
     ORDER BY pa.is_managed_account DESC, pa.created_at DESC
     LIMIT 1;
    v_recipient := coalesce(v_recipient, v_investor);
  END IF;

  RETURN public.create_ledger_transaction(
    entries => jsonb_build_array(
      jsonb_build_object(
        'user_id', v_investor, 'ledger_scope', 'platform', 'direction', 'cash_out',
        'amount', p_amount, 'category', 'roi_expense',
        'description', p_description_out, 'reference_id', p_reference,
        'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
        'linked_party', v_actor, 'currency', 'UGX'),
      CASE WHEN v_keep THEN jsonb_build_object(
        'user_id', v_recipient, 'ledger_scope', 'wallet', 'direction', 'cash_in',
        'amount', p_amount, 'category', 'roi_wallet_credit',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'description', p_description_in, 'reference_id', p_reference,
        'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
        'linked_party', v_investor, 'currency', 'UGX')
      ELSE jsonb_build_object(
        'user_id', v_investor, 'ledger_scope', 'platform', 'direction', 'cash_in',
        'amount', p_amount, 'category', 'roi_reinvestment',
        'description', p_description_in, 'reference_id', p_reference,
        'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
        'linked_party', CASE WHEN p_operation = 'compound' THEN v_actor ELSE v_investor END,
        'currency', 'UGX')
      END),
    idempotency_key => 'portfolio-roi-ledger:' || p_reference);
END $$;
REVOKE ALL ON FUNCTION public.post_portfolio_roi_ledger(text,uuid,numeric,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_portfolio_roi_ledger(text,uuid,numeric,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.post_portfolio_roi_ledger(text,uuid,numeric,text,text,text) TO service_role;