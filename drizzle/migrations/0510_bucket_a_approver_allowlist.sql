-- Bucket A posting is authorised ONLY by users listed in cfo_approval_approvers (the allowlist named in the Bucket A brief).
-- No fallback to super admin, CFO role, CFO office or any other permission. Nothing else in the posting logic changes.
CREATE OR REPLACE FUNCTION public.is_bucket_a_approver(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.cfo_approval_approvers a WHERE a.user_id = _user_id)
$$;
REVOKE ALL ON FUNCTION public.is_bucket_a_approver(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_bucket_a_approver(uuid) TO authenticated;

DO $mig$
DECLARE v_def text; v_new text;
BEGIN
  -- cfo_bucket_a_post: swap only the authorisation check
  v_def := pg_get_functiondef('public.cfo_bucket_a_post(uuid,text,text)'::regprocedure);
  v_new := replace(v_def, 'IF NOT public.is_cfo_approver(auth.uid()) THEN', 'IF NOT public.is_bucket_a_approver(auth.uid()) THEN');
  IF v_new = v_def OR position('is_cfo_approver' in v_new) > 0 THEN RAISE EXCEPTION 'cfo_bucket_a_post check not replaced'; END IF;
  EXECUTE v_new;

  -- cfo_bucket_a_preflight: stays read-only and runnable by CFO staff; only the can_authorize flag uses the allowlist
  v_def := pg_get_functiondef('public.cfo_bucket_a_preflight()'::regprocedure);
  v_new := replace(v_def, '''can_authorize'', public.is_cfo_approver(auth.uid())', '''can_authorize'', public.is_bucket_a_approver(auth.uid())');
  IF v_new = v_def THEN RAISE EXCEPTION 'cfo_bucket_a_preflight can_authorize not replaced'; END IF;
  EXECUTE v_new;
END $mig$;