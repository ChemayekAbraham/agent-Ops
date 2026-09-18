CREATE OR REPLACE FUNCTION public.enforce_withdrawal_destination_verified()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  m text := lower(coalesce(NEW.payout_method,''));
  v_dest_status text;
  v_binding record;
  v_has_nid boolean;
BEGIN
  IF m NOT IN ('mobile_money','bank_transfer') THEN
    RETURN NEW;
  END IF;

  IF NEW.landlord_payout_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.proxy_partner_id IS NOT NULL
     AND NEW.initiated_by IS NOT NULL
     AND NEW.initiated_by <> NEW.user_id THEN
    RETURN NEW;
  END IF;

  IF public.user_is_pure_partner(NEW.user_id) THEN
    RETURN NEW;
  END IF;

  -- HARD GATE: no National ID on record means no payout, whatever the state of
  -- the destination queue. Accepts either the profile field or a captured
  -- identity binding.
  SELECT EXISTS (
           SELECT 1 FROM public.profiles p
           WHERE p.id = NEW.user_id
             AND coalesce(btrim(p.national_id), '') <> ''
         )
         OR EXISTS (
           SELECT 1 FROM public.user_identity_bindings b
           WHERE b.user_id = NEW.user_id
             AND b.status <> 'revoked'
             AND coalesce(btrim(coalesce(b.national_id, b.linked_national_id, '')), '') <> ''
         )
    INTO v_has_nid;

  IF NOT v_has_nid THEN
    RAISE EXCEPTION 'You have not submitted your National ID yet. Submit your National ID and payout details, then try again.';
  END IF;

  IF public.payout_destination_is_verified(
       NEW.user_id, NEW.payout_method, NEW.mobile_money_number, NEW.bank_name, NEW.bank_account_number) THEN
    RETURN NEW;
  END IF;

  SELECT d.status INTO v_dest_status
  FROM public.payout_destination_verifications d
  WHERE d.user_id = NEW.user_id
    AND d.destination_key = public.payout_destination_key(
          NEW.payout_method, NEW.mobile_money_number, NEW.bank_name, NEW.bank_account_number)
  ORDER BY (d.status = 'rejected') DESC, d.updated_at DESC NULLS LAST
  LIMIT 1;

  IF v_dest_status = 'rejected' THEN
    RAISE EXCEPTION 'This payout destination was rejected by Financial Ops. Contact support.';
  END IF;

  IF m = 'mobile_money' THEN
    SELECT * INTO v_binding
    FROM public.user_identity_bindings
    WHERE user_id = NEW.user_id
      AND status <> 'revoked'
      AND coalesce(locked_payout_number, '') <> ''
      AND regexp_replace(coalesce(locked_payout_number, ''), '[^0-9]', '', 'g')
          LIKE '%' || right(regexp_replace(coalesce(NEW.mobile_money_number, ''), '[^0-9]', '', 'g'), 9)
    LIMIT 1;

    IF v_binding.id IS NOT NULL
       AND coalesce(btrim(coalesce(v_binding.national_id, v_binding.linked_national_id, '')), '') <> ''
       AND coalesce(btrim(coalesce(v_binding.national_id_photo_path, '')), '') <> ''
       AND coalesce(btrim(coalesce(v_binding.selfie_photo_path, '')), '') <> '' THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'You have not submitted your National ID details and payout number yet. Submit them, then try again.';
END;
$function$;