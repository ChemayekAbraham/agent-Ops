-- 1. Status + reason columns
ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verification_reason text;

ALTER TABLE public.lc1_chairpersons
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verification_reason text;

-- 2. Backfill status from the legacy boolean
UPDATE public.landlords
  SET verification_status = CASE WHEN verified THEN 'verified' ELSE 'pending' END
  WHERE verification_status = 'pending';
UPDATE public.lc1_chairpersons
  SET verification_status = CASE WHEN verified THEN 'verified' ELSE 'pending' END
  WHERE verification_status = 'pending';

-- 3. Constrain allowed values (static list = immutable safe)
ALTER TABLE public.landlords DROP CONSTRAINT IF EXISTS landlords_verification_status_check;
ALTER TABLE public.landlords ADD CONSTRAINT landlords_verification_status_check
  CHECK (verification_status IN ('pending','verified','rejected'));
ALTER TABLE public.lc1_chairpersons DROP CONSTRAINT IF EXISTS lc1_verification_status_check;
ALTER TABLE public.lc1_chairpersons ADD CONSTRAINT lc1_verification_status_check
  CHECK (verification_status IN ('pending','verified','rejected'));

-- 4. Ops RPC: set landlord GPS / verification status with mandatory reason
CREATE OR REPLACE FUNCTION public.set_landlord_verification(p_landlord_id uuid, p_status text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF NOT is_ops_role(v_actor) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_status NOT IN ('pending','verified','rejected') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;

  UPDATE public.landlords
  SET verification_status = p_status,
      verification_reason = btrim(p_reason),
      verified = (p_status = 'verified'),
      verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE verified_at END,
      verified_by = CASE WHEN p_status = 'verified' THEN v_actor ELSE verified_by END
  WHERE id = p_landlord_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Landlord not found'; END IF;

  UPDATE public.landlord_verification_requests
  SET status = p_status,
      reject_comment = CASE WHEN p_status = 'rejected' THEN btrim(p_reason) ELSE reject_comment END,
      resolved_by = v_actor,
      resolved_at = now()
  WHERE landlord_id = p_landlord_id AND status = 'pending';

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'landlord_verification_status_set', 'landlords', p_landlord_id,
    jsonb_build_object('status', p_status, 'reason', btrim(p_reason)));
END;
$$;

-- 5. Ops RPC: set LC1 chairperson verification status with mandatory reason
CREATE OR REPLACE FUNCTION public.set_lc1_verification(p_lc1_id uuid, p_status text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF NOT is_ops_role(v_actor) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_status NOT IN ('pending','verified','rejected') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;

  UPDATE public.lc1_chairpersons
  SET verification_status = p_status,
      verification_reason = btrim(p_reason),
      verified = (p_status = 'verified'),
      verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE verified_at END,
      verified_by = CASE WHEN p_status = 'verified' THEN v_actor ELSE verified_by END
  WHERE id = p_lc1_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'LC1 chairperson not found'; END IF;

  UPDATE public.lc1_verification_requests
  SET status = p_status,
      reject_comment = CASE WHEN p_status = 'rejected' THEN btrim(p_reason) ELSE reject_comment END,
      resolved_by = v_actor,
      resolved_at = now()
  WHERE lc1_id = p_lc1_id AND status = 'pending';

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'lc1_verification_status_set', 'lc1_chairpersons', p_lc1_id,
    jsonb_build_object('status', p_status, 'reason', btrim(p_reason)));
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_landlord_verification(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_lc1_verification(uuid, text, text) TO authenticated;