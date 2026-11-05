CREATE OR REPLACE FUNCTION public.wh_nin_in_use(p_nin text, p_tenant_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (select auth.uid()) IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.wh_tenant_identity
    WHERE nin = upper(regexp_replace(coalesce(p_nin,''), '\s', '', 'g'))
      AND (p_tenant_id IS NULL OR tenant_id <> p_tenant_id))
$$;
REVOKE ALL ON FUNCTION public.wh_nin_in_use(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_nin_in_use(text, uuid) TO authenticated, service_role;