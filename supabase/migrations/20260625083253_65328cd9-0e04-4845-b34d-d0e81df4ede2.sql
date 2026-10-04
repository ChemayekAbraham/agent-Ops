CREATE OR REPLACE FUNCTION public.get_email_by_phone(phone_variants text[])
RETURNS TABLE(email text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  last9_variants text[];
  v text;
  cleaned text;
BEGIN
  last9_variants := ARRAY[]::text[];

  FOREACH v IN ARRAY phone_variants LOOP
    cleaned := regexp_replace(COALESCE(v, ''), '[^0-9]', '', 'g');
    IF length(cleaned) >= 9 THEN
      last9_variants := array_append(last9_variants, right(cleaned, 9));
    END IF;
  END LOOP;

  RETURN QUERY
  WITH matched_profiles AS (
    SELECT
      p.id,
      p.email AS profile_email,
      p.phone AS profile_phone,
      p.full_name,
      p.updated_at AS profile_updated_at,
      u.email AS auth_email,
      u.phone AS auth_phone,
      u.deleted_at AS auth_deleted_at,
      u.updated_at AS auth_updated_at
    FROM public.profiles p
    LEFT JOIN auth.users u ON u.id = p.id
    WHERE (
      right(regexp_replace(COALESCE(p.phone, ''), '[^0-9]', '', 'g'), 9) = ANY(last9_variants)
      OR right(regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g'), 9) = ANY(last9_variants)
    )
    AND COALESCE(p.full_name, '') NOT ILIKE '[ARCHIVED]%'
    AND (u.id IS NULL OR u.deleted_at IS NULL)
  ), candidate_emails AS (
    SELECT lower(auth_email) AS candidate_email, 0 AS priority, COALESCE(auth_updated_at, profile_updated_at) AS last_seen
    FROM matched_profiles
    WHERE NULLIF(auth_email, '') IS NOT NULL

    UNION ALL

    SELECT lower(profile_email) AS candidate_email, 1 AS priority, profile_updated_at AS last_seen
    FROM matched_profiles
    WHERE NULLIF(profile_email, '') IS NOT NULL
  )
  SELECT candidate_email
  FROM candidate_emails
  WHERE candidate_email IS NOT NULL
    AND candidate_email <> ''
    AND candidate_email NOT LIKE 'freed+%@archived.local'
  GROUP BY candidate_email
  ORDER BY min(priority), max(last_seen) DESC NULLS LAST
  LIMIT 10;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_email_by_phone(text[]) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_archived_account_by_phone(phone_variants text[])
RETURNS TABLE(
  is_archived boolean,
  status text,
  full_name text,
  archived_at timestamptz,
  user_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH normalized AS (
    SELECT DISTINCT right(regexp_replace(COALESCE(v, ''), '[^0-9]', '', 'g'), 9) AS last9
    FROM unnest(phone_variants) AS v
    WHERE length(regexp_replace(COALESCE(v, ''), '[^0-9]', '', 'g')) >= 9
  )
  (
    SELECT
      true AS is_archived,
      'archived'::text AS status,
      regexp_replace(COALESCE(p.full_name, ''), '^\[ARCHIVED\]\s*', '') AS full_name,
      u.deleted_at AS archived_at,
      p.id AS user_id
    FROM public.profiles p
    LEFT JOIN auth.users u ON u.id = p.id
    WHERE (
        right(regexp_replace(COALESCE(p.phone, ''), '[^0-9]', '', 'g'), 9) IN (SELECT last9 FROM normalized)
        OR right(regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g'), 9) IN (SELECT last9 FROM normalized)
      )
      AND (p.full_name ILIKE '[ARCHIVED]%' OR u.deleted_at IS NOT NULL)
    ORDER BY u.deleted_at DESC NULLS LAST
    LIMIT 1
  )
  UNION ALL
  (
    SELECT
      true AS is_archived,
      'freed'::text AS status,
      COALESCE(NULLIF(regexp_replace(a.metadata->'before'->>'full_name', '^\[ARCHIVED\]\s*', ''), ''), 'Previous account') AS full_name,
      a.created_at AS archived_at,
      NULLIF(a.record_id, '')::uuid AS user_id
    FROM public.audit_logs a
    WHERE a.action_type = 'credentials_freed_for_resignup'
      AND right(regexp_replace(COALESCE(a.metadata->'before'->>'profile_phone', ''), '[^0-9]', '', 'g'), 9) IN (SELECT last9 FROM normalized)
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p2
        LEFT JOIN auth.users u2 ON u2.id = p2.id
        WHERE (
            right(regexp_replace(COALESCE(p2.phone, ''), '[^0-9]', '', 'g'), 9) IN (SELECT last9 FROM normalized)
            OR right(regexp_replace(COALESCE(u2.phone, ''), '[^0-9]', '', 'g'), 9) IN (SELECT last9 FROM normalized)
          )
          AND (p2.full_name ILIKE '[ARCHIVED]%' OR u2.deleted_at IS NOT NULL)
      )
    ORDER BY a.created_at DESC
    LIMIT 1
  );
$$;

GRANT EXECUTE ON FUNCTION public.check_archived_account_by_phone(text[]) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_archived_account_by_email(p_email text)
RETURNS TABLE(
  is_archived boolean,
  status text,
  full_name text,
  archived_at timestamptz,
  user_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  (
    SELECT
      true AS is_archived,
      'archived'::text AS status,
      regexp_replace(COALESCE(p.full_name, ''), '^\[ARCHIVED\]\s*', '') AS full_name,
      u.deleted_at AS archived_at,
      p.id AS user_id
    FROM public.profiles p
    LEFT JOIN auth.users u ON u.id = p.id
    WHERE (
        lower(p.email) = lower(btrim(p_email))
        OR lower(u.email) = lower(btrim(p_email))
      )
      AND (p.full_name ILIKE '[ARCHIVED]%' OR u.deleted_at IS NOT NULL)
    ORDER BY u.deleted_at DESC NULLS LAST
    LIMIT 1
  )
  UNION ALL
  (
    SELECT
      true AS is_archived,
      'freed'::text AS status,
      COALESCE(NULLIF(regexp_replace(a.metadata->'before'->>'full_name', '^\[ARCHIVED\]\s*', ''), ''), 'Previous account') AS full_name,
      a.created_at AS archived_at,
      NULLIF(a.record_id, '')::uuid AS user_id
    FROM public.audit_logs a
    WHERE a.action_type = 'credentials_freed_for_resignup'
      AND lower(a.metadata->'before'->>'profile_email') = lower(btrim(p_email))
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p2
        LEFT JOIN auth.users u2 ON u2.id = p2.id
        WHERE (lower(p2.email) = lower(btrim(p_email)) OR lower(u2.email) = lower(btrim(p_email)))
          AND (p2.full_name ILIKE '[ARCHIVED]%' OR u2.deleted_at IS NOT NULL)
      )
    ORDER BY a.created_at DESC
    LIMIT 1
  );
$$;

GRANT EXECUTE ON FUNCTION public.check_archived_account_by_email(text) TO anon, authenticated;