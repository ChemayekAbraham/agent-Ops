
-- Shared authorization helper for Landlord Ops staff.
CREATE OR REPLACE FUNCTION public.is_landlord_ops_staff(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_role(_user_id, 'manager'::app_role)
    OR public.has_role(_user_id, 'coo'::app_role)
    OR public.has_role(_user_id, 'super_admin'::app_role)
    OR public.has_role(_user_id, 'cto'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.staff_permissions sp
      WHERE sp.user_id = _user_id
        AND sp.permitted_dashboard IN ('landlord', 'landlord-ops', 'landlord_ops')
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_landlord_ops_staff(uuid) TO authenticated;

-- Single-listing visibility toggle with in-transaction audit.
CREATE OR REPLACE FUNCTION public.toggle_house_listing_visibility(
  p_listing_id uuid,
  p_hidden boolean,
  p_reason text
) RETURNS TABLE(id uuid, is_hidden boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_title text;
  v_reason text := coalesce(trim(p_reason), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_landlord_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'Insufficient permissions' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters' USING ERRCODE = '22023';
  END IF;

  UPDATE public.house_listings
    SET is_hidden = p_hidden
    WHERE public.house_listings.id = p_listing_id
    RETURNING title INTO v_title;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listing % not found', p_listing_id USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_uid,
    CASE WHEN p_hidden THEN 'listing_hidden' ELSE 'listing_unhidden' END,
    'house_listings',
    p_listing_id,
    jsonb_build_object(
      'reason', v_reason,
      'listing_title', v_title,
      'hidden_by', 'landlord_ops',
      'bulk', false
    )
  );

  RETURN QUERY SELECT p_listing_id, p_hidden;
END;
$$;

GRANT EXECUTE ON FUNCTION public.toggle_house_listing_visibility(uuid, boolean, text) TO authenticated;

-- Bulk visibility with per-listing audit entries, all in one transaction.
CREATE OR REPLACE FUNCTION public.bulk_update_house_listing_visibility(
  p_listing_ids uuid[],
  p_hidden boolean,
  p_reason text
) RETURNS TABLE(id uuid, is_hidden boolean, title text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := coalesce(trim(p_reason), '');
  v_ids uuid[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_landlord_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'Insufficient permissions' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters' USING ERRCODE = '22023';
  END IF;
  IF p_listing_ids IS NULL OR array_length(p_listing_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- Deduplicate + strip nulls.
  SELECT array_agg(DISTINCT x) INTO v_ids
  FROM unnest(p_listing_ids) AS x
  WHERE x IS NOT NULL;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH updated AS (
    UPDATE public.house_listings hl
      SET is_hidden = p_hidden
      WHERE hl.id = ANY(v_ids)
      RETURNING hl.id, hl.is_hidden, hl.title
  ),
  logged AS (
    INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
    SELECT
      v_uid,
      CASE WHEN p_hidden THEN 'listing_hidden' ELSE 'listing_unhidden' END,
      'house_listings',
      u.id,
      jsonb_build_object(
        'reason', v_reason,
        'listing_title', u.title,
        'hidden_by', 'landlord_ops',
        'bulk', true
      )
    FROM updated u
    RETURNING 1
  )
  SELECT u.id, u.is_hidden, u.title FROM updated u;
END;
$$;

GRANT EXECUTE ON FUNCTION public.bulk_update_house_listing_visibility(uuid[], boolean, text) TO authenticated;

-- Bulk reject that delegates to the existing single-reject RPC so all
-- side-effects (penalties, status transitions, audit) stay identical.
-- Runs inside one transaction: a failure on any listing rolls the whole
-- batch back.
CREATE OR REPLACE FUNCTION public.bulk_reject_house_listings(
  p_listing_ids uuid[],
  p_reason text
) RETURNS TABLE(id uuid, ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := coalesce(trim(p_reason), '');
  v_ids uuid[];
  v_id uuid;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_landlord_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'Insufficient permissions' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters' USING ERRCODE = '22023';
  END IF;
  IF p_listing_ids IS NULL OR array_length(p_listing_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids
  FROM unnest(p_listing_ids) AS x
  WHERE x IS NOT NULL;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  FOREACH v_id IN ARRAY v_ids LOOP
    v_result := public.reject_house_listing(v_id, v_reason);
    IF v_result ? 'error' THEN
      -- Propagate so the outer transaction is rolled back atomically.
      RAISE EXCEPTION 'reject_house_listing % failed: %', v_id, v_result->>'error'
        USING ERRCODE = 'P0001';
    END IF;
    id := v_id;
    ok := true;
    error := NULL;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.bulk_reject_house_listings(uuid[], text) TO authenticated;
