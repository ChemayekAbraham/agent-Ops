-- LC1 bonus trigger fix — DRAFT, NOT APPLIED.
-- Function logic only. No data rewrite, no backfill, no trigger re-declaration,
-- so installing it cannot touch any Rent Plan, chairperson, wallet or ledger row.
--
-- Before: sync_landlord_verified_on_pipeline_approval (AFTER INSERT OR UPDATE OF
-- landlord_ops_reviewed_at, landlord_ops_reviewed_by, status ON rent_requests)
-- verified the linked landlord and LC1 on ANY such write where landlord_ops_reviewed_at IS NOT NULL
-- and the LC1 was unverified, copying the plan's review date as verified_at.
-- An unchanged `status = 'repaying'` write (repayment, reversal, correction,
-- settlement rebuild, admin edit) therefore paid the UGX 2,000 LC1 bonus.
--
-- After: the LC1 branch runs only on the genuine Landlord Ops review transition
-- (INSERT with a review date, or UPDATE where OLD.landlord_ops_reviewed_at IS NULL
-- and NEW is set). It calls a dedicated function that records the real actor,
-- the real verification time (now()), the source and the qualifying Rent Plan.
-- The landlord branch gets the same treatment via verify_landlord_on_landlord_review
-- (real verification time, reviewer, audit row); landlord bonus function/trigger unchanged.
-- The LC1 bonus function/trigger are unchanged: still false→true only, still
-- `registration_verification_bonus_paid` guarded, still key lc1_reg_verify_v1:<id>.

CREATE OR REPLACE FUNCTION public.verify_lc1_on_landlord_review(
  p_lc1_id uuid, p_rent_request_id uuid, p_reviewer uuid, p_reviewed_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_done int;
BEGIN
  UPDATE public.lc1_chairpersons
     SET verified            = true,
         verification_status = 'verified',
         verified_at         = now(),
         verified_by         = COALESCE(p_reviewer, verified_by),
         verification_reason = 'Verified at Landlord Ops review of Rent Plan ' || p_rent_request_id::text
   WHERE id = p_lc1_id
     AND COALESCE(verified, false) = false;
  GET DIAGNOSTICS v_done = ROW_COUNT;

  IF v_done = 1 THEN
    INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata, reason)
    VALUES (p_reviewer, 'lc1_verified_at_landlord_review', 'lc1_chairpersons', p_lc1_id::text,
            jsonb_build_object('rent_request_id', p_rent_request_id,
                               'landlord_ops_reviewed_at', p_reviewed_at,
                               'source', 'landlord_ops_review_transition'),
            'LC1 verified at the genuine Landlord Ops review of its Rent Plan');
  END IF;
  RETURN v_done = 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.verify_lc1_on_landlord_review(uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.verify_landlord_on_landlord_review(
  p_landlord_id uuid, p_rent_request_id uuid, p_reviewer uuid, p_reviewed_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_done int;
BEGIN
  PERFORM set_config('landlord_verification.sync_authorized', 'true', true);
  UPDATE public.landlords
     SET verification_status = 'verified',
         verified            = true,
         verification_source = COALESCE(verification_source, 'pipeline_auto'),
         verification_reason = COALESCE(verification_reason, 'Auto-verified after landlord pipeline review'),
         verified_at         = now(),
         verified_by         = COALESCE(p_reviewer, verified_by)
   WHERE id = p_landlord_id
     AND COALESCE(verification_status, 'pending') = 'pending';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  PERFORM set_config('landlord_verification.sync_authorized', 'false', true);

  IF v_done = 1 THEN
    INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata, reason)
    VALUES (p_reviewer, 'landlord_verified_at_landlord_review', 'landlords', p_landlord_id::text,
            jsonb_build_object('rent_request_id', p_rent_request_id,
                               'landlord_ops_reviewed_at', p_reviewed_at,
                               'source', 'landlord_ops_review_transition'),
            'Landlord verified at the genuine Landlord Ops review of its Rent Plan');
  END IF;
  RETURN v_done = 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.verify_landlord_on_landlord_review(uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_landlord_verified_on_pipeline_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Agreement evidence is visible in the pipeline but is not a prerequisite
  -- for landlord verification or for an existing request to move forward.
  -- Landlord: only the genuine first-time Landlord Ops review (review date
  -- NULL -> set) qualifies. Ordinary Rent Plan writes never verify a landlord,
  -- so they can never release the landlord registration bonus.
  IF NEW.landlord_id IS NOT NULL
     AND NEW.landlord_ops_reviewed_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.landlord_ops_reviewed_at IS NULL) THEN
    PERFORM public.verify_landlord_on_landlord_review(
      NEW.landlord_id, NEW.id, NEW.landlord_ops_reviewed_by, NEW.landlord_ops_reviewed_at);
  END IF;

  -- LC1: only the genuine Landlord Ops review event qualifies (review date
  -- NULL -> set). Status writes, repeated review writes, repayments, reversals,
  -- accounting corrections and settlement rebuilds never verify an LC1, so a
  -- Rent Plan write can never by itself release the LC1 bonus.
  IF NEW.lc1_id IS NOT NULL
     AND NEW.landlord_ops_reviewed_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.landlord_ops_reviewed_at IS NULL) THEN
    PERFORM public.verify_lc1_on_landlord_review(
      NEW.lc1_id, NEW.id, NEW.landlord_ops_reviewed_by, NEW.landlord_ops_reviewed_at);
  END IF;

  RETURN NEW;
END;
$function$;
