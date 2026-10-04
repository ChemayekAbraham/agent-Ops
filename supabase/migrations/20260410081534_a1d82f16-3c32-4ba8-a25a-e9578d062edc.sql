-- Drop the rogue trigger that creates unbalanced ledger entries on deposit approval
DROP TRIGGER IF EXISTS trg_deposit_to_ledger ON public.deposit_requests;

-- Drop the associated function
DROP FUNCTION IF EXISTS public.log_deposit_to_ledger();