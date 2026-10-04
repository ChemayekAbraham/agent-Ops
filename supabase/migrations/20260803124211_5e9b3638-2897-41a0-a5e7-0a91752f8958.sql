CREATE OR REPLACE FUNCTION public.sum_storage_object_size(p_bucket text, p_paths text[])
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, storage
AS $$
  SELECT COALESCE(SUM(COALESCE((o.metadata->>'size')::bigint, 0)), 0)::bigint
  FROM storage.objects o
  WHERE o.bucket_id = p_bucket
    AND o.name = ANY(p_paths);
$$;

REVOKE ALL ON FUNCTION public.sum_storage_object_size(text, text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sum_storage_object_size(text, text[]) TO service_role;