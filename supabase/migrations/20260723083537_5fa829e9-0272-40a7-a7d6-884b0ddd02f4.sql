DROP TRIGGER IF EXISTS trg_credit_signup_referral_bonus ON public.referrals;

CREATE OR REPLACE FUNCTION public.try_credit_qualified_referrals(p_referred_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_referrer_valid BOOLEAN;
  v_idempotency_key TEXT;
  v_group_id UUID;
  v_qualified BOOLEAN;
BEGIN
  IF p_referred_id IS NULL THEN RETURN; END IF;

  SELECT (
       EXISTS (SELECT 1 FROM public.house_listings   WHERE agent_id      = p_referred_id)
    OR EXISTS (SELECT 1 FROM public.rent_requests    WHERE agent_id      = p_referred_id)
    OR EXISTS (SELECT 1 FROM public.landlords        WHERE registered_by = p_referred_id)
    OR EXISTS (SELECT 1 FROM public.lc1_chairpersons WHERE registered_by = p_referred_id)
  ) INTO v_qualified;

  IF NOT v_qualified THEN RETURN; END IF;

  FOR r IN
    SELECT * FROM public.referrals
    WHERE referred_id = p_referred_id
      AND credited = false
      AND bonus_amount > 0
      AND referrer_id IS NOT NULL
      AND referrer_id <> referred_id
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = r.referrer_id
        AND COALESCE(p.is_frozen, FALSE) = FALSE
    ) INTO v_referrer_valid;
    IF NOT v_referrer_valid THEN CONTINUE; END IF;

    v_idempotency_key := 'referral_signup:' || r.id::text;
    IF EXISTS (SELECT 1 FROM public.general_ledger WHERE idempotency_key = v_idempotency_key) THEN
      UPDATE public.referrals SET credited = true, credited_at = COALESCE(credited_at, now())
       WHERE id = r.id AND credited = false;
      CONTINUE;
    END IF;

    PERFORM set_config('wallet.sync_authorized', 'true', true);
    PERFORM set_config('ledger.authorized', 'true', true);

    v_group_id := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id', r.referrer_id,'amount', r.bonus_amount,'direction','cash_out','category','marketing_expense','source_table','referrals','source_id',r.id::text,'description','Referral bonus payout (platform expense)','ledger_scope','platform'),
        jsonb_build_object('user_id', r.referrer_id,'amount', r.bonus_amount,'direction','cash_in','category','referral_bonus','source_table','referrals','source_id',r.id::text,'description','Referral bonus — your invite completed their first activity','ledger_scope','wallet','recipient_type','user')
      ),
      v_idempotency_key
    );

    UPDATE public.referrals SET credited = true, credited_at = now() WHERE id = r.id;

    BEGIN
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        r.referrer_id,
        'Referral bonus earned: UGX ' || to_char(r.bonus_amount, 'FM999,999,999'),
        'Your invite just completed their first activity on Welile. UGX ' || to_char(r.bonus_amount, 'FM999,999,999') || ' has been added to your wallet.',
        'success',
        jsonb_build_object('referral_id', r.id, 'amount', r.bonus_amount, 'ledger_group_id', v_group_id)
      );
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'try_credit_qualified_referrals failed for %: %', p_referred_id, SQLERRM;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_referral_activation_registered_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.registered_by IS NOT NULL THEN
    PERFORM public.try_credit_qualified_referrals(NEW.registered_by);
  END IF;
  RETURN NEW;
END;
$function$;