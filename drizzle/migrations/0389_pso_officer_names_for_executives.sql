CREATE OR REPLACE FUNCTION public.pso_officer_names()
RETURNS TABLE(staff_id uuid, full_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT st.id, p.full_name
    FROM public.hr_staff st
    JOIN public.profiles p ON p.id = st.user_id
   WHERE public.has_role(auth.uid(), 'ceo'::public.app_role)
      OR public.has_role(auth.uid(), 'coo'::public.app_role)
      OR public.has_role(auth.uid(), 'hr'::public.app_role)
$$;
REVOKE ALL ON FUNCTION public.pso_officer_names() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pso_officer_names() TO authenticated;