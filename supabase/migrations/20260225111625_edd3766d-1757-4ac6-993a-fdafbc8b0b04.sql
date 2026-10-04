
-- Prohibit manual/direct balance adjustments by managers
-- All balance changes must go through pending_wallet_operations approval flow

-- 1. Drop the policy that allows managers to directly update wallet balances
DROP POLICY IF EXISTS "Managers can update wallets" ON public.wallets;

-- 2. Drop the policy that allows managers to insert wallet_transactions directly
DROP POLICY IF EXISTS "Managers can insert wallet transactions" ON public.wallet_transactions;

-- 3. Also block direct inserts to general_ledger from authenticated users
-- (system triggers and service_role can still insert)
DROP POLICY IF EXISTS "Managers can insert ledger entries" ON public.general_ledger;

-- 4. Explicitly deny authenticated INSERT on general_ledger 
-- (only service_role / SECURITY DEFINER functions should write here)
DO $$
BEGIN
  -- Check if there's any permissive INSERT policy on general_ledger for authenticated
  -- and drop it
  PERFORM 1 FROM pg_policies 
  WHERE schemaname = 'public' 
    AND tablename = 'general_ledger' 
    AND cmd = 'INSERT'
    AND permissive = 'PERMISSIVE';
END$$;

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
