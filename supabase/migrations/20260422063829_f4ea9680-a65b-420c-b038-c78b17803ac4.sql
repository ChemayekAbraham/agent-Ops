-- Drop all duplicate / broken triggers
DROP TRIGGER IF EXISTS on_profile_referral ON public.profiles;
DROP TRIGGER IF EXISTS trg_credit_referral_bonus ON public.profiles;
DROP TRIGGER IF EXISTS trg_credit_signup_bonus_insert ON public.referrals;
DROP TRIGGER IF EXISTS trg_credit_signup_bonus_update ON public.referrals;
DROP TRIGGER IF EXISTS trg_credit_signup_referral_bonus ON public.referrals;

-- Trigger 1: when a new profile is created with referrer_id, insert a referrals row
CREATE OR REPLACE FUNCTION public.credit_referral_bonus()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.referrer_id IS NULL OR NEW.referrer_id = NEW.id THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.referrals (referrer_id, referred_id, bonus_amount, credited)
  VALUES (NEW.referrer_id, NEW.id, 500, false)
  ON CONFLICT (referrer_id, referred_id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'credit_referral_bonus failed for profile %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

-- Trigger 2: when a referrals row is created, post the double-entry ledger
CREATE OR REPLACE FUNCTION public.credit_signup_referral_bonus()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group TEXT;
  v_exists BOOLEAN;
BEGIN
  IF NEW.bonus_amount IS NULL OR NEW.bonus_amount <= 0 THEN
    RETURN NEW;
  END IF;

  v_group := 'referral-bonus-' || NEW.id::text;

  -- idempotency
  SELECT EXISTS (
    SELECT 1 FROM public.general_ledger WHERE transaction_group_id = v_group
  ) INTO v_exists;

  IF v_exists THEN
    RETURN NEW;
  END IF;

  -- Layer-4 ledger guard authorization
  PERFORM set_config('wallet.sync_authorized', 'true', true);
  PERFORM set_config('ledger.authorized', 'true', true);

  -- Balanced double-entry: marketing expense (platform) + referral bonus to wallet
  PERFORM public.create_ledger_transaction(
    p_transaction_group_id := v_group,
    p_description := 'Referral signup bonus — ' || NEW.referred_id::text,
    p_entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', NEW.referrer_id,
        'category', 'marketing_expense',
        'direction', 'cash_out',
        'amount', NEW.bonus_amount,
        'scope', 'platform',
        'description', 'Referral bonus payout (platform expense)'
      ),
      jsonb_build_object(
        'user_id', NEW.referrer_id,
        'category', 'referral_bonus',
        'direction', 'cash_in',
        'amount', NEW.bonus_amount,
        'scope', 'wallet',
        'description', 'Referral bonus — friend signed up via your link'
      )
    )
  );

  -- mark credited (bypass UPDATE deny RLS via SECURITY DEFINER)
  UPDATE public.referrals
     SET credited = true,
         credited_at = now()
   WHERE id = NEW.id;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'credit_signup_referral_bonus failed for referral %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

-- Re-attach exactly one trigger per table
CREATE TRIGGER trg_credit_referral_bonus
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  WHEN (NEW.referrer_id IS NOT NULL)
  EXECUTE FUNCTION public.credit_referral_bonus();

CREATE TRIGGER trg_credit_signup_referral_bonus
  AFTER INSERT ON public.referrals
  FOR EACH ROW
  WHEN (NEW.bonus_amount > 0)
  EXECUTE FUNCTION public.credit_signup_referral_bonus();