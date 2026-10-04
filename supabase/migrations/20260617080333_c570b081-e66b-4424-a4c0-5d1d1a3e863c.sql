-- Fix referral signup bonus: the previous trigger called create_ledger_transaction
-- with an invalid signature (text transaction_group_id + nonexistent p_description),
-- so every referral bonus since the April ledger refactor failed silently and no
-- referrer was ever paid. Rewrite it to use the correct (entries, idempotency_key)
-- signature with recipient_type routing so the bonus lands in the referrer's
-- withdrawable wallet, funded by platform marketing expense.

CREATE OR REPLACE FUNCTION public.credit_signup_referral_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_idempotency_key TEXT;
  v_group_id UUID;
  v_referrer_valid BOOLEAN;
BEGIN
  IF NEW.bonus_amount IS NULL OR NEW.bonus_amount <= 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.referrer_id IS NULL OR NEW.referrer_id = NEW.referred_id THEN
    RETURN NEW;
  END IF;

  -- Referrer must be a real, non-frozen account
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = NEW.referrer_id
      AND COALESCE(p.is_frozen, FALSE) = FALSE
  ) INTO v_referrer_valid;

  IF NOT v_referrer_valid THEN
    RAISE WARNING 'credit_signup_referral_bonus: invalid/frozen referrer % — skipped', NEW.referrer_id;
    RETURN NEW;
  END IF;

  v_idempotency_key := 'referral_signup:' || NEW.id::text;

  -- Idempotency guard: never double-pay the same referral row
  IF EXISTS (
    SELECT 1 FROM public.general_ledger WHERE idempotency_key = v_idempotency_key
  ) THEN
    UPDATE public.referrals
       SET credited = true, credited_at = COALESCE(credited_at, now())
     WHERE id = NEW.id AND credited = false;
    RETURN NEW;
  END IF;

  -- Layer-4 ledger guard authorization
  PERFORM set_config('wallet.sync_authorized', 'true', true);
  PERFORM set_config('ledger.authorized', 'true', true);

  -- Balanced double-entry: platform marketing expense out, referral bonus into
  -- the referrer's withdrawable wallet (recipient_type = user).
  v_group_id := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', NEW.referrer_id,
        'amount', NEW.bonus_amount,
        'direction', 'cash_out',
        'category', 'marketing_expense',
        'source_table', 'referrals',
        'source_id', NEW.id::text,
        'description', 'Referral signup bonus payout (platform expense)',
        'ledger_scope', 'platform'
      ),
      jsonb_build_object(
        'user_id', NEW.referrer_id,
        'amount', NEW.bonus_amount,
        'direction', 'cash_in',
        'category', 'referral_bonus',
        'source_table', 'referrals',
        'source_id', NEW.id::text,
        'description', 'Referral bonus — someone signed up using your shared link',
        'ledger_scope', 'wallet',
        'recipient_type', 'user'
      )
    ),
    v_idempotency_key
  );

  UPDATE public.referrals
     SET credited = true, credited_at = now()
   WHERE id = NEW.id;

  -- Best-effort notification (non-critical)
  BEGIN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      NEW.referrer_id,
      'Referral bonus earned: UGX ' || to_char(NEW.bonus_amount, 'FM999,999,999'),
      'Someone signed up using your shared link. UGX '
        || to_char(NEW.bonus_amount, 'FM999,999,999')
        || ' has been added to your wallet.',
      'success',
      jsonb_build_object('referral_id', NEW.id, 'amount', NEW.bonus_amount, 'ledger_group_id', v_group_id)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'credit_signup_referral_bonus failed for referral %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;