-- Verbatim production copy (16 Nov 2026 after item 1, read-only export).
CREATE OR REPLACE FUNCTION public.fin_balance_sheet(p_as_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_sofp jsonb;
  v_val  jsonb;
  v_ties jsonb;
BEGIN
  IF NOT public._fin_can_view() THEN
    RAISE EXCEPTION 'Not authorised to view the balance sheet';
  END IF;

  v_sofp := public.get_statement_of_financial_position(COALESCE(p_as_at, now()));

  -- account values by code, from the statement just produced
  SELECT jsonb_object_agg(substring(e->>'source' from 'account ([A-Z0-9]+)$'), (e->>'value')::numeric)
    INTO v_val
  FROM (
    SELECT jsonb_array_elements(COALESCE(v_sofp->'assets'->'current','[]'::jsonb) || COALESCE(v_sofp->'assets'->'non_current','[]'::jsonb)
                              || COALESCE(v_sofp->'liabilities'->'current','[]'::jsonb) || COALESCE(v_sofp->'liabilities'->'non_current','[]'::jsonb)) e
  ) z
  WHERE substring(e->>'source' from 'account ([A-Z0-9]+)$') IS NOT NULL;

  WITH w AS (
    SELECT COALESCE(SUM(withdrawable_balance),0) wd, COALESCE(SUM(locked_balance),0) lk,
           COALESCE(SUM(float_balance),0) fl, COALESCE(SUM(advance_balance),0) adv FROM public.wallets
  ), t AS (
    SELECT
      (SELECT COALESCE(SUM(COALESCE(total_repayment,0) - COALESCE(amount_repaid,0)),0) FROM public.rent_requests
        WHERE status IN ('funded','disbursed','repaying') AND created_at <= COALESCE(p_as_at, now())) AS rent_book,
      (SELECT COALESCE(SUM(COALESCE(outstanding_balance,0)),0) FROM public.agent_advances
        WHERE status IN ('active','overdue') AND created_at <= COALESCE(p_as_at, now())) AS advances,
      (SELECT COALESCE(SUM(investment_amount),0) FROM public.investor_portfolios
        WHERE status = 'active' AND created_at <= COALESCE(p_as_at, now())) AS portfolios,
      (SELECT COALESCE(SUM(v.outstanding),0) FROM public.v_partner_note_settlement v JOIN public.promissory_notes n ON n.id = v.note_id
        WHERE n.status = 'activated' AND n.created_at <= COALESCE(p_as_at, now())) AS notes
  )
  SELECT jsonb_build_array(
    jsonb_build_object('key','rent_plans','label','Rent Plan receivables (A3) vs Rent Plan book',
      'ledger', ROUND(COALESCE((v_val->>'A3')::numeric,0)), 'operational', ROUND(t.rent_book),
      'difference', ROUND(COALESCE((v_val->>'A3')::numeric,0) - t.rent_book)),
    jsonb_build_object('key','agent_advances','label','Agent advances (A10+A11+A20) vs open advances outstanding (fees and arrears included)',
      'basis','outstanding_only_v2',
      'ledger', ROUND(COALESCE((v_val->>'A10')::numeric,0) + COALESCE((v_val->>'A11')::numeric,0) + COALESCE((v_val->>'A20')::numeric,0)),
      'operational', ROUND(t.advances),
      'difference', ROUND(COALESCE((v_val->>'A10')::numeric,0) + COALESCE((v_val->>'A11')::numeric,0) + COALESCE((v_val->>'A20')::numeric,0) - t.advances)),
    jsonb_build_object('key','supporter_capital','label','Supporter capital (L2 less unpaid promissory notes A7) vs active portfolios',
      'ledger', ROUND(COALESCE((v_val->>'L2')::numeric,0) - COALESCE((v_val->>'A7')::numeric,0)), 'operational', ROUND(t.portfolios),
      'difference', ROUND(COALESCE((v_val->>'L2')::numeric,0) - COALESCE((v_val->>'A7')::numeric,0) - t.portfolios)),
    jsonb_build_object('key','promissory_notes','label','Promissory notes (A7) vs activated notes not yet settled',
      'ledger', ROUND(COALESCE((v_val->>'A7')::numeric,0)), 'operational', ROUND(t.notes),
      'difference', ROUND(COALESCE((v_val->>'A7')::numeric,0) - t.notes)),
    jsonb_build_object('key','wallet_custody','label','Wallet custody (L1) vs wallets withdrawable + locked',
      'ledger', ROUND(COALESCE((v_val->>'L1')::numeric,0)), 'operational', ROUND(w.wd + w.lk),
      'difference', ROUND(COALESCE((v_val->>'L1')::numeric,0) - (w.wd + w.lk))),
    jsonb_build_object('key','agent_float','label','Agent float (A2) vs wallets float',
      'ledger', ROUND(COALESCE((v_val->>'A2')::numeric,0)), 'operational', ROUND(w.fl),
      'difference', ROUND(COALESCE((v_val->>'A2')::numeric,0) - w.fl))
  ) INTO v_ties
  FROM w, t;

  -- Comparison lines corrected (CFO, 10 Nov 2026): merchandise counts issued orders only (receivable recognised
  -- when an order is issued, policy of 4 Nov 2026); promissory notes split into activated and not yet activated.
  WITH memo AS (
    SELECT e FROM jsonb_array_elements(COALESCE(v_sofp->'reconciliation'->'memo_sub_ledgers', '[]'::jsonb)) e
    WHERE e->>'label' NOT IN ('Merchandise sales outstanding', 'Promissory notes uncollected')
  ), extra AS (
    SELECT jsonb_build_array(
      jsonb_build_object('label', 'Merchandise sales outstanding — issued orders only',
        'value', (SELECT COALESCE(SUM(COALESCE(amount_outstanding,0)),0) FROM public.merchandise_sales
                  WHERE order_status IN ('issued','completed') AND created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — orders marked issued or completed (receivable recognised on issue)'),
      jsonb_build_object('label', 'Merchandise orders not yet issued (not a receivable)',
        'value', (SELECT COALESCE(SUM(COALESCE(amount_outstanding,0)),0) FROM public.merchandise_sales
                  WHERE COALESCE(order_status,'') NOT IN ('issued','completed','rejected','failed','cancelled')
                    AND created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — pending, approved or awaiting handover; information only'),
      jsonb_build_object('label', 'Promissory notes activated, not yet settled',
        'value', (SELECT COALESCE(SUM(v.outstanding),0) FROM public.v_partner_note_settlement v JOIN public.promissory_notes n ON n.id = v.note_id
                  WHERE n.status = 'activated' AND n.created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — note amount less collections, fund-ins attributed to the note and CFO-confirmed funding; compare against ledger account A7'),
      jsonb_build_object('label', 'Promissory notes not yet activated (commitments only)',
        'value', (SELECT COALESCE(SUM(COALESCE(amount,0) - COALESCE(total_collected,0)),0) FROM public.promissory_notes
                  WHERE status = 'pending' AND created_at <= COALESCE(p_as_at, now())),
        'source', 'operational sub-ledger — not recognised in the ledger')
    ) j
  )
  SELECT jsonb_set(v_sofp, '{reconciliation,memo_sub_ledgers}',
                   COALESCE((SELECT jsonb_agg(e) FROM memo), '[]'::jsonb) || (SELECT j FROM extra))
    INTO v_sofp
  WHERE v_sofp ? 'reconciliation';

  RETURN v_sofp || jsonb_build_object(
    'engine', 'fin_balance_sheet',
    'subledger_ties', v_ties,
    'subledger_ties_basis', 'Ledger balances are as at the statement date; operational figures (wallets, Rent Plan balances, advances, portfolios, notes) are as they stand now, so ties for past dates are indicative only.',
    'disclosures', jsonb_build_array(
      'Partner Product Receivables (A7) are activated promissory notes not yet settled by Supporter capital; the same amount is included in Supporter capital (L2). A note settled by a funded portfolio is released, so the capital is counted once.',
      'Landlord Float Pool (A21/A22) is company cash earmarked to fund Rent Plans (Supporter capital and compounded Returns), not money owed to landlords.',
      'Cash and Bank (A1) is negative mainly because verified cash deposits remain in Cash in Transit (A5); the two should be read together.',
      'Landlord Rent Payable (L4) holds no landlord obligations; its balance comes from resolver counterpart legs.')
  );
END;
$function$;
