SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.get_partner_wallet_hub(
  p_user_id uuid,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  withdrawable_amount numeric,
  float_amount numeric,
  advance_amount numeric,
  roi_amount numeric,
  deposits_amount numeric,
  total_available numeric,
  pending_holds numeric,
  restricted_held numeric,
  recent_transactions jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH wallet_summary AS (
    SELECT
      COALESCE((gwv ->> 'withdrawable')::numeric, 0) AS withdrawable,
      COALESCE((gwv ->> 'float_balance')::numeric, 0) AS float_balance,
      COALESCE((gwv ->> 'advance_balance')::numeric, 0) AS advance_balance,
      COALESCE((gwv ->> 'pending_holds')::numeric, 0) AS pending_holds,
      COALESCE((gwv ->> 'restricted_held')::numeric, 0) AS restricted_held
    FROM public.get_user_wallet_view(p_user_id) AS gwv
  ),
  portfolio_summary AS (
    SELECT
      COALESCE(SUM(ip.total_roi_earned), 0) AS roi,
      COALESCE(SUM(ip.investment_amount), 0) AS deposits
    FROM public.investor_portfolios ip
    WHERE ip.investor_id = p_user_id
      AND ip.status IN ('active', 'funded', 'repaying', 'paused', 'locked', 'pending_activation')
  ),
  recent_tx AS (
    SELECT
      gl.id,
      gl.transaction_date,
      gl.amount,
      gl.direction,
      gl.category,
      gl.description,
      gl.reference_id,
      gl.linked_party,
      gl.source_table,
      gl.source_id,
      gl.classification,
      gl.created_at
    FROM public.general_ledger gl
    WHERE gl.user_id = p_user_id
      AND (
        gl.ledger_scope IN ('wallet', 'bridge')
        OR (
          gl.ledger_scope = 'platform'
          AND gl.category IN (
            'supporter_rent_fund',
            'partner_funding',
            'roi_wallet_credit',
            'roi_payout',
            'roi_accrual',
            'angel_pool_contribution',
            'angel_pool_refund',
            'portfolio_topup',
            'portfolio_redemption',
            'portfolio_principal_lock',
            'managed_proxy_payout',
            'proxy_partner_withdrawal'
          )
        )
      )
      AND public.is_customer_wallet_history_visible(
        p_user_id,
        gl.classification,
        gl.category,
        gl.source_table,
        gl.description,
        gl.reference_id,
        gl.source_id
      )
    ORDER BY gl.transaction_date DESC, gl.created_at DESC
    LIMIT p_limit
    OFFSET p_offset
  )
  SELECT
    ws.withdrawable,
    ws.float_balance,
    ws.advance_balance,
    ps.roi,
    ps.deposits,
    (ws.withdrawable + ws.float_balance + ps.roi),
    ws.pending_holds,
    ws.restricted_held,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', rt.id,
          'transaction_date', rt.transaction_date,
          'amount', rt.amount,
          'direction', rt.direction,
          'category', rt.category,
          'description', rt.description,
          'reference_id', rt.reference_id,
          'linked_party', rt.linked_party,
          'source_table', rt.source_table,
          'source_id', rt.source_id,
          'classification', rt.classification
        )
        ORDER BY rt.transaction_date DESC, rt.created_at DESC
      ) FILTER (WHERE rt.id IS NOT NULL),
      '[]'::jsonb
    ) AS recent_transactions
  FROM wallet_summary ws
  CROSS JOIN portfolio_summary ps
  LEFT JOIN recent_tx rt ON true
  GROUP BY ws.withdrawable, ws.float_balance, ws.advance_balance, ws.pending_holds,
           ws.restricted_held, ps.roi, ps.deposits;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_partner_wallet_hub(uuid, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_partner_wallet_hub(uuid, integer, integer) TO service_role;