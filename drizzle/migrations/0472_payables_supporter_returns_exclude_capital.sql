-- Supporter Returns & Capital payables: count only the returns actually paid out
-- (investment x roi_percentage), not the portfolio principal at maturity.
DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_viewdef('public.v_payables_lines'::regclass, true);
  v_new := regexp_replace(
    v_def,
    'UNION ALL\s+SELECT ''partner''::text AS category_key,\s+''Supporter Returns & Capital''::text AS category_label,\s+''portfolio_maturity''::text.*?ip\.maturity_date IS NOT NULL\)?\s+AND\s+\(?COALESCE\(ip\.investment_amount, 0::numeric\) > 0::numeric\)?\s*(?=UNION ALL)',
    '',
    's'
  );
  IF v_new = v_def OR v_new LIKE '%portfolio_maturity%' THEN
    RAISE EXCEPTION 'portfolio_maturity branch not removed cleanly';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_payables_lines AS ' || v_new;
END $$;