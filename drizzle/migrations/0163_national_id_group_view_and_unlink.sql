-- Notices raised when an ID owner removes someone from their National ID group
CREATE TABLE IF NOT EXISTS public.national_id_unlink_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  nin_masked text NOT NULL,
  owner_name text,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);

GRANT SELECT, UPDATE ON public.national_id_unlink_notices TO authenticated;
GRANT ALL ON public.national_id_unlink_notices TO service_role;

ALTER TABLE public.national_id_unlink_notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own unlink notices readable" ON public.national_id_unlink_notices;
CREATE POLICY "own unlink notices readable"
ON public.national_id_unlink_notices
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "own unlink notices ackable" ON public.national_id_unlink_notices;
CREATE POLICY "own unlink notices ackable"
ON public.national_id_unlink_notices
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS national_id_unlink_notices_user_open_idx
  ON public.national_id_unlink_notices (user_id, acknowledged_at);

-- Mask a National ID: keep the first 3 and last 4 characters only.
CREATE OR REPLACE FUNCTION public.mask_national_id(p_nin text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN coalesce(p_nin, '') = '' THEN NULL
    WHEN length(regexp_replace(p_nin, '\s', '', 'g')) <= 7
      THEN repeat('*', length(regexp_replace(p_nin, '\s', '', 'g')))
    ELSE left(upper(regexp_replace(p_nin, '\s', '', 'g')), 3)
         || repeat('*', greatest(length(regexp_replace(p_nin, '\s', '', 'g')) - 7, 1))
         || right(upper(regexp_replace(p_nin, '\s', '', 'g')), 4)
  END
$$;

-- What the caller may see about the National ID they share with others.
CREATE OR REPLACE FUNCTION public.national_id_group_view()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_nin text;
  v_fuzzy text;
  v_owner uuid;
  v_masked text;
  v_members jsonb := '[]'::jsonb;
  v_owner_row jsonb;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('found', false, 'reason', 'not_signed_in');
  END IF;

  SELECT nullif(coalesce(nullif(p.national_id, ''), nullif(p.linked_national_id, '')), '')
    INTO v_nin
  FROM public.profiles p
  WHERE p.id = v_me;

  IF v_nin IS NULL THEN
    RETURN jsonb_build_object('found', false, 'reason', 'no_national_id');
  END IF;

  v_fuzzy := public.normalize_national_id_fuzzy(v_nin);
  v_masked := public.mask_national_id(v_nin);

  -- Owner: earliest account that carries this ID as its own.
  SELECT p.id INTO v_owner
  FROM public.profiles p
  WHERE coalesce(p.national_id, '') <> ''
    AND public.normalize_national_id_fuzzy(p.national_id) = v_fuzzy
  ORDER BY p.created_at ASC NULLS LAST, p.id ASC
  LIMIT 1;

  IF v_owner IS NULL THEN
    SELECT p.id INTO v_owner
    FROM public.profiles p
    WHERE public.normalize_national_id_fuzzy(
            coalesce(nullif(p.national_id, ''), p.linked_national_id, '')) = v_fuzzy
    ORDER BY p.created_at ASC NULLS LAST, p.id ASC
    LIMIT 1;
  END IF;

  IF v_owner = v_me THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'user_id', p.id,
             'full_name', p.full_name,
             'phone', p.phone,
             'email', p.email,
             'avatar_url', p.avatar_url
           ) ORDER BY p.created_at ASC NULLS LAST), '[]'::jsonb)
      INTO v_members
    FROM public.profiles p
    WHERE p.id <> v_me
      AND public.normalize_national_id_fuzzy(
            coalesce(nullif(p.national_id, ''), p.linked_national_id, '')) = v_fuzzy;

    RETURN jsonb_build_object(
      'found', true,
      'is_owner', true,
      'masked_nin', v_masked,
      'member_count', jsonb_array_length(v_members),
      'members', v_members,
      'owner', NULL
    );
  END IF;

  SELECT jsonb_build_object('user_id', p.id, 'full_name', p.full_name, 'phone', p.phone)
    INTO v_owner_row
  FROM public.profiles p
  WHERE p.id = v_owner;

  RETURN jsonb_build_object(
    'found', true,
    'is_owner', false,
    'masked_nin', v_masked,
    'member_count', 0,
    'members', '[]'::jsonb,
    'owner', v_owner_row
  );
END;
$$;

REVOKE ALL ON FUNCTION public.national_id_group_view() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.national_id_group_view() TO authenticated;

-- The owner of a National ID removes someone else from it.
CREATE OR REPLACE FUNCTION public.national_id_unlink_member(p_member_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_nin text;
  v_fuzzy text;
  v_owner uuid;
  v_masked text;
  v_owner_name text;
  v_member_phone text;
  v_member_name text;
  v_member_fuzzy text;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Please sign in again.');
  END IF;
  IF p_member_id IS NULL OR p_member_id = v_me THEN
    RETURN jsonb_build_object('success', false, 'message', 'Choose someone else on the ID.');
  END IF;
  IF length(coalesce(trim(p_reason), '')) < 10 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Please write a short reason (at least 10 characters).');
  END IF;

  SELECT nullif(p.national_id, ''), p.full_name INTO v_nin, v_owner_name
  FROM public.profiles p WHERE p.id = v_me;

  IF v_nin IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only the owner of the National ID can remove someone.');
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
    RETURN jsonb_build_object('success', false, 'message', 'Only the owner of the National ID can remove someone.');
  END IF;

  SELECT public.normalize_national_id_fuzzy(
           coalesce(nullif(p.national_id, ''), p.linked_national_id, '')),
         p.phone, p.full_name
    INTO v_member_fuzzy, v_member_phone, v_member_name
  FROM public.profiles p WHERE p.id = p_member_id;

  IF v_member_fuzzy IS DISTINCT FROM v_fuzzy THEN
    RETURN jsonb_build_object('success', false, 'message', 'That person is not on your National ID.');
  END IF;

  UPDATE public.profiles
     SET linked_national_id = NULL,
         linked_national_id_request_id = NULL
   WHERE id = p_member_id;

  UPDATE public.national_id_link_requests
     SET status = 'expired',
         decision_reason = left('Unlinked by the ID holder: ' || trim(p_reason), 500),
         updated_at = now()
   WHERE requester_id = p_member_id
     AND holder_id = v_me
     AND status IN ('awaiting_owner', 'owner_approved', 'active');

  INSERT INTO public.national_id_unlink_notices (user_id, nin_masked, owner_name, reason)
  VALUES (p_member_id, v_masked, v_owner_name, trim(p_reason));

  RETURN jsonb_build_object(
    'success', true,
    'member_phone', v_member_phone,
    'member_name', v_member_name,
    'masked_nin', v_masked,
    'owner_name', v_owner_name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.national_id_unlink_member(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.national_id_unlink_member(uuid, text) TO authenticated, service_role;

-- The removed person acknowledges the in-app notice.
CREATE OR REPLACE FUNCTION public.national_id_unlink_ack(p_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.national_id_unlink_notices
     SET acknowledged_at = now()
   WHERE id = p_id
     AND user_id = auth.uid()
     AND acknowledged_at IS NULL
  RETURNING true;
$$;

REVOKE ALL ON FUNCTION public.national_id_unlink_ack(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.national_id_unlink_ack(uuid) TO authenticated;