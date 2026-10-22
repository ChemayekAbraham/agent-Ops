-- A landlord payout may only go to the number the landlord is registered with.
--
-- Until now the database checked the payout phone against verified_mobile_money_number only. That column is the "approved" snapshot, and for
-- about 5,000 landlords it was filled by the 22 Sep 2026 backfill, which preferred the number on an old verification request over the number on
-- the landlord's own record. Result: payouts to a number that is not on the record (UGX 900,000 on 20 Oct to "Mukama Michael" / "Mukama Micheal",
-- the OTP going to the record's phone while the money went to a different number).
--
-- The rule now: payout phone = approved number AND payout phone = the landlord's registered phone (landlords.phone, which is also where the
-- OTP goes), compared as the subscriber number (last 9 digits) so formatting never blocks a payout. The separate mobile_money_number field is no
-- longer a payout destination: 32 of 46,903 landlords have one that differs from their phone.
-- A landlord whose approved number differs from the record is refused until Landlord Ops reconciles it
-- (get_landlord_payout_number_review / confirm_landlord_payout_number in 20261020170000_landlord_rejected_gate_and_payout_number_review.sql).
--
-- This replaces enforce_landlord_payout_eligibility() with the existing body plus one check. Nothing else in it changes.

CREATE OR REPLACE FUNCTION public.enforce_landlord_payout_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_landlord_verified boolean;
  v_landlord_phone text;
  v_record_phone text;
  v_float_balance numeric;
  v_kampala_hour int;
BEGIN
  IF public.landlord_float_withdrawals_paused() THEN
    RAISE EXCEPTION 'Landlord float withdrawals are currently paused from Platform Controls. Try again once they are re-enabled.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_kampala_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala'));
  IF v_kampala_hour < 6 OR v_kampala_hour >= 22 THEN
    RAISE EXCEPTION 'Landlord payouts are only allowed between 06:00 and 22:00 Africa/Kampala.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- verified_mobile_money_number (never raw phone/mobile_money_number) is the
  -- only number Landlord Ops actually approved -- see migration 20260922150000.
  SELECT verified, verified_mobile_money_number,
         phone
    INTO v_landlord_verified, v_landlord_phone, v_record_phone
  FROM public.landlords WHERE id = NEW.landlord_id;

  IF v_landlord_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'Landlord is not verified — Landlord Ops must verify the phone number first.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_landlord_phone IS NULL OR length(public.landlord_number_norm(v_landlord_phone)) < 9 THEN
    RAISE EXCEPTION 'Landlord Ops has not approved a payout number for this landlord.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Structural guarantee, independent of any application code: the phone
  -- actually being paid out to must be the number Landlord Ops approved.
  -- Compared as the subscriber number (last 9 digits) so formatting
  -- ("0772 363 578" vs "0772363578" vs "+256772363578") can't block a payout,
  -- while any different number is still refused (doc 122).
  IF public.landlord_number_norm(NEW.landlord_phone) <> public.landlord_number_norm(v_landlord_phone) THEN
    RAISE EXCEPTION 'Payout phone does not match the number Landlord Ops approved for this landlord.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The approved number must also be the landlord's registered phone. If it is not, the approval is stale or came from
  -- the backfill, so the payout is refused until Landlord Ops confirms which number is correct.
  IF v_record_phone IS NOT NULL
     AND length(public.landlord_number_norm(v_record_phone)) >= 9
     AND public.landlord_number_norm(NEW.landlord_phone) <> public.landlord_number_norm(v_record_phone) THEN
    RAISE EXCEPTION 'PAYOUT_NUMBER_MISMATCH: the payout number does not match the phone number registered for this landlord. Landlord Ops must confirm the correct number before a payout can be made.'
      USING ERRCODE = 'check_violation',
            HINT = 'Landlord Ops: use the Payout number review to confirm the number on the landlord record.';
  END IF;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float WHERE agent_id = NEW.agent_id;

  IF v_float_balance IS NULL THEN
    RAISE EXCEPTION 'Agent has no landlord float account.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_float_balance < NEW.amount THEN
    RAISE EXCEPTION 'Insufficient landlord float (balance: %, requested: %).', v_float_balance, NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

