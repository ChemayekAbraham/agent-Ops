-- PSO-HEAD-1. Approved: Bwayo (HR Lead), 6 Oct 2026, on executive authority.
-- Jacob Munabi (EMP-00045) is head of the Platform Sales Officers. Only the active head sees every PSO's
-- performance; other PSOs still see only themselves. Access ends automatically if he stops being a PSO.
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='user_roles' AND column_name='enabled') THEN
    RAISE EXCEPTION 'FINGERPRINT FAIL: not the RentFlow database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.v_pso_officers WHERE staff_id = '5b490047-b450-451e-a981-7e2133117afe') THEN
    RAISE EXCEPTION 'PRECONDITION FAIL: Jacob Munabi (EMP-00045) is not an active PSO';
  END IF;
END $pre$;

CREATE TABLE IF NOT EXISTS public.pso_team_leads (
  staff_id uuid PRIMARY KEY REFERENCES public.hr_staff(id),
  appointed_on date NOT NULL DEFAULT current_date,
  appointed_by text NOT NULL,
  note text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pso_team_leads_one_active ON public.pso_team_leads ((true)) WHERE active;
ALTER TABLE public.pso_team_leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pso_team_leads_read ON public.pso_team_leads;
CREATE POLICY pso_team_leads_read ON public.pso_team_leads FOR SELECT TO authenticated USING (
  public.hr_is_admin() OR public.hr_is_executive() OR staff_id = public.hr_my_staff_id());
GRANT SELECT ON public.pso_team_leads TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.pso_team_leads FROM anon, authenticated;

INSERT INTO public.pso_team_leads (staff_id, appointed_on, appointed_by, note)
VALUES ('5b490047-b450-451e-a981-7e2133117afe', date '2026-10-06', 'Bwayo (HR Lead)', 'Head of Platform Sales Officers')
ON CONFLICT (staff_id) DO UPDATE SET active = true;

CREATE OR REPLACE FUNCTION public.pso_is_team_lead()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT EXISTS (
    SELECT 1 FROM public.pso_team_leads l
      JOIN public.v_pso_officers o ON o.staff_id = l.staff_id
     WHERE l.active AND l.staff_id = public.hr_my_staff_id());
$f$;
REVOKE ALL ON FUNCTION public.pso_is_team_lead() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pso_is_team_lead() TO authenticated;

-- Let the PSO head read all officers in the three PSO report functions
DO $patch$
DECLARE fn text; d text; n int;
BEGIN
  FOREACH fn IN ARRAY ARRAY['public.pso_promise_summary(date,date,uuid)',
                            'public.pso_funded_summary(date,date,uuid)',
                            'public.pso_daily_series(date,date,uuid)'] LOOP
    d := pg_get_functiondef(fn::regprocedure);
    IF position('pso_is_team_lead()' in d) > 0 THEN RAISE EXCEPTION '% already patched', fn; END IF;
    SELECT count(*) INTO n FROM regexp_matches(d, 'v_reviewer boolean := public\.hr_is_admin\(\)', 'g');
    IF n <> 1 THEN RAISE EXCEPTION '% reviewer anchor found % times, expected 1', fn, n; END IF;
    d := regexp_replace(d, 'v_reviewer boolean := public\.hr_is_admin\(\)',
                           'v_reviewer boolean := public.pso_is_team_lead() or public.hr_is_admin()');
    EXECUTE d;
  END LOOP;
END $patch$;

-- Let the PSO head resolve the names of PSOs only (CEO/COO/HR unchanged)
CREATE OR REPLACE FUNCTION public.pso_officer_names()
RETURNS TABLE(staff_id uuid, full_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT st.id, p.full_name
    FROM public.hr_staff st
    JOIN public.profiles p ON p.id = st.user_id
   WHERE public.has_role(auth.uid(), 'ceo'::public.app_role)
      OR public.has_role(auth.uid(), 'coo'::public.app_role)
      OR public.has_role(auth.uid(), 'hr'::public.app_role)
      OR (public.pso_is_team_lead()
          AND EXISTS (SELECT 1 FROM public.v_pso_officers o WHERE o.staff_id = st.id))
$function$;

SELECT (SELECT count(*) FROM public.pso_team_leads WHERE active) AS active_leads,
       (SELECT count(*) FROM pg_proc WHERE proname IN ('pso_promise_summary','pso_funded_summary','pso_daily_series')
          AND position('pso_is_team_lead()' in pg_get_functiondef(oid)) > 0) AS patched_functions;