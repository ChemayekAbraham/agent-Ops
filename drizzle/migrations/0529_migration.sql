CREATE OR REPLACE FUNCTION public.claim_lead_click(p_click_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_created timestamptz; n int; v_new boolean; v_bot uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  SELECT created_at INTO v_created FROM profiles WHERE id = v_uid;
  UPDATE lead_link_clicks c SET user_id = v_uid, came_in_at = now(),
    is_new_registration = (v_created IS NOT NULL AND v_created >= c.created_at - interval '5 minutes')
  WHERE c.id = p_click_id AND c.user_id IS NULL AND c.created_at > now() - interval '30 days'
  RETURNING c.is_new_registration INTO v_new;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 AND COALESCE(v_new,false) THEN
    SELECT id INTO v_bot FROM profiles WHERE email = 'neexabot@welileapp.com';
    IF v_bot IS NOT NULL AND v_bot <> v_uid THEN
      UPDATE profiles SET referrer_id = v_bot WHERE id = v_uid AND referrer_id IS NULL;
    END IF;
  END IF;
  RETURN n > 0;
END $function$;