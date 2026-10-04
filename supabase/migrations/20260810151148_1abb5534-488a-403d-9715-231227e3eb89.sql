CREATE OR REPLACE FUNCTION public.get_partner_ops_daily_report(p_date date DEFAULT ((now() AT TIME ZONE 'Africa/Nairobi'::text))::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d0 timestamptz := (p_date::timestamp AT TIME ZONE 'Africa/Nairobi');
  d1 timestamptz := ((p_date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi');
  w0 timestamptz := ((p_date - 6)::timestamp AT TIME ZONE 'Africa/Nairobi');
  result jsonb;
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT (
       public.has_role(auth.uid(), 'partner_ops') OR public.has_role(auth.uid(), 'coo')
       OR public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'ceo')
       OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
     ) THEN
    RAISE EXCEPTION 'Not authorised to read the partner operations report';
  END IF;

  SELECT jsonb_build_object(
    'report_date', p_date,
    'kpis', (
      SELECT jsonb_build_object(
        'total_partners', (SELECT count(DISTINCT investor_id) FROM investor_portfolios),
        'onboarded_partners', (SELECT count(DISTINCT investor_id) FROM investor_portfolios WHERE status = 'active'),
        'total_portfolios', (SELECT count(*) FROM investor_portfolios),
        'active_portfolios', (SELECT count(*) FROM investor_portfolios WHERE status = 'active'),
        'total_capital', (SELECT coalesce(sum(investment_amount),0) FROM investor_portfolios WHERE status = 'active'),
        'new_portfolios_today', (SELECT count(*) FROM investor_portfolios WHERE created_at >= d0 AND created_at < d1),
        'new_capital_today', (SELECT coalesce(sum(investment_amount),0) FROM investor_portfolios WHERE created_at >= d0 AND created_at < d1),
        'compounding_portfolios', (SELECT count(*) FROM investor_portfolios WHERE status = 'active' AND roi_mode IN ('monthly_compounding','compound')),
        'monthly_payout_portfolios', (SELECT count(*) FROM investor_portfolios WHERE status = 'active' AND roi_mode NOT IN ('monthly_compounding','compound')),
        'paid_out_today_count', (SELECT count(*) FROM general_ledger WHERE category = 'roi_wallet_credit' AND created_at >= d0 AND created_at < d1),
        'paid_out_today_amount', (SELECT coalesce(sum(amount),0) FROM general_ledger WHERE category = 'roi_wallet_credit' AND created_at >= d0 AND created_at < d1),
        'paid_out_today_partners', (
          SELECT count(DISTINCT coalesce(
            CASE WHEN gl.linked_party ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN gl.linked_party::uuid END,
            ip.investor_id, gl.user_id))
          FROM general_ledger gl
          LEFT JOIN investor_portfolios ip ON ip.id = gl.source_id AND gl.source_table = 'investor_portfolios'
          WHERE gl.category = 'roi_wallet_credit' AND gl.created_at >= d0 AND gl.created_at < d1
        ),
        'compounded_today_count', (SELECT count(*) FROM general_ledger WHERE category = 'roi_reinvestment' AND created_at >= d0 AND created_at < d1),
        'compounded_today_amount', (SELECT coalesce(sum(amount),0) FROM general_ledger WHERE category = 'roi_reinvestment' AND created_at >= d0 AND created_at < d1)
      )
    ),
    'paid_today', coalesce((
      SELECT jsonb_agg(x ORDER BY (x->>'roi')::numeric DESC) FROM (
        SELECT jsonb_build_object(
          'name', coalesce(partner.full_name, holder.full_name, 'Partner'),
          'phone', coalesce(partner.phone, holder.phone),
          'roi', gl.amount,
          'portfolio_code', ip.portfolio_code,
          'principal', coalesce(ip.investment_amount, 0),
          'paid_to', CASE WHEN partner.id IS NOT NULL AND partner.id <> gl.user_id
                          THEN coalesce(holder.full_name, 'proxy wallet') END,
          'at', gl.created_at
        ) AS x
        FROM general_ledger gl
        LEFT JOIN investor_portfolios ip ON ip.id = gl.source_id AND gl.source_table = 'investor_portfolios'
        LEFT JOIN profiles holder ON holder.id = gl.user_id
        LEFT JOIN profiles partner ON partner.id = coalesce(
          CASE WHEN gl.linked_party ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN gl.linked_party::uuid END,
          ip.investor_id)
        WHERE gl.category = 'roi_wallet_credit' AND gl.created_at >= d0 AND gl.created_at < d1
        ORDER BY gl.amount DESC
        LIMIT 200
      ) s
    ), '[]'::jsonb),
    'compounded_today', coalesce((
      SELECT jsonb_agg(x ORDER BY (x->>'roi')::numeric DESC) FROM (
        SELECT jsonb_build_object(
          'name', coalesce(partner.full_name, holder.full_name, 'Partner'),
          'portfolio_code', ip.portfolio_code,
          'roi', gl.amount,
          'principal', greatest(coalesce(ip.investment_amount,0) - gl.amount, 0),
          'new_amount', coalesce(ip.investment_amount, 0),
          'at', gl.created_at
        ) AS x
        FROM general_ledger gl
        LEFT JOIN investor_portfolios ip ON ip.id = gl.source_id AND gl.source_table = 'investor_portfolios'
        LEFT JOIN profiles holder ON holder.id = gl.user_id
        LEFT JOIN profiles partner ON partner.id = coalesce(
          CASE WHEN gl.linked_party ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN gl.linked_party::uuid END,
          ip.investor_id)
        WHERE gl.category = 'roi_reinvestment' AND gl.created_at >= d0 AND gl.created_at < d1
        ORDER BY gl.amount DESC
        LIMIT 200
      ) s
    ), '[]'::jsonb),
    'forecast', (
      SELECT jsonb_build_object(
        'days', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'date', f.day,
            'label', to_char(f.day, 'Dy DD Mon'),
            'is_weekend', extract(isodow FROM f.day) IN (6,7),
            'portfolios', f.cnt,
            'payout_amount', f.payout_amt,
            'compound_amount', f.compound_amt,
            'total_amount', f.payout_amt + f.compound_amt
          ) ORDER BY f.day)
          FROM (
            SELECT ip.next_roi_date::date AS day,
                   count(*) AS cnt,
                   coalesce(sum(CASE WHEN ip.roi_mode NOT IN ('monthly_compounding','compound') THEN round(ip.investment_amount * coalesce(ip.roi_percentage,15) / 100.0) ELSE 0 END),0) AS payout_amt,
                   coalesce(sum(CASE WHEN ip.roi_mode IN ('monthly_compounding','compound') THEN round(ip.investment_amount * coalesce(ip.roi_percentage,15) / 100.0) ELSE 0 END),0) AS compound_amt
            FROM investor_portfolios ip
            WHERE ip.status = 'active' AND ip.next_roi_date IS NOT NULL
              AND ip.next_roi_date::date >= p_date AND ip.next_roi_date::date <= p_date + 6
            GROUP BY 1
          ) f
        ), '[]'::jsonb),
        'weekdays_total', coalesce((
          SELECT sum(round(ip.investment_amount * coalesce(ip.roi_percentage,15) / 100.0))
          FROM investor_portfolios ip
          WHERE ip.status='active' AND ip.next_roi_date::date BETWEEN p_date AND p_date + 6
            AND extract(isodow FROM ip.next_roi_date::date) BETWEEN 1 AND 5
        ), 0),
        'weekdays_count', (
          SELECT count(*) FROM investor_portfolios ip
          WHERE ip.status='active' AND ip.next_roi_date::date BETWEEN p_date AND p_date + 6
            AND extract(isodow FROM ip.next_roi_date::date) BETWEEN 1 AND 5
        ),
        'weekend_total', coalesce((
          SELECT sum(round(ip.investment_amount * coalesce(ip.roi_percentage,15) / 100.0))
          FROM investor_portfolios ip
          WHERE ip.status='active' AND ip.next_roi_date::date BETWEEN p_date AND p_date + 6
            AND extract(isodow FROM ip.next_roi_date::date) IN (6,7)
        ), 0),
        'weekend_count', (
          SELECT count(*) FROM investor_portfolios ip
          WHERE ip.status='active' AND ip.next_roi_date::date BETWEEN p_date AND p_date + 6
            AND extract(isodow FROM ip.next_roi_date::date) IN (6,7)
        )
      )
    ),
    'renewals', (
      SELECT jsonb_build_object(
        'today_count', (SELECT count(*) FROM portfolio_renewals WHERE created_at >= d0 AND created_at < d1 AND reversed_at IS NULL),
        'week_count', (SELECT count(*) FROM portfolio_renewals WHERE created_at >= w0 AND created_at < d1 AND reversed_at IS NULL),
        'week_topup_amount', (SELECT coalesce(sum(top_up_amount),0) FROM portfolio_renewals WHERE created_at >= w0 AND created_at < d1 AND reversed_at IS NULL),
        'rows', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'name', coalesce(p.full_name,'Partner'),
            'portfolio_code', ip.portfolio_code,
            'amount', coalesce(ip.investment_amount,0),
            'top_up', coalesce(r.top_up_amount,0),
            'source', coalesce(r.source, CASE WHEN r.is_auto THEN 'auto' ELSE 'manual' END),
            'new_maturity', r.new_maturity_date,
            'at', r.created_at
          ) ORDER BY r.created_at DESC)
          FROM portfolio_renewals r
          LEFT JOIN investor_portfolios ip ON ip.id = r.portfolio_id
          LEFT JOIN profiles p ON p.id = ip.investor_id
          WHERE r.created_at >= w0 AND r.created_at < d1 AND r.reversed_at IS NULL
        ), '[]'::jsonb)
      )
    ),
    'topups', (
      SELECT jsonb_build_object(
        'pending_count', (SELECT count(*) FROM pending_wallet_operations WHERE category = 'pending_portfolio_topup' AND status IN ('pending','approved','awaiting_verification')),
        'pending_amount', (SELECT coalesce(sum(amount),0) FROM pending_wallet_operations WHERE category = 'pending_portfolio_topup' AND status IN ('pending','approved','awaiting_verification')),
        'applied_today_count', (SELECT count(*) FROM pending_wallet_operations WHERE category = 'pending_portfolio_topup' AND status = 'completed' AND updated_at >= d0 AND updated_at < d1),
        'applied_today_amount', (SELECT coalesce(sum(amount),0) FROM pending_wallet_operations WHERE category = 'pending_portfolio_topup' AND status = 'completed' AND updated_at >= d0 AND updated_at < d1),
        'rows', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'name', coalesce(p.full_name,'Partner'),
            'amount', o.amount,
            'status', o.status,
            'at', o.created_at
          ) ORDER BY o.amount DESC)
          FROM pending_wallet_operations o
          LEFT JOIN profiles p ON p.id = o.user_id
          WHERE o.category = 'pending_portfolio_topup' AND o.status IN ('pending','approved','awaiting_verification')
        ), '[]'::jsonb)
      )
    ),
    'pending_portfolios', (
      SELECT jsonb_build_object(
        'count', (SELECT count(*) FROM investor_portfolios WHERE status IN ('pending_ops_approval','awaiting_partner_details')),
        'amount', (SELECT coalesce(sum(investment_amount),0) FROM investor_portfolios WHERE status IN ('pending_ops_approval','awaiting_partner_details')),
        'funder_queue_count', (SELECT count(*) FROM funder_pending_portfolios WHERE status = 'pending'),
        'funder_queue_amount', (SELECT coalesce(sum(amount),0) FROM funder_pending_portfolios WHERE status = 'pending'),
        'pending_renewal_requests', (SELECT count(*) FROM portfolio_action_requests WHERE status = 'pending' AND request_type = 'RENEWAL_REQUEST'),
        'pending_redemption_requests', (SELECT count(*) FROM portfolio_action_requests WHERE status = 'pending' AND request_type <> 'RENEWAL_REQUEST'),
        'rows', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'name', coalesce(p.full_name, ip.account_name, 'Partner'),
            'portfolio_code', ip.portfolio_code,
            'amount', coalesce(ip.investment_amount,0),
            'status', ip.status,
            'at', ip.created_at
          ) ORDER BY ip.created_at DESC)
          FROM investor_portfolios ip
          LEFT JOIN profiles p ON p.id = ip.investor_id
          WHERE ip.status IN ('pending_ops_approval','awaiting_partner_details')
        ), '[]'::jsonb)
      )
    ),
    'promissory', (
      SELECT jsonb_build_object(
        'pending_count', (SELECT count(*) FROM promissory_notes WHERE status = 'pending'),
        'pending_amount', (SELECT coalesce(sum(amount),0) FROM promissory_notes WHERE status = 'pending'),
        'approved_today_count', (SELECT count(*) FROM promissory_notes WHERE status = 'approved' AND updated_at >= d0 AND updated_at < d1),
        'approved_today_amount', (SELECT coalesce(sum(amount),0) FROM promissory_notes WHERE status = 'approved' AND updated_at >= d0 AND updated_at < d1)
      )
    ),
    'withdrawals', (
      SELECT jsonb_build_object(
        'completed_today_count', (SELECT count(*) FROM withdrawal_requests WHERE status = 'completed' AND updated_at >= d0 AND updated_at < d1),
        'completed_today_amount', (SELECT coalesce(sum(amount),0) FROM withdrawal_requests WHERE status = 'completed' AND updated_at >= d0 AND updated_at < d1),
        'pending_count', (SELECT count(*) FROM withdrawal_requests WHERE status IN ('pending','processing','approved')),
        'pending_amount', (SELECT coalesce(sum(amount),0) FROM withdrawal_requests WHERE status IN ('pending','processing','approved'))
      )
    )
  ) INTO result;

  RETURN result;
END;
$function$;