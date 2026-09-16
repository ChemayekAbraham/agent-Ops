-- Everything a partner's portfolio statement needs, in one call.
--
-- WHY AN RPC AND NOT A QUERY
-- The statement has to show when Returns were compounded, and those events live
-- in `audit_logs`, which a partner may not read - the only SELECT policy on
-- that table is manager or CEO. A partner reading their own compounding history
-- is entirely reasonable; reading the audit log is not. So the server assembles
-- the statement and returns only the partner's own rows.
--
-- Scope is proved from `auth.uid()`, never from a parameter: `p_portfolio_id`
-- can narrow the result to one portfolio but can never reach another person's.
--
-- Read-only. No wallet, ledger or portfolio state is touched.
CREATE OR REPLACE FUNCTION public.my_portfolio_statement(p_portfolio_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'not_signed_in');
  END IF;

  SELECT jsonb_build_object(
    'generated_at', now(),
    'partner', (
      SELECT jsonb_build_object(
               'name', pr.full_name,
               'phone', pr.phone,
               'mobile_money', pr.mobile_money_number)
        FROM public.profiles pr WHERE pr.id = v_uid
    ),
    'payouts_total', (
      SELECT jsonb_build_object(
               'count', count(*),
               'amount', coalesce(sum(w.amount), 0))
        FROM public.withdrawal_requests w
       WHERE w.user_id = v_uid AND w.status IN ('completed', 'approved')
    ),
    'portfolios', coalesce((
      SELECT jsonb_agg(p ORDER BY p->>'start_date')
        FROM (
          SELECT jsonb_build_object(
            'id', ip.id,
            'code', ip.portfolio_code,
            'name', ip.account_name,
            'status', ip.status,
            'roi_mode', ip.roi_mode,
            'rate', ip.roi_percentage,
            'current_value', ip.investment_amount,
            'start_date', ip.created_at::date,
            'maturity_date', ip.maturity_date,
            'days_left', (ip.maturity_date - current_date),
            'next_roi_date', ip.next_roi_date,
            'duration_months', ip.duration_months,
            'auto_reinvest', coalesce(ip.auto_reinvest, false),

            -- Returns folded back into the principal.
            'compounds', coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                       'date', a.created_at::date,
                       'amount', (a.metadata->>'roi_amount')::numeric,
                       'reference', a.metadata->>'reference')
                     ORDER BY a.created_at)
                FROM public.audit_logs a
               WHERE a.action_type = 'roi_compounded'
                 AND a.table_name = 'investor_portfolios'
                 AND a.record_id = ip.id::text
            ), '[]'::jsonb),

            'renewals', coalesce((
              SELECT jsonb_agg(jsonb_build_object('date', r.created_at::date)
                     ORDER BY r.created_at)
                FROM public.portfolio_renewals r WHERE r.portfolio_id = ip.id
            ), '[]'::jsonb),

            -- Office corrections and closures. Amounts are deliberately not
            -- exposed: the partner sees THAT a correction happened, and the
            -- balance already reflects it.
            'changes', coalesce((
              SELECT jsonb_agg(c ORDER BY c->>'date')
                FROM (
                  SELECT jsonb_build_object('date', a.created_at::date,
                                            'what', 'Amount corrected by the office') AS c
                    FROM public.audit_logs a
                   WHERE a.action_type = 'edit_investment_portfolio'
                     AND a.table_name = 'investor_portfolios'
                     AND a.record_id = ip.id::text
                  UNION ALL
                  SELECT jsonb_build_object('date', d.created_at::date,
                                            'what', 'Closed and paid back')
                    FROM public.portfolio_redemptions d WHERE d.portfolio_id = ip.id
                ) q
            ), '[]'::jsonb),

            -- Only payouts that actually name this portfolio.
            'payouts', coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                       'date', (w.processed_at AT TIME ZONE 'Africa/Kampala')::date,
                       'amount', w.amount,
                       'reference', w.fin_ops_reference)
                     ORDER BY w.processed_at)
                FROM public.withdrawal_requests w
               WHERE w.user_id = v_uid
                 AND w.status = 'completed'
                 AND w.payout_route_ref = 'portfolio:' || ip.id::text
            ), '[]'::jsonb)
          ) AS p
            FROM public.investor_portfolios ip
           WHERE ip.investor_id = v_uid
             AND (p_portfolio_id IS NULL OR ip.id = p_portfolio_id)
        ) s
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.my_portfolio_statement(uuid) IS
  'The caller''s own portfolio statement: details plus compounds, renewals, office changes and portfolio-linked payouts. Compounding history lives in audit_logs, which partners cannot read directly.';

GRANT EXECUTE ON FUNCTION public.my_portfolio_statement(uuid) TO authenticated;
