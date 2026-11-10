-- Rollback for 20261111090000_fin_bs_memo_lines.sql: restore fin_balance_sheet as in 20261110090000.

-- ── Balance Sheet (current resolver statement + sub-ledger ties) ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fin_balance_sheet(p_as_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
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
      (SELECT COALESCE(SUM(COALESCE(outstanding_balance,0) + COALESCE(arrears_balance,0)),0) FROM public.agent_advances
        WHERE status IN ('active','overdue') AND created_at <= COALESCE(p_as_at, now())) AS advances,
      (SELECT COALESCE(SUM(investment_amount),0) FROM public.investor_portfolios
        WHERE status = 'active' AND created_at <= COALESCE(p_as_at, now())) AS portfolios,
      (SELECT COALESCE(SUM(amount - COALESCE(total_collected,0)),0) FROM public.promissory_notes
        WHERE status = 'activated' AND created_at <= COALESCE(p_as_at, now())) AS notes
  )
  SELECT jsonb_build_array(
    jsonb_build_object('key','rent_plans','label','Rent Plan receivables (A3) vs Rent Plan book',
      'ledger', ROUND(COALESCE((v_val->>'A3')::numeric,0)), 'operational', ROUND(t.rent_book),
      'difference', ROUND(COALESCE((v_val->>'A3')::numeric,0) - t.rent_book)),
    jsonb_build_object('key','agent_advances','label','Agent advances (A10+A11+A20) vs agent_advances outstanding + arrears',
      'ledger', ROUND(COALESCE((v_val->>'A10')::numeric,0) + COALESCE((v_val->>'A11')::numeric,0) + COALESCE((v_val->>'A20')::numeric,0)),
      'operational', ROUND(t.advances),
      'difference', ROUND(COALESCE((v_val->>'A10')::numeric,0) + COALESCE((v_val->>'A11')::numeric,0) + COALESCE((v_val->>'A20')::numeric,0) - t.advances)),
    jsonb_build_object('key','supporter_capital','label','Supporter capital (L2 less unpaid promissory notes A7) vs active portfolios',
      'ledger', ROUND(COALESCE((v_val->>'L2')::numeric,0) - COALESCE((v_val->>'A7')::numeric,0)), 'operational', ROUND(t.portfolios),
      'difference', ROUND(COALESCE((v_val->>'L2')::numeric,0) - COALESCE((v_val->>'A7')::numeric,0) - t.portfolios)),
    jsonb_build_object('key','promissory_notes','label','Promissory notes (A7) vs activated notes uncollected',
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

  RETURN v_sofp || jsonb_build_object(
    'engine', 'fin_balance_sheet',
    'subledger_ties', v_ties,
    'subledger_ties_basis', 'Ledger balances are as at the statement date; operational figures (wallets, Rent Plan balances, advances, portfolios, notes) are as they stand now, so ties for past dates are indicative only.',
    'disclosures', jsonb_build_array(
      'Partner Product Receivables (A7) are activated promissory notes not yet paid; the same amount is included in Supporter capital (L2).',
      'Landlord Float Pool (A21/A22) is company cash earmarked to fund Rent Plans (Supporter capital and compounded Returns), not money owed to landlords.',
      'Cash and Bank (A1) is negative mainly because verified cash deposits remain in Cash in Transit (A5); the two should be read together.',
      'Landlord Rent Payable (L4) holds no landlord obligations; its balance comes from resolver counterpart legs.')
  );
END;
$function$;
