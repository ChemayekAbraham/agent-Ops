ALTER TABLE public.angel_pool_investments
  ALTER COLUMN shares TYPE numeric(20,6) USING shares::numeric;

CREATE OR REPLACE FUNCTION public.enforce_angel_share_amount_match()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_price constant numeric := 20000;
  v_expected numeric;
BEGIN
  IF NEW.shares IS NULL OR NEW.amount IS NULL THEN
    RETURN NEW;
  END IF;
  v_expected := round(NEW.shares * v_price);
  IF abs(NEW.amount - v_expected) > 1 THEN
    RAISE EXCEPTION 'angel_pool_investments: amount (%) must equal shares (%) * 20000 = %',
      NEW.amount, NEW.shares, v_expected;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_angel_share_amount_match ON public.angel_pool_investments;
CREATE TRIGGER trg_enforce_angel_share_amount_match
BEFORE INSERT OR UPDATE OF shares, amount ON public.angel_pool_investments
FOR EACH ROW EXECUTE FUNCTION public.enforce_angel_share_amount_match();