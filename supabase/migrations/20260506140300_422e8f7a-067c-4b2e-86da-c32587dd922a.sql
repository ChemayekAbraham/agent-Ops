ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_wallet_id_fkey;

ALTER TABLE public.wallets RENAME TO wallets_physical;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_wallet_id_fkey
  FOREIGN KEY (wallet_id) REFERENCES public.wallets_physical(id) ON DELETE SET NULL;

CREATE OR REPLACE VIEW public.wallets
WITH (security_invoker = true) AS
SELECT
    wp.id,
    wp.user_id,
    COALESCE(vs.total_visible, 0)::numeric         AS balance,
    wp.created_at,
    wp.updated_at,
    wp.locked_balance,
    wp.currency,
    COALESCE(vs.withdrawable, 0)::numeric          AS withdrawable_balance,
    COALESCE(vs.float_balance, 0)::numeric         AS float_balance,
    COALESCE(vs.advance_balance, 0)::numeric       AS advance_balance
FROM public.wallets_physical wp
LEFT JOIN public.v_user_wallet_strict vs ON vs.user_id = wp.user_id;

GRANT SELECT ON public.wallets TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.wallets_view_dml()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.wallets_physical (
            id, user_id, balance, created_at, updated_at, locked_balance, currency,
            withdrawable_balance, float_balance, advance_balance
        ) VALUES (
            COALESCE(NEW.id, gen_random_uuid()),
            NEW.user_id,
            COALESCE(NEW.balance, 0),
            COALESCE(NEW.created_at, now()),
            COALESCE(NEW.updated_at, now()),
            COALESCE(NEW.locked_balance, 0),
            COALESCE(NEW.currency, 'UGX'),
            COALESCE(NEW.withdrawable_balance, 0),
            COALESCE(NEW.float_balance, 0),
            COALESCE(NEW.advance_balance, 0)
        );
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        UPDATE public.wallets_physical SET
            balance              = COALESCE(NEW.balance, balance),
            withdrawable_balance = COALESCE(NEW.withdrawable_balance, withdrawable_balance),
            float_balance        = COALESCE(NEW.float_balance, float_balance),
            advance_balance      = COALESCE(NEW.advance_balance, advance_balance),
            locked_balance       = COALESCE(NEW.locked_balance, locked_balance),
            currency             = COALESCE(NEW.currency, currency),
            updated_at           = now()
        WHERE id = OLD.id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        DELETE FROM public.wallets_physical WHERE id = OLD.id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS instead_of_wallets_dml ON public.wallets;
CREATE TRIGGER instead_of_wallets_dml
INSTEAD OF INSERT OR UPDATE OR DELETE ON public.wallets
FOR EACH ROW EXECUTE FUNCTION public.wallets_view_dml();

NOTIFY pgrst, 'reload schema';