-- Live "is this name already taken" check so the app can stop someone before
-- they submit. Same rule the submit path enforces: a name already carried by
-- another account holding a different National ID cannot be reused.
CREATE OR REPLACE FUNCTION public.national_id_name_taken(p_name text, p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_self uuid := coalesce(p_user_id, auth.uid());
  v_key text := public.person_name_key(coalesce(p_name, ''));
  v_owner uuid;
BEGIN
  IF v_key IS NULL OR position(' ' IN v_key) = 0 THEN
    RETURN jsonb_build_object('taken', false, 'reason', 'need_two_names');
  END IF;

  SELECT p.id INTO v_owner
    FROM public.profiles p
   WHERE (v_self IS NULL OR p.id IS DISTINCT FROM v_self)
     AND public.person_name_key(coalesce(nullif(btrim(p.national_id_name), ''), p.full_name)) = v_key
     AND nullif(btrim(coalesce(p.national_id, '')), '') IS NOT NULL
   ORDER BY p.created_at
   LIMIT 1;

  RETURN jsonb_build_object('taken', v_owner IS NOT NULL, 'name_key', v_key);
END $$;

GRANT EXECUTE ON FUNCTION public.national_id_name_taken(text, uuid) TO authenticated;