-- Confirming a number now only accepts the landlord's registered phone. Choosing a different
-- number means changing the record first through the normal Landlord Ops edit or number-change flow, so the approved number and the
-- record can never disagree after a confirmation.
CREATE OR REPLACE FUNCTION public.confirm_landlord_payout_number(p_landlord_id uuid, p_number text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := btrim(p_reason);
  v_l public.landlords%ROWTYPE;
  v_pick text := right(regexp_replace(COALESCE(p_number, ''), '\D', '', 'g'), 9);
  v_record text;
BEGIN
  IF NOT public.can_review_landlord_payout_numbers(v_actor) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;
  IF length(v_pick) < 9 THEN RAISE EXCEPTION 'Enter a valid number'; END IF;

  SELECT * INTO v_l FROM public.landlords WHERE id = p_landlord_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Landlord not found'; END IF;
  IF COALESCE(v_l.verification_status, 'pending') <> 'verified' THEN
    RAISE EXCEPTION 'This landlord is not verified. Verify the landlord first.';
  END IF;

  v_record := NULLIF(btrim(v_l.phone), '');
  IF v_record IS NULL OR right(regexp_replace(v_record, '\D', '', 'g'), 9) <> v_pick THEN
    RAISE EXCEPTION 'That is not the phone number registered for this landlord. Update the landlord record first, then confirm it.';
  END IF;

  PERFORM set_config('landlord_verification.sync_authorized', 'true', true);
  UPDATE public.landlords
     SET verified_mobile_money_number = v_record,
         verified_mobile_money_set_at = now(),
         verified_mobile_money_source = 'payout_number_reconcile'
   WHERE id = p_landlord_id;
  PERFORM set_config('landlord_verification.sync_authorized', 'false', true);

  INSERT INTO public.landlord_number_audit (landlord_id, field, event, old_value, new_value, actor, comment)
  VALUES (p_landlord_id, 'verified_mobile_money_number', 'payout_number_reconciled',
          v_l.verified_mobile_money_number, v_record, v_actor, v_reason);

  RETURN jsonb_build_object('ok', true, 'landlord_id', p_landlord_id, 'approved_number', v_record,
                            'previous_number', v_l.verified_mobile_money_number);
END $$;
REVOKE ALL ON FUNCTION public.confirm_landlord_payout_number(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_landlord_payout_number(uuid, text, text) TO authenticated;

-- The review list compares the approved number with the landlord's registered phone, the same rule the gate uses.
-- kind: 'approved_differs_from_record' | 'approved_number_missing' | 'not_verified_with_float' (open float held against a landlord who is not verified).
CREATE OR REPLACE FUNCTION public.get_landlord_payout_number_review(
  p_kind text DEFAULT NULL, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
RETURNS TABLE (
  landlord_id uuid, landlord_name text, verification_status text, kind text,
  on_file_number text, phone text, approved_number text, approved_source text, approved_set_at timestamptz,
  last_verified_request_number text, open_allocations bigint, open_float_remaining numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.can_review_landlord_payout_numbers(auth.uid()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  RETURN QUERY
  WITH base AS (
    SELECT l.id, l.name, l.verification_status AS vs, l.phone AS ph,
           l.phone AS on_file,
           l.verified_mobile_money_number AS approved, l.verified_mobile_money_source AS src, l.verified_mobile_money_set_at AS set_at,
           f.cnt, f.remaining
      FROM public.landlords l
      LEFT JOIN LATERAL (
        SELECT count(*) AS cnt, COALESCE(sum(a.remaining_amount), 0) AS remaining
          FROM public.agent_landlord_float_allocations a
         WHERE a.landlord_id = l.id AND a.status = 'open' AND a.remaining_amount > 0) f ON true
  ), kinds AS (
    SELECT b.*,
      CASE
        WHEN COALESCE(b.vs, 'pending') <> 'verified' THEN CASE WHEN b.cnt > 0 THEN 'not_verified_with_float' END
        WHEN COALESCE(b.approved, '') = '' THEN 'approved_number_missing'
        WHEN right(regexp_replace(b.approved, '\D', '', 'g'), 9) <> right(regexp_replace(COALESCE(b.on_file, ''), '\D', '', 'g'), 9) THEN 'approved_differs_from_record'
      END AS k
    FROM base b
  )
  SELECT k.id, k.name, k.vs, k.k, k.on_file, k.ph, k.approved, k.src, k.set_at,
         (SELECT lvr.landlord_phone FROM public.landlord_verification_requests lvr
           WHERE lvr.landlord_id = k.id AND lvr.status = 'verified' AND lvr.landlord_phone IS NOT NULL
           ORDER BY lvr.resolved_at DESC NULLS LAST LIMIT 1),
         k.cnt, k.remaining
    FROM kinds k
   WHERE k.k IS NOT NULL AND (p_kind IS NULL OR k.k = p_kind)
   ORDER BY k.remaining DESC, k.name
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END $$;
REVOKE ALL ON FUNCTION public.get_landlord_payout_number_review(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_landlord_payout_number_review(text, integer, integer) TO authenticated;

