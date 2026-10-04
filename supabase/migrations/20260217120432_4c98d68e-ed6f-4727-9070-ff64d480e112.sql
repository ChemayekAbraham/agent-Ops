-- Remove the notification trigger on user_loans
DROP TRIGGER IF EXISTS trg_notify_agents_credit_request ON public.user_loans;
DROP FUNCTION IF EXISTS public.notify_agents_on_credit_request();