-- Proxy split withdrawal failed on every submit:
--   column "client_request_id" is of type uuid but expression is of type text
-- submit_proxy_split_withdrawal (created in prod by Lovable, no migration until
-- now) wrote md5(gen_random_uuid()::text), a text hash, into the uuid column
-- withdrawal_requests.client_request_id. Each split row now gets a fresh uuid.
-- Everything else is the live body unchanged. CREATE OR REPLACE keeps the
-- existing EXECUTE grant to authenticated; it is restated for a rebuild.

CREATE OR REPLACE FUNCTION public.submit_proxy_split_withdrawal(p_portfolio_id uuid, p_allocations jsonb, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := auth.uid();
  v_pf record; a jsonb; v_dest text; v_amt numeric; v_total numeric := 0; v_avail numeric;
  v_seen text[] := '{}'; v_ids uuid[] := '{}'; v_id uuid;
  m text; prov text; num text; nm text; bn text; ban text; acn text;
  ex record;
BEGIN
  IF v_agent IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT * INTO v_pf FROM investor_portfolios WHERE id = p_portfolio_id;
  IF v_pf.id IS NULL THEN RAISE EXCEPTION 'Portfolio not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM proxy_agent_assignments WHERE agent_id = v_agent AND beneficiary_id = v_pf.investor_id
                 AND is_active AND approval_status = 'approved') THEN
    RAISE EXCEPTION 'You are not the approved proxy agent for this partner';
  END IF;
  IF length(btrim(coalesce(p_reason,''))) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;
  IF jsonb_typeof(p_allocations) <> 'array' OR jsonb_array_length(p_allocations) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'Split across 1 to 3 payout numbers';
  END IF;

  FOR a IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_dest := a->>'destination';
    v_amt := (a->>'amount')::numeric;
    IF v_amt IS NULL OR v_amt < 500 OR v_amt <> round(v_amt) THEN RAISE EXCEPTION 'Each amount must be a whole number of at least UGX 500'; END IF;
    IF v_dest = ANY(v_seen) THEN RAISE EXCEPTION 'The same payout number is used twice'; END IF;
    IF v_dest <> 'primary' AND NOT EXISTS (SELECT 1 FROM portfolio_payout_destinations WHERE id::text = v_dest AND portfolio_id = p_portfolio_id) THEN
      RAISE EXCEPTION 'Payout number does not belong to this portfolio';
    END IF;
    IF v_dest = 'primary' AND coalesce(v_pf.payment_method,'') NOT IN ('mobile_money','bank_transfer','cash') THEN
      RAISE EXCEPTION 'This portfolio has no main payout route';
    END IF;
    v_seen := v_seen || v_dest; v_total := v_total + v_amt;
  END LOOP;

  v_avail := GREATEST(public.get_user_available_balance(v_pf.investor_id), public.proxy_held_for_partner_available(v_agent, v_pf.investor_id));
  IF v_total > v_avail THEN
    RAISE EXCEPTION 'Insufficient funds. Total UGX % is more than available UGX %', to_char(v_total,'FM999,999,999,999'), to_char(v_avail,'FM999,999,999,999');
  END IF;

  FOR a IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_dest := a->>'destination'; v_amt := (a->>'amount')::numeric;
    IF v_dest = 'primary' THEN
      m := v_pf.payment_method; prov := v_pf.mobile_network; num := v_pf.mobile_money_number;
      nm := coalesce(v_pf.bank_account_name, v_pf.account_name); bn := v_pf.bank_name; ban := v_pf.bank_account_name; acn := v_pf.account_number;
    ELSE
      SELECT * INTO ex FROM portfolio_payout_destinations WHERE id::text = v_dest;
      m := ex.payout_method; prov := ex.mobile_network; num := ex.mobile_money_number;
      nm := ex.recipient_name; bn := ex.bank_name; ban := ex.recipient_name; acn := ex.account_number;
    END IF;
    INSERT INTO withdrawal_requests(user_id, agent_id, initiated_by, beneficiary_id, amount, status, reason, proxy_partner_id,
      client_request_id, auto_dispatched, payout_route_ref, payout_method, mobile_money_provider, mobile_money_number,
      mobile_money_name, bank_name, bank_account_name, bank_account_number)
    VALUES (v_pf.investor_id, v_agent, v_agent, v_pf.investor_id, v_amt, 'pending',
      format('[Proxy initiated by agent %s] %s | Route: portfolio %s | Split %s of %s', v_agent, btrim(p_reason), coalesce(v_pf.portfolio_code, p_portfolio_id::text), array_position(v_seen, v_dest), array_length(v_seen,1)),
      v_pf.investor_id, gen_random_uuid(), false, 'portfolio:' || p_portfolio_id::text, m,
      CASE WHEN m='mobile_money' THEN prov END, CASE WHEN m='mobile_money' THEN num END, CASE WHEN m='mobile_money' THEN nm END,
      CASE WHEN m='bank_transfer' THEN bn END, CASE WHEN m='bank_transfer' THEN ban END, CASE WHEN m='bank_transfer' THEN acn END)
    RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
  END LOOP;

  INSERT INTO audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_agent, 'proxy_split_withdrawal_request', 'withdrawal_requests', p_portfolio_id::text,
    jsonb_build_object('funder_id', v_pf.investor_id, 'total', v_total, 'request_ids', to_jsonb(v_ids), 'reason', btrim(p_reason)));
  RETURN jsonb_build_object('ok', true, 'request_ids', to_jsonb(v_ids), 'total', v_total);
END $function$;

GRANT EXECUTE ON FUNCTION public.submit_proxy_split_withdrawal(uuid, jsonb, text) TO authenticated;
