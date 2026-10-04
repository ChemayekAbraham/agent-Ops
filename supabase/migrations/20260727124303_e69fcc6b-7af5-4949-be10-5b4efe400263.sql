CREATE OR REPLACE FUNCTION public.enforce_portfolio_funding_at_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing integer;
  v_idem text;
BEGIN
  IF NEW.investor_id IS NULL OR NEW.investment_amount IS NULL OR NEW.investment_amount <= 0 THEN
    RETURN NEW;
  END IF;

  v_idem := 'portfolio-funding-' || NEW.id::text;

  SELECT COUNT(*) INTO v_existing
  FROM public.general_ledger
  WHERE idempotency_key = v_idem
     OR (source_table = 'investor_portfolios'
         AND source_id = NEW.id
         AND ledger_scope = 'wallet'
         AND direction = 'cash_out'
         AND category IN ('partner_funding','portfolio_topup'));

  IF v_existing > 0 THEN
    RETURN NEW;
  END IF;

  PERFORM public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', NEW.investor_id,
        'amount', NEW.investment_amount,
        'direction', 'cash_out',
        'category', 'partner_funding',
        'ledger_scope', 'wallet',
        'recipient_type', 'user',
        'description', 'Wallet deduction for portfolio ' || COALESCE(NEW.portfolio_code,'') || ' (auto — creation trigger)',
        'source_table', 'investor_portfolios',
        'source_id', NEW.id::text,
        'reference_id', NEW.portfolio_code,
        'linked_party', 'platform'
      ),
      jsonb_build_object(
        'amount', NEW.investment_amount,
        'direction', 'cash_in',
        'category', 'partner_funding',
        'ledger_scope', 'platform',
        'description', 'Platform capital received for portfolio ' || COALESCE(NEW.portfolio_code,'') || ' (auto — creation trigger)',
        'source_table', 'investor_portfolios',
        'source_id', NEW.id::text,
        'reference_id', NEW.portfolio_code,
        'linked_party', NEW.investor_id::text
      )
    ),
    idempotency_key := v_idem
  );

  RETURN NEW;
END $$;