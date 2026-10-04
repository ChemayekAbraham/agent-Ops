-- 1) One-off correction: debit Mbakureeba Joshua for portfolio WIP2607272004
DO $$
DECLARE
  v_portfolio_id uuid := 'fa02b796-3048-4ed5-9ba6-fd1f945dd42a';
  v_investor_id  uuid := '83f86f1c-ce49-472a-8dd4-4023ce060e10';
  v_code         text := 'WIP2607272004';
  v_amount       numeric := 2500000;
  v_existing     integer;
BEGIN
  SELECT COUNT(*) INTO v_existing
  FROM public.general_ledger
  WHERE idempotency_key = 'portfolio-funding-' || v_portfolio_id::text;

  IF v_existing = 0 THEN
    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_investor_id,
          'amount', v_amount,
          'direction', 'cash_out',
          'category', 'partner_funding',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'description', 'Wallet deduction for portfolio ' || v_code || ' (awaiting_partner_details backfill)',
          'source_table', 'investor_portfolios',
          'source_id', v_portfolio_id::text,
          'reference_id', v_code,
          'linked_party', 'platform'
        ),
        jsonb_build_object(
          'amount', v_amount,
          'direction', 'cash_in',
          'category', 'partner_funding',
          'ledger_scope', 'platform',
          'description', 'Platform capital received for portfolio ' || v_code || ' (awaiting_partner_details backfill)',
          'source_table', 'investor_portfolios',
          'source_id', v_portfolio_id::text,
          'reference_id', v_code,
          'linked_party', v_investor_id::text
        )
      ),
      idempotency_key := 'portfolio-funding-' || v_portfolio_id::text
    );
  END IF;
END $$;

-- 2) Enforce funding at portfolio creation via trigger (defense-in-depth)
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
         AND source_id = NEW.id::text
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

DROP TRIGGER IF EXISTS trg_enforce_portfolio_funding_at_creation ON public.investor_portfolios;
CREATE TRIGGER trg_enforce_portfolio_funding_at_creation
AFTER INSERT ON public.investor_portfolios
FOR EACH ROW
EXECUTE FUNCTION public.enforce_portfolio_funding_at_creation();