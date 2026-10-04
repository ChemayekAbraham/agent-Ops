DROP FUNCTION IF EXISTS public.check_archived_account_by_phone(text[]);

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
  (
    SELECT
      true AS is_archived,
      'archived'::text AS status,
      regexp_replace(COALESCE(p.full_name, ''), '^\[ARCHIVED\]\s*', '') AS full_name,
      u.deleted_at AS archived_at,
      p.id AS user_id
    FROM public.profiles p
    LEFT JOIN auth.users u ON u.id = p.id
    WHERE (p.phone = ANY(phone_variants) OR u.phone = ANY(phone_variants))
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
      AND (a.metadata->'before'->>'profile_phone') = ANY(phone_variants)
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p2
        LEFT JOIN auth.users u2 ON u2.id = p2.id
        WHERE (p2.phone = ANY(phone_variants) OR u2.phone = ANY(phone_variants))
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
    WHERE lower(p.email) = lower(btrim(p_email))
      AND (p.full_name ILIKE '[ARCHIVED]%' OR u.deleted_at IS NOT NULL)
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
        WHERE lower(p2.email) = lower(btrim(p_email))
          AND (p2.full_name ILIKE '[ARCHIVED]%' OR u2.deleted_at IS NOT NULL)
      )
    ORDER BY a.created_at DESC
    LIMIT 1
  );
$$;

GRANT EXECUTE ON FUNCTION public.check_archived_account_by_email(text) TO anon, authenticated;