-- 1. Control switch row
INSERT INTO public.treasury_controls (control_key, enabled)
VALUES ('advance_withdrawals_paused', false)
ON CONFLICT (control_key) DO NOTHING;

-- 2. Advance-funded (unspent) portion of a user's withdrawable wallet money.
--    FIFO-lite: total advance credits into the wallet minus every wallet
--    outflow that happened at/after the first advance credit. Once the agent
--    has spent the advance money, nothing is locked.
CREATE OR REPLACE FUNCTION public.get_advance_locked_withdrawable(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH credits AS (
    SELECT COALESCE(SUM(amount), 0)::numeric AS total,
           MIN(transaction_date) AS first_at
    FROM public.general_ledger
    WHERE user_id = p_user_id
      AND ledger_scope = 'wallet'
      AND direction = 'cash_in'
      AND category = 'agent_advance_credit'
      AND COALESCE(classification, 'production') <> 'admin_correction'
  ),
  outflows AS (
    SELECT COALESCE(SUM(g.amount), 0)::numeric AS total
    FROM public.general_ledger g, credits c
    WHERE g.user_id = p_user_id
      AND g.ledger_scope = 'wallet'
      AND g.direction = 'cash_out'
      AND c.first_at IS NOT NULL
      AND g.transaction_date >= c.first_at
      AND COALESCE(g.classification, 'production') <> 'admin_correction'
      AND g.category <> 'system_balance_correction'
  )
  SELECT GREATEST(0::numeric, (SELECT total FROM credits) - (SELECT total FROM outflows));
$$;

GRANT EXECUTE ON FUNCTION public.get_advance_locked_withdrawable(uuid) TO authenticated, service_role;

-- 3. Central withdrawable gate now honours the halt.
CREATE OR REPLACE FUNCTION public.get_user_available_balance(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(
    0::numeric,
    COALESCE((
      SELECT withdrawable FROM public.wallet_balances_projection WHERE user_id = p_user_id
    ), 0::numeric)
    - public.funder_pending_hold(p_user_id)
    - CASE
        WHEN COALESCE((
          SELECT enabled FROM public.treasury_controls
          WHERE control_key = 'advance_withdrawals_paused'
        ), false)
        THEN public.get_advance_locked_withdrawable(p_user_id)
        ELSE 0::numeric
      END
  );
$$;
