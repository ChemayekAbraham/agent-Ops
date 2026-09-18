CREATE TABLE IF NOT EXISTS public.national_id_unlink_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  member_id uuid NOT NULL,
  owner_name text,
  member_name text,
  member_phone text,
  nin_masked text,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decided_by uuid,
  decided_by_name text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT national_id_unlink_requests_status_ck
    CHECK (status IN ('pending','approved','rejected','cancelled')),
  CONSTRAINT national_id_unlink_requests_reason_ck CHECK (length(btrim(reason)) >= 10)
);

CREATE UNIQUE INDEX IF NOT EXISTS national_id_unlink_requests_one_pending
  ON public.national_id_unlink_requests (owner_id, member_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS national_id_unlink_requests_status_idx
  ON public.national_id_unlink_requests (status, created_at DESC);

GRANT SELECT ON public.national_id_unlink_requests TO authenticated;
GRANT ALL ON public.national_id_unlink_requests TO service_role;

ALTER TABLE public.national_id_unlink_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY national_id_unlink_requests_read ON public.national_id_unlink_requests
FOR SELECT TO authenticated
USING (
  owner_id = auth.uid() OR member_id = auth.uid()
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

-- Who may decide on these requests.
CREATE OR REPLACE FUNCTION public.national_id_unlink_is_approver(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p_uid IS NOT NULL AND (
    public.has_role(p_uid, 'financial_ops'::app_role)
    OR public.has_role(p_uid, 'cfo'::app_role)
    OR public.has_role(p_uid, 'manager'::app_role)
    OR public.has_role(p_uid, 'super_admin'::app_role)
  );
$$;

-- The ID holder asks Finance Operations to remove someone from their ID.
CREATE OR REPLACE FUNCTION public.request_national_id_unlink(p_member_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_nin text; v_fuzzy text; v_masked text; v_owner uuid; v_owner_name text;
  v_member_fuzzy text; v_member_phone text; v_member_name text;
  v_id uuid;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Please sign in again.');
  END IF;
  IF p_member_id IS NULL OR p_member_id = v_me THEN
    RETURN jsonb_build_object('success', false, 'message', 'Choose someone else on the ID.');
  END IF;
  IF length(coalesce(btrim(p_reason), '')) < 10 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Please write a reason (at least 10 characters).');
  END IF;

  SELECT nullif(p.national_id, ''), p.full_name INTO v_nin, v_owner_name
  FROM public.profiles p WHERE p.id = v_me;

  IF v_nin IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only the owner of the National ID can ask for a removal.');
  END IF;

  v_fuzzy := public.normalize_national_id_fuzzy(v_nin);
  v_masked := public.mask_national_id(v_nin);

  SELECT p.id INTO v_owner
  FROM public.profiles p
  WHERE coalesce(p.national_id, '') <> ''
    AND public.normalize_national_id_fuzzy(p.national_id) = v_fuzzy
  ORDER BY p.created_at ASC NULLS LAST, p.id ASC
  LIMIT 1;

  IF v_owner IS DISTINCT FROM v_me THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only the owner of the National ID can ask for a removal.');
  END IF;

  SELECT public.normalize_national_id_fuzzy(
           coalesce(nullif(p.national_id, ''), p.linked_national_id, '')),
         p.phone, p.full_name
    INTO v_member_fuzzy, v_member_phone, v_member_name
  FROM public.profiles p WHERE p.id = p_member_id;

  IF v_member_fuzzy IS DISTINCT FROM v_fuzzy THEN
    RETURN jsonb_build_object('success', false, 'message', 'That person is not on your National ID.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.national_id_unlink_requests
    WHERE owner_id = v_me AND member_id = p_member_id AND status = 'pending'
  ) THEN
    RETURN jsonb_build_object('success', false, 'message', 'A removal request for this person is already waiting for Finance Operations.');
  END IF;

  INSERT INTO public.national_id_unlink_requests (
    owner_id, member_id, owner_name, member_name, member_phone, nin_masked, reason
  ) VALUES (
    v_me, p_member_id, v_owner_name, v_member_name, v_member_phone, v_masked, btrim(p_reason)
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'request_id', v_id, 'status', 'pending');
END;
$$;

-- What the ID holder sees on each person's card.
CREATE OR REPLACE FUNCTION public.national_id_unlink_my_requests()
RETURNS SETOF public.national_id_unlink_requests
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT r.* FROM public.national_id_unlink_requests r
  WHERE auth.uid() IS NOT NULL AND r.owner_id = auth.uid()
  ORDER BY r.created_at DESC;
$$;

-- The Finance Operations queue.
CREATE OR REPLACE FUNCTION public.national_id_unlink_queue(p_status text DEFAULT 'pending')
RETURNS SETOF public.national_id_unlink_requests
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT r.* FROM public.national_id_unlink_requests r
  WHERE public.national_id_unlink_is_approver(auth.uid())
    AND (p_status IS NULL OR p_status = 'all' OR r.status = p_status)
  ORDER BY r.created_at DESC
  LIMIT 300;
$$;

-- Finance Operations approves or refuses. Approval performs the removal.
CREATE OR REPLACE FUNCTION public.decide_national_id_unlink(
  p_request_id uuid,
  p_approve boolean,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_req public.national_id_unlink_requests;
  v_me_name text;
  v_fuzzy text;
  v_member_fuzzy text;
BEGIN
  IF NOT public.national_id_unlink_is_approver(v_me) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only Finance Operations can decide this.');
  END IF;

  SELECT * INTO v_req FROM public.national_id_unlink_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request no longer exists.');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request has already been decided.');
  END IF;

  SELECT full_name INTO v_me_name FROM public.profiles WHERE id = v_me;

  IF NOT coalesce(p_approve, false) THEN
    UPDATE public.national_id_unlink_requests
       SET status = 'rejected', decided_by = v_me, decided_by_name = v_me_name,
           decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
     WHERE id = p_request_id;
    RETURN jsonb_build_object('success', true, 'status', 'rejected');
  END IF;

  -- Re-check the link still holds before removing anything.
  SELECT public.normalize_national_id_fuzzy(nullif(p.national_id, ''))
    INTO v_fuzzy FROM public.profiles p WHERE p.id = v_req.owner_id;
  SELECT public.normalize_national_id_fuzzy(
           coalesce(nullif(p.national_id, ''), p.linked_national_id, ''))
    INTO v_member_fuzzy FROM public.profiles p WHERE p.id = v_req.member_id;

  IF v_fuzzy IS NULL OR v_member_fuzzy IS DISTINCT FROM v_fuzzy THEN
    UPDATE public.national_id_unlink_requests
       SET status = 'cancelled', decided_by = v_me, decided_by_name = v_me_name,
           decided_at = now(),
           decision_note = 'That person is no longer on this National ID.', updated_at = now()
     WHERE id = p_request_id;
    RETURN jsonb_build_object('success', false, 'message', 'That person is no longer on this National ID.');
  END IF;

  UPDATE public.profiles
     SET linked_national_id = NULL,
         linked_national_id_request_id = NULL
   WHERE id = v_req.member_id;

  UPDATE public.national_id_link_requests
     SET status = 'expired',
         decision_reason = left('Unlinked by the ID holder (approved by Finance Operations): ' || v_req.reason, 500),
         updated_at = now()
   WHERE requester_id = v_req.member_id
     AND holder_id = v_req.owner_id
     AND status IN ('awaiting_owner', 'owner_approved', 'active');

  INSERT INTO public.national_id_unlink_notices (user_id, nin_masked, owner_name, reason)
  VALUES (v_req.member_id, v_req.nin_masked, v_req.owner_name, v_req.reason);

  UPDATE public.national_id_unlink_requests
     SET status = 'approved', decided_by = v_me, decided_by_name = v_me_name,
         decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
   WHERE id = p_request_id;

  RETURN jsonb_build_object(
    'success', true, 'status', 'approved',
    'member_id', v_req.member_id, 'member_phone', v_req.member_phone,
    'member_name', v_req.member_name, 'masked_nin', v_req.nin_masked,
    'owner_name', v_req.owner_name
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_national_id_unlink(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.national_id_unlink_my_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION public.national_id_unlink_queue(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_national_id_unlink(uuid, boolean, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.national_id_unlink_is_approver(uuid) TO authenticated, service_role;
