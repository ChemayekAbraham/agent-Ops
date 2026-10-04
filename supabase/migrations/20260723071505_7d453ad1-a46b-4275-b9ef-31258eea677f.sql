CREATE OR REPLACE FUNCTION public.search_users_fast(p_query text, p_limit integer DEFAULT 25)
 RETURNS TABLE(id uuid, full_name text, phone text, email text, national_id text, verified boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_authorized boolean := false;
  v_q text := btrim(coalesce(p_query, ''));
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_digits text;
  v_lower text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF length(v_q) < 3 THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_uid
      AND enabled = true
      AND role::text IN ('manager','operations','cfo','coo','ceo','cto','cmo','crm','hr','super_admin','employee')
  ) OR EXISTS (
    SELECT 1 FROM public.staff_permissions
    WHERE user_id = v_uid AND permitted_dashboard = 'all'
  ) INTO v_authorized;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  v_digits := regexp_replace(v_q, '\D', '', 'g');
  v_lower  := lower(v_q);

  -- 1) UUID exact match
  IF v_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN QUERY
      SELECT p.id, p.full_name, p.phone, p.email, p.national_id, p.verified
      FROM public.profiles p
      WHERE p.id = v_q::uuid
      LIMIT v_limit;
    RETURN;
  END IF;

  -- 2) Phone lookup — uses idx_profiles_phone_last9 (functional btree on last 9 digits)
  IF length(v_digits) >= 6 THEN
    RETURN QUERY
      SELECT p.id, p.full_name, p.phone, p.email, p.national_id, p.verified
      FROM public.profiles p
      WHERE right(regexp_replace(p.phone, '\D', '', 'g'), 9) = right(v_digits, 9)
      LIMIT v_limit;
    RETURN;
  END IF;

  -- 3) National ID prefix — REQUIRES at least one digit (Ugandan NINs are digit-heavy);
  --    pure-alpha strings like "JOSHUA" fall through to the name branch.
  IF v_q ~* '^[A-Z0-9]{4,}$' AND v_digits <> '' THEN
    RETURN QUERY
      SELECT p.id, p.full_name, p.phone, p.email, p.national_id, p.verified
      FROM public.profiles p
      WHERE p.national_id LIKE upper(v_q) || '%'
      LIMIT v_limit;
    RETURN;
  END IF;

  -- 4) Email prefix — uses idx_profiles_email_lower
  IF position('@' in v_q) > 0 OR v_q ~* '\.[a-z]{2,}$' THEN
    RETURN QUERY
      SELECT p.id, p.full_name, p.phone, p.email, p.national_id, p.verified
      FROM public.profiles p
      WHERE lower(p.email) LIKE v_lower || '%'
      LIMIT v_limit;
    RETURN;
  END IF;

  -- 5) Name: prefix first (uses idx_profiles_full_name_lower btree), then trigram substring
  RETURN QUERY
    WITH prefix AS (
      SELECT p.id, p.full_name, p.phone, p.email, p.national_id, p.verified
      FROM public.profiles p
      WHERE lower(p.full_name) LIKE v_lower || '%'
      LIMIT v_limit
    ),
    trigram AS (
      SELECT p.id, p.full_name, p.phone, p.email, p.national_id, p.verified
      FROM public.profiles p
      WHERE p.full_name ILIKE '%' || v_q || '%'
        AND NOT EXISTS (SELECT 1 FROM prefix pf WHERE pf.id = p.id)
      LIMIT v_limit
    )
    SELECT * FROM prefix
    UNION ALL
    SELECT * FROM trigram
    LIMIT v_limit;
END;
$function$;