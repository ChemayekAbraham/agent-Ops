CREATE OR REPLACE FUNCTION public.ops_rent_frequency_history(p_rent_request_id uuid)
RETURNS TABLE (
  id uuid,
  changed_at timestamptz,
  changed_by uuid,
  changed_by_name text,
  old_frequency text,
  new_frequency text,
  starts_on date,
  reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT a.id,
         a.created_at,
         a.user_id,
         p.full_name,
         a.metadata->>'old_frequency',
         a.metadata->>'new_frequency',
         NULLIF(a.metadata->>'repayment_starts_on','')::date,
         a.metadata->>'reason'
  FROM public.audit_logs a
  LEFT JOIN public.profiles p ON p.id = a.user_id
  WHERE a.action_type = 'ops.set_rent_plan_frequency'
    AND a.table_name = 'rent_requests'
    AND a.record_id = p_rent_request_id::text
    AND (
      public.is_ops_role(auth.uid())
      OR public.has_role(auth.uid(), 'manager'::app_role)
      OR public.has_role(auth.uid(), 'super_admin'::app_role)
    )
  ORDER BY a.created_at DESC
  LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION public.ops_rent_frequency_history(uuid) TO authenticated;