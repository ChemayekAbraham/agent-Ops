
CREATE OR REPLACE FUNCTION public.bulk_reject_house_listings(p_listing_ids uuid[], p_reason text)
 RETURNS TABLE(id uuid, ok boolean, error text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := coalesce(trim(p_reason), '');
  v_ids uuid[];
  v_id uuid;
  v_result jsonb;
  v_err text;
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
    BEGIN
      v_result := public.reject_house_listing(v_id, v_reason);
      IF v_result ? 'error' THEN
        id := v_id;
        ok := false;
        error := coalesce(v_result->>'error', 'Rejection failed');
        RETURN NEXT;
      ELSE
        id := v_id;
        ok := true;
        error := NULL;
        RETURN NEXT;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      id := v_id;
      ok := false;
      error := v_err;
      RETURN NEXT;
    END;
  END LOOP;
END;
$function$;
