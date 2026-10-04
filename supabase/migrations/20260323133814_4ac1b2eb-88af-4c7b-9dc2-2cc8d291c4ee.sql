CREATE OR REPLACE FUNCTION public.get_financial_ops_pulse()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'pending_deposits', (
      SELECT jsonb_build_object('count', count(*)::int, 'amount', coalesce(sum(amount), 0))
      FROM deposit_requests WHERE status = 'pending'
    ),
    'pending_withdrawals', (
      SELECT jsonb_build_object('count', count(*)::int, 'amount', coalesce(sum(amount), 0))
      FROM investment_withdrawal_requests WHERE status = 'pending'
    ),
    'pending_wallet_withdrawals', (
      SELECT jsonb_build_object('count', count(*)::int, 'amount', coalesce(sum(amount), 0))
      FROM withdrawal_requests WHERE status IN ('pending', 'requested', 'manager_approved', 'cfo_approved')
    ),
    'pending_wallet_ops', (
      SELECT jsonb_build_object('count', count(*)::int, 'amount', coalesce(sum(amount), 0))
      FROM pending_wallet_operations WHERE status = 'pending'
    ),
    'today_volume', (
      SELECT jsonb_build_object('count', count(*)::int, 'amount', coalesce(sum(amount), 0))
      FROM general_ledger WHERE transaction_date >= CURRENT_DATE
    )
  );
$$;