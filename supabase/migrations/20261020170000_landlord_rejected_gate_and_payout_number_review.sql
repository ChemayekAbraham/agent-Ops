-- 1. Gate: Landlord Ops cannot verify (move forward) a Rent Plan whose landlord was rejected.
-- 2. Payout-number review: the list Landlord Ops works through to confirm landlords whose approved payout number is missing or differs
--    from the number on their record (most come from the 22 Sep 2026 backfill, which preferred an old verification-request number).
--
-- No money moves here. The gate raises before a status change; the review list is read-only; the confirm action writes only
-- verified_mobile_money_number (through the same sync flag set_landlord_verification uses) and an audit row.

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. The gate.
-- It only fires at the Landlord Ops desk (OLD.status = 'tenant_ops_approved') or on the first Landlord Ops review stamp, and only for a
-- move into a forward status. It deliberately does NOT fire on later status moves (funded -> repaying), so collecting repayments on a plan
-- whose landlord is rejected afterwards is never blocked. Rejecting or returning a Rent Plan is never blocked either.
-- enforce_landlord_verified_before_approval() already stops 'approved' and later, but it does not list landlord_ops_approved or
-- partner_ops_approved, which is how a rejected landlord's plan could pass Landlord Ops.
CREATE OR REPLACE FUNCTION public.block_rent_plan_review_for_rejected_landlord()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_forward text[] := ARRAY['landlord_ops_approved','partner_ops_approved','coo_approved','approved','funded','repaying','disbursed','force_approved'];
  v_status text; v_name text; v_reason text;
BEGIN
  IF NEW.landlord_id IS NULL OR NEW.status IS NULL OR NOT (NEW.status = ANY (v_forward)) THEN RETURN NEW; END IF;
  IF TG_OP <> 'UPDATE' THEN RETURN NEW; END IF;
  IF NOT (
       (OLD.status = 'tenant_ops_approved' AND OLD.status IS DISTINCT FROM NEW.status)
    OR (OLD.landlord_ops_reviewed_at IS NULL AND NEW.landlord_ops_reviewed_at IS NOT NULL)
  ) THEN RETURN NEW; END IF;

  SELECT l.verification_status, COALESCE(l.name, 'this landlord'), l.verification_reason
    INTO v_status, v_name, v_reason
    FROM public.landlords l WHERE l.id = NEW.landlord_id;

  IF v_status = 'rejected' THEN
    RAISE EXCEPTION 'LANDLORD_REJECTED: % was rejected by Landlord Ops%. This Rent Plan cannot be verified until the landlord is verified again or the Rent Plan is moved to another landlord.',
      v_name, COALESCE(' (reason: ' || NULLIF(btrim(v_reason), '') || ')', '')
      USING ERRCODE = 'check_violation',
            HINT = 'Re-verify the landlord in Landlord Ops, or return the Rent Plan to the agent to change the landlord.';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.block_rent_plan_review_for_rejected_landlord() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_block_review_rejected_landlord ON public.rent_requests;
CREATE TRIGGER trg_block_review_rejected_landlord
  BEFORE UPDATE OF status, landlord_ops_reviewed_at ON public.rent_requests
  FOR EACH ROW EXECUTE FUNCTION public.block_rent_plan_review_for_rejected_landlord();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Payout-number review.
CREATE OR REPLACE FUNCTION public.can_review_landlord_payout_numbers(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = p_user AND COALESCE(ur.enabled, true)
       AND ur.role::text IN ('landlord_ops','manager','super_admin','coo','operations','cto'));
$$;
REVOKE ALL ON FUNCTION public.can_review_landlord_payout_numbers(uuid) FROM PUBLIC, anon, authenticated;

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
           COALESCE(NULLIF(btrim(l.mobile_money_number), ''), l.phone) AS on_file,
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

-- Confirm which number on the landlord's record is the approved payout number. The number must already be on the record
-- (mobile_money_number or phone): nothing is typed in, so this cannot retarget a payout to a new number. To approve a different
-- number, change it on the record first through the normal Landlord Ops edit / number-change flow, then confirm it here.
CREATE OR REPLACE FUNCTION public.confirm_landlord_payout_number(p_landlord_id uuid, p_number text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := btrim(p_reason);
  v_l public.landlords%ROWTYPE;
  v_pick text := right(regexp_replace(COALESCE(p_number, ''), '\D', '', 'g'), 9);
  v_chosen text;
BEGIN
  IF NOT public.can_review_landlord_payout_numbers(v_actor) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;
  IF length(v_pick) < 9 THEN RAISE EXCEPTION 'Enter a valid number'; END IF;

  SELECT * INTO v_l FROM public.landlords WHERE id = p_landlord_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Landlord not found'; END IF;
  IF COALESCE(v_l.verification_status, 'pending') <> 'verified' THEN
    RAISE EXCEPTION 'This landlord is not verified. Verify the landlord first.';
  END IF;

  IF NULLIF(btrim(v_l.mobile_money_number), '') IS NOT NULL
     AND right(regexp_replace(v_l.mobile_money_number, '\D', '', 'g'), 9) = v_pick THEN
    v_chosen := btrim(v_l.mobile_money_number);
  ELSIF NULLIF(btrim(v_l.phone), '') IS NOT NULL
     AND right(regexp_replace(v_l.phone, '\D', '', 'g'), 9) = v_pick THEN
    v_chosen := btrim(v_l.phone);
  ELSE
    RAISE EXCEPTION 'That number is not on this landlord''s record. Update the record first, then confirm it.';
  END IF;

  PERFORM set_config('landlord_verification.sync_authorized', 'true', true);
  UPDATE public.landlords
     SET verified_mobile_money_number = v_chosen,
         verified_mobile_money_set_at = now(),
         verified_mobile_money_source = 'payout_number_reconcile'
   WHERE id = p_landlord_id;
  PERFORM set_config('landlord_verification.sync_authorized', 'false', true);

  INSERT INTO public.landlord_number_audit (landlord_id, field, event, old_value, new_value, actor, comment)
  VALUES (p_landlord_id, 'verified_mobile_money_number', 'payout_number_reconciled',
          v_l.verified_mobile_money_number, v_chosen, v_actor, v_reason);

  RETURN jsonb_build_object('ok', true, 'landlord_id', p_landlord_id, 'approved_number', v_chosen,
                            'previous_number', v_l.verified_mobile_money_number);
END $$;
REVOKE ALL ON FUNCTION public.confirm_landlord_payout_number(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_landlord_payout_number(uuid, text, text) TO authenticated;
