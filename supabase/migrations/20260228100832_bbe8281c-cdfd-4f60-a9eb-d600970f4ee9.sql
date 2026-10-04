
-- Server-side aggregation for manager wallet dashboard stats
-- Replaces client-side reduce() over unbounded arrays

CREATE OR REPLACE FUNCTION public.get_wallet_ops_stats(
  p_period TEXT DEFAULT '30d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from TIMESTAMPTZ;
  v_result JSON;
BEGIN
  -- Calculate date range
  CASE p_period
    WHEN '7d' THEN v_from := NOW() - INTERVAL '7 days';
    WHEN '30d' THEN v_from := NOW() - INTERVAL '30 days';
    WHEN 'month' THEN v_from := date_trunc('month', NOW());
    ELSE v_from := NULL; -- 'all'
  END CASE;

  SELECT json_build_object(
    'totalCashIn', COALESCE(d.approved_amount, 0),
    'totalCashOut', COALESCE(w.approved_amount, 0),
    'netBalance', COALESCE(d.approved_amount, 0) - COALESCE(w.approved_amount, 0),
    'depositCount', COALESCE(d.total_count, 0),
    'withdrawalCount', COALESCE(w.total_count, 0),
    'approvedWithdrawals', COALESCE(w.approved_count, 0),
    'rejectedWithdrawals', COALESCE(w.rejected_count, 0),
    'pendingWithdrawals', COALESCE(w.pending_count, 0),
    'approvedDeposits', COALESCE(d.approved_count, 0),
    'totalApprovedWithdrawalAmount', COALESCE(w.approved_amount, 0),
    'totalRejectedWithdrawalAmount', COALESCE(w.rejected_amount, 0),
    'totalPendingWithdrawalAmount', COALESCE(w.pending_amount, 0),
    'totalApprovedDepositAmount', COALESCE(d.approved_amount, 0),
    'pendingDeposits', COALESCE(d.pending_count, 0),
    'pendingDepositAmount', COALESCE(d.pending_amount, 0),
    'todayApprovedDeposits', COALESCE(d.today_approved_count, 0),
    'todayApprovedDepositAmount', COALESCE(d.today_approved_amount, 0)
  ) INTO v_result
  FROM
    (SELECT
      COUNT(*) AS total_count,
      COUNT(*) FILTER (WHERE status = 'approved') AS approved_count,
      COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
      COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0) AS approved_amount,
      COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) AS pending_amount,
      COUNT(*) FILTER (WHERE status = 'approved' AND created_at >= date_trunc('day', NOW())) AS today_approved_count,
      COALESCE(SUM(amount) FILTER (WHERE status = 'approved' AND created_at >= date_trunc('day', NOW())), 0) AS today_approved_amount
    FROM deposit_requests
    WHERE (v_from IS NULL OR created_at >= v_from)
    ) d,
    (SELECT
      COUNT(*) AS total_count,
      COUNT(*) FILTER (WHERE status = 'approved') AS approved_count,
      COUNT(*) FILTER (WHERE status = 'rejected') AS rejected_count,
      COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
      COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0) AS approved_amount,
      COALESCE(SUM(amount) FILTER (WHERE status = 'rejected'), 0) AS rejected_amount,
      COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) AS pending_amount
    FROM withdrawal_requests
    WHERE (v_from IS NULL OR created_at >= v_from)
    ) w;

  RETURN v_result;
END;
$$;

-- Only managers/staff can call this
REVOKE ALL ON FUNCTION public.get_wallet_ops_stats(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_wallet_ops_stats(TEXT) FROM anon;
