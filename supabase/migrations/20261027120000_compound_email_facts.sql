-- Facts for the "Portfolio Compounded" email, read from the recorded compounding
-- events instead of from whatever the browser had on screen.
--
-- Why: the email used to be assembled in the COO page at the moment of the click.
-- Production showed (a) two emails carrying the previous cycle's value, (b) the
-- portfolio's account name ("ACCOUNT 1") in place of its code, and (c) an
-- "original contribution" figure that was really the balance before the first
-- recorded compounding. This function returns only recorded facts:
--
--   capital_added    = principal after this compound - every compounded return
--                      up to and including it (reversed compounds excluded).
--                      Compounded returns are added into investment_amount, so
--                      this is what the partner actually put in, top-ups included.
--   returns_to_date  = sum of the compounded returns up to this one.
--   compound_number  = how many compoundings this portfolio has had, this one included.
--
-- Read-only. Callable by service_role only (the edge function that sends the email).

CREATE OR REPLACE FUNCTION public.portfolio_compound_email_facts(
  p_portfolio_id uuid,
  p_reference    text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p     record;
  v_out jsonb;
BEGIN
  SELECT ip.id, ip.portfolio_code, ip.account_name, ip.investor_id, ip.roi_percentage, ip.roi_mode,
         ip.created_at, ip.maturity_date, ip.next_roi_date, ip.duration_months, ip.investment_amount,
         ip.status, pr.full_name AS partner_name, pr.email AS partner_email
    INTO p
    FROM public.investor_portfolios ip
    LEFT JOIN public.profiles pr ON pr.id = ip.investor_id
   WHERE ip.id = p_portfolio_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'portfolio_not_found');
  END IF;

  WITH ev AS (
    SELECT a.id AS audit_id,
           a.created_at,
           a.metadata->>'reference'                AS reference,
           a.metadata->>'new_roi_date'             AS new_roi_date,
           (a.metadata->>'roi_amount')::numeric    AS roi_amount,
           (a.metadata->>'new_principal')::numeric AS new_principal,
           EXISTS (
             SELECT 1 FROM public.compound_reversal_requests r
              WHERE r.portfolio_id = p.id
                AND r.status = 'approved'
                AND abs(r.amount - (a.metadata->>'roi_amount')::numeric) < 1
                AND abs(extract(epoch FROM (r.reinvested_at - a.created_at))) < 300
           ) AS reversed
      FROM public.audit_logs a
     WHERE a.action_type = 'roi_compounded'
       AND a.record_id = p.id::text
       AND (a.metadata->>'roi_amount') IS NOT NULL
       AND (a.metadata->>'new_principal') IS NOT NULL
  ), sel AS (
    SELECT * FROM ev
     WHERE NOT reversed AND (p_reference IS NULL OR reference = p_reference)
     ORDER BY created_at DESC
     LIMIT 1
  ), agg AS (
    SELECT COALESCE(sum(e.roi_amount), 0) AS returns_to_date,
           count(*)::int                  AS compound_number,
           COALESCE(jsonb_agg(jsonb_build_object(
             'at', e.created_at, 'reference', e.reference,
             'roi_amount', e.roi_amount, 'new_principal', e.new_principal) ORDER BY e.created_at), '[]'::jsonb) AS events
      FROM ev e JOIN sel s ON e.created_at <= s.created_at
     WHERE NOT e.reversed
  )
  SELECT jsonb_build_object(
           'compound', jsonb_build_object(
             'at', s.created_at, 'reference', s.reference, 'next_roi_date', s.new_roi_date,
             'return_amount', s.roi_amount, 'new_principal', s.new_principal,
             'opening_balance', s.new_principal - s.roi_amount),
           'compound_number', a.compound_number,
           'returns_to_date', a.returns_to_date,
           'capital_added', s.new_principal - a.returns_to_date,
           'events', a.events)
    INTO v_out
    FROM sel s, agg a;

  IF v_out IS NULL THEN
    RETURN jsonb_build_object('error', 'compound_event_not_found',
                              'portfolio_code', p.portfolio_code, 'reference', p_reference);
  END IF;

  RETURN v_out || jsonb_build_object(
    'portfolio', jsonb_build_object(
      'id', p.id, 'code', p.portfolio_code, 'account_name', p.account_name, 'status', p.status,
      'roi_percentage', p.roi_percentage, 'roi_mode', p.roi_mode,
      'created_at', p.created_at, 'maturity_date', p.maturity_date, 'next_roi_date', p.next_roi_date,
      'duration_months', p.duration_months, 'current_principal', p.investment_amount),
    'partner', jsonb_build_object('id', p.investor_id, 'name', p.partner_name, 'email', p.partner_email));
END;
$function$;

REVOKE ALL ON FUNCTION public.portfolio_compound_email_facts(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portfolio_compound_email_facts(uuid, text) TO service_role;
