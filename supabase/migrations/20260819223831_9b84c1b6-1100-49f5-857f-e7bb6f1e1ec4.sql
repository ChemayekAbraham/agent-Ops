DROP FUNCTION IF EXISTS public.get_budget_department_notifications();

CREATE OR REPLACE FUNCTION public.get_budget_department_notifications(_department_keys text[] DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  call_id uuid,
  department_id uuid,
  department_key text,
  department_name text,
  cycle_title text,
  deadline timestamptz,
  title text,
  message text,
  link text,
  created_at timestamptz,
  is_read boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT n.id,
         n.call_id,
         n.department_id,
         d.key AS department_key,
         d.name AS department_name,
         c.title AS cycle_title,
         c.deadline,
         n.title,
         n.message,
         COALESCE(n.metadata->>'link', '/budgets') AS link,
         n.created_at,
         EXISTS (
           SELECT 1 FROM budget_department_notification_reads rr
            WHERE rr.notification_id = n.id AND rr.user_id = auth.uid()
         ) AS is_read
    FROM budget_department_notifications n
    JOIN hr_departments d ON d.id = n.department_id
    JOIN budget_calls c ON c.id = n.call_id
   WHERE d.active
     AND public.budget_can_access_department(n.department_id, auth.uid())
     AND (
       _department_keys IS NULL
       OR lower(d.key) IN (SELECT lower(k) FROM unnest(_department_keys) AS k)
     )
   ORDER BY n.created_at DESC
   LIMIT 50;
$$;

REVOKE EXECUTE ON FUNCTION public.get_budget_department_notifications(text[]) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.get_budget_department_notifications(text[]) TO authenticated;