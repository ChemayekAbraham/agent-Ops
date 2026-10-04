
-- ============================================================
-- Fix: Replace legacy referral bonus triggers with ledger-compliant versions
-- ============================================================

-- 1. Replace credit_referral_bonus (fires on profiles INSERT)
--    - Still creates the referrals record
--    - Sets bonus_amount = 0 for sub-agent registrations (handled by activate-supporter RPC)
--    - Sets bonus_amount = 500 for regular referrals
--    - Removes legacy agent_earnings insert
CREATE OR REPLACE FUNCTION public.credit_referral_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referrer_role TEXT;
  v_bonus_amount NUMERIC := 500;
BEGIN
  -- Only process if the new profile has a referrer
  IF NEW.referrer_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if referrer is an agent and new user will be a sub-agent
  SELECT role INTO v_referrer_role
  FROM public.profiles
  WHERE id = NEW.referrer_id;

  -- If the referrer is an agent, this is a sub-agent registration
  -- Set bonus to 0 because activate-supporter RPC handles the 10,000 bonus
  IF v_referrer_role = 'agent' AND NEW.role = 'agent' THEN
    v_bonus_amount := 0;
  END IF;

  -- Create referral record (idempotent: unique constraint on referred_user_id)
  INSERT INTO public.referrals (
    referrer_id,
    referred_user_id,
    bonus_amount,
    credited
  ) VALUES (
    NEW.referrer_id,
    NEW.id,
    v_bonus_amount,
    CASE WHEN v_bonus_amount > 0 THEN TRUE ELSE FALSE END
  )
  ON CONFLICT (referred_user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- 2. Replace credit_signup_referral_bonus (fires on referrals INSERT/UPDATE)
--    - Removes direct wallet UPDATE (was violating single-writer principle)
--    - Uses proper double-entry ledger with deterministic transaction_group_id
--    - Idempotency guard: checks for existing ledger entries before inserting
CREATE OR REPLACE FUNCTION public.credit_signup_referral_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn_group TEXT;
  v_wallet_id UUID;
BEGIN
  -- Only process when credited becomes true and bonus > 0
  IF NEW.credited IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF NEW.bonus_amount IS NULL OR NEW.bonus_amount <= 0 THEN
    RETURN NEW;
  END IF;

  -- Deterministic transaction group for idempotency
  v_txn_group := 'referral-bonus-' || NEW.id::TEXT;

  -- Idempotency check: skip if already credited
  IF EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE transaction_group_id = v_txn_group
    LIMIT 1
  ) THEN
    RETURN NEW;
  END IF;

  -- Get or create wallet for the referrer
  SELECT id INTO v_wallet_id
  FROM public.wallets
  WHERE user_id = NEW.referrer_id;

  IF v_wallet_id IS NULL THEN
    INSERT INTO public.wallets (user_id, balance)
    VALUES (NEW.referrer_id, 0)
    RETURNING id INTO v_wallet_id;
  END IF;

  -- Double-entry ledger: platform debit (marketing expense)
  INSERT INTO public.general_ledger (
    direction,
    amount,
    category,
    description,
    scope,
    source_table,
    source_id,
    transaction_group_id
  ) VALUES (
    'cash_out',
    NEW.bonus_amount,
    'marketing_expense',
    'Referral bonus for referring user ' || NEW.referred_user_id::TEXT,
    'platform',
    'referrals',
    NEW.id::TEXT,
    v_txn_group
  );

  -- Double-entry ledger: agent credit (referral bonus)
  INSERT INTO public.general_ledger (
    direction,
    amount,
    category,
    description,
    scope,
    wallet_id,
    source_table,
    source_id,
    transaction_group_id
  ) VALUES (
    'cash_in',
    NEW.bonus_amount,
    'referral_bonus',
    'Referral bonus for referring user ' || NEW.referred_user_id::TEXT,
    'wallet',
    v_wallet_id,
    'referrals',
    NEW.id::TEXT,
    v_txn_group
  );

  RETURN NEW;
END;
$$;

-- 3. Ensure triggers are correctly attached (recreate to be safe)
DROP TRIGGER IF EXISTS trg_credit_referral_bonus ON public.profiles;
CREATE TRIGGER trg_credit_referral_bonus
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.credit_referral_bonus();

DROP TRIGGER IF EXISTS trg_credit_signup_referral_bonus ON public.referrals;
CREATE TRIGGER trg_credit_signup_referral_bonus
  AFTER INSERT OR UPDATE OF credited ON public.referrals
  FOR EACH ROW
  EXECUTE FUNCTION public.credit_signup_referral_bonus();
