DROP FUNCTION IF EXISTS public.finops_holder_name_history(uuid);

CREATE OR REPLACE FUNCTION public.finops_holder_name_history(p_user_id uuid)
RETURNS TABLE(
  id uuid,
  changed_at timestamp with time zone,
  changed_by uuid,
  changed_by_name text,
  old_name text,
  new_name text,
  source text,
  reason text,
  can_revert boolean,
  user_agent text,
  ip_address text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id,
         a.created_at AS changed_at,
         a.user_id AS changed_by,
         p.full_name AS changed_by_name,
         a.old_values->>'full_name' AS old_name,
         a.new_values->>'full_name' AS new_name,
         coalesce(a.new_values->>'source', 'national_id_ocr') AS source,
         a.reason,
         (
           a.action_type IN ('payout_holder_name_from_national_id', 'payout_holder_name_manual_override')
           AND length(btrim(coalesce(a.old_values->>'full_name', ''))) >= 3
           AND NOT EXISTS (
             SELECT 1 FROM public.audit_logs r
             WHERE r.action_type = 'payout_holder_name_reverted'
               AND r.new_values->>'reverted_audit_id' = a.id::text
           )
         ) AS can_revert,
         a.user_agent,
         a.ip_address
  FROM public.audit_logs a
  LEFT JOIN public.profiles p ON p.id = a.user_id
  WHERE a.table_name = 'profiles'
    AND a.record_id = p_user_id::text
    AND a.action_type IN ('payout_holder_name_from_national_id', 'payout_holder_name_manual_override', 'payout_holder_name_reverted')
    AND (
      auth.uid() IS NOT NULL AND (
        public.has_role(auth.uid(), 'financial_ops')
        OR public.has_role(auth.uid(), 'cfo')
        OR public.has_role(auth.uid(), 'super_admin')
      )
    )
  ORDER BY a.created_at DESC
  LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION public.finops_holder_name_history(uuid) TO authenticated;
