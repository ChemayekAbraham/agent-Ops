DO $mig$
DECLARE
  d text;
  p text := '(w.linked_party IS NOT NULL OR EXISTS (SELECT 1 FROM investor_portfolios ipw WHERE ipw.investor_id = w.user_id))';
BEGIN
  d := pg_get_functiondef('public.get_partner_ops_range_report(date,date)'::regprocedure);

  -- series leg (already aliased w)
  d := replace(
    d,
    'FROM withdrawal_requests w WHERE w.status = ''completed'' AND w.linked_party IS NOT NULL AND w.updated_at >=',
    'FROM withdrawal_requests w WHERE w.status = ''completed'' AND ' || p || ' AND w.updated_at >='
  );

  -- kpi legs (unaliased)
  d := replace(
    d,
    'FROM withdrawal_requests WHERE status = ''completed'' AND linked_party IS NOT NULL AND updated_at >= d0 AND updated_at < d1',
    'FROM withdrawal_requests w WHERE w.status = ''completed'' AND ' || p || ' AND w.updated_at >= d0 AND w.updated_at < d1'
  );

  -- renewal top-up amount must only sum renewals that carried a top-up
  d := replace(
    d,
    '''renewal_topup_amount'', (SELECT coalesce(sum(top_up_amount),0) FROM portfolio_renewals WHERE created_at >= d0 AND created_at < d1 AND reversed_at IS NULL)',
    '''renewal_topup_amount'', (SELECT coalesce(sum(top_up_amount),0) FROM portfolio_renewals WHERE created_at >= d0 AND created_at < d1 AND reversed_at IS NULL AND coalesce(top_up_amount,0) > 0)'
  );

  -- new totals: 90-day renewal top-ups + all-time applied top-ups
  d := replace(
    d,
    '        ''backlog_count'',',
    '        ''renewal_topup_count_90d'', (SELECT count(*) FROM portfolio_renewals WHERE created_at >= (d1 - interval ''90 days'') AND created_at < d1 AND reversed_at IS NULL AND coalesce(top_up_amount,0) > 0),
        ''renewal_topup_amount_90d'', (SELECT coalesce(sum(top_up_amount),0) FROM portfolio_renewals WHERE created_at >= (d1 - interval ''90 days'') AND created_at < d1 AND reversed_at IS NULL AND coalesce(top_up_amount,0) > 0),
        ''applied_all_count'', (SELECT count(*) FROM pending_wallet_operations WHERE category = ''pending_portfolio_topup'' AND operation_type = ''portfolio_topup'' AND status = ''completed''),
        ''applied_all_amount'', (SELECT coalesce(sum(amount),0) FROM pending_wallet_operations WHERE category = ''pending_portfolio_topup'' AND operation_type = ''portfolio_topup'' AND status = ''completed''),
        ''backlog_count'','
  );

  IF position('applied_all_amount' in d) = 0 OR position('ipw.investor_id' in d) = 0 THEN
    RAISE EXCEPTION 'Partner ops report patch did not apply cleanly';
  END IF;

  EXECUTE d;
END $mig$;