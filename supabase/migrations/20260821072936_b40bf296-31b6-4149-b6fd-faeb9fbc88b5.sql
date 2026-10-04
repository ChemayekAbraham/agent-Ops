ALTER TABLE public.service_centre_setups
  ADD COLUMN IF NOT EXISTS ceo_approved_by uuid,
  ADD COLUMN IF NOT EXISTS ceo_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS ceo_comment text,
  ADD COLUMN IF NOT EXISTS ceo_rejection_reason text;

CREATE INDEX IF NOT EXISTS idx_service_centre_setups_status ON public.service_centre_setups(status);

DROP POLICY IF EXISTS "Staff can view all service centre setups" ON public.service_centre_setups;
CREATE POLICY "Staff can view all service centre setups"
ON public.service_centre_setups FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.user_roles
  WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = ANY (ARRAY['manager'::app_role,'coo'::app_role,'cfo'::app_role,'cto'::app_role,'ceo'::app_role,'super_admin'::app_role,'operations'::app_role,'agent_ops'::app_role])
));

DROP POLICY IF EXISTS "Staff can update service centre setups" ON public.service_centre_setups;
CREATE POLICY "Staff can update service centre setups"
ON public.service_centre_setups FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.user_roles
  WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = ANY (ARRAY['manager'::app_role,'coo'::app_role,'cfo'::app_role,'cto'::app_role,'ceo'::app_role,'super_admin'::app_role,'operations'::app_role,'agent_ops'::app_role])
));

CREATE OR REPLACE FUNCTION public.ceo_approve_service_centres(p_ids uuid[], p_comment text)
RETURNS TABLE(id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_comment text := btrim(coalesce(p_comment, ''));
  r record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'super_admin')) THEN
    RAISE EXCEPTION 'Only the CEO can approve service centres';
  END IF;
  IF length(v_comment) < 10 THEN
    RAISE EXCEPTION 'A comment of at least 10 characters is required';
  END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Select at least one service centre';
  END IF;

  FOR r IN
    UPDATE public.service_centre_setups s
       SET status = 'active',
           ceo_approved_by = v_actor,
           ceo_approved_at = now(),
           ceo_comment = v_comment,
           approved_by = v_actor,
           approved_at = now()
     WHERE s.id = ANY(p_ids)
       AND s.status = 'verified'
    RETURNING s.id, s.status
  LOOP
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_actor, 'service_centre_ceo_approved', 'service_centre_setups', r.id, v_comment,
            jsonb_build_object('status', 'active'));
    id := r.id; status := r.status;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.ceo_reject_service_centres(p_ids uuid[], p_comment text)
RETURNS TABLE(id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_comment text := btrim(coalesce(p_comment, ''));
  r record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'super_admin')) THEN
    RAISE EXCEPTION 'Only the CEO can reject service centres';
  END IF;
  IF length(v_comment) < 10 THEN
    RAISE EXCEPTION 'A rejection reason of at least 10 characters is required';
  END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Select at least one service centre';
  END IF;

  FOR r IN
    UPDATE public.service_centre_setups s
       SET status = 'rejected',
           ceo_rejection_reason = v_comment,
           ceo_approved_by = v_actor,
           ceo_approved_at = now()
     WHERE s.id = ANY(p_ids)
       AND s.status = 'verified'
    RETURNING s.id, s.status
  LOOP
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (v_actor, 'service_centre_ceo_rejected', 'service_centre_setups', r.id, v_comment,
            jsonb_build_object('status', 'rejected'));
    id := r.id; status := r.status;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.ceo_approve_service_centres(uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ceo_reject_service_centres(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ceo_approve_service_centres(uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ceo_reject_service_centres(uuid[], text) TO authenticated;