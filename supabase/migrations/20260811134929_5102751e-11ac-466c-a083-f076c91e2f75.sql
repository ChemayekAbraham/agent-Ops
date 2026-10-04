CREATE OR REPLACE FUNCTION public.get_partner_ops_range_report(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  d0 timestamptz := (p_start::timestamp AT TIME ZONE 'Africa/Nairobi');
  d1 timestamptz := ((p_end + 1)::timestamp AT TIME ZONE 'Africa/Nairobi');
  days int := greatest(1, (p_end - p_start) + 1);
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
    'start_date', p_start,
    'end_date', p_end,
    'days', days,
    'kpis', (
      SELECT jsonb_build_object(
        'total_partners', (SELECT count(DISTINCT investor_id) FROM investor_portfolios),
        'active_partners', (SELECT count(DISTINCT investor_id) FROM investor_portfolios WHERE status = 'active'),
        'total_portfolios', (SELECT count(*) FROM investor_portfolios),
        'active_portfolios', (SELECT count(*) FROM investor_portfolios WHERE status = 'active'),
        'total_capital', (SELECT coalesce(sum(investment_amount),0) FROM investor_portfolios WHERE status = 'active'),
        'avg_ticket', (SELECT coalesce(round(avg(investment_amount)),0) FROM investor_portfolios WHERE status = 'active'),
        'compounding_portfolios', (SELECT count(*) FROM investor_portfolios WHERE status = 'active' AND roi_mode IN ('monthly_compounding','compound')),
        'monthly_payout_portfolios', (SELECT count(*) FROM investor_portfolios WHERE status = 'active' AND roi_mode NOT IN ('monthly_compounding','compound')),
        'avg_return_rate', (SELECT coalesce(round(avg(coalesce(roi_percentage,15))::numeric, 2),0) FROM investor_portfolios WHERE status = 'active'),
        'new_portfolios', (SELECT count(*) FROM investor_portfolios WHERE created_at >= d0 AND created_at < d1),
        'new_capital', (SELECT coalesce(sum(investment_amount),0) FROM investor_portfolios WHERE created_at >= d0 AND created_at < d1),
        'paid_out_count', (SELECT count(*) FROM general_ledger WHERE category = 'roi_wallet_credit' AND created_at >= d0 AND created_at < d1),
        'paid_out_amount', (SELECT coalesce(sum(amount),0) FROM general_ledger WHERE category = 'roi_wallet_credit' AND created_at >= d0 AND created_at < d1),
        'paid_out_partners', (
          SELECT count(DISTINCT coalesce(ip.investor_id, gl.user_id))
          FROM general_ledger gl
          LEFT JOIN investor_portfolios ip ON ip.id = gl.source_id AND gl.source_table = 'investor_portfolios'
          WHERE gl.category = 'roi_wallet_credit' AND gl.created_at >= d0 AND gl.created_at < d1
        ),
        'compounded_count', (SELECT count(*) FROM general_ledger WHERE category = 'roi_reinvestment' AND created_at >= d0 AND created_at < d1),
        'compounded_amount', (SELECT coalesce(sum(amount),0) FROM general_ledger WHERE category = 'roi_reinvestment' AND created_at >= d0 AND created_at < d1),
        'renewals_count', (SELECT count(*) FROM portfolio_renewals WHERE created_at >= d0 AND created_at < d1 AND reversed_at IS NULL),
        'renewals_topup_amount', (SELECT coalesce(sum(top_up_amount),0) FROM portfolio_renewals WHERE created_at >= d0 AND created_at < d1 AND reversed_at IS NULL),
        'withdrawals_completed_count', (SELECT count(*) FROM withdrawal_requests WHERE status = 'completed' AND linked_party IS NOT NULL AND updated_at >= d0 AND updated_at < d1),
        'withdrawals_completed_amount', (SELECT coalesce(sum(amount),0) FROM withdrawal_requests WHERE status = 'completed' AND linked_party IS NOT NULL AND updated_at >= d0 AND updated_at < d1),
        'promissory_created_count', (SELECT count(*) FROM promissory_notes WHERE created_at >= d0 AND created_at < d1),
        'promissory_created_amount', (SELECT coalesce(sum(amount),0) FROM promissory_notes WHERE created_at >= d0 AND created_at < d1)
      )
    ),
    'topups', (
      SELECT jsonb_build_object(
        'requested_count', (SELECT count(*) FROM pending_wallet_operations WHERE category = 'pending_portfolio_topup' AND created_at >= d0 AND created_at < d1),
        'requested_amount', (SELECT coalesce(sum(amount),0) FROM pending_wallet_operations WHERE category = 'pending_portfolio_topup' AND created_at >= d0 AND created_at < d1),
        'applied_count', (SELECT count(*) FROM pending_wallet_operations WHERE category = 'pending_portfolio_topup' AND status = 'completed' AND updated_at >= d0 AND updated_at < d1),
        'applied_amount', (SELECT coalesce(sum(amount),0) FROM pending_wallet_operations WHERE category = 'pending_portfolio_topup' AND status = 'completed' AND updated_at >= d0 AND updated_at < d1),
        'rejected_count', (SELECT count(*) FROM pending_wallet_operations WHERE category = 'pending_portfolio_topup' AND status IN ('rejected','cancelled','failed') AND updated_at >= d0 AND updated_at < d1),
        'rejected_amount', (SELECT coalesce(sum(amount),0) FROM pending_wallet_operations WHERE category = 'pending_portfolio_topup' AND status IN ('rejected','cancelled','failed') AND updated_at >= d0 AND updated_at < d1),
        'renewal_topup_count', (SELECT count(*) FROM portfolio_renewals WHERE created_at >= d0 AND created_at < d1 AND reversed_at IS NULL AND coalesce(top_up_amount,0) > 0),
        'renewal_topup_amount', (SELECT coalesce(sum(top_up_amount),0) FROM portfolio_renewals WHERE created_at >= d0 AND created_at < d1 AND reversed_at IS NULL),
        'backlog_count', (SELECT count(*) FROM pending_wallet_operations WHERE category = 'pending_portfolio_topup' AND status IN ('pending','approved','awaiting_verification')),
        'backlog_amount', (SELECT coalesce(sum(amount),0) FROM pending_wallet_operations WHERE category = 'pending_portfolio_topup' AND status IN ('pending','approved','awaiting_verification')),
        'backlog_oldest_days', (SELECT coalesce(max(extract(day FROM (now() - created_at)))::int, 0) FROM pending_wallet_operations WHERE category = 'pending_portfolio_topup' AND status IN ('pending','approved','awaiting_verification')),
        'by_status', coalesce((
          SELECT jsonb_agg(jsonb_build_object('status', s.status, 'count', s.cnt, 'amount', s.amt) ORDER BY s.amt DESC)
          FROM (
            SELECT status, count(*) AS cnt, coalesce(sum(amount),0) AS amt
            FROM pending_wallet_operations
            WHERE category = 'pending_portfolio_topup'
              AND ((created_at >= d0 AND created_at < d1) OR (updated_at >= d0 AND updated_at < d1))
            GROUP BY status
          ) s
        ), '[]'::jsonb)
      )
    ),
    'backlog', (
      SELECT jsonb_build_object(
        'pending_portfolios_count', (SELECT count(*) FROM investor_portfolios WHERE status IN ('pending_ops_approval','awaiting_partner_details')),
        'pending_portfolios_amount', (SELECT coalesce(sum(investment_amount),0) FROM investor_portfolios WHERE status IN ('pending_ops_approval','awaiting_partner_details')),
        'funder_queue_count', (SELECT count(*) FROM funder_pending_portfolios WHERE status = 'pending'),
        'funder_queue_amount', (SELECT coalesce(sum(amount),0) FROM funder_pending_portfolios WHERE status = 'pending'),
        'pending_renewal_requests', (SELECT count(*) FROM portfolio_action_requests WHERE status = 'pending' AND request_type = 'RENEWAL_REQUEST'),
        'pending_redemption_requests', (SELECT count(*) FROM portfolio_action_requests WHERE status = 'pending' AND request_type <> 'RENEWAL_REQUEST'),
        'promissory_pending_count', (SELECT count(*) FROM promissory_notes WHERE status = 'pending'),
        'promissory_pending_amount', (SELECT coalesce(sum(amount),0) FROM promissory_notes WHERE status = 'pending'),
        'withdrawals_pending_count', (SELECT count(*) FROM withdrawal_requests WHERE linked_party IS NOT NULL AND status IN ('pending','processing','approved','fin_ops_approved','cfo_approved','coo_approved','manager_approved')),
        'withdrawals_pending_amount', (SELECT coalesce(sum(amount),0) FROM withdrawal_requests WHERE linked_party IS NOT NULL AND status IN ('pending','processing','approved','fin_ops_approved','cfo_approved','coo_approved','manager_approved'))
      )
    ),
    'series', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'date', g.day,
        'label', to_char(g.day, 'Dy DD Mon'),
        'is_weekend', extract(isodow FROM g.day) IN (6,7),
        'new_portfolios', (SELECT count(*) FROM investor_portfolios ip WHERE ip.created_at >= (g.day::date::timestamp AT TIME ZONE 'Africa/Nairobi') AND ip.created_at < ((g.day::date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi')),
        'new_capital', (SELECT coalesce(sum(ip.investment_amount),0) FROM investor_portfolios ip WHERE ip.created_at >= (g.day::date::timestamp AT TIME ZONE 'Africa/Nairobi') AND ip.created_at < ((g.day::date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi')),
        'paid_out', (SELECT coalesce(sum(gl.amount),0) FROM general_ledger gl WHERE gl.category = 'roi_wallet_credit' AND gl.created_at >= (g.day::date::timestamp AT TIME ZONE 'Africa/Nairobi') AND gl.created_at < ((g.day::date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi')),
        'compounded', (SELECT coalesce(sum(gl.amount),0) FROM general_ledger gl WHERE gl.category = 'roi_reinvestment' AND gl.created_at >= (g.day::date::timestamp AT TIME ZONE 'Africa/Nairobi') AND gl.created_at < ((g.day::date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi')),
        'topups_applied', (SELECT coalesce(sum(o.amount),0) FROM pending_wallet_operations o WHERE o.category = 'pending_portfolio_topup' AND o.status = 'completed' AND o.updated_at >= (g.day::date::timestamp AT TIME ZONE 'Africa/Nairobi') AND o.updated_at < ((g.day::date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi')),
        'topups_requested', (SELECT coalesce(sum(o.amount),0) FROM pending_wallet_operations o WHERE o.category = 'pending_portfolio_topup' AND o.created_at >= (g.day::date::timestamp AT TIME ZONE 'Africa/Nairobi') AND o.created_at < ((g.day::date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi')),
        'withdrawn', (SELECT coalesce(sum(w.amount),0) FROM withdrawal_requests w WHERE w.status = 'completed' AND w.linked_party IS NOT NULL AND w.updated_at >= (g.day::date::timestamp AT TIME ZONE 'Africa/Nairobi') AND w.updated_at < ((g.day::date + 1)::timestamp AT TIME ZONE 'Africa/Nairobi'))
      ) ORDER BY g.day)
      FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') AS g(day)
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
              AND ip.next_roi_date::date >= p_end AND ip.next_roi_date::date <= p_end + 6
            GROUP BY 1
          ) f
        ), '[]'::jsonb),
        'weekdays_total', coalesce((
          SELECT sum(round(ip.investment_amount * coalesce(ip.roi_percentage,15) / 100.0))
          FROM investor_portfolios ip
          WHERE ip.status='active' AND ip.next_roi_date::date BETWEEN p_end AND p_end + 6
            AND extract(isodow FROM ip.next_roi_date::date) BETWEEN 1 AND 5
        ), 0),
        'weekdays_count', (
          SELECT count(*) FROM investor_portfolios ip
          WHERE ip.status='active' AND ip.next_roi_date::date BETWEEN p_end AND p_end + 6
            AND extract(isodow FROM ip.next_roi_date::date) BETWEEN 1 AND 5
        ),
        'weekend_total', coalesce((
          SELECT sum(round(ip.investment_amount * coalesce(ip.roi_percentage,15) / 100.0))
          FROM investor_portfolios ip
          WHERE ip.status='active' AND ip.next_roi_date::date BETWEEN p_end AND p_end + 6
            AND extract(isodow FROM ip.next_roi_date::date) IN (6,7)
        ), 0),
        'weekend_count', (
          SELECT count(*) FROM investor_portfolios ip
          WHERE ip.status='active' AND ip.next_roi_date::date BETWEEN p_end AND p_end + 6
            AND extract(isodow FROM ip.next_roi_date::date) IN (6,7)
        )
      )
    ),
    'mix', (
      SELECT jsonb_build_object(
        'by_mode', coalesce((
          SELECT jsonb_agg(jsonb_build_object('label', m.mode_label, 'count', m.cnt, 'amount', m.amt) ORDER BY m.amt DESC)
          FROM (
            SELECT CASE WHEN roi_mode IN ('monthly_compounding','compound') THEN 'Compounding' ELSE 'Monthly payout' END AS mode_label,
                   count(*) AS cnt, coalesce(sum(investment_amount),0) AS amt
            FROM investor_portfolios WHERE status = 'active' GROUP BY 1
          ) m
        ), '[]'::jsonb),
        'by_band', coalesce((
          SELECT jsonb_agg(jsonb_build_object('label', b.band, 'count', b.cnt, 'amount', b.amt) ORDER BY b.sort)
          FROM (
            SELECT CASE
                     WHEN investment_amount < 1000000 THEN 'Under 1M'
                     WHEN investment_amount < 5000000 THEN '1M - 5M'
                     WHEN investment_amount < 20000000 THEN '5M - 20M'
                     ELSE '20M+'
                   END AS band,
                   CASE
                     WHEN investment_amount < 1000000 THEN 1
                     WHEN investment_amount < 5000000 THEN 2
                     WHEN investment_amount < 20000000 THEN 3
                     ELSE 4
                   END AS sort,
                   count(*) AS cnt, coalesce(sum(investment_amount),0) AS amt
            FROM investor_portfolios WHERE status = 'active' GROUP BY 1,2
          ) b
        ), '[]'::jsonb)
      )
    )
  ) INTO result;

  RETURN result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_partner_ops_range_report(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_partner_ops_range_report(date, date) TO authenticated, service_role;