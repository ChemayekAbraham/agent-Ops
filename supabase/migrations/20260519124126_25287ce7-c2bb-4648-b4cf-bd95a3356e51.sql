
CREATE OR REPLACE FUNCTION public.check_archived_account_by_phone(phone_variants text[])
RETURNS TABLE (
  is_archived boolean,
  full_name text,
  archived_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH p AS (
    SELECT
      regexp_replace(coalesce(pr.full_name, ''), '^\[ARCHIVED\]\s*', '', 'i') AS clean_name,
      pr.full_name,
      au.deleted_at
    FROM public.profiles pr
    LEFT JOIN auth.users au ON au.id = pr.id
    WHERE pr.phone = ANY(phone_variants)
      AND (
        pr.full_name ILIKE '[ARCHIVED]%'
        OR au.deleted_at IS NOT NULL
      )
    ORDER BY au.deleted_at DESC NULLS LAST
    LIMIT 1
  )
  SELECT TRUE, clean_name, deleted_at FROM p;
$$;

GRANT EXECUTE ON FUNCTION public.check_archived_account_by_phone(text[]) TO anon, authenticated;
