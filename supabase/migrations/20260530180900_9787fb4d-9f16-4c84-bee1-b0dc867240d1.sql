-- Make notifications readable/updatable by their owner (RLS was enabled but had no policies)
GRANT SELECT, UPDATE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;

DROP POLICY IF EXISTS "Users read own notifications" ON public.notifications;
CREATE POLICY "Users read own notifications"
ON public.notifications FOR SELECT TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own notifications" ON public.notifications;
CREATE POLICY "Users update own notifications"
ON public.notifications FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
ON public.notifications (user_id, is_read, created_at DESC);

-- Helper: tenant-ops recipients for alerts (backend use; gated to ops staff)
CREATE OR REPLACE FUNCTION public.get_tenant_ops_recipients(p_email_only boolean DEFAULT false)
 RETURNS TABLE(user_id uuid, full_name text, email text, roles text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    ur.user_id,
    p.full_name,
    p.email,
    array_agg(DISTINCT ur.role::text) AS roles
  FROM public.user_roles ur
  LEFT JOIN public.profiles p ON p.id = ur.user_id
  WHERE ur.enabled = true
    AND ur.role IN ('operations','manager','coo','super_admin')
    AND (NOT p_email_only OR (ur.role = 'operations' AND p.email IS NOT NULL AND p.email <> ''))
  GROUP BY ur.user_id, p.full_name, p.email;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_tenant_ops_recipients(boolean) TO service_role;