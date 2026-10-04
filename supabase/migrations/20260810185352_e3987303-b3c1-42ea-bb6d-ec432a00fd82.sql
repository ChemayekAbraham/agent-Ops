CREATE OR REPLACE FUNCTION public.get_roi_disbursement_report(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cash jsonb := '[]'::jsonb;
  v_comp jsonb := '[]'::jsonb;
  v_appr jsonb := '[]'::jsonb;
  v_rec jsonb;
  v_routing jsonb := '[]'::jsonb;
  v_exc jsonb := '[]'::jsonb;
  v_summary jsonb;
  v_cash_count int := 0; v_cash_total numeric := 0;
  v_comp_count int := 0; v_comp_total numeric := 0;
  v_exp_count int := 0; v_exp_total numeric := 0;
  v_partners int := 0; v_principal_total numeric := 0;
  v_cash_win text := '—'; v_comp_win text := '—';
  v_req text; v_coo text; v_cfo text; v_compby text;
  v_proxy_count int := 0;
BEGIN
  IF v_uid IS NULL OR NOT (
    has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
    OR has_role(v_uid,'manager') OR has_role(v_uid,'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised to view ROI disbursement reports';
  END IF;

  -- Section 1: cash Returns disbursed to wallets
  WITH c AS (
    SELECT gl.id, gl.amount, gl.transaction_date, gl.user_id AS wallet_user,
           ip.portfolio_code, ip.investment_amount, ip.investor_id
    FROM general_ledger gl
    LEFT JOIN investor_portfolios ip ON ip.id = gl.source_id
    WHERE gl.category = 'roi_wallet_credit'
      AND gl.transaction_date >= p_start AND gl.transaction_date < p_end
  ), r AS (
    SELECT c.*,
      COALESCE(pi.full_name, 'Unknown partner') AS partner,
      NULLIF(pi.phone, '') AS phone,
      COALESCE(pw.full_name, 'Unknown wallet') AS paid_to,
      ROW_NUMBER() OVER (ORDER BY c.amount DESC, c.transaction_date) AS rn
    FROM c
    LEFT JOIN profiles pi ON pi.id = c.investor_id
    LEFT JOIN profiles pw ON pw.id = c.wallet_user
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'n', rn,
           'portfolio_phone', COALESCE(phone, 'Not registered'),
           'partner', partner,
           'paid_to', paid_to,
           'principal', COALESCE(investment_amount, 0),
           'returns_paid', amount,
           'time_eat', to_char(transaction_date AT TIME ZONE 'Africa/Kampala', 'HH24:MI'),
           'date_eat', to_char(transaction_date AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD'),
           'portfolio_code', portfolio_code
         ) ORDER BY rn), '[]'::jsonb),
         COUNT(*)::int, COALESCE(SUM(amount),0), COALESCE(SUM(investment_amount),0)
    INTO v_cash, v_cash_count, v_cash_total, v_principal_total
  FROM r;

  -- Section 2: Returns compounded into principal
  WITH c AS (
    SELECT gl.id, gl.amount, gl.transaction_date, gl.user_id AS actor,
           gl.source_id, ip.portfolio_code, ip.investment_amount, ip.investor_id
    FROM general_ledger gl
    LEFT JOIN investor_portfolios ip ON ip.id = gl.source_id
    WHERE gl.category = 'roi_reinvestment'
      AND gl.transaction_date >= p_start AND gl.transaction_date < p_end
  ), r AS (
    SELECT c.*,
      COALESCE(pi.full_name, 'Unknown partner') AS partner,
      NULLIF(pi.phone, '') AS phone,
      COALESCE((
        SELECT pa.full_name FROM audit_logs a
        JOIN profiles pa ON pa.id = a.user_id
        WHERE a.action_type = 'roi_compounded'
          AND a.record_id::text = c.source_id::text
          AND a.created_at >= p_start AND a.created_at < p_end
        ORDER BY a.created_at DESC LIMIT 1
      ), pa2.full_name, 'System') AS executed_by,
      ROW_NUMBER() OVER (ORDER BY c.amount DESC, c.transaction_date) AS rn
    FROM c
    LEFT JOIN profiles pi ON pi.id = c.investor_id
    LEFT JOIN profiles pa2 ON pa2.id = c.actor
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'n', rn,
           'portfolio_phone', COALESCE(phone, 'Not registered'),
           'partner', partner,
           'new_principal', COALESCE(investment_amount, 0),
           'returns_compounded', amount,
           'executed_by', executed_by,
           'time_eat', to_char(transaction_date AT TIME ZONE 'Africa/Kampala', 'HH24:MI'),
           'date_eat', to_char(transaction_date AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD'),
           'portfolio_code', portfolio_code
         ) ORDER BY rn), '[]'::jsonb),
         COUNT(*)::int, COALESCE(SUM(amount),0)
    INTO v_comp, v_comp_count, v_comp_total
  FROM r;

  -- Platform expense leg
  SELECT COUNT(*)::int, COALESCE(SUM(amount),0) INTO v_exp_count, v_exp_total
  FROM general_ledger
  WHERE category = 'roi_expense'
    AND transaction_date >= p_start AND transaction_date < p_end;

  -- Distinct partners affected across both sections
  SELECT COUNT(DISTINCT ip.investor_id)::int INTO v_partners
  FROM general_ledger gl
  JOIN investor_portfolios ip ON ip.id = gl.source_id
  WHERE gl.category IN ('roi_wallet_credit','roi_reinvestment')
    AND gl.transaction_date >= p_start AND gl.transaction_date < p_end;

  -- Windows (EAT)
  SELECT COALESCE(to_char(MIN(transaction_date) AT TIME ZONE 'Africa/Kampala','HH24:MI')
         || ' - ' || to_char(MAX(transaction_date) AT TIME ZONE 'Africa/Kampala','HH24:MI'), '—')
    INTO v_cash_win
  FROM general_ledger
  WHERE category = 'roi_wallet_credit' AND transaction_date >= p_start AND transaction_date < p_end;

  SELECT COALESCE(to_char(MIN(transaction_date) AT TIME ZONE 'Africa/Kampala','HH24:MI')
         || ' - ' || to_char(MAX(transaction_date) AT TIME ZONE 'Africa/Kampala','HH24:MI'), '—')
    INTO v_comp_win
  FROM general_ledger
  WHERE category = 'roi_reinvestment' AND transaction_date >= p_start AND transaction_date < p_end;

  -- Section 3: authorisers from existing approval history
  SELECT string_agg(DISTINCT p.full_name, ' / ') INTO v_req
  FROM audit_logs a JOIN profiles p ON p.id = a.user_id
  WHERE a.action_type = 'roi_payout_requested' AND a.created_at >= p_start AND a.created_at < p_end;

  SELECT string_agg(DISTINCT p.full_name, ' / ') INTO v_coo
  FROM audit_logs a JOIN profiles p ON p.id = a.user_id
  WHERE a.action_type = 'coo_roi_approval' AND a.created_at >= p_start AND a.created_at < p_end;

  SELECT string_agg(DISTINCT p.full_name, ' / ') INTO v_cfo
  FROM audit_logs a JOIN profiles p ON p.id = a.user_id
  WHERE a.action_type = 'cfo_roi_payout_approved' AND a.created_at >= p_start AND a.created_at < p_end;

  SELECT string_agg(DISTINCT p.full_name, ' / ') INTO v_compby
  FROM audit_logs a JOIN profiles p ON p.id = a.user_id
  WHERE a.action_type = 'roi_compounded' AND a.created_at >= p_start AND a.created_at < p_end;

  v_appr := jsonb_build_array(
    jsonb_build_object('stage','Requested / prepared','authorised_by',COALESCE(v_req,'—'),'role','Partner Ops','items',v_cash_count,'amount',v_cash_total,'window',v_cash_win),
    jsonb_build_object('stage','Operational clearance','authorised_by',COALESCE(v_coo,'—'),'role','COO','items',v_cash_count,'amount',v_cash_total,'window',v_cash_win),
    jsonb_build_object('stage','Final approval / disbursed','authorised_by',COALESCE(v_cfo,'—'),'role','CFO','items',v_cash_count,'amount',v_cash_total,'window',v_cash_win),
    jsonb_build_object('stage','Compounding executed','authorised_by',COALESCE(v_compby,'—'),'role','Partner Ops','items',v_comp_count,'amount',v_comp_total,'window',v_comp_win)
  );

  v_rec := jsonb_build_object(
    'wallet_credits', jsonb_build_object('legs', v_cash_count, 'amount', v_cash_total),
    'reinvestments', jsonb_build_object('legs', v_comp_count, 'amount', v_comp_total),
    'platform_expense', jsonb_build_object('legs', v_exp_count, 'amount', v_exp_total),
    'balanced', (v_cash_total + v_comp_total) = v_exp_total
  );

  -- Routing note: managed-proxy wallets that received partner Returns
  WITH c AS (
    SELECT gl.user_id AS wallet_user, ip.investor_id, gl.amount
    FROM general_ledger gl
    LEFT JOIN investor_portfolios ip ON ip.id = gl.source_id
    WHERE gl.category = 'roi_wallet_credit'
      AND gl.transaction_date >= p_start AND gl.transaction_date < p_end
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'credits')::int DESC), '[]'::jsonb), COALESCE(SUM((x->>'credits')::int),0)
    INTO v_routing, v_proxy_count
  FROM (
    SELECT jsonb_build_object(
             'name', COALESCE(p.full_name,'Unknown wallet'),
             'phone', COALESCE(NULLIF(p.phone,''),'—'),
             'credits', COUNT(*)::int,
             'amount', SUM(c.amount)
           ) AS x
    FROM c LEFT JOIN profiles p ON p.id = c.wallet_user
    WHERE c.investor_id IS NOT NULL AND c.wallet_user IS DISTINCT FROM c.investor_id
    GROUP BY p.full_name, p.phone
  ) s;

  -- Exceptions: same portfolio compounded AND paid the same amount in the window
  WITH cash AS (
    SELECT gl.source_id, gl.amount, gl.transaction_date
    FROM general_ledger gl
    WHERE gl.category = 'roi_wallet_credit' AND gl.transaction_date >= p_start AND gl.transaction_date < p_end
  ), comp AS (
    SELECT gl.source_id, gl.amount, gl.transaction_date
    FROM general_ledger gl
    WHERE gl.category = 'roi_reinvestment' AND gl.transaction_date >= p_start AND gl.transaction_date < p_end
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'portfolio_code', ip.portfolio_code,
           'partner', COALESCE(p.full_name,'Unknown partner'),
           'amount', cash.amount,
           'compounded_at', to_char(comp.transaction_date AT TIME ZONE 'Africa/Kampala','YYYY-MM-DD HH24:MI'),
           'paid_at', to_char(cash.transaction_date AT TIME ZONE 'Africa/Kampala','YYYY-MM-DD HH24:MI')
         )), '[]'::jsonb) INTO v_exc
  FROM cash
  JOIN comp ON comp.source_id = cash.source_id AND comp.amount = cash.amount
  LEFT JOIN investor_portfolios ip ON ip.id = cash.source_id
  LEFT JOIN profiles p ON p.id = ip.investor_id;

  v_summary := jsonb_build_object(
    'total_approved', v_cash_total + v_comp_total,
    'cash_total', v_cash_total,
    'compounded_total', v_comp_total,
    'partners_affected', v_partners,
    'approvals_count', v_cash_count + v_comp_count,
    'payouts_count', v_cash_count,
    'compounded_portfolios', v_comp_count,
    'portfolios_total', v_cash_count + v_comp_count,
    'principal_total', v_principal_total
  );

  RETURN jsonb_build_object(
    'period', jsonb_build_object(
      'start', p_start, 'end', p_end,
      'start_eat', to_char(p_start AT TIME ZONE 'Africa/Kampala','YYYY-MM-DD HH24:MI'),
      'end_eat', to_char(p_end AT TIME ZONE 'Africa/Kampala','YYYY-MM-DD HH24:MI')
    ),
    'generated_at', now(),
    'summary', v_summary,
    'cash', v_cash,
    'compounded', v_comp,
    'approvals', v_appr,
    'reconciliation', v_rec,
    'routing', v_routing,
    'proxy_credits', v_proxy_count,
    'exceptions', v_exc
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_roi_disbursement_report(timestamptz, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.get_roi_disbursement_report(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_roi_disbursement_report(timestamptz, timestamptz) TO service_role;