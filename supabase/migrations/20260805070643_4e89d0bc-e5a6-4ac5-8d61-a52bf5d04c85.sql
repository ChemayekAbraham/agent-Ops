CREATE OR REPLACE FUNCTION public.partner_ops_report_breakdown(
  p_from timestamptz DEFAULT (now() - interval '30 days'),
  p_to   timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_from timestamptz := coalesce(p_from, now() - interval '30 days');
  v_to   timestamptz := coalesce(p_to, now());
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF NOT (
    has_role(v_uid, 'coo') OR has_role(v_uid, 'ceo') OR has_role(v_uid, 'cfo')
    OR has_role(v_uid, 'manager') OR has_role(v_uid, 'super_admin')
    OR has_role(v_uid, 'partner_ops') OR has_role(v_uid, 'financial_ops')
    OR has_role(v_uid, 'operations')
  ) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  WITH created AS (
    SELECT p.id, p.portfolio_code, p.investment_amount, p.status, p.cfo_verified,
           p.cfo_rejection_reason, p.created_at, p.investor_id, p.account_name,
           p.bank_account_name, p.roi_percentage, p.next_roi_date, p.maturity_date
    FROM investor_portfolios p
    WHERE p.created_at >= v_from AND p.created_at <= v_to
  ),
  nearing AS (
    SELECT p.id, p.portfolio_code, p.investment_amount, p.next_roi_date, p.investor_id,
           p.account_name, p.bank_account_name,
           round(p.investment_amount * coalesce(p.roi_percentage,15) / 100.0) AS expected_amount,
           (p.next_roi_date < current_date) AS overdue
    FROM investor_portfolios p
    WHERE p.status = 'active'
      AND p.cfo_verified IS TRUE
      AND p.next_roi_date IS NOT NULL
      AND p.next_roi_date <= current_date + 7
  ),
  paid_legs AS (
    SELECT DISTINCT ON (substring(g.description from 'Portfolio: ([0-9a-fA-F]{8})'), g.reference_id)
           substring(g.description from 'Portfolio: ([0-9a-fA-F]{8})') AS pref,
           g.amount, g.transaction_date, g.reference_id
    FROM general_ledger g
    WHERE g.category = 'roi_wallet_credit'
      AND g.transaction_date >= v_from AND g.transaction_date <= v_to
      AND g.description ~ 'Portfolio: [0-9a-fA-F]{8}'
      AND coalesce(g.classification,'production') <> 'admin_correction'
  ),
  paid AS (
    SELECT l.pref, l.amount, l.transaction_date, l.reference_id,
           p.id AS portfolio_id, p.portfolio_code, p.investment_amount,
           p.investor_id, p.account_name, p.bank_account_name
    FROM paid_legs l
    LEFT JOIN investor_portfolios p ON left(p.id::text, 8) = lower(l.pref)
  ),
  suspended AS (
    SELECT p.id, p.portfolio_code, p.investment_amount, p.status, p.created_at,
           p.investor_id, p.account_name, p.bank_account_name, p.cfo_rejection_reason
    FROM investor_portfolios p
    WHERE p.status IN ('cancelled','suspended','awaiting_partner_details')
  )
  SELECT jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'new_portfolios', jsonb_build_object(
      'count', (SELECT count(*) FROM created),
      'amount', (SELECT coalesce(sum(investment_amount),0) FROM created),
      'partners', (SELECT count(DISTINCT investor_id) FROM created),
      'verified', (SELECT count(*) FROM created WHERE cfo_verified),
      'pending', (SELECT count(*) FROM created WHERE NOT coalesce(cfo_verified,false) AND cfo_rejection_reason IS NULL),
      'rows', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'id', c.id, 'code', c.portfolio_code, 'amount', c.investment_amount,
          'status', CASE WHEN c.cfo_verified THEN 'Verified'
                         WHEN c.cfo_rejection_reason IS NOT NULL THEN 'Rejected'
                         ELSE coalesce(c.status,'Pending') END,
          'created_at', c.created_at,
          'person', coalesce(pr.full_name, c.account_name, c.bank_account_name, pr.phone, 'Unknown')
        ) AS x
        FROM created c LEFT JOIN profiles pr ON pr.id = c.investor_id
        ORDER BY c.created_at DESC LIMIT 200
      ) s)
    ),
    'nearing_payouts', jsonb_build_object(
      'count', (SELECT count(*) FROM nearing),
      'amount', (SELECT coalesce(sum(expected_amount),0) FROM nearing),
      'overdue_count', (SELECT count(*) FROM nearing WHERE overdue),
      'overdue_amount', (SELECT coalesce(sum(expected_amount),0) FROM nearing WHERE overdue),
      'rows', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'next_roi_date'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'id', n.id, 'code', n.portfolio_code, 'principal', n.investment_amount,
          'amount', n.expected_amount, 'next_roi_date', n.next_roi_date,
          'overdue', n.overdue,
          'person', coalesce(pr.full_name, n.account_name, n.bank_account_name, pr.phone, 'Unknown')
        ) AS x
        FROM nearing n LEFT JOIN profiles pr ON pr.id = n.investor_id
        ORDER BY n.next_roi_date LIMIT 200
      ) s)
    ),
    'paid_out', jsonb_build_object(
      'count', (SELECT count(DISTINCT portfolio_id) FROM paid WHERE portfolio_id IS NOT NULL),
      'payments', (SELECT count(*) FROM paid),
      'amount', (SELECT coalesce(sum(amount),0) FROM paid),
      'rows', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'paid_at' DESC), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'id', coalesce(pd.portfolio_id::text, pd.reference_id), 'code', pd.portfolio_code,
          'amount', pd.amount, 'paid_at', pd.transaction_date, 'reference', pd.reference_id,
          'principal', pd.investment_amount,
          'person', coalesce(pr.full_name, pd.account_name, pd.bank_account_name, pr.phone, 'Unknown')
        ) AS x
        FROM paid pd LEFT JOIN profiles pr ON pr.id = pd.investor_id
        ORDER BY pd.transaction_date DESC LIMIT 200
      ) s)
    ),
    'suspended', jsonb_build_object(
      'count', (SELECT count(*) FROM suspended),
      'amount', (SELECT coalesce(sum(investment_amount),0) FROM suspended),
      'in_range', (SELECT count(*) FROM suspended WHERE created_at >= v_from AND created_at <= v_to),
      'rows', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'id', su.id, 'code', su.portfolio_code, 'amount', su.investment_amount,
          'status', su.status, 'created_at', su.created_at,
          'reason', su.cfo_rejection_reason,
          'person', coalesce(pr.full_name, su.account_name, su.bank_account_name, pr.phone, 'Unknown')
        ) AS x
        FROM suspended su LEFT JOIN profiles pr ON pr.id = su.investor_id
        ORDER BY su.created_at DESC LIMIT 200
      ) s)
    ),
    'created_all_time', jsonb_build_object(
      'count', (SELECT count(*) FROM investor_portfolios),
      'amount', (SELECT coalesce(sum(investment_amount),0) FROM investor_portfolios),
      'partners', (SELECT count(DISTINCT investor_id) FROM investor_portfolios WHERE investor_id IS NOT NULL),
      'active', (SELECT count(*) FROM investor_portfolios WHERE status = 'active')
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.partner_ops_report_breakdown(timestamptz, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.partner_ops_report_breakdown(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_ops_report_breakdown(timestamptz, timestamptz) TO service_role;