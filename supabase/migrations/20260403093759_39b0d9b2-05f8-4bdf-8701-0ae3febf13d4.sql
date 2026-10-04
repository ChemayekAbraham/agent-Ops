DROP TRIGGER IF EXISTS trg_enforce_one_withdrawal_per_day ON public.withdrawal_requests;
DROP FUNCTION IF EXISTS public.enforce_one_withdrawal_per_day();