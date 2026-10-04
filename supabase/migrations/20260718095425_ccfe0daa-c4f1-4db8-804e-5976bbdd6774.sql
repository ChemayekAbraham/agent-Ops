
-- Audit view: every account without a verified phone
CREATE OR REPLACE VIEW public.v_accounts_no_verified_phone AS
SELECT
  p.id,
  p.full_name,
  p.email,
  p.phone,
  p.phone_verified_at,
  p.created_at,
  (p.phone IS NULL OR p.phone = '') AS missing_phone,
  (au.raw_app_meta_data->>'provider') AS auth_provider
FROM public.profiles p
LEFT JOIN auth.users au ON au.id = p.id
WHERE p.phone_verified_at IS NULL;

-- Suspicious duplicate clusters: group no-phone accounts by email stem (strip trailing digits)
CREATE OR REPLACE VIEW public.v_suspicious_duplicate_accounts AS
WITH s AS (
  SELECT
    id, full_name, email, created_at,
    lower(regexp_replace(split_part(email,'@',1), '[0-9]+$', '')) AS email_stem,
    split_part(email,'@',2) AS email_domain,
    lower(regexp_replace(coalesce(full_name,''), '\s+', ' ', 'g')) AS name_norm
  FROM public.profiles
  WHERE (phone IS NULL OR phone = '')
)
SELECT
  email_stem,
  email_domain,
  name_norm,
  COUNT(*) AS accounts,
  array_agg(id ORDER BY created_at) AS profile_ids,
  string_agg(email, ', ' ORDER BY created_at) AS emails,
  string_agg(coalesce(full_name,'∅'), ' | ' ORDER BY created_at) AS names,
  min(created_at) AS first_seen,
  max(created_at) AS last_seen
FROM s
WHERE length(email_stem) >= 3
GROUP BY email_stem, email_domain, name_norm
HAVING COUNT(*) > 1
ORDER BY accounts DESC;

REVOKE ALL ON public.v_accounts_no_verified_phone FROM anon, authenticated;
REVOKE ALL ON public.v_suspicious_duplicate_accounts FROM anon, authenticated;
GRANT SELECT ON public.v_accounts_no_verified_phone TO service_role;
GRANT SELECT ON public.v_suspicious_duplicate_accounts TO service_role;

-- Ops-only read access via existing has_role helper
CREATE OR REPLACE FUNCTION public.get_duplicate_account_audit()
RETURNS TABLE (
  email_stem text,
  email_domain text,
  name_norm text,
  accounts bigint,
  profile_ids uuid[],
  emails text,
  names text,
  first_seen timestamptz,
  last_seen timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT * FROM public.v_suspicious_duplicate_accounts
  WHERE public.has_role(auth.uid(), 'manager')
     OR public.has_role(auth.uid(), 'super_admin')
     OR public.has_role(auth.uid(), 'cfo');
$$;

GRANT EXECUTE ON FUNCTION public.get_duplicate_account_audit() TO authenticated;
