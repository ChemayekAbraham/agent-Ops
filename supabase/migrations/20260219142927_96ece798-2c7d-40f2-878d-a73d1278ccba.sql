
-- ============================================================
-- FIX 1: Correct log_agent_earning_to_ledger direction bug
-- Earnings are INCOME (cash_in), not expenses (cash_out)
-- ============================================================
CREATE OR REPLACE FUNCTION public.log_agent_earning_to_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Skip referral_bonus — handled separately by credit_signup_referral_bonus trigger
  IF NEW.earning_type = 'referral_bonus' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.general_ledger (
    transaction_date, amount, direction, category, description,
    user_id, source_table, source_id, linked_party
  ) VALUES (
    NEW.created_at,
    NEW.amount,
    'cash_in',   -- FIXED: was 'cash_out'
    'agent_commission',
    COALESCE(NEW.description, 'Agent earning: ' || NEW.earning_type),
    NEW.agent_id,
    'agent_earnings',
    NEW.id,
    'agent'
  );
  RETURN NEW;
END;
$$;

-- ============================================================
-- FIX 2: Add ledger entry to credit_signup_referral_bonus
-- The trigger credited wallets but never logged to general_ledger
-- ============================================================
CREATE OR REPLACE FUNCTION public.credit_signup_referral_bonus()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  signup_bonus NUMERIC := 500;
BEGIN
  -- Only process when 'credited' transitions from false → true
  IF NEW.credited = true AND (OLD IS NULL OR OLD.credited = false) THEN

    -- Ensure referrer has a wallet
    INSERT INTO wallets (user_id, balance)
    VALUES (NEW.referrer_id, 0)
    ON CONFLICT (user_id) DO NOTHING;

    -- Credit ONLY the referrer's wallet
    UPDATE wallets
    SET balance = balance + signup_bonus,
        updated_at = now()
    WHERE user_id = NEW.referrer_id;

    -- FIX: Log referral bonus to general_ledger (was missing)
    INSERT INTO public.general_ledger (
      transaction_date, amount, direction, category, description,
      user_id, source_table, source_id, linked_party, reference_id
    ) VALUES (
      now(),
      signup_bonus,
      'cash_in',
      'referral_bonus',
      'Referral bonus for referring a new user',
      NEW.referrer_id,
      'referrals',
      NEW.id,
      'tenant',
      NEW.referred_id::text
    );

    -- Notify referrer
    INSERT INTO notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.referrer_id,
      '🎉 Referral Bonus!',
      'You earned ' || signup_bonus || ' UGX for referring a new user!',
      'earning',
      jsonb_build_object('referral_id', NEW.id, 'bonus_amount', signup_bonus, 'referred_id', NEW.referred_id)
    );

  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================
-- FIX 3: Backfill missing ledger entries for referral bonuses
-- (credited=true referrals that have no ledger entry)
-- ============================================================
INSERT INTO public.general_ledger (
  transaction_date, amount, direction, category, description,
  user_id, source_table, source_id, linked_party, reference_id
)
SELECT
  r.credited_at,
  500,
  'cash_in',
  'referral_bonus',
  'Referral bonus for referring a new user (backfilled)',
  r.referrer_id,
  'referrals',
  r.id,
  'tenant',
  r.referred_id::text
FROM referrals r
WHERE r.credited = true
  AND NOT EXISTS (
    SELECT 1 FROM public.general_ledger gl
    WHERE gl.source_table = 'referrals'
      AND gl.source_id = r.id
      AND gl.direction = 'cash_in'
  );

-- ============================================================
-- FIX 4: Backfill approved deposits missing from ledger
-- (deposits approved directly with status='approved', missed by UPDATE trigger)
-- ============================================================
INSERT INTO public.general_ledger (
  transaction_date, amount, direction, category, description,
  user_id, source_table, source_id, reference_id, linked_party
)
SELECT
  COALESCE(dr.approved_at, dr.created_at),
  dr.amount,
  'cash_in',
  'deposit',
  'Wallet deposit via ' || COALESCE(dr.provider, 'mobile money') || ' (backfilled)',
  dr.user_id,
  'deposit_requests',
  dr.id,
  dr.transaction_id,
  'platform'
FROM deposit_requests dr
WHERE dr.status = 'approved'
  AND NOT EXISTS (
    SELECT 1 FROM public.general_ledger gl
    WHERE gl.source_table = 'deposit_requests'
      AND gl.source_id = dr.id
  );

-- ============================================================
-- FIX 5: Backfill withdrawal ledger entries (cash_out)
-- ============================================================
INSERT INTO public.general_ledger (
  transaction_date, amount, direction, category, description,
  user_id, source_table, source_id, linked_party
)
SELECT
  wr.created_at,
  wr.amount,
  'cash_out',
  'wallet_withdrawal',
  'Wallet withdrawal request',
  wr.user_id,
  'withdrawal_requests',
  wr.id,
  'platform'
FROM withdrawal_requests wr
WHERE NOT EXISTS (
  SELECT 1 FROM public.general_ledger gl
  WHERE gl.source_table = 'withdrawal_requests'
    AND gl.source_id = wr.id
);
