CREATE OR REPLACE FUNCTION public.ops_landlord_change_history(p_landlord_id uuid, p_limit integer DEFAULT 50)
RETURNS TABLE (
  audit_id uuid,
  changed_at timestamptz,
  actor_id uuid,
  actor_name text,
  action_type text,
  reason text,
  record_id text,
  field_name text,
  old_value text,
  new_value text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH allowed AS (
    SELECT public.is_ops_role(auth.uid()) AS ok
  ),
  rows AS (
    SELECT a.id, a.created_at, a.user_id, a.action_type, a.reason, a.record_id, a.metadata
    FROM public.audit_logs a, allowed
    WHERE allowed.ok
      AND a.table_name = 'landlords'
      AND a.record_id = p_landlord_id::text
    ORDER BY a.created_at DESC
    LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  )
  SELECT r.id,
         r.created_at,
         r.user_id,
         COALESCE(p.full_name, p.email, 'Unknown'),
         r.action_type,
         COALESCE(r.reason, r.metadata->>'reason'),
         r.record_id,
         k.key,
         NULLIF(r.metadata->'old'->>k.key, ''),
         NULLIF(r.metadata->'patch'->>k.key, '')
  FROM rows r
  LEFT JOIN public.profiles p ON p.id = r.user_id
  LEFT JOIN LATERAL (
    SELECT key FROM jsonb_object_keys(COALESCE(r.metadata->'patch', '{}'::jsonb)) AS key
  ) k ON true
  ORDER BY r.created_at DESC, k.key;
$function$;

REVOKE ALL ON FUNCTION public.ops_landlord_change_history(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_landlord_change_history(uuid, integer) TO authenticated;