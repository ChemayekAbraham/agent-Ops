CREATE OR REPLACE FUNCTION public.cto_set_kyc_level(p_user_id uuid, p_new_level smallint, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_old smallint;
BEGIN
  IF NOT public.has_role(auth.uid(),'cto') THEN
    RAISE EXCEPTION 'Only CTO can change KYC level';
  END IF;
  IF p_new_level NOT IN (1,2,3) THEN
    RAISE EXCEPTION 'KYC level must be 1, 2, or 3';
  END IF;
  IF char_length(coalesce(p_reason,'')) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  SELECT kyc_level INTO v_old FROM public.kyc_profiles WHERE user_id = p_user_id;

  INSERT INTO public.kyc_profiles(user_id, kyc_level, level_source, upgraded_at, last_reviewed_at, last_reviewed_by)
  VALUES (p_user_id, p_new_level, 'manual', now(), now(), auth.uid())
  ON CONFLICT (user_id) DO UPDATE
    SET kyc_level = EXCLUDED.kyc_level,
        level_source = 'manual',
        upgraded_at = now(),
        last_reviewed_at = now(),
        last_reviewed_by = auth.uid();

  INSERT INTO public.kyc_level_change_audit(user_id, action, old_level, new_level, actor_id, reason)
  VALUES (p_user_id,
          CASE WHEN p_new_level > COALESCE(v_old,1) THEN 'upgrade' ELSE 'downgrade' END,
          v_old, p_new_level, auth.uid(), p_reason);
END $function$;

REVOKE ALL ON FUNCTION public.cto_set_kyc_level(uuid, smallint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cto_set_kyc_level(uuid, smallint, text) TO authenticated;