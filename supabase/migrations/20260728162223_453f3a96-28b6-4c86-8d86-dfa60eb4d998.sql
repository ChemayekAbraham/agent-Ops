CREATE OR REPLACE FUNCTION public.get_agent_duplicate_accounts(_agent_ids uuid[])
RETURNS TABLE(agent_id uuid, duplicate_count integer, duplicates jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT p.id,
           lower(regexp_replace(coalesce(p.full_name,''), '[^a-zA-Z]', '', 'g')) AS name_key,
           nullif(upper(regexp_replace(coalesce(p.national_id,''), '[^a-zA-Z0-9]', '', 'g')), '') AS nin_key,
           nullif(regexp_replace(coalesce(p.mobile_money_number,''), '[^0-9]', '', 'g'), '') AS momo_key
    FROM public.profiles p
    WHERE p.id = ANY(_agent_ids)
  ),
  cand AS (
    SELECT p.id,
           lower(regexp_replace(coalesce(p.full_name,''), '[^a-zA-Z]', '', 'g')) AS name_key,
           nullif(upper(regexp_replace(coalesce(p.national_id,''), '[^a-zA-Z0-9]', '', 'g')), '') AS nin_key,
           nullif(regexp_replace(coalesce(p.mobile_money_number,''), '[^0-9]', '', 'g'), '') AS momo_key,
           p.full_name, p.phone, p.email, p.is_frozen, p.created_at
    FROM public.profiles p
  ),
  matches AS (
    SELECT b.id AS agent_id,
           c.id AS dup_id,
           c.full_name, c.phone, c.email, c.is_frozen, c.created_at,
           CASE
             WHEN b.nin_key IS NOT NULL AND b.nin_key = c.nin_key THEN 'national_id'
             WHEN b.momo_key IS NOT NULL AND b.momo_key = c.momo_key THEN 'mobile_money'
             ELSE 'name'
           END AS match_type
    FROM base b
    JOIN cand c
      ON c.id <> b.id
     AND (
          (length(b.name_key) >= 6 AND b.name_key = c.name_key)
       OR (b.nin_key IS NOT NULL AND b.nin_key = c.nin_key)
       OR (b.momo_key IS NOT NULL AND b.momo_key = c.momo_key)
     )
  )
  SELECT m.agent_id,
         count(*)::int AS duplicate_count,
         jsonb_agg(jsonb_build_object(
           'id', m.dup_id,
           'full_name', m.full_name,
           'phone', m.phone,
           'email', m.email,
           'is_frozen', m.is_frozen,
           'created_at', m.created_at,
           'match_type', m.match_type,
           'active_advances', (
             SELECT count(*) FROM public.agent_advances a
             WHERE a.agent_id = m.dup_id AND a.status IN ('active','overdue')
           ),
           'outstanding', (
             SELECT COALESCE(sum(a.outstanding_balance),0) FROM public.agent_advances a
             WHERE a.agent_id = m.dup_id AND a.status IN ('active','overdue')
           )
         ) ORDER BY m.created_at) AS duplicates
  FROM matches m
  GROUP BY m.agent_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_duplicate_accounts(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_duplicate_accounts(uuid[]) TO service_role;