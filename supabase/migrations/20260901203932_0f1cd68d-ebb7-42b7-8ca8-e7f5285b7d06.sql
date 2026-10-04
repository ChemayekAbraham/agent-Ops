CREATE OR REPLACE FUNCTION public.guard_investor_portfolio_self_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_privileged boolean;
BEGIN
  -- Only guard direct edits made by the portfolio owner as a signed-in user.
  IF v_uid IS NULL OR v_uid IS DISTINCT FROM NEW.investor_id THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = v_uid
       AND ur.role IN ('super_admin','admin','manager','ceo','coo','cfo',
                       'financial_ops','partner_ops','operations')
  ) INTO v_privileged;

  IF v_privileged THEN
    RETURN NEW;
  END IF;

  IF to_jsonb(NEW) - 'account_name' - 'updated_at'
     IS DISTINCT FROM to_jsonb(OLD) - 'account_name' - 'updated_at' THEN
    RAISE EXCEPTION 'PORTFOLIO_FIELD_LOCKED'
      USING HINT = 'You can only change the account name on your own portfolio.',
            ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_investor_portfolio_self_edit ON public.investor_portfolios;
CREATE TRIGGER trg_guard_investor_portfolio_self_edit
BEFORE UPDATE ON public.investor_portfolios
FOR EACH ROW EXECUTE FUNCTION public.guard_investor_portfolio_self_edit();

REVOKE EXECUTE ON FUNCTION public.guard_investor_portfolio_self_edit() FROM PUBLIC, anon, authenticated;