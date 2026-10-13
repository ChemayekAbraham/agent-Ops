CREATE OR REPLACE FUNCTION public.staff_create_redemption_request(p_portfolio_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_p record; v_id uuid; v_name text; v_email text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT (has_role(auth.uid(),'manager'::app_role) OR has_role(auth.uid(),'coo'::app_role)
       OR has_role(auth.uid(),'super_admin'::app_role) OR has_role(auth.uid(),'cto'::app_role)
       OR has_role(auth.uid(),'partner_ops'::app_role) OR has_role(auth.uid(),'cfo'::app_role)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN RAISE EXCEPTION 'reason_required'; END IF;
  SELECT id, portfolio_code, account_name, investment_amount, maturity_date, display_currency, investor_id, agent_id, status
    INTO v_p FROM investor_portfolios WHERE id = p_portfolio_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'portfolio_not_found'; END IF;
  IF v_p.status IN ('redeemed','closed','cancelled') THEN RAISE EXCEPTION 'portfolio_already_closed'; END IF;
  SELECT id INTO v_id FROM portfolio_action_requests
    WHERE portfolio_id = v_p.id AND request_type='REDEMPTION_REQUEST' AND status='pending' LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT full_name, email INTO v_name, v_email FROM profiles WHERE id = COALESCE(v_p.investor_id, v_p.agent_id);
  INSERT INTO portfolio_action_requests(portfolio_id, portfolio_code, portfolio_name, portfolio_value, maturity_date,
      partner_id, partner_name, partner_email, request_type, status, message, currency)
  VALUES (v_p.id, v_p.portfolio_code, COALESCE(v_p.account_name,'Partnership Portfolio'), v_p.investment_amount, v_p.maturity_date,
      COALESCE(v_p.investor_id, v_p.agent_id), COALESCE(v_name,'Partner'), COALESCE(v_email,''), 'REDEMPTION_REQUEST', 'pending',
      'Raised by staff: ' || trim(p_reason), COALESCE(v_p.display_currency,'UGX'))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.staff_create_redemption_request(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_create_redemption_request(uuid,text) TO authenticated;