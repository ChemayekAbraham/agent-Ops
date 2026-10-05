DROP TRIGGER IF EXISTS trg_credit_promissory_portfolio_creation ON public.investor_portfolios;
DROP FUNCTION IF EXISTS public.trg_credit_promissory_portfolio_creation();

CREATE OR REPLACE FUNCTION public.trg_credit_promissory_portfolio_topup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner_id uuid;
BEGIN
  IF NEW.operation_type = 'portfolio_topup'
     AND NEW.source_table = 'investor_portfolios'
     AND NEW.source_id IS NOT NULL
     AND coalesce(NEW.amount, 0) > 0
     AND NEW.status = 'approved'
     AND (TG_OP = 'INSERT' OR coalesce(OLD.status, '') IS DISTINCT FROM NEW.status) THEN
    SELECT ip.investor_id
      INTO v_partner_id
      FROM public.investor_portfolios ip
     WHERE ip.id = NEW.source_id;

    PERFORM public.try_credit_promissory_agent_commission(
      coalesce(v_partner_id, NEW.user_id),
      NEW.amount,
      'portfolio_topup',
      'pending_wallet_operations',
      NEW.id,
      NEW.id::text
    );
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.trg_credit_promissory_portfolio_topup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_credit_promissory_portfolio_topup() TO service_role;