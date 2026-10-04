CREATE OR REPLACE FUNCTION public.try_credit_qualified_referrals(p_referred_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_referrer_valid boolean;
  v_idempotency_key text;
  v_group_id uuid;
  v_progress jsonb;
  v_qualified boolean;
BEGIN
  IF p_referred_id IS NULL THEN RETURN; END IF;

  v_progress := public.get_referral_progress(p_referred_id);
  v_qualified := COALESCE((v_progress->>'qualified')::boolean, false);
  IF NOT v_qualified THEN RETURN; END IF;

  FOR r IN
    SELECT * FROM public.referrals
    WHERE referred_id = p_referred_id
      AND unlocked = false
      AND COALESCE(credited, false) = false
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

    IF NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE idempotency_key = v_idempotency_key) THEN
      PERFORM set_config('wallet.sync_authorized', 'true', true);
      PERFORM set_config('ledger.authorized', 'true', true);

      v_group_id := public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object('user_id', r.referrer_id, 'amount', COALESCE(r.restricted_amount, 100), 'direction','cash_out','category','marketing_expense','source_table','referrals','source_id',r.id::text,'description','Referral bonus payout (platform expense)','ledger_scope','platform'),
          jsonb_build_object('user_id', r.referrer_id, 'amount', COALESCE(r.restricted_amount, 100), 'direction','cash_in','category','referral_bonus','source_table','referrals','source_id',r.id::text,'description','Referral bonus unlocked — your invite met all milestones','ledger_scope','wallet','recipient_type','user')
        ),
        v_idempotency_key
      );
    END IF;

    UPDATE public.referrals
       SET credited = true,
           credited_at = COALESCE(credited_at, now()),
           unlocked = true,
           unlocked_at = now(),
           bonus_amount = COALESCE(restricted_amount, bonus_amount)
     WHERE id = r.id;

    BEGIN
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
      VALUES (
        r.referrer_id,
        'referral_bonus_unlocked',
        'referrals',
        r.id,
        'milestones_met',
        jsonb_build_object('amount', COALESCE(r.restricted_amount, 100), 'referred_id', r.referred_id)
      );
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        r.referrer_id,
        'Referral bonus unlocked: UGX ' || to_char(COALESCE(r.restricted_amount, 100), 'FM999,999,999'),
        'Your invite completed every milestone. Your referral bonus is now withdrawable.',
        'success',
        jsonb_build_object('referral_id', r.id, 'amount', COALESCE(r.restricted_amount, 100), 'ledger_group_id', v_group_id)
      );
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'try_credit_qualified_referrals failed for %: %', p_referred_id, SQLERRM;
END;
$function$;