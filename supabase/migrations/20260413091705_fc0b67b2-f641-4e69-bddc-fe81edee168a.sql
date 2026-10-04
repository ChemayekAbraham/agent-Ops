-- Drop the redundant 2-parameter overload that causes ambiguity
-- The 3-parameter version already defaults skip_balance_check to false,
-- so it handles both cases.
DROP FUNCTION IF EXISTS public.create_ledger_transaction(jsonb, text);