
-- Remove non-critical tables from realtime to reduce connection overhead
-- Keep ONLY: messages, wallets, force_refresh_signals
DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'notifications','profiles','rent_requests','agent_earnings',
      'agent_commission_payouts','deposit_requests','withdrawal_requests',
      'agent_subagents','subscription_charges','manager_investment_requests',
      'opportunity_summaries','welile_homes_withdrawals','wallet_transactions',
      'money_requests','product_orders','referrals','user_receipts'
    ])
  LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', tbl);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END $$;

-- Server-side RPC for velocity detection (replaces client-side grouping)
CREATE OR REPLACE FUNCTION public.detect_velocity_abuse(p_window_minutes int DEFAULT 60, p_threshold int DEFAULT 5)
RETURNS TABLE(user_id uuid, deposit_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT dr.user_id, count(*) as deposit_count
  FROM public.deposit_requests dr
  WHERE dr.status = 'pending'
    AND dr.created_at >= now() - (p_window_minutes || ' minutes')::interval
  GROUP BY dr.user_id
  HAVING count(*) > p_threshold;
$$;
