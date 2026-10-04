
-- Auto-assign ledger_scope on INSERT based on category
CREATE OR REPLACE FUNCTION public.auto_assign_ledger_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Platform-only categories
  IF NEW.category IN (
    'pool_rent_deployment',
    'platform_service_income',
    'agent_commission_payout',
    'supporter_platform_rewards',
    'transaction_platform_expenses',
    'operational_expenses',
    'opening_balance'
  ) THEN
    NEW.ledger_scope := 'platform';
  -- Bridge categories (appear in both user + platform views)
  ELSIF NEW.category IN (
    'supporter_facilitation_capital',
    'rent_facilitation_payout',
    'agent_commission'
  ) THEN
    NEW.ledger_scope := 'bridge';
  ELSE
    NEW.ledger_scope := 'wallet';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_ledger_scope
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_assign_ledger_scope();
