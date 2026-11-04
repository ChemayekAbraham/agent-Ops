DROP POLICY IF EXISTS wh_fresh_start_read ON public.wh_fresh_start;
CREATE POLICY wh_fresh_start_read ON public.wh_fresh_start FOR SELECT TO authenticated USING ((select public._wh_archive_viewer()));