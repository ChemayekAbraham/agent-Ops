
-- 1) Core: credit any pending referral for an invitee, but ONLY once the
--    invitee has completed at least one activation step (anti-fake-account gate).
CREATE OR REPLACE FUNCTION public.try_credit_qualified_referrals(p_referred_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_qualified BOOLEAN;
  v_referrer_valid BOOLEAN;
  v_idempotency_key TEXT;
  v_group_id UUID;
BEGIN
  IF p_referred_id IS NULL THEN
    RETURN;
  END IF;

  -- Activation gate: invitee must have done at least one real action.
  SELECT
       EXISTS (SELECT 1 FROM public.house_listings hl WHERE hl.agent_id = p_referred_id)
    OR EXISTS (SELECT 1 FROM public.referrals rf WHERE rf.referrer_id = p_referred_id AND rf.referred_id <> p_referred_id)
    OR EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.agent_id = p_referred_id)
  INTO v_qualified;

  IF NOT v_qualified THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT * FROM public.referrals
    WHERE referred_id = p_referred_id
      AND credited = false
      AND bonus_amount > 0
      AND referrer_id IS NOT NULL
      AND referrer_id <> referred_id
  LOOP
    -- Referrer must be a real, non-frozen account
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = r.referrer_id
        AND COALESCE(p.is_frozen, FALSE) = FALSE
    ) INTO v_referrer_valid;

    IF NOT v_referrer_valid THEN
      RAISE WARNING 'try_credit_qualified_referrals: invalid/frozen referrer % — skipped', r.referrer_id;
      CONTINUE;
    END IF;

    v_idempotency_key := 'referral_signup:' || r.id::text;

    -- Idempotency: never double-pay the same referral row
    IF EXISTS (SELECT 1 FROM public.general_ledger WHERE idempotency_key = v_idempotency_key) THEN
      UPDATE public.referrals
         SET credited = true, credited_at = COALESCE(credited_at, now())
       WHERE id = r.id AND credited = false;
      CONTINUE;
    END IF;

    -- Layer-4 ledger guard authorization
    PERFORM set_config('wallet.sync_authorized', 'true', true);
    PERFORM set_config('ledger.authorized', 'true', true);

    v_group_id := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', r.referrer_id,
          'amount', r.bonus_amount,
          'direction', 'cash_out',
          'category', 'marketing_expense',
          'source_table', 'referrals',
          'source_id', r.id::text,
          'description', 'Referral bonus payout (platform expense)',
          'ledger_scope', 'platform'
        ),
        jsonb_build_object(
          'user_id', r.referrer_id,
          'amount', r.bonus_amount,
          'direction', 'cash_in',
          'category', 'referral_bonus',
          'source_table', 'referrals',
          'source_id', r.id::text,
          'description', 'Referral bonus — your invite became an active member',
          'ledger_scope', 'wallet',
          'recipient_type', 'user'
        )
      ),
      v_idempotency_key
    );

    UPDATE public.referrals
       SET credited = true, credited_at = now()
     WHERE id = r.id;

    BEGIN
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        r.referrer_id,
        'Referral bonus earned: UGX ' || to_char(r.bonus_amount, 'FM999,999,999'),
        'Your invite completed an activation step (listed a house, referred someone, or registered a tenant). UGX '
          || to_char(r.bonus_amount, 'FM999,999,999')
          || ' has been added to your wallet.',
        'success',
        jsonb_build_object('referral_id', r.id, 'amount', r.bonus_amount, 'ledger_group_id', v_group_id)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'try_credit_qualified_referrals failed for %: %', p_referred_id, SQLERRM;
END;
$function$;

-- 2) Replace the referrals INSERT trigger function: NO more instant payout.
--    On a new referral, the referrer just performed the "refer another user"
--    activation step, so try to release any pending bonus where THEY were the
--    invitee. The freshly-referred person stays pending until they activate.
CREATE OR REPLACE FUNCTION public.credit_signup_referral_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- The person who just referred someone has completed activation criterion #2.
  PERFORM public.try_credit_qualified_referrals(NEW.referrer_id);
  RETURN NEW;
END;
$function$;

-- 3) Activation triggers on house listing + tenant registration.
CREATE OR REPLACE FUNCTION public.trg_referral_activation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid;
BEGIN
  IF TG_TABLE_NAME = 'house_listings' THEN
    v_uid := NEW.agent_id;
  ELSIF TG_TABLE_NAME = 'rent_requests' THEN
    v_uid := NEW.agent_id;
  END IF;

  IF v_uid IS NOT NULL THEN
    PERFORM public.try_credit_qualified_referrals(v_uid);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_referral_activation_house ON public.house_listings;
CREATE TRIGGER trg_referral_activation_house
AFTER INSERT ON public.house_listings
FOR EACH ROW EXECUTE FUNCTION public.trg_referral_activation();

DROP TRIGGER IF EXISTS trg_referral_activation_rent ON public.rent_requests;
CREATE TRIGGER trg_referral_activation_rent
AFTER INSERT ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.trg_referral_activation();
