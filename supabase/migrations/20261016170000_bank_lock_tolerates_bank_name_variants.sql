-- Bank-account lock: stop treating spelling variants of the SAME bank account as
-- a different account.
--
-- NOT YET APPLIED.
--
-- enforce_withdrawal_bank_account_lock compared account_key, which is
-- 'bank:' || <bank name with non-alphanumerics stripped> || ':' || <digits>.
-- The same account is spelled differently across the app and across time
-- ("EQUITY BANK", "Equity Bank Uganda", "Equity Bank Uganda Limited"), so a user
-- locked as "Equity Bank Uganda" was refused on account 1046103202361 when the
-- picker sent "Equity Bank Uganda Limited" (Nabukenya Hellen, 2026-10-15 15:47 UTC).
--
-- Rule now: a request is the locked account when the account NUMBER (digits) is
-- identical AND the normalised bank names are equal or one is a prefix of the
-- other (equitybank / equitybankuganda / equitybankugandalimited). Same digits at
-- an unrelated bank is still refused. Everything else in the function is
-- unchanged: scope guards, the "already registered to another user" check and the
-- first-use auto-lock.
--
-- locked_bank_accounts.account_key and payout_destination_key are NOT changed, so
-- no stored key moves. The function is not in critical_function_baselines
-- (checked 2026-10-16), so no re-baseline.

CREATE OR REPLACE FUNCTION public.enforce_withdrawal_bank_account_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text;
  v_lock public.locked_bank_accounts;
  v_new_bank text;
  v_lock_bank text;
  v_same_account boolean;
BEGIN
  IF NEW.payout_method IS DISTINCT FROM 'bank_transfer' THEN
    RETURN NEW;
  END IF;
  -- Not the user's own request: landlord payouts, system inserts, and staff or proxy requests on their behalf.
  IF NEW.landlord_payout_id IS NOT NULL OR auth.uid() IS NULL OR auth.uid() <> NEW.user_id THEN
    RETURN NEW;
  END IF;

  v_key := public.payout_destination_key('bank_transfer', NULL, NEW.bank_name, NEW.bank_account_number);
  IF v_key IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_lock FROM public.locked_bank_accounts WHERE user_id = NEW.user_id;

  IF v_lock.user_id IS NOT NULL THEN
    IF v_lock.account_key <> v_key THEN
      v_new_bank  := lower(regexp_replace(coalesce(NEW.bank_name, ''), '[^a-zA-Z0-9]', '', 'g'));
      v_lock_bank := lower(regexp_replace(coalesce(v_lock.bank_name, ''), '[^a-zA-Z0-9]', '', 'g'));
      v_same_account :=
        regexp_replace(coalesce(NEW.bank_account_number, ''), '\D', '', 'g')
          = regexp_replace(coalesce(v_lock.account_number, ''), '\D', '', 'g')
        AND (
          v_new_bank = '' OR v_lock_bank = ''
          OR v_new_bank LIKE v_lock_bank || '%'
          OR v_lock_bank LIKE v_new_bank || '%'
        );

      IF NOT v_same_account THEN
        RAISE EXCEPTION 'Your withdrawal bank account is locked (% ending %). To use a different account, apply for a change in Settings and Financial Ops will confirm it is yours.',
          v_lock.bank_name, right(regexp_replace(v_lock.account_number, '\D', '', 'g'), 4)
          USING ERRCODE = '28000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- First bank account this user has used: it is locked as it is saved.
  IF EXISTS (SELECT 1 FROM public.locked_bank_accounts WHERE account_key = v_key AND user_id <> NEW.user_id) THEN
    RAISE EXCEPTION 'That bank account is already registered to another user.' USING ERRCODE = '28000';
  END IF;
  INSERT INTO public.locked_bank_accounts (user_id, bank_name, account_number, account_name, account_key, source)
  VALUES (NEW.user_id, btrim(NEW.bank_name), btrim(NEW.bank_account_number),
          btrim(coalesce(NEW.bank_account_name, '')), v_key, 'saved')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

-- Nabukenya Hellen (bd266fc7): align her lock row with the spelling the app now
-- sends so her retry matches immediately. Guarded: no-op on re-run, or if
-- Financial Ops has already changed her lock.
UPDATE public.locked_bank_accounts
SET bank_name   = 'Equity Bank Uganda Limited',
    account_key = 'bank:equitybankugandalimited:1046103202361',
    updated_at  = now()
WHERE user_id = 'bd266fc7-1066-468a-8beb-347430d9d9b6'
  AND account_key = 'bank:equitybankuganda:1046103202361';
