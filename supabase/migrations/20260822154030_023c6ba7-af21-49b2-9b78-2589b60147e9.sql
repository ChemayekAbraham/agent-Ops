DROP FUNCTION IF EXISTS public.lending_find_user_by_phone(text);

CREATE OR REPLACE FUNCTION public.lending_find_user_by_phone(p_phone text)
 RETURNS TABLE(user_id uuid, full_name text, phone text, city text, ai_id text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_digits text;
  v_last9 text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.lending_agent_agreement_acceptance laa
    WHERE laa.agent_user_id = auth.uid() AND laa.status = 'accepted'
  ) THEN
    RAISE EXCEPTION 'lending_agreement_required';
  END IF;

  v_digits := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  IF length(v_digits) < 9 THEN
    RAISE EXCEPTION 'phone_too_short';
  END IF;
  v_last9 := right(v_digits, 9);

  RETURN QUERY
  SELECT p.id, p.full_name, p.phone, p.city,
         coalesce(c.ai_id, public.derive_welile_ai_id(p.id)) AS ai_id
  FROM public.profiles p
  LEFT JOIN public.welile_trust_score_cache c ON c.user_id = p.id
  WHERE right(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 9) = v_last9
    AND p.id <> auth.uid()
  LIMIT 5;
END;
$function$;