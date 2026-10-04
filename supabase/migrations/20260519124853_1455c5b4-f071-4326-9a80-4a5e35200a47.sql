DROP FUNCTION IF EXISTS public.check_archived_account_by_phone(text[]);

CREATE OR REPLACE FUNCTION public.check_archived_account_by_phone(phone_variants text[])
RETURNS TABLE(
  is_archived boolean,
  full_name text,
  archived_at timestamptz,
  user_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    true AS is_archived,
    regexp_replace(COALESCE(p.full_name, ''), '^\[ARCHIVED\]\s*', '') AS full_name,
    u.deleted_at AS archived_at,
    p.id AS user_id
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE (
    p.phone = ANY(phone_variants)
    OR u.phone = ANY(phone_variants)
  )
    AND (
      p.full_name ILIKE '[ARCHIVED]%'
      OR u.deleted_at IS NOT NULL
    )
  ORDER BY u.deleted_at DESC NULLS LAST
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.check_archived_account_by_phone(text[]) TO anon, authenticated;