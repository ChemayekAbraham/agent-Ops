
-- 1. Extend referrals table
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS unlocked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS unlocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS restricted_amount numeric NOT NULL DEFAULT 500;

ALTER TABLE public.referrals ALTER COLUMN bonus_amount SET DEFAULT 500;

-- 2. Progress computation
CREATE OR REPLACE FUNCTION public.get_referral_progress(p_referred_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_houses_verified int;
  v_rent_submitted int;
  v_rent_approved_paid int;
  v_landlords_total int;
  v_landlords_verified int;
  v_lc1_total int;
  v_lc1_verified int;
  v_qualified boolean;
BEGIN
  IF p_referred_id IS NULL THEN
    RETURN jsonb_build_object('qualified', false);
  END IF;

  SELECT count(*) INTO v_houses_verified
  FROM public.house_listings
  WHERE agent_id = p_referred_id AND COALESCE(verified, false) = true;

  SELECT count(*) INTO v_rent_submitted
  FROM public.rent_requests
  WHERE agent_id = p_referred_id
    AND status NOT IN ('rejected','deleted_by_agent');

  SELECT count(*) INTO v_rent_approved_paid
  FROM public.rent_requests
  WHERE agent_id = p_referred_id
    AND status IN ('funded','repaying','completed');

  SELECT count(*) INTO v_landlords_total
  FROM public.landlords WHERE registered_by = p_referred_id;
  SELECT count(*) INTO v_landlords_verified
  FROM public.landlords
  WHERE registered_by = p_referred_id AND COALESCE(verified, false) = true;

  SELECT count(*) INTO v_lc1_total
  FROM public.lc1_chairpersons WHERE registered_by = p_referred_id;
  SELECT count(*) INTO v_lc1_verified
  FROM public.lc1_chairpersons
  WHERE registered_by = p_referred_id AND COALESCE(verified, false) = true;

  v_qualified :=
        v_houses_verified >= 3
    AND v_rent_submitted >= 5
    AND v_rent_approved_paid >= 3
    AND v_landlords_total >= 5 AND v_landlords_verified = v_landlords_total AND v_landlords_verified >= 5
    AND v_lc1_total >= 5 AND v_lc1_verified = v_lc1_total AND v_lc1_verified >= 5;

  RETURN jsonb_build_object(
    'qualified', v_qualified,
    'houses_verified', v_houses_verified,
    'houses_required', 3,
    'rent_submitted', v_rent_submitted,
    'rent_submitted_required', 5,
    'rent_approved_paid', v_rent_approved_paid,
    'rent_approved_paid_required', 3,
    'landlords_total', v_landlords_total,
    'landlords_verified', v_landlords_verified,
    'landlords_required', 5,
    'lc1_total', v_lc1_total,
    'lc1_verified', v_lc1_verified,
    'lc1_required', 5
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_referral_progress(uuid) TO authenticated, service_role;

-- 3. Rewrite qualification credit function with new milestone rules
CREATE OR REPLACE FUNCTION public.try_credit_qualified_referrals(p_referred_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
          jsonb_build_object('user_id', r.referrer_id, 'amount', COALESCE(r.restricted_amount, 500), 'direction','cash_out','category','marketing_expense','source_table','referrals','source_id',r.id::text,'description','Referral bonus payout (platform expense)','ledger_scope','platform'),
          jsonb_build_object('user_id', r.referrer_id, 'amount', COALESCE(r.restricted_amount, 500), 'direction','cash_in','category','referral_bonus','source_table','referrals','source_id',r.id::text,'description','Referral bonus unlocked — your invite met all milestones','ledger_scope','wallet','recipient_type','user')
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
        jsonb_build_object('amount', COALESCE(r.restricted_amount, 500), 'referred_id', r.referred_id)
      );
    EXCEPTION WHEN OTHERS THEN NULL; END;

    BEGIN
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        r.referrer_id,
        'Referral bonus unlocked: UGX ' || to_char(COALESCE(r.restricted_amount, 500), 'FM999,999,999'),
        'Your invite completed every milestone. Your referral bonus is now withdrawable.',
        'success',
        jsonb_build_object('referral_id', r.id, 'amount', COALESCE(r.restricted_amount, 500), 'ledger_group_id', v_group_id)
      );
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'try_credit_qualified_referrals failed for %: %', p_referred_id, SQLERRM;
END;
$$;

-- 4. Progress-check trigger dispatcher
CREATE OR REPLACE FUNCTION public.trg_referral_progress_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := CASE TG_TABLE_NAME
    WHEN 'house_listings' THEN NEW.agent_id
    WHEN 'rent_requests' THEN NEW.agent_id
    WHEN 'landlords' THEN NEW.registered_by
    WHEN 'lc1_chairpersons' THEN NEW.registered_by
    ELSE NULL END;

  IF v_user IS NOT NULL THEN
    PERFORM public.try_credit_qualified_referrals(v_user);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_referral_progress_house_listings ON public.house_listings;
CREATE TRIGGER trg_referral_progress_house_listings
AFTER INSERT OR UPDATE OF verified, status ON public.house_listings
FOR EACH ROW EXECUTE FUNCTION public.trg_referral_progress_check();

DROP TRIGGER IF EXISTS trg_referral_progress_landlords ON public.landlords;
CREATE TRIGGER trg_referral_progress_landlords
AFTER INSERT OR UPDATE OF verified, verification_status ON public.landlords
FOR EACH ROW EXECUTE FUNCTION public.trg_referral_progress_check();

DROP TRIGGER IF EXISTS trg_referral_progress_lc1 ON public.lc1_chairpersons;
CREATE TRIGGER trg_referral_progress_lc1
AFTER INSERT OR UPDATE OF verified, verification_status ON public.lc1_chairpersons
FOR EACH ROW EXECUTE FUNCTION public.trg_referral_progress_check();

DROP TRIGGER IF EXISTS trg_referral_progress_rent_requests ON public.rent_requests;
CREATE TRIGGER trg_referral_progress_rent_requests
AFTER INSERT OR UPDATE OF status ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.trg_referral_progress_check();

-- 5. UI-facing aggregate RPC
CREATE OR REPLACE FUNCTION public.get_my_referral_bonuses()
RETURNS TABLE (
  referral_id uuid,
  referred_id uuid,
  referred_name text,
  created_at timestamptz,
  restricted_amount numeric,
  unlocked boolean,
  unlocked_at timestamptz,
  progress jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.id, r.referred_id, p.full_name,
         r.created_at, COALESCE(r.restricted_amount, 500),
         r.unlocked, r.unlocked_at,
         public.get_referral_progress(r.referred_id)
    FROM public.referrals r
    LEFT JOIN public.profiles p ON p.id = r.referred_id
   WHERE r.referrer_id = auth.uid()
   ORDER BY r.created_at DESC
$$;

GRANT EXECUTE ON FUNCTION public.get_my_referral_bonuses() TO authenticated, service_role;
