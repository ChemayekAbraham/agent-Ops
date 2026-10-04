-- Permanent fix: make the public.wallets VIEW accept INSERT/UPSERT calls
-- by redirecting them to wallets_physical. This unblocks any legacy code path
-- (agent-deposit, cfo-direct-credit, import-partners, register-proxy-funder, etc.)
-- that still issues INSERT INTO wallets.
--
-- The view's `balance`, `withdrawable_balance`, `float_balance`, `advance_balance`
-- columns are COMPUTED from the strict ledger view — they cannot be written.
-- The trigger silently drops those values (writes are ledger-driven, not cache-driven,
-- per the WALLET SOLE WRITER constitution rule).

CREATE OR REPLACE FUNCTION public.wallets_view_instead_of_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'wallets insert requires user_id';
  END IF;

  INSERT INTO public.wallets_physical (user_id, locked_balance, currency)
  VALUES (
    NEW.user_id,
    COALESCE(NEW.locked_balance, 0),
    COALESCE(NEW.currency, 'UGX')
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- Re-read the row through the view so RETURNING works
  SELECT * INTO NEW FROM public.wallets WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wallets_view_instead_of_insert ON public.wallets;
CREATE TRIGGER wallets_view_instead_of_insert
  INSTEAD OF INSERT ON public.wallets
  FOR EACH ROW
  EXECUTE FUNCTION public.wallets_view_instead_of_insert();

-- Symmetrical UPDATE handler so .upsert(...) (PostgREST issues an UPDATE branch)
-- and any stray UPDATE wallets SET locked_balance / currency calls succeed.
-- Bucket fields remain ignored because they are computed.
CREATE OR REPLACE FUNCTION public.wallets_view_instead_of_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.wallets_physical
  SET
    locked_balance = COALESCE(NEW.locked_balance, locked_balance),
    currency = COALESCE(NEW.currency, currency),
    updated_at = now()
  WHERE user_id = OLD.user_id;

  SELECT * INTO NEW FROM public.wallets WHERE user_id = OLD.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wallets_view_instead_of_update ON public.wallets;
CREATE TRIGGER wallets_view_instead_of_update
  INSTEAD OF UPDATE ON public.wallets
  FOR EACH ROW
  EXECUTE FUNCTION public.wallets_view_instead_of_update();