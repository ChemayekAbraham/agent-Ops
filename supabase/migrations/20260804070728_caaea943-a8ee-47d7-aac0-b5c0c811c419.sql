
CREATE OR REPLACE FUNCTION public.enforce_portfolio_funding_at_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_existing integer;
  v_idem text;
BEGIN
  IF NEW.investor_id IS NULL OR NEW.investment_amount IS NULL OR NEW.investment_amount <= 0 THEN
    RETURN NEW;
  END IF;

  v_idem := 'portfolio-funding-' || NEW.id::text;

  -- Duplicate guard: any wallet-side funding deduction already recorded for this
  -- portfolio counts, regardless of which source_table the app path stamped.
  SELECT COUNT(*) INTO v_existing
  FROM public.general_ledger g
  WHERE g.idempotency_key = v_idem
     OR (
          g.ledger_scope = 'wallet'
          AND g.direction = 'cash_out'
          AND g.category IN ('partner_funding','portfolio_topup')
          AND (
            -- same portfolio row
            (g.source_table = 'investor_portfolios' AND g.source_id = NEW.id::text)
            -- same portfolio reference code
            OR (NEW.portfolio_code IS NOT NULL AND g.reference_id = NEW.portfolio_code)
            -- app path posted the same partner + amount moments before/after this insert
            OR (
                 g.user_id = NEW.investor_id
                 AND g.amount = NEW.investment_amount
                 AND g.created_at >= now() - interval '30 minutes'
                 AND g.created_at <= now() + interval '30 minutes'
               )
          )
        );

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
END $function$;
