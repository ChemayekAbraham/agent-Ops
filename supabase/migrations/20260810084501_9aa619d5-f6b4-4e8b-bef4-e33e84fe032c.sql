INSERT INTO public.staff_permissions (user_id, permitted_dashboard)
SELECT '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b', 'cfo'
WHERE NOT EXISTS (
  SELECT 1 FROM public.staff_permissions
  WHERE user_id = '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b'
    AND permitted_dashboard = 'cfo'
    AND revoked_at IS NULL
);