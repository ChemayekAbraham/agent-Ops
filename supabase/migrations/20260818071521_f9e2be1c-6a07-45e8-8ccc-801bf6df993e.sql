BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.get_user_signup_windows();

CREATE FUNCTION public.get_user_signup_windows()
RETURNS TABLE(window_days integer, current_count bigint, previous_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_anchor timestamptz := now();
BEGIN
  IF auth.uid() IS NULL OR NOT (
    public.has_role(auth.uid(), 'hr'::public.app_role)
    OR public.has_role(auth.uid(), 'manager'::public.app_role)
    OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'ceo'::public.app_role)
    OR public.has_role(auth.uid(), 'coo'::public.app_role)
    OR public.has_role(auth.uid(), 'cto'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to view user signup windows';
  END IF;

  RETURN QUERY
  SELECT w.n::integer AS window_days,
         (SELECT count(*)::bigint FROM public.profiles p
           WHERE p.created_at >= v_anchor - make_interval(days => w.n)
             AND p.created_at < v_anchor) AS current_count,
         (SELECT count(*)::bigint FROM public.profiles p
           WHERE p.created_at >= v_anchor - make_interval(days => 2 * w.n)
             AND p.created_at < v_anchor - make_interval(days => w.n)) AS previous_count
  FROM (VALUES (1), (7), (30), (90)) AS w(n)
  ORDER BY w.n;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_user_signup_windows() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_signup_windows() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_user_signup_windows() TO authenticated;

COMMIT;