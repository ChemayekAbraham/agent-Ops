CREATE OR REPLACE FUNCTION public.national_id_link_holder_requests()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'id', r.id,
      'nin', r.nin,
      'status', r.status,
      'code_verified_at', r.code_verified_at,
      'created_at', r.created_at,
      'expires_at', r.expires_at,
      'requester_name', NULLIF(TRIM(COALESCE(p.full_name, '')), ''),
      'requester_phone', p.phone
    ) AS x
    FROM public.national_id_link_requests r
    LEFT JOIN public.profiles p ON p.id = r.requester_id
    WHERE r.holder_id = auth.uid()
      AND r.status = 'awaiting_owner'
      AND r.expires_at > now()
  ) s;
$$;

REVOKE ALL ON FUNCTION public.national_id_link_holder_requests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.national_id_link_holder_requests() TO authenticated;